/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgSearchAdapter.h"

#include "msgCore.h"
#include "nsTextFormatter.h"
#include "nsMsgSearchCore.h"
#include "nsMsgSearchScopeTerm.h"
#include "nsMsgI18N.h"
#include "nsIPrefLocalizedString.h"
#include "nsMsgSearchTerm.h"
#include "nsMsgSearchBoolExpression.h"
#include "nsIIOService.h"
#include "nsNetCID.h"
#include "prprf.h"
#include "mozilla/UniquePtr.h"
#include "prmem.h"
#include "MailNewsTypes.h"
#include "nsComponentManagerUtils.h"
#include "nsServiceManagerUtils.h"
#include "nsMemory.h"
#include "nsMsgMessageFlags.h"
#include "mozilla/Attributes.h"
#include "mozilla/Preferences.h"
#include "nsIMsgNewsFolder.h"

using mozilla::Preferences;

// This stuff lives in the base class because the IMAP search syntax
// is used by the Dredd SEARCH command as well as IMAP itself
// TODO: dredd never used now, rework!

// km - the NOT and HEADER strings are not encoded with a trailing
//      <space> because they always precede a mnemonic that has a
//      preceding <space> and double <space> characters cause some
//    imap servers to return an error.
const char* nsMsgSearchAdapter::m_kImapBefore = " SENTBEFORE ";
const char* nsMsgSearchAdapter::m_kImapBody = " BODY ";
const char* nsMsgSearchAdapter::m_kImapCC = " CC ";
const char* nsMsgSearchAdapter::m_kImapFrom = " FROM ";
const char* nsMsgSearchAdapter::m_kImapNot = " NOT";
const char* nsMsgSearchAdapter::m_kImapUnDeleted = " UNDELETED";
const char* nsMsgSearchAdapter::m_kImapOr = " OR";
const char* nsMsgSearchAdapter::m_kImapSince = " SENTSINCE ";
const char* nsMsgSearchAdapter::m_kImapSubject = " SUBJECT ";
const char* nsMsgSearchAdapter::m_kImapTo = " TO ";
const char* nsMsgSearchAdapter::m_kImapHeader = " HEADER";
const char* nsMsgSearchAdapter::m_kImapAnyText = " TEXT ";
const char* nsMsgSearchAdapter::m_kImapKeyword = " KEYWORD ";
const char* nsMsgSearchAdapter::m_kNntpKeywords = " KEYWORDS ";  // ggrrrr...
const char* nsMsgSearchAdapter::m_kImapSentOn = " SENTON ";
const char* nsMsgSearchAdapter::m_kImapSeen = " SEEN ";
const char* nsMsgSearchAdapter::m_kImapAnswered = " ANSWERED ";
const char* nsMsgSearchAdapter::m_kImapNotSeen = " UNSEEN ";
const char* nsMsgSearchAdapter::m_kImapNotAnswered = " UNANSWERED ";
const char* nsMsgSearchAdapter::m_kImapSizeSmaller = " SMALLER ";
const char* nsMsgSearchAdapter::m_kImapSizeLarger = " LARGER ";
const char* nsMsgSearchAdapter::m_kImapNew = " NEW ";
const char* nsMsgSearchAdapter::m_kImapNotNew = " OLD SEEN ";
const char* nsMsgSearchAdapter::m_kImapFlagged = " FLAGGED ";
const char* nsMsgSearchAdapter::m_kImapNotFlagged = " UNFLAGGED ";

#define PREF_CUSTOM_HEADERS "mailnews.customHeaders"

NS_IMPL_ISUPPORTS(nsMsgSearchAdapter, nsIMsgSearchAdapter)

nsMsgSearchAdapter::nsMsgSearchAdapter(
    nsIMsgSearchScopeTerm* scope,
    nsTArray<RefPtr<nsIMsgSearchTerm>> const& searchTerms)
    : m_scope(scope), m_searchTerms(searchTerms.Clone()) {}

nsMsgSearchAdapter::~nsMsgSearchAdapter() {}

NS_IMETHODIMP nsMsgSearchAdapter::ClearScope() {
  if (m_scope) {
    m_scope->CloseInputStream();
    m_scope = nullptr;
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchAdapter::ValidateTerms() {
  // all this used to do is check if the object had been deleted - we can skip
  // that.
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchAdapter::Search(bool* aDone) { return NS_OK; }

/* void CurrentUrlDone (in nsresult exitCode); */
NS_IMETHODIMP nsMsgSearchAdapter::CurrentUrlDone(nsresult exitCode) {
  // base implementation doesn't need to do anything.
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchAdapter::GetEncoding(char** encoding) { return NS_OK; }

NS_IMETHODIMP nsMsgSearchAdapter::AddResultElement(nsIMsgDBHdr* pHeaders) {
  NS_ASSERTION(false, "shouldn't call this base class impl");
  return NS_ERROR_FAILURE;
}

NS_IMETHODIMP nsMsgSearchAdapter::AddHit(nsMsgKey key) {
  NS_ASSERTION(false, "shouldn't call this base class impl");
  return NS_ERROR_FAILURE;
}

nsresult nsMsgSearchAdapter::GetSearchCharset(nsAString& dstCharset) {
  nsresult rv;
  dstCharset.Assign(u"UTF-8"_ns);

  if (m_scope) {
    nsCOMPtr<nsIMsgFolder> folder;
    rv = m_scope->GetFolder(getter_AddRefs(folder));
    if (NS_SUCCEEDED(rv) && folder) {
      nsCOMPtr<nsIMsgNewsFolder> newsfolder(do_QueryInterface(folder));
      if (newsfolder) {
        nsCString folderCharset;
        rv = newsfolder->GetCharset(folderCharset);
        if (NS_SUCCEEDED(rv))
          dstCharset.Assign(NS_ConvertASCIItoUTF16(folderCharset));
      }
    }
  }

  if (Preferences::GetBool("mailnews.force_ascii_search")) {
    // Special cases to use in order to force US-ASCII searching with Latin1
    // or MacRoman text. Eurgh. This only has to happen because IMAP
    // and Dredd servers currently (4/23/97) only support US-ASCII.
    //
    // If the dest csid is ISO Latin 1 or MacRoman, attempt to convert the
    // source text to US-ASCII. (Not for now.)
    // if ((dst_csid == CS_LATIN1) || (dst_csid == CS_MAC_ROMAN))
    dstCharset.AssignLiteral("us-ascii");
  }

  return NS_OK;
}

nsresult nsMsgSearchAdapter::EncodeImapTerm(nsIMsgSearchTerm* term,
                                            const char16_t* srcCharset,
                                            const char16_t* destCharset,
                                            char** ppOutTerm) {
  NS_ENSURE_ARG_POINTER(term);
  NS_ENSURE_ARG_POINTER(ppOutTerm);

  nsresult err = NS_OK;
  bool useNot = false;
  bool useQuotes = false;
  bool ignoreValue = false;
  nsAutoCString arbitraryHeader;
  const char* whichMnemonic = nullptr;
  const char* orHeaderMnemonic = nullptr;

  *ppOutTerm = nullptr;

  nsCOMPtr<nsIMsgSearchValue> searchValue;
  nsresult rv = term->GetValue(getter_AddRefs(searchValue));

  NS_ENSURE_SUCCESS(rv, rv);

  nsMsgSearchOpValue op;
  term->GetOp(&op);

  if (op == nsMsgSearchOp::DoesntContain || op == nsMsgSearchOp::Isnt)
    useNot = true;

  nsMsgSearchAttribValue attrib;
  term->GetAttrib(&attrib);

  switch (attrib) {
    case nsMsgSearchAttrib::ToOrCC:
      orHeaderMnemonic = m_kImapCC;
      // fall through to case nsMsgSearchAttrib::To:
      [[fallthrough]];
    case nsMsgSearchAttrib::To:
      whichMnemonic = m_kImapTo;
      break;
    case nsMsgSearchAttrib::CC:
      whichMnemonic = m_kImapCC;
      break;
    case nsMsgSearchAttrib::Sender:
      whichMnemonic = m_kImapFrom;
      break;
    case nsMsgSearchAttrib::Subject:
      whichMnemonic = m_kImapSubject;
      break;
    case nsMsgSearchAttrib::Body:
      whichMnemonic = m_kImapBody;
      break;
    case nsMsgSearchAttrib::AgeInDays:  // added for searching online for age in
                                        // days...
      // for AgeInDays, we are actually going to perform a search by date, so
      // convert the operations for age to the IMAP mnemonics that we would use
      // for date!
      {
        // If we have a future date, the > and < are reversed.
        // e.g. ageInDays > 2 means more than 2 days old ("date before X")
        // whereas
        //      ageInDays > -2 should be more than 2 days in the future ("date
        //      after X")
        int32_t ageInDays;
        searchValue->GetAge(&ageInDays);
        bool dateInFuture = (ageInDays < 0);
        switch (op) {
          case nsMsgSearchOp::IsGreaterThan:
            whichMnemonic = (!dateInFuture) ? m_kImapBefore : m_kImapSince;
            break;
          case nsMsgSearchOp::IsLessThan:
            whichMnemonic = (!dateInFuture) ? m_kImapSince : m_kImapBefore;
            break;
          case nsMsgSearchOp::Is:
            whichMnemonic = m_kImapSentOn;
            break;
          default:
            NS_ASSERTION(false, "invalid search operator");
            return NS_ERROR_INVALID_ARG;
        }
      }
      break;
    case nsMsgSearchAttrib::Size:
      switch (op) {
        case nsMsgSearchOp::IsGreaterThan:
          whichMnemonic = m_kImapSizeLarger;
          break;
        case nsMsgSearchOp::IsLessThan:
          whichMnemonic = m_kImapSizeSmaller;
          break;
        default:
          NS_ASSERTION(false, "invalid search operator");
          return NS_ERROR_INVALID_ARG;
      }
      break;
    case nsMsgSearchAttrib::Date:
      switch (op) {
        case nsMsgSearchOp::IsBefore:
          whichMnemonic = m_kImapBefore;
          break;
        case nsMsgSearchOp::IsAfter:
          whichMnemonic = m_kImapSince;
          break;
        case nsMsgSearchOp::Isnt: /* we've already added the "Not" so just
                                     process it like it was a date is search */
        case nsMsgSearchOp::Is:
          whichMnemonic = m_kImapSentOn;
          break;
        default:
          NS_ASSERTION(false, "invalid search operator");
          return NS_ERROR_INVALID_ARG;
      }
      break;
    case nsMsgSearchAttrib::AnyText:
      whichMnemonic = m_kImapAnyText;
      break;
    case nsMsgSearchAttrib::Keywords:
      whichMnemonic = m_kImapKeyword;
      break;
    case nsMsgSearchAttrib::MsgStatus:
      useNot = false;      // bizarrely, NOT SEEN is wrong, but UNSEEN is right.
      ignoreValue = true;  // the mnemonic is all we need
      uint32_t status;
      searchValue->GetStatus(&status);

      switch (status) {
        case nsMsgMessageFlags::Read:
          whichMnemonic =
              op == nsMsgSearchOp::Is ? m_kImapSeen : m_kImapNotSeen;
          break;
        case nsMsgMessageFlags::Replied:
          whichMnemonic =
              op == nsMsgSearchOp::Is ? m_kImapAnswered : m_kImapNotAnswered;
          break;
        case nsMsgMessageFlags::New:
          whichMnemonic = op == nsMsgSearchOp::Is ? m_kImapNew : m_kImapNotNew;
          break;
        case nsMsgMessageFlags::Marked:
          whichMnemonic =
              op == nsMsgSearchOp::Is ? m_kImapFlagged : m_kImapNotFlagged;
          break;
        default:
          NS_ASSERTION(false, "invalid search operator");
          return NS_ERROR_INVALID_ARG;
      }
      break;
    default:
      if (attrib > nsMsgSearchAttrib::OtherHeader &&
          attrib < nsMsgSearchAttrib::kNumMsgSearchAttributes) {
        nsCString arbitraryHeaderTerm;
        term->GetArbitraryHeader(arbitraryHeaderTerm);
        if (!arbitraryHeaderTerm.IsEmpty()) {
          arbitraryHeader.AssignLiteral(" \"");
          arbitraryHeader.Append(arbitraryHeaderTerm);
          arbitraryHeader.AppendLiteral("\" ");
          whichMnemonic = arbitraryHeader.get();
        } else
          return NS_ERROR_FAILURE;
      } else {
        NS_ASSERTION(false, "invalid search operator");
        return NS_ERROR_INVALID_ARG;
      }
  }

  char* value = nullptr;
  char dateBuf[100];
  dateBuf[0] = '\0';

  bool valueWasAllocated = false;
  if (attrib == nsMsgSearchAttrib::Date) {
    // note that there used to be code here that encoded an RFC822 date for imap
    // searches. The IMAP RFC 2060 is misleading to the point that it looks like
    // it requires an RFC822 date but really it expects dd-mmm-yyyy, like dredd,
    // and refers to the RFC822 date only in that the dd-mmm-yyyy date will
    // match the RFC822 date within the message.

    PRTime adjustedDate;
    searchValue->GetDate(&adjustedDate);
    if (whichMnemonic == m_kImapSince) {
      // it looks like the IMAP server searches on Since includes the date in
      // question... our UI presents Is, IsGreater and IsLessThan. For the
      // IsGreater case (m_kImapSince) we need to adjust the date so we get
      // greater than and not greater than or equal to which is what the IMAP
      // server wants to search on won't work on Mac.
      adjustedDate += PR_USEC_PER_DAY;
    }

    PRExplodedTime exploded;
    PR_ExplodeTime(adjustedDate, PR_LocalTimeParameters, &exploded);
    PR_FormatTimeUSEnglish(dateBuf, sizeof(dateBuf), "%d-%b-%Y", &exploded);
    //    strftime (dateBuf, sizeof(dateBuf), "%d-%b-%Y", localtime (/*
    //    &term->m_value.u.date */ &adjustedDate));
    value = dateBuf;
  } else {
    if (attrib == nsMsgSearchAttrib::AgeInDays) {
      // okay, take the current date, subtract off the age in days, then do an
      // appropriate Date search on the resulting day.
      int32_t ageInDays;

      searchValue->GetAge(&ageInDays);

      PRTime now = PR_Now();
      PRTime matchDay = now - ageInDays * PR_USEC_PER_DAY;

      PRExplodedTime exploded;
      PR_ExplodeTime(matchDay, PR_LocalTimeParameters, &exploded);
      PR_FormatTimeUSEnglish(dateBuf, sizeof(dateBuf), "%d-%b-%Y", &exploded);
      //      strftime (dateBuf, sizeof(dateBuf), "%d-%b-%Y", localtime
      //      (&matchDay));
      value = dateBuf;
    } else if (attrib == nsMsgSearchAttrib::Size) {
      uint32_t sizeValue;
      nsAutoCString searchTermValue;
      searchValue->GetSize(&sizeValue);

      // Multiply by 1024 to get into kb resolution
      sizeValue *= 1024;

      // Ensure that greater than is really greater than
      // in kb resolution.
      if (op == nsMsgSearchOp::IsGreaterThan) sizeValue += 1024;

      searchTermValue.AppendInt(sizeValue);

      value = ToNewCString(searchTermValue);
      valueWasAllocated = true;
    } else if (IS_STRING_ATTRIBUTE(attrib)) {
      nsString searchTermValue;
      searchValue->GetStr(searchTermValue);

      useQuotes = (attrib != nsMsgSearchAttrib::Keywords);
      // now convert to char* and escape quoted_specials
      nsAutoCString valueStr;
      nsresult rv = nsMsgI18NConvertFromUnicode(
          NS_LossyConvertUTF16toASCII(destCharset), searchTermValue, valueStr);
      if (NS_SUCCEEDED(rv)) {
        const char* vptr = valueStr.get();
        // max escaped length is one extra character for every character in the
        // cmd.
        mozilla::UniquePtr<char[]> newValue =
            mozilla::MakeUnique<char[]>(2 * strlen(vptr) + 1);
        if (newValue) {
          char* p = newValue.get();
          while (1) {
            char ch = *vptr++;
            if (!ch) break;
            if ((useQuotes ? ch == '"' : 0) || ch == '\\') *p++ = '\\';
            *p++ = ch;
          }
          *p = '\0';
          value = strdup(newValue.get());  // realloc down to smaller size
        }
      } else
        value = strdup("");
      valueWasAllocated = true;
    }
  }

  // this should be rewritten to use nsCString
  int subLen = (value ? strlen(value) : 0) + (useNot ? strlen(m_kImapNot) : 0) +
               strlen(m_kImapHeader);
  int len =
      strlen(whichMnemonic) + subLen + (useQuotes ? 2 : 0) +
      (orHeaderMnemonic
           ? (subLen + strlen(m_kImapOr) + strlen(orHeaderMnemonic) + 2 /*""*/)
           : 0) +
      10;  // add slough for imap string literals
  char* encoding = new char[len];
  if (encoding) {
    encoding[0] = '\0';
    // Remember: if ToOrCC and useNot then the expression becomes NOT To AND Not
    // CC as opposed to (NOT TO) || (NOT CC)
    if (orHeaderMnemonic && !useNot) PL_strcat(encoding, m_kImapOr);
    if (useNot) PL_strcat(encoding, m_kImapNot);
    if (!arbitraryHeader.IsEmpty()) PL_strcat(encoding, m_kImapHeader);
    PL_strcat(encoding, whichMnemonic);
    if (!ignoreValue) err = EncodeImapValue(encoding, value, useQuotes);

    if (orHeaderMnemonic) {
      if (useNot) PL_strcat(encoding, m_kImapNot);

      PL_strcat(encoding, m_kImapHeader);

      PL_strcat(encoding, orHeaderMnemonic);
      if (!ignoreValue) err = EncodeImapValue(encoding, value, useQuotes);
    }

    // kmcentee, don't let the encoding end with whitespace,
    // this throws off later url STRCMP
    if (*encoding && *(encoding + strlen(encoding) - 1) == ' ')
      *(encoding + strlen(encoding) - 1) = '\0';
  }

  if (value && valueWasAllocated) free(value);

  *ppOutTerm = encoding;

  return err;
}

nsresult nsMsgSearchAdapter::EncodeImapValue(char* encoding, const char* value,
                                             bool useQuotes) {
  // By IMAP RFC, SEARCH HEADER SUBJECT "" is illegal and will generate an
  // error from the server
  if (!value || !value[0]) return NS_ERROR_NULL_POINTER;

  if (!NS_IsAscii(value)) {
    nsAutoCString lengthStr;
    PL_strcat(encoding, "{");
    lengthStr.AppendInt((int32_t)strlen(value));
    PL_strcat(encoding, lengthStr.get());
    PL_strcat(encoding, "}" CRLF);
    PL_strcat(encoding, value);
    return NS_OK;
  }
  if (useQuotes) PL_strcat(encoding, "\"");
  PL_strcat(encoding, value);
  if (useQuotes) PL_strcat(encoding, "\"");

  return NS_OK;
}

nsresult nsMsgSearchAdapter::EncodeImap(
    char** ppOutEncoding, nsTArray<RefPtr<nsIMsgSearchTerm>> const& searchTerms,
    const char16_t* srcCharset, const char16_t* destCharset) {
  // i've left the old code (before using CBoolExpression for debugging purposes
  // to make sure that the new code generates the same encoding string as the
  // old code.....

  nsresult err = NS_OK;
  *ppOutEncoding = nullptr;

  // create our expression
  nsMsgSearchBoolExpression* expression = new nsMsgSearchBoolExpression();
  if (!expression) return NS_ERROR_OUT_OF_MEMORY;

  for (nsIMsgSearchTerm* pTerm : searchTerms) {
    bool matchAll;
    pTerm->GetMatchAll(&matchAll);
    if (matchAll) continue;
    char* termEncoding;
    err = EncodeImapTerm(pTerm, srcCharset, destCharset, &termEncoding);
    if (NS_SUCCEEDED(err) && nullptr != termEncoding) {
      expression = nsMsgSearchBoolExpression::AddSearchTerm(expression, pTerm,
                                                            termEncoding);
      delete[] termEncoding;
    } else {
      delete[] termEncoding;
      break;
    }
  }

  if (NS_SUCCEEDED(err)) {
    // Catenate the intermediate encodings together into a big string
    nsAutoCString encodingBuff;
    encodingBuff.Append(m_kImapUnDeleted);

    expression->GenerateEncodeStr(&encodingBuff);
    *ppOutEncoding = ToNewCString(encodingBuff);
  }

  delete expression;

  return err;
}

//-----------------------------------------------------------------------------
//------------------- Validity checking for menu items etc. -------------------
//-----------------------------------------------------------------------------

nsMsgSearchValidityTable::nsMsgSearchValidityTable() {
  // Set everything to be unavailable and disabled
  for (int i = 0; i < nsMsgSearchAttrib::kNumMsgSearchAttributes; i++)
    for (int j = 0; j < nsMsgSearchOp::kNumMsgSearchOperators; j++) {
      SetAvailable(i, j, false);
      SetEnabled(i, j, false);
      SetValidButNotShown(i, j, false);
    }
  m_numAvailAttribs =
      0;  // # of attributes marked with at least one available operator
  // assume default is Subject, which it is for mail and news search
  // it's not for LDAP, so we'll call SetDefaultAttrib()
  m_defaultAttrib = nsMsgSearchAttrib::Subject;
}

NS_IMPL_ISUPPORTS(nsMsgSearchValidityTable, nsIMsgSearchValidityTable)

nsresult nsMsgSearchValidityTable::GetNumAvailAttribs(int32_t* aResult) {
  m_numAvailAttribs = 0;
  for (int i = 0; i < nsMsgSearchAttrib::kNumMsgSearchAttributes; i++)
    for (int j = 0; j < nsMsgSearchOp::kNumMsgSearchOperators; j++) {
      bool available;
      GetAvailable(i, j, &available);
      if (available) {
        m_numAvailAttribs++;
        break;
      }
    }
  *aResult = m_numAvailAttribs;
  return NS_OK;
}

nsresult nsMsgSearchValidityTable::GetAvailableAttributes(
    nsTArray<nsMsgSearchAttribValue>& aResult) {
  aResult.Clear();
  int32_t i, j;
  for (i = 0; i < nsMsgSearchAttrib::kNumMsgSearchAttributes; i++) {
    for (j = 0; j < nsMsgSearchOp::kNumMsgSearchOperators; j++) {
      if (m_table[i][j].bitAvailable) {
        aResult.AppendElement(static_cast<nsMsgSearchAttribValue>(i));
        break;
      }
    }
  }
  return NS_OK;
}

nsresult nsMsgSearchValidityTable::GetAvailableOperators(
    nsMsgSearchAttribValue aAttribute, nsTArray<nsMsgSearchOpValue>& aResult) {
  aResult.Clear();

  nsMsgSearchAttribValue attr;
  if (aAttribute == nsMsgSearchAttrib::Default)
    attr = m_defaultAttrib;
  else
    attr = std::min(aAttribute,
                    (nsMsgSearchAttribValue)nsMsgSearchAttrib::OtherHeader);

  int32_t i;
  for (i = 0; i < nsMsgSearchOp::kNumMsgSearchOperators; i++) {
    if (m_table[attr][i].bitAvailable) {
      aResult.AppendElement(static_cast<nsMsgSearchOpValue>(i));
    }
  }
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchValidityTable::SetDefaultAttrib(nsMsgSearchAttribValue aAttribute) {
  m_defaultAttrib = aAttribute;
  return NS_OK;
}

nsMsgSearchValidityManager::nsMsgSearchValidityManager() {}

nsMsgSearchValidityManager::~nsMsgSearchValidityManager() {
  // tables released by nsCOMPtr
}

NS_IMPL_ISUPPORTS(nsMsgSearchValidityManager, nsIMsgSearchValidityManager)

//-----------------------------------------------------------------------------
// Bottleneck accesses to the objects so we can allocate and initialize them
// lazily. This way, there's no heap overhead for the validity tables until the
// user actually searches that scope.
//-----------------------------------------------------------------------------

NS_IMETHODIMP nsMsgSearchValidityManager::GetTable(
    int whichTable, nsIMsgSearchValidityTable** ppOutTable) {
  NS_ENSURE_ARG_POINTER(ppOutTable);

  nsresult rv = NS_OK;
  *ppOutTable = nullptr;

  nsCString customHeaders;
  Preferences::GetCString(PREF_CUSTOM_HEADERS, customHeaders);

  switch (whichTable) {
    case nsMsgSearchScope::offlineMail:
      if (!m_offlineMailTable) rv = InitOfflineMailTable();
      if (m_offlineMailTable)
        rv = SetOtherHeadersInTable(m_offlineMailTable, customHeaders.get());
      *ppOutTable = m_offlineMailTable;
      break;
    case nsMsgSearchScope::offlineMailFilter:
      if (!m_offlineMailFilterTable) rv = InitOfflineMailFilterTable();
      if (m_offlineMailFilterTable)
        rv = SetOtherHeadersInTable(m_offlineMailFilterTable,
                                    customHeaders.get());
      *ppOutTable = m_offlineMailFilterTable;
      break;
    case nsMsgSearchScope::onlineMail:
      if (!m_onlineMailTable) rv = InitOnlineMailTable();
      if (m_onlineMailTable)
        rv = SetOtherHeadersInTable(m_onlineMailTable, customHeaders.get());
      *ppOutTable = m_onlineMailTable;
      break;
    case nsMsgSearchScope::onlineMailFilter:
      if (!m_onlineMailFilterTable) rv = InitOnlineMailFilterTable();
      if (m_onlineMailFilterTable)
        rv = SetOtherHeadersInTable(m_onlineMailFilterTable,
                                    customHeaders.get());
      *ppOutTable = m_onlineMailFilterTable;
      break;
    case nsMsgSearchScope::news:
      if (!m_newsTable) rv = InitNewsTable();
      if (m_newsTable)
        rv = SetOtherHeadersInTable(m_newsTable, customHeaders.get());
      *ppOutTable = m_newsTable;
      break;
    case nsMsgSearchScope::newsFilter:
      if (!m_newsFilterTable) rv = InitNewsFilterTable();
      if (m_newsFilterTable)
        rv = SetOtherHeadersInTable(m_newsFilterTable, customHeaders.get());
      *ppOutTable = m_newsFilterTable;
      break;
    case nsMsgSearchScope::localNews:
      if (!m_localNewsTable) rv = InitLocalNewsTable();
      if (m_localNewsTable)
        rv = SetOtherHeadersInTable(m_localNewsTable, customHeaders.get());
      *ppOutTable = m_localNewsTable;
      break;
    case nsMsgSearchScope::localNewsJunk:
      if (!m_localNewsJunkTable) rv = InitLocalNewsJunkTable();
      if (m_localNewsJunkTable)
        rv = SetOtherHeadersInTable(m_localNewsJunkTable, customHeaders.get());
      *ppOutTable = m_localNewsJunkTable;
      break;
    case nsMsgSearchScope::localNewsBody:
      if (!m_localNewsBodyTable) rv = InitLocalNewsBodyTable();
      if (m_localNewsBodyTable)
        rv = SetOtherHeadersInTable(m_localNewsBodyTable, customHeaders.get());
      *ppOutTable = m_localNewsBodyTable;
      break;
    case nsMsgSearchScope::localNewsJunkBody:
      if (!m_localNewsJunkBodyTable) rv = InitLocalNewsJunkBodyTable();
      if (m_localNewsJunkBodyTable)
        rv = SetOtherHeadersInTable(m_localNewsJunkBodyTable,
                                    customHeaders.get());
      *ppOutTable = m_localNewsJunkBodyTable;
      break;

    case nsMsgSearchScope::onlineManual:
      if (!m_onlineManualFilterTable) rv = InitOnlineManualFilterTable();
      if (m_onlineManualFilterTable)
        rv = SetOtherHeadersInTable(m_onlineManualFilterTable,
                                    customHeaders.get());
      *ppOutTable = m_onlineManualFilterTable;
      break;
    case nsMsgSearchScope::LDAP:
      if (!m_ldapTable) rv = InitLdapTable();
      *ppOutTable = m_ldapTable;
      break;
    case nsMsgSearchScope::LDAPAnd:
      if (!m_ldapAndTable) rv = InitLdapAndTable();
      *ppOutTable = m_ldapAndTable;
      break;
    case nsMsgSearchScope::LocalAB:
      if (!m_localABTable) rv = InitLocalABTable();
      *ppOutTable = m_localABTable;
      break;
    case nsMsgSearchScope::LocalABAnd:
      if (!m_localABAndTable) rv = InitLocalABAndTable();
      *ppOutTable = m_localABAndTable;
      break;
    default:
      NS_ASSERTION(false, "invalid table type");
      rv = NS_MSG_ERROR_INVALID_SEARCH_TERM;
  }

  NS_IF_ADDREF(*ppOutTable);  // Was populated from member variable.
  return rv;
}

// mapping between ordered attribute values, and property strings
// see search-attributes.properties
static struct {
  nsMsgSearchAttribValue id;
  const char* property;
} nsMsgSearchAttribMap[] = {
    {nsMsgSearchAttrib::Subject, "Subject"},
    {nsMsgSearchAttrib::Sender, "From"},
    {nsMsgSearchAttrib::Body, "Body"},
    {nsMsgSearchAttrib::Date, "Date"},
    {nsMsgSearchAttrib::Priority, "Priority"},
    {nsMsgSearchAttrib::MsgStatus, "Status"},
    {nsMsgSearchAttrib::To, "To"},
    {nsMsgSearchAttrib::CC, "Cc"},
    {nsMsgSearchAttrib::ToOrCC, "ToOrCc"},
    {nsMsgSearchAttrib::AgeInDays, "AgeInDays"},
    {nsMsgSearchAttrib::Size, "SizeKB"},
    {nsMsgSearchAttrib::Keywords, "Tags"},
    {nsMsgSearchAttrib::Name, "AnyName"},
    {nsMsgSearchAttrib::DisplayName, "DisplayName"},
    {nsMsgSearchAttrib::Nickname, "Nickname"},
    {nsMsgSearchAttrib::ScreenName, "ScreenName"},
    {nsMsgSearchAttrib::Email, "Email"},
    {nsMsgSearchAttrib::AdditionalEmail, "AdditionalEmail"},
    {nsMsgSearchAttrib::PhoneNumber, "AnyNumber"},
    {nsMsgSearchAttrib::WorkPhone, "WorkPhone"},
    {nsMsgSearchAttrib::HomePhone, "HomePhone"},
    {nsMsgSearchAttrib::Fax, "Fax"},
    {nsMsgSearchAttrib::Pager, "Pager"},
    {nsMsgSearchAttrib::Mobile, "Mobile"},
    {nsMsgSearchAttrib::City, "City"},
    {nsMsgSearchAttrib::Street, "Street"},
    {nsMsgSearchAttrib::Title, "Title"},
    {nsMsgSearchAttrib::Organization, "Organization"},
    {nsMsgSearchAttrib::Department, "Department"},
    {nsMsgSearchAttrib::AllAddresses, "FromToCcOrBcc"},
    {nsMsgSearchAttrib::JunkScoreOrigin, "JunkScoreOrigin"},
    {nsMsgSearchAttrib::JunkPercent, "JunkPercent"},
    {nsMsgSearchAttrib::HasAttachmentStatus, "AttachmentStatus"},
    {nsMsgSearchAttrib::JunkStatus, "JunkStatus"},
    {nsMsgSearchAttrib::OtherHeader, "Customize"},
    // the last id is -1 to denote end of table
    {-1, ""}};

NS_IMETHODIMP
nsMsgSearchValidityManager::GetAttributeProperty(
    nsMsgSearchAttribValue aSearchAttribute, nsAString& aProperty) {
  for (int32_t i = 0; nsMsgSearchAttribMap[i].id >= 0; ++i) {
    if (nsMsgSearchAttribMap[i].id == aSearchAttribute) {
      aProperty.Assign(NS_ConvertUTF8toUTF16(nsMsgSearchAttribMap[i].property));
      return NS_OK;
    }
  }
  return NS_ERROR_FAILURE;
}

nsresult nsMsgSearchValidityManager::NewTable(
    nsIMsgSearchValidityTable** aTable) {
  NS_ENSURE_ARG_POINTER(aTable);
  NS_ADDREF(*aTable = new nsMsgSearchValidityTable);
  return NS_OK;
}

nsresult nsMsgSearchValidityManager::SetOtherHeadersInTable(
    nsIMsgSearchValidityTable* aTable, const char* customHeaders) {
  uint32_t customHeadersLength = strlen(customHeaders);
  uint32_t numHeaders = 0;
  if (customHeadersLength) {
    nsAutoCString hdrStr(customHeaders);
    hdrStr.StripWhitespace();  // remove whitespace before parsing
    char* newStr = hdrStr.BeginWriting();
    char* token = NS_strtok(":", &newStr);
    while (token) {
      numHeaders++;
      token = NS_strtok(":", &newStr);
    }
  }

  NS_ASSERTION(nsMsgSearchAttrib::OtherHeader + numHeaders <
                   nsMsgSearchAttrib::kNumMsgSearchAttributes,
               "more headers than the table can hold");

  uint32_t maxHdrs =
      std::min(nsMsgSearchAttrib::OtherHeader + numHeaders + 1,
               (uint32_t)nsMsgSearchAttrib::kNumMsgSearchAttributes);
  for (uint32_t i = nsMsgSearchAttrib::OtherHeader + 1; i < maxHdrs; i++) {
    // clang-format off
    aTable->SetAvailable(i, nsMsgSearchOp::Contains, 1);  // added for arbitrary headers
    aTable->SetEnabled  (i, nsMsgSearchOp::Contains, 1);
    aTable->SetAvailable(i, nsMsgSearchOp::DoesntContain, 1);
    aTable->SetEnabled  (i, nsMsgSearchOp::DoesntContain, 1);
    aTable->SetAvailable(i, nsMsgSearchOp::Is, 1);
    aTable->SetEnabled  (i, nsMsgSearchOp::Is, 1);
    aTable->SetAvailable(i, nsMsgSearchOp::Isnt, 1);
    aTable->SetEnabled  (i, nsMsgSearchOp::Isnt, 1);
    // clang-format on
  }
  // because custom headers can change; so reset the table for those which are
  // no longer used.
  for (uint32_t j = maxHdrs; j < nsMsgSearchAttrib::kNumMsgSearchAttributes;
       j++) {
    for (uint32_t k = 0; k < nsMsgSearchOp::kNumMsgSearchOperators; k++) {
      aTable->SetAvailable(j, k, 0);
      aTable->SetEnabled(j, k, 0);
    }
  }
  return NS_OK;
}

nsresult nsMsgSearchValidityManager::EnableDirectoryAttribute(
    nsIMsgSearchValidityTable* table, nsMsgSearchAttribValue aSearchAttrib) {
  // clang-format off
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::Contains, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::Contains, 1);
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::DoesntContain, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::DoesntContain, 1);
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::Is, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::Is, 1);
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::Isnt, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::Isnt, 1);
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::BeginsWith, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::BeginsWith, 1);
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::EndsWith, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::EndsWith, 1);
  table->SetAvailable(aSearchAttrib, nsMsgSearchOp::SoundsLike, 1);
  table->SetEnabled  (aSearchAttrib, nsMsgSearchOp::SoundsLike, 1);
  // clang-format on
  return NS_OK;
}

nsresult nsMsgSearchValidityManager::InitLdapTable() {
  NS_ASSERTION(!m_ldapTable, "don't call this twice!");

  nsresult rv = NewTable(getter_AddRefs(m_ldapTable));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = SetUpABTable(m_ldapTable, true);
  NS_ENSURE_SUCCESS(rv, rv);
  return rv;
}

nsresult nsMsgSearchValidityManager::InitLdapAndTable() {
  NS_ASSERTION(!m_ldapAndTable, "don't call this twice!");

  nsresult rv = NewTable(getter_AddRefs(m_ldapAndTable));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = SetUpABTable(m_ldapAndTable, false);
  NS_ENSURE_SUCCESS(rv, rv);
  return rv;
}

nsresult nsMsgSearchValidityManager::InitLocalABTable() {
  NS_ASSERTION(!m_localABTable, "don't call this twice!");

  nsresult rv = NewTable(getter_AddRefs(m_localABTable));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = SetUpABTable(m_localABTable, true);
  NS_ENSURE_SUCCESS(rv, rv);
  return rv;
}

nsresult nsMsgSearchValidityManager::InitLocalABAndTable() {
  NS_ASSERTION(!m_localABAndTable, "don't call this twice!");

  nsresult rv = NewTable(getter_AddRefs(m_localABAndTable));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = SetUpABTable(m_localABAndTable, false);
  NS_ENSURE_SUCCESS(rv, rv);
  return rv;
}

nsresult nsMsgSearchValidityManager::SetUpABTable(
    nsIMsgSearchValidityTable* aTable, bool isOrTable) {
  nsresult rv = aTable->SetDefaultAttrib(
      isOrTable ? nsMsgSearchAttrib::Name : nsMsgSearchAttrib::DisplayName);
  NS_ENSURE_SUCCESS(rv, rv);

  if (isOrTable) {
    rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Name);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::PhoneNumber);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::DisplayName);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Email);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::AdditionalEmail);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::ScreenName);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Street);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::City);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Title);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Organization);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Department);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Nickname);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::WorkPhone);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::HomePhone);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Fax);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Pager);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableDirectoryAttribute(aTable, nsMsgSearchAttrib::Mobile);
  NS_ENSURE_SUCCESS(rv, rv);

  return rv;
}
