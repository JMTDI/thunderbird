/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_MSGDB_PUBLIC_NSMSGHDR_H_
#define COMM_MAILNEWS_DB_MSGDB_PUBLIC_NSMSGHDR_H_

#include "mozilla/MemoryReporting.h"
#include "nsIMsgHdr.h"
#include "nsString.h"
#include "mdb.h"
#include "nsTArray.h"

class nsMsgDatabase;
class nsIMsgThread;

class nsMsgHdr : public nsIMsgDBHdr {
 public:
  NS_DECL_NSIMSGDBHDR
  friend class nsMsgDatabase;
  friend class nsImapMailDatabase;
  friend class nsMsgPropertyEnumerator;
  friend class nsMsgThread;

  ////////////////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////////////////
  // nsMsgHdr methods:
  nsMsgHdr(nsMsgDatabase* db, nsIMdbRow* dbRow);

  NS_DECL_ISUPPORTS

  size_t SizeOfExcludingThis(mozilla::MallocSizeOf aMallocSizeOfFun) const {
    return m_references.ShallowSizeOfExcludingThis(aMallocSizeOfFun);
  }
  size_t SizeOfIncludingThis(mozilla::MallocSizeOf aMallocSizeOfFun) const {
    return aMallocSizeOfFun(this) + SizeOfExcludingThis(aMallocSizeOfFun);
  }

 protected:
  nsIMdbRow* GetMDBRow() { return m_mdbRow; }
  void ReleaseMDBRow() { NS_IF_RELEASE(m_mdbRow); }
  nsMsgDatabase* GetMdb() { return m_mdb; }
  void ClearCachedValues() { m_initedValues = 0; }

  virtual nsresult GetRawFlags(uint32_t* result);

  bool IsParentOf(nsIMsgDBHdr* possibleChild);
  bool IsAncestorOf(nsIMsgDBHdr* possibleChild);

 private:
  virtual ~nsMsgHdr();

  void Init();
  virtual nsresult InitFlags();
  virtual nsresult InitCachedValues();

  bool IsAncestorKilled(uint32_t ancestorsToCheck);
  void ReparentInThread(nsIMsgThread* thread);

  nsresult SetStringColumn(const char* str, mdb_token token);
  nsresult SetUInt32Column(uint32_t value, mdb_token token);
  nsresult GetUInt32Column(mdb_token token, uint32_t* pvalue,
                           uint32_t defaultValue = 0);
  nsresult SetUInt64Column(uint64_t value, mdb_token token);
  nsresult GetUInt64Column(mdb_token token, uint64_t* pvalue,
                           uint64_t defaultValue = 0);

  // reference and threading stuff.
  nsresult ParseReferences(const char* references);
  const char* GetNextReference(const char* startNextRef, nsCString& reference,
                               bool acceptNonDelimitedReferences);

  nsMsgKey m_threadId;
  nsMsgKey m_messageKey;    // Unique id of message in msgDB.
  nsMsgKey m_threadParent;  // message this is a reply to, in thread.
  PRTime m_date;
  uint32_t m_messageSize;  // lines for news articles, bytes for mail messages
  uint32_t m_flags;
  // avoid parsing references every time we want one
  nsTArray<nsCString> m_references;

  // nsMsgHdrs will have to know what db and row they belong to, since they are
  // really just a wrapper around the msg row in the mdb. This could cause
  // problems, though I hope not.
  nsMsgDatabase* m_mdb;
  nsIMdbRow* m_mdbRow;
  uint32_t m_initedValues;
};

#endif  // COMM_MAILNEWS_DB_MSGDB_PUBLIC_NSMSGHDR_H_
