/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_EXTENSIONS_BAYESIAN_SPAM_FILTER_NSBAYESIANFILTER_H_
#define COMM_MAILNEWS_EXTENSIONS_BAYESIAN_SPAM_FILTER_NSBAYESIANFILTER_H_

#include <stdio.h>
#include "nsCOMPtr.h"
#include "nsIMsgFilterPlugin.h"
#include "PLDHashTable.h"
#include "nsITimer.h"
#include "nsTArray.h"
#include "nsString.h"
#include "nsWeakReference.h"
#include "nsIObserver.h"
#include "nsHashPropertyBag.h"
#include "mozilla/intl/WordBreaker.h"

#include "mozilla/ArenaAllocator.h"

#define DEFAULT_MIN_INTERVAL_BETWEEN_WRITES 15 * 60 * 1000

struct Token;
class TokenEnumeration;
class TokenAnalyzer;
class nsIMsgWindow;
class nsIUTF8StringEnumerator;
struct BaseToken;
struct CorpusToken;

/**
 * Helper class to enumerate Token objects in a PLDHashTable
 * safely and without copying (see bugzilla #174859). The
 * enumeration is safe to use until an Add()
 * or Remove() is performed on the table.
 */
class TokenEnumeration {
 public:
  explicit TokenEnumeration(PLDHashTable* table);
  bool hasMoreTokens();
  BaseToken* nextToken();

 private:
  PLDHashTable::Iterator mIterator;
};

// A trait is some aspect of a message, like being junk or tagged as
// Personal, that the statistical classifier should track. The Trait
// structure is a per-token representation of information pertaining to
// a message trait.
//
// Traits per token are maintained as a linked list.
//
struct TraitPerToken {
  uint32_t mId;        // identifying number for a trait
  uint32_t mCount;     // count of messages with this token and trait
  uint32_t mNextLink;  // index in mTraitStore for the next trait, or 0
                       // for none
  TraitPerToken(uint32_t aId, uint32_t aCount);  // inititializer
};

// An Analysis is the statistical results for a particular message, a
// particular token, and for a particular pair of trait/antitrait, that
// is then used in subsequent analysis to score the message.
//
// Analyses per token are maintained as a linked list.
//
struct AnalysisPerToken {
  uint32_t mTraitIndex;  // index representing a protrait/antitrait pair.
                         // So if we are analyzing 3 different traits, then
                         // the first trait is 0, the second 1, etc.
  double mDistance;      // absolute value of mProbability - 0.5
  double mProbability;   // relative indicator of match of trait to token
  uint32_t mNextLink;    // index in mAnalysisStore for the Analysis object
                         // for the next trait index, or 0 for none.
  // initializer
  AnalysisPerToken(uint32_t aTraitIndex, double aDistance, double aProbability);
};

class TokenHash {
 public:
  virtual ~TokenHash();
  /**
   * Clears out the previous message tokens.
   */
  nsresult clearTokens();
  uint32_t countTokens();
  TokenEnumeration getTokens();
  BaseToken* add(const char* word);

 protected:
  explicit TokenHash(uint32_t entrySize);
  mozilla::ArenaAllocator<16384, 2> mWordPool;
  uint32_t mEntrySize;
  PLDHashTable mTokenTable;
  char* copyWord(const char* word, uint32_t len);
  BaseToken* get(const char* word);
};

class Tokenizer : public TokenHash {
 public:
  Tokenizer();
  ~Tokenizer();

  Token* get(const char* word);

  // The training set keeps an occurrence count on each word. This count
  // is supposed to count the # of messages it occurs in.
  // When add/remove is called while tokenizing a message and NOT the training
  // set,
  //
  Token* add(const char* word, uint32_t count = 1);

  Token* copyTokens();

  void tokenize(const char* text);

  /**
   *  Creates specific tokens based on the mime headers for the message being
   * tokenized
   */
  void tokenizeHeaders(nsTArray<nsCString>& aHeaderNames,
                       nsTArray<nsCString>& aHeaderValues);

  void tokenizeAttachments(nsTArray<RefPtr<nsIPropertyBag2>>& attachments);

  nsCString mBodyDelimiters;    // delimiters for body tokenization
  nsCString mHeaderDelimiters;  // delimiters for header tokenization

  // arrays of extra headers to tokenize / to not tokenize
  nsTArray<nsCString> mEnabledHeaders;
  nsTArray<nsCString> mDisabledHeaders;
  // Delimiters used in tokenizing a particular header.
  // Parallel array to mEnabledHeaders
  nsTArray<nsCString> mEnabledHeadersDelimiters;
  bool mCustomHeaderTokenization;  // Are there any preference-set tokenization
                                   // customizations?
  uint32_t mMaxLengthForToken;     // maximum length of a token
  // should we convert iframe to div during tokenization?
  bool mIframeToDiv;

 private:
  void tokenize_ascii_word(char* word);
  void tokenize_japanese_word(char* chunk);
  inline void addTokenForHeader(const char* aTokenPrefix, nsACString& aValue,
                                bool aTokenizeValue = false,
                                const char* aDelimiters = nullptr);
  nsresult stripHTML(const nsAString& inString, nsAString& outString);
  // helper function to escape \n, \t, etc from a CString
  void UnescapeCString(nsCString& aCString);
  nsresult ScannerNext(const char16_t* text, int32_t length, int32_t pos,
                       bool isLastBuffer, int32_t* begin, int32_t* end,
                       bool* _retval);
};

/**
 * Implements storage of a collection of message tokens and counts for
 * a corpus of classified messages
 */

class CorpusStore : public TokenHash {
 public:
  CorpusStore();
  ~CorpusStore();

  /**
   * retrieve the token structure for a particular string
   *
   * @param word  the character representation of the token
   *
   * @return      token structure containing counts, null if not found
   */
  CorpusToken* get(const char* word);

  /**
   * add tokens to the storage, or increment counts if already exists.
   *
   * @param aTokenizer tokenizer for the list of tokens to remember
   * @param aTraitId   id for the trait whose counts will be remembered
   * @param aCount     number of new messages represented by the token list
   */
  void rememberTokens(Tokenizer& aTokenizer, uint32_t aTraitId,
                      uint32_t aCount);

  /**
   * decrement counts for tokens in the storage, removing if all counts
   * are zero
   *
   * @param aTokenizer tokenizer for the list of tokens to forget
   * @param aTraitId   id for the trait whose counts will be removed
   * @param aCount     number of messages represented by the token list
   */
  void forgetTokens(Tokenizer& aTokenizer, uint32_t aTraitId, uint32_t aCount);

  /**
   * write the corpus information to file storage
   *
   * @param aMaximumTokenCount  prune tokens if number of tokens exceeds
   *                            this value.  == 0  for no pruning
   */
  void writeTrainingData(uint32_t aMaximumTokenCount);

  /**
   * read the corpus information from file storage
   */
  void readTrainingData();

  /**
   * delete the local corpus storage file and data
   */
  nsresult resetTrainingData();

  /**
   * get the count of messages whose tokens are stored that are associated
   * with a trait
   *
   * @param aTraitId  identifier for the trait
   * @return          number of messages for that trait
   */
  uint32_t getMessageCount(uint32_t aTraitId);

  /**
   * set the count of messages whose tokens are stored that are associated
   * with a trait
   *
   * @param aTraitId  identifier for the trait
   * @param aCount    number of messages for that trait
   */
  void setMessageCount(uint32_t aTraitId, uint32_t aCount);

  /**
   * get the count of messages associated with a particular token and trait
   *
   * @param  token     the token string and associated counts
   * @param  aTraitId  identifier for the trait
   */
  uint32_t getTraitCount(CorpusToken* token, uint32_t aTraitId);

  /**
   * Add (or remove) data from a particular file to the corpus data.
   *
   * @param aFile       the file with the data, in the format:
   *
   *                    Format of the trait file for version 1:
   *                    [0xFCA93601]  (the 01 is the version)
   *                    for each trait to write:
   *                    [id of trait to write] (0 means end of list)
   *                    [number of messages per trait]
   *                    for each token with non-zero count
   *                    [count]
   *                    [length of word]word
   *
   * @param aIsAdd      should the data be added, or removed? true if adding,
   *                    else removing.
   *
   * @param aFromTraits array of trait ids used in aFile. If aFile contains
   *                    trait ids that are not in this array, they are not
   *                    remapped, but assumed to be local trait ids.
   *
   * @param aToTraits   array of trait ids, corresponding to elements of
   *                    aFromTraits, that represent the local trait ids to be
   *                    used in storing data from aFile into the local corpus.
   *
   */
  nsresult UpdateData(nsIFile* aFile, bool aIsAdd,
                      const nsTArray<uint32_t>& aFromTraits,
                      const nsTArray<uint32_t>& aToTraits);

  /**
   * remove all counts (message and tokens) for a trait id
   *
   * @param aTrait  trait id for the trait to remove
   */
  nsresult ClearTrait(uint32_t aTrait);

 protected:
  /**
   * return the local corpus storage file for junk traits
   */
  nsresult getTrainingFile(nsIFile** aFile);

  /**
   * return the local corpus storage file for non-junk traits
   */
  nsresult getTraitFile(nsIFile** aFile);

  /**
   * read token strings from the data file
   *
   * @param stream     file stream with token data
   * @param fileSize   file size
   * @param aTraitId   id for the trait whose counts will be read
   * @param aIsAdd     true to add the counts, false to remove them
   *
   * @return           true if successful, false if error
   */
  bool readTokens(FILE* stream, int64_t fileSize, uint32_t aTraitId,
                  bool aIsAdd);

  /**
   * write token strings to the data file
   */
  bool writeTokens(FILE* stream, bool shrink, uint32_t aTraitId);

  /**
   * remove counts for a token string
   */
  void remove(const char* word, uint32_t aTraitId, uint32_t aCount);

  /**
   * add counts for a token string, adding the token string if new
   */
  CorpusToken* add(const char* word, uint32_t aTraitId, uint32_t aCount);

  /**
   * change counts in a trait in the traits array, adding the trait if needed
   */
  nsresult updateTrait(CorpusToken* token, uint32_t aTraitId,
                       int32_t aCountChange);
  nsCOMPtr<nsIFile> mTrainingFile;      // file used to store junk training data
  nsCOMPtr<nsIFile> mTraitFile;         // file used to store non-junk
                                        // training data
  nsTArray<TraitPerToken> mTraitStore;  // memory for linked-list of counts
  uint32_t mNextTraitIndex;             // index in mTraitStore to first empty
                                        // TraitPerToken
  nsTArray<uint32_t> mMessageCounts;    // count of messages per trait
                                        // represented in the store
  nsTArray<uint32_t> mMessageCountsId;  // Parallel array to mMessageCounts,
                                        // with the corresponding trait ID
};

class nsBayesianFilter : public nsIJunkMailPlugin,
                         nsIMsgCorpus,
                         nsIObserver,
                         nsSupportsWeakReference {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGFILTERPLUGIN
  NS_DECL_NSIJUNKMAILPLUGIN
  NS_DECL_NSIMSGCORPUS
  NS_DECL_NSIOBSERVER

  nsBayesianFilter();

  nsresult Init();

  nsresult tokenizeMessage(const nsACString& messageURI,
                           nsIMsgWindow* aMsgWindow, TokenAnalyzer* analyzer);
  void classifyMessage(Tokenizer& tokens, const nsACString& messageURI,
                       nsIJunkMailClassificationListener* listener);

  void classifyMessage(Tokenizer& tokenizer, const nsACString& messageURI,
                       nsTArray<uint32_t>& aProTraits,
                       nsTArray<uint32_t>& aAntiTraits,
                       nsIJunkMailClassificationListener* listener,
                       nsIMsgTraitClassificationListener* aTraitListener,
                       nsIMsgTraitDetailListener* aDetailListener);

  void observeMessage(Tokenizer& tokens, const nsACString& messageURI,
                      nsTArray<uint32_t>& oldClassifications,
                      nsTArray<uint32_t>& newClassifications,
                      nsIJunkMailClassificationListener* listener,
                      nsIMsgTraitClassificationListener* aTraitListener);

 protected:
  virtual ~nsBayesianFilter();

  static void TimerCallback(nsITimer* aTimer, void* aClosure);

  CorpusStore mCorpus;
  double mJunkProbabilityThreshold;
  int32_t mMaximumTokenCount;
  bool mTrainingDataDirty;
  int32_t mMinFlushInterval;  // in milliseconds, must be positive
                              // and not too close to 0
  nsCOMPtr<nsITimer> mTimer;

  // index in mAnalysisStore for first empty AnalysisPerToken
  uint32_t mNextAnalysisIndex;
  // memory for linked list of AnalysisPerToken objects
  nsTArray<AnalysisPerToken> mAnalysisStore;
  /**
   * Determine the location in mAnalysisStore where the AnalysisPerToken
   * object for a particular token and trait is stored
   */
  uint32_t getAnalysisIndex(Token& token, uint32_t aTraitIndex);
  /**
   * Set the value of the AnalysisPerToken object for a particular
   * token and trait
   */
  nsresult setAnalysis(Token& token, uint32_t aTraitIndex, double aDistance,
                       double aProbability);
};

#endif  // COMM_MAILNEWS_EXTENSIONS_BAYESIAN_SPAM_FILTER_NSBAYESIANFILTER_H_
