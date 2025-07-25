/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsImapUndoTxn.h"

#include "mozilla/Components.h"
#include "msgCore.h"  // for precompiled headers
#include "nsIMsgHdr.h"
#include "nsIMsgIncomingServer.h"
#include "nsImapCore.h"
#include "nsImapMailFolder.h"
#include "nsIImapService.h"
#include "nsIDBFolderInfo.h"
#include "nsIMsgDatabase.h"
#include "nsMsgUtils.h"
#include "nsServiceManagerUtils.h"

nsImapMoveCopyMsgTxn::nsImapMoveCopyMsgTxn()
    : m_idsAreUids(false), m_isMove(false), m_srcIsLocal(false) {}

nsresult nsImapMoveCopyMsgTxn::Init(nsIMsgFolder* srcFolder,
                                    nsTArray<nsMsgKey>* srcKeyArray,
                                    const char* srcMsgIdString,
                                    nsIMsgFolder* dstFolder, bool idsAreUids,
                                    bool isMove) {
  m_srcMsgIdString = srcMsgIdString;
  m_idsAreUids = idsAreUids;
  m_isMove = isMove;
  m_srcFolder = do_GetWeakReference(srcFolder);
  m_dstFolder = do_GetWeakReference(dstFolder);
  m_srcKeyArray = srcKeyArray->Clone();
  m_dupKeyArray = srcKeyArray->Clone();
  nsCString uri;
  nsresult rv = srcFolder->GetURI(uri);
  nsCString protocolType(uri);
  protocolType.SetLength(protocolType.FindChar(':'));
  nsCOMPtr<nsIMsgDatabase> srcDB;
  rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
  NS_ENSURE_SUCCESS(rv, rv);
  uint32_t i, count = m_srcKeyArray.Length();
  nsCOMPtr<nsIMsgDBHdr> srcHdr;
  nsCOMPtr<nsIMsgDBHdr> copySrcHdr;
  nsCString messageId;

  for (i = 0; i < count; i++) {
    rv = srcDB->GetMsgHdrForKey(m_srcKeyArray[i], getter_AddRefs(srcHdr));
    if (NS_SUCCEEDED(rv)) {
      // ** jt -- only do this for mailbox protocol
      if (protocolType.LowerCaseEqualsLiteral("mailbox")) {
        m_srcIsLocal = true;
        uint32_t msgSize;
        rv = srcHdr->GetMessageSize(&msgSize);
        if (NS_SUCCEEDED(rv)) m_srcSizeArray.AppendElement(msgSize);
        if (isMove) {
          // Copy the src msgHdrs, but don't add to the db.
          rv = srcDB->CopyHdrFromExistingHdr(nsMsgKey_None, srcHdr, false,
                                             getter_AddRefs(copySrcHdr));
          nsMsgKey pseudoKey = nsMsgKey_None;
          if (NS_SUCCEEDED(rv)) {
            copySrcHdr->GetMessageKey(&pseudoKey);
            m_srcHdrs.AppendObject(copySrcHdr);
          }
          m_dupKeyArray[i] = pseudoKey;
        }
      }
      srcHdr->GetMessageId(messageId);
      m_srcMessageIds.AppendElement(messageId);
    }
  }
  return NS_OK;
}

nsImapMoveCopyMsgTxn::~nsImapMoveCopyMsgTxn() {}

NS_IMPL_ISUPPORTS_INHERITED(nsImapMoveCopyMsgTxn, nsMsgTxn, nsIUrlListener)

NS_IMETHODIMP
nsImapMoveCopyMsgTxn::UndoTransaction(void) {
  nsresult rv;
  nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();

  bool finishInOnStopRunningUrl = false;

  if (m_isMove || !m_dstFolder) {
    if (m_srcIsLocal) {
      rv = UndoMailboxDelete();
      NS_ENSURE_SUCCESS(rv, rv);
    } else {
      nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
      if (NS_FAILED(rv) || !srcFolder) return rv;
      nsCOMPtr<nsIUrlListener> srcListener = do_QueryInterface(srcFolder, &rv);
      if (NS_FAILED(rv)) return rv;
      m_onStopListener = do_GetWeakReference(srcListener);

      // ** make sure we are in the selected state; use lite select
      // folder so we won't hit performance hard
      nsCOMPtr<nsIURI> outUri;
      rv = imapService->LiteSelectFolder(srcFolder, srcListener, nullptr,
                                         getter_AddRefs(outUri));
      if (NS_FAILED(rv)) return rv;
      bool deletedMsgs = true;  // default is true unless imapDelete model
      nsMsgImapDeleteModel deleteModel;
      rv = GetImapDeleteModel(srcFolder, &deleteModel);

      // protect against a bogus undo txn without any source keys
      // see bug #179856 for details
      NS_ASSERTION(!m_srcKeyArray.IsEmpty(), "no source keys");
      if (m_srcKeyArray.IsEmpty()) return NS_ERROR_UNEXPECTED;

      if (!m_srcMsgIdString.IsEmpty()) {
        if (NS_SUCCEEDED(rv) &&
            deleteModel == nsMsgImapDeleteModels::IMAPDelete)
          CheckForToggleDelete(srcFolder, m_srcKeyArray[0], &deletedMsgs);

        if (deletedMsgs)
          rv = imapService->SubtractMessageFlags(
              srcFolder, this, m_srcMsgIdString, kImapMsgDeletedFlag,
              m_idsAreUids);
        else
          rv = imapService->AddMessageFlags(srcFolder, srcListener,
                                            m_srcMsgIdString,
                                            kImapMsgDeletedFlag, m_idsAreUids);
        if (NS_FAILED(rv)) return rv;

        finishInOnStopRunningUrl = true;
        if (deleteModel != nsMsgImapDeleteModels::IMAPDelete)
          nsCOMPtr<nsIURI> outUri;
        rv = imapService->GetHeaders(srcFolder, srcListener,
                                     getter_AddRefs(outUri), m_srcMsgIdString,
                                     true);
      }
    }
  }
  if (!finishInOnStopRunningUrl && !m_dstMsgIdString.IsEmpty()) {
    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    if (NS_FAILED(rv) || !dstFolder) return rv;

    nsCOMPtr<nsIUrlListener> dstListener;

    dstListener = do_QueryInterface(dstFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    // ** make sure we are in the selected state; use lite select folder
    // so we won't potentially download a bunch of headers.
    nsCOMPtr<nsIURI> outUri;
    rv = imapService->LiteSelectFolder(dstFolder, dstListener, nullptr,
                                       getter_AddRefs(outUri));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = imapService->AddMessageFlags(dstFolder, dstListener, m_dstMsgIdString,
                                      kImapMsgDeletedFlag, m_idsAreUids);
  }
  return rv;
}

NS_IMETHODIMP
nsImapMoveCopyMsgTxn::RedoTransaction(void) {
  nsresult rv;
  nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();

  if (m_isMove || !m_dstFolder) {
    if (m_srcIsLocal) {
      rv = RedoMailboxDelete();
      if (NS_FAILED(rv)) return rv;
    } else if (!m_srcMsgIdString.IsEmpty()) {
      nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
      if (NS_FAILED(rv) || !srcFolder) return rv;
      nsCOMPtr<nsIUrlListener> srcListener = do_QueryInterface(srcFolder, &rv);
      NS_ENSURE_SUCCESS(rv, rv);

      bool deletedMsgs = false;  // default will be false unless
                                 // imapDeleteModel;
      nsMsgImapDeleteModel deleteModel;
      rv = GetImapDeleteModel(srcFolder, &deleteModel);

      // protect against a bogus undo txn without any source keys
      // see bug #179856 for details
      NS_ASSERTION(!m_srcKeyArray.IsEmpty(), "no source keys");
      if (m_srcKeyArray.IsEmpty()) return NS_ERROR_UNEXPECTED;

      if (NS_SUCCEEDED(rv) && deleteModel == nsMsgImapDeleteModels::IMAPDelete)
        rv = CheckForToggleDelete(srcFolder, m_srcKeyArray[0], &deletedMsgs);

      // Make sure we are in the selected state; use lite select
      // folder so performance won't suffer.
      nsCOMPtr<nsIURI> outUri;
      rv = imapService->LiteSelectFolder(srcFolder, srcListener, nullptr,
                                         getter_AddRefs(outUri));
      NS_ENSURE_SUCCESS(rv, rv);
      if (deletedMsgs) {
        rv = imapService->SubtractMessageFlags(
            srcFolder, srcListener, m_srcMsgIdString, kImapMsgDeletedFlag,
            m_idsAreUids);
      } else {
        rv = imapService->AddMessageFlags(srcFolder, srcListener,
                                          m_srcMsgIdString, kImapMsgDeletedFlag,
                                          m_idsAreUids);
      }
    }
  }
  if (!m_dstMsgIdString.IsEmpty()) {
    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    if (NS_FAILED(rv) || !dstFolder) return rv;

    nsCOMPtr<nsIUrlListener> dstListener;

    dstListener = do_QueryInterface(dstFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    // ** make sure we are in the selected state; use lite select
    // folder so we won't hit performance hard
    nsCOMPtr<nsIURI> outUri;
    rv = imapService->LiteSelectFolder(dstFolder, dstListener, nullptr,
                                       getter_AddRefs(outUri));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = imapService->SubtractMessageFlags(dstFolder, dstListener,
                                           m_dstMsgIdString,
                                           kImapMsgDeletedFlag, m_idsAreUids);
    NS_ENSURE_SUCCESS(rv, rv);
    nsMsgImapDeleteModel deleteModel;
    rv = GetImapDeleteModel(dstFolder, &deleteModel);
    if (NS_FAILED(rv) || deleteModel == nsMsgImapDeleteModels::MoveToTrash) {
      rv = imapService->GetHeaders(dstFolder, dstListener, nullptr,
                                   m_dstMsgIdString, true);
    }
  }
  return rv;
}

nsresult nsImapMoveCopyMsgTxn::SetCopyResponseUid(const char* aMsgIdString) {
  if (!aMsgIdString) return NS_ERROR_NULL_POINTER;
  m_dstMsgIdString = aMsgIdString;
  if (m_dstMsgIdString.Last() == ']') {
    int32_t len = m_dstMsgIdString.Length();
    m_dstMsgIdString.SetLength(len - 1);
  }
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::GetSrcKeyArray(nsTArray<nsMsgKey>& srcKeyArray) {
  srcKeyArray = m_srcKeyArray.Clone();
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::AddDstKey(nsMsgKey aKey) {
  if (!m_dstMsgIdString.IsEmpty()) m_dstMsgIdString.Append(',');
  m_dstMsgIdString.AppendInt((int32_t)aKey);
  return NS_OK;
}

nsresult nsImapMoveCopyMsgTxn::UndoMailboxDelete() {
  nsresult rv = NS_ERROR_FAILURE;
  // ** jt -- only do this for mailbox protocol
  if (m_srcIsLocal) {
    nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
    if (NS_FAILED(rv) || !srcFolder) return rv;

    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    if (NS_FAILED(rv) || !dstFolder) return rv;

    nsCOMPtr<nsIMsgDatabase> srcDB;
    nsCOMPtr<nsIMsgDatabase> dstDB;
    rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
    if (NS_FAILED(rv)) return rv;
    rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
    if (NS_FAILED(rv)) return rv;

    uint32_t count = m_srcKeyArray.Length();
    uint32_t i;
    nsCOMPtr<nsIMsgDBHdr> oldHdr;
    nsCOMPtr<nsIMsgDBHdr> newHdr;
    for (i = 0; i < count; i++) {
      oldHdr = m_srcHdrs[i];
      NS_ASSERTION(oldHdr, "fatal ... cannot get old msg header");
      rv = srcDB->CopyHdrFromExistingHdr(m_srcKeyArray[i], oldHdr, true,
                                         getter_AddRefs(newHdr));
      NS_ASSERTION(newHdr, "fatal ... cannot create new header");

      if (NS_SUCCEEDED(rv) && newHdr) {
        if (i < m_srcSizeArray.Length())
          newHdr->SetMessageSize(m_srcSizeArray[i]);
        srcDB->UndoDelete(newHdr);
      }
    }
    srcDB->SetSummaryValid(true);
    return NS_OK;  // always return NS_OK
  }
  return NS_ERROR_FAILURE;
}

nsresult nsImapMoveCopyMsgTxn::RedoMailboxDelete() {
  nsresult rv = NS_ERROR_FAILURE;
  if (m_srcIsLocal) {
    nsCOMPtr<nsIMsgDatabase> srcDB;
    nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
    if (NS_FAILED(rv) || !srcFolder) return rv;
    rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
    if (NS_SUCCEEDED(rv)) {
      srcDB->DeleteMessages(m_srcKeyArray, nullptr);
      srcDB->SetSummaryValid(true);
    }
    return NS_OK;  // always return NS_OK
  }
  return NS_ERROR_FAILURE;
}

nsresult nsImapMoveCopyMsgTxn::GetImapDeleteModel(
    nsIMsgFolder* aFolder, nsMsgImapDeleteModel* aDeleteModel) {
  nsresult rv;
  nsCOMPtr<nsIMsgIncomingServer> server;
  if (!aFolder) return NS_ERROR_NULL_POINTER;
  rv = aFolder->GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIImapIncomingServer> imapServer = do_QueryInterface(server, &rv);
  if (NS_SUCCEEDED(rv) && imapServer)
    rv = imapServer->GetDeleteModel(aDeleteModel);
  return rv;
}

NS_IMETHODIMP nsImapMoveCopyMsgTxn::OnStartRunningUrl(nsIURI* aUrl) {
  return NS_OK;
}

NS_IMETHODIMP nsImapMoveCopyMsgTxn::OnStopRunningUrl(nsIURI* aUrl,
                                                     nsresult aExitCode) {
  nsCOMPtr<nsIUrlListener> urlListener = do_QueryReferent(m_onStopListener);
  if (urlListener) urlListener->OnStopRunningUrl(aUrl, aExitCode);

  nsCOMPtr<nsIImapUrl> imapUrl = do_QueryInterface(aUrl);
  if (imapUrl) {
    nsresult rv;
    nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();
    nsImapAction imapAction;
    imapUrl->GetImapAction(&imapAction);
    nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
    NS_ENSURE_SUCCESS(rv, rv);
    if (imapAction == nsIImapUrl::nsImapSubtractMsgFlags) {
      int32_t extraStatus;
      imapUrl->GetExtraStatus(&extraStatus);
      if (extraStatus != nsIImapUrl::ImapStatusNone) {
        // If subtracting the deleted flag didn't work, try
        // moving the message back from the target folder to the src folder
        if (!m_dstMsgIdString.IsEmpty())
          imapService->OnlineMessageCopy(dstFolder, m_dstMsgIdString, srcFolder,
                                         true, true, nullptr, /* listener */
                                         nullptr, nullptr, nullptr);
        else {
          // server doesn't support COPYUID, so we're going to update the dest
          // folder, and when that's done, use the db to find the messages
          // to move back, looking them up by message-id.
          nsCOMPtr<nsIMsgImapMailFolder> imapDest =
              do_QueryInterface(dstFolder);
          if (imapDest) imapDest->UpdateFolderWithListener(nullptr, this);
        }
      } else if (!m_dstMsgIdString.IsEmpty()) {
        nsCOMPtr<nsIUrlListener> dstListener;

        dstListener = do_QueryInterface(dstFolder, &rv);
        NS_ENSURE_SUCCESS(rv, rv);
        // ** make sure we are in the selected state; use lite select folder
        // so we won't potentially download a bunch of headers.
        nsCOMPtr<nsIURI> outUri;
        rv = imapService->LiteSelectFolder(dstFolder, dstListener, nullptr,
                                           getter_AddRefs(outUri));
        NS_ENSURE_SUCCESS(rv, rv);
        rv = imapService->AddMessageFlags(dstFolder, dstListener,
                                          m_dstMsgIdString, kImapMsgDeletedFlag,
                                          m_idsAreUids);
      }
    } else if (imapAction == nsIImapUrl::nsImapSelectFolder) {
      // Now we should have the headers from the dest folder.
      // Look them up and move them back to the source folder.
      uint32_t count = m_srcMessageIds.Length();
      uint32_t i;
      nsCString messageId;
      nsTArray<nsMsgKey> dstKeys;
      nsCOMPtr<nsIMsgDatabase> destDB;
      nsCOMPtr<nsIMsgDBHdr> dstHdr;

      rv = dstFolder->GetMsgDatabase(getter_AddRefs(destDB));
      NS_ENSURE_SUCCESS(rv, rv);
      for (i = 0; i < count; i++) {
        rv = destDB->GetMsgHdrForMessageID(m_srcMessageIds[i].get(),
                                           getter_AddRefs(dstHdr));
        if (NS_SUCCEEDED(rv) && dstHdr) {
          nsMsgKey dstKey;
          dstHdr->GetMessageKey(&dstKey);
          dstKeys.AppendElement(dstKey);
        }
      }
      if (dstKeys.Length()) {
        nsAutoCString uids;
        nsImapMailFolder::AllocateUidStringFromKeys(dstKeys, uids);
        rv = imapService->OnlineMessageCopy(dstFolder, uids, srcFolder, true,
                                            true, nullptr, nullptr, nullptr,
                                            nullptr);
      }
    }
  }
  return NS_OK;
}

nsImapOfflineTxn::nsImapOfflineTxn(nsIMsgFolder* srcFolder,
                                   nsTArray<nsMsgKey>* srcKeyArray,
                                   const char* srcMsgIdString,
                                   nsIMsgFolder* dstFolder, bool isMove,
                                   nsOfflineImapOperationType opType,
                                   nsCOMArray<nsIMsgDBHdr>& srcHdrs) {
  Init(srcFolder, srcKeyArray, srcMsgIdString, dstFolder, true, isMove);

  m_opType = opType;
  m_flags = 0;
  m_addFlags = false;
  if (opType == nsIMsgOfflineImapOperation::kDeletedMsg) {
    nsCOMPtr<nsIMsgDatabase> srcDB;
    nsCOMPtr<nsIDBFolderInfo> folderInfo;

    nsresult rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                                  getter_AddRefs(srcDB));
    if (NS_SUCCEEDED(rv) && srcDB) {
      nsMsgKey pseudoKey;
      nsCOMPtr<nsIMsgDBHdr> copySrcHdr;

      // Imap protocols have conflated key/UUID so we cannot use
      // auto key with them.
      nsCString protocolType;
      srcFolder->GetURI(protocolType);
      protocolType.SetLength(protocolType.FindChar(':'));
      for (int32_t i = 0; i < srcHdrs.Count(); i++) {
        if (protocolType.EqualsLiteral("imap")) {
          srcDB->GetNextPseudoMsgKey(&pseudoKey);
          pseudoKey--;
        } else {
          pseudoKey = nsMsgKey_None;
        }
        rv = srcDB->CopyHdrFromExistingHdr(pseudoKey, srcHdrs[i], false,
                                           getter_AddRefs(copySrcHdr));
        if (NS_SUCCEEDED(rv)) {
          copySrcHdr->GetMessageKey(&pseudoKey);
          m_srcHdrs.AppendObject(copySrcHdr);
        }
        m_dupKeyArray[i] = pseudoKey;
      }
    }
  } else
    m_srcHdrs.AppendObjects(srcHdrs);
}

nsImapOfflineTxn::~nsImapOfflineTxn() {}

// Open the database and find the key for the offline operation that we want to
// undo, then remove it from the database, we also hold on to this
// data for a redo operation.
NS_IMETHODIMP nsImapOfflineTxn::UndoTransaction(void) {
  nsresult rv;

  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  if (NS_FAILED(rv) || !srcFolder) return rv;
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  nsCOMPtr<nsIDBFolderInfo> folderInfo;
  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> destDB;

  rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                       getter_AddRefs(srcDB));
  NS_ENSURE_SUCCESS(rv, rv);

  switch (m_opType) {
    case nsIMsgOfflineImapOperation::kMsgMoved:
    case nsIMsgOfflineImapOperation::kMsgCopy:
    case nsIMsgOfflineImapOperation::kAddedHeader:
    case nsIMsgOfflineImapOperation::kFlagsChanged:
    case nsIMsgOfflineImapOperation::kDeletedMsg: {
      if (m_srcHdrs.IsEmpty()) {
        NS_ASSERTION(false, "No msg header to apply undo.");
        break;
      }
      nsCOMPtr<nsIMsgDBHdr> firstHdr = m_srcHdrs[0];
      nsMsgKey hdrKey;
      firstHdr->GetMessageKey(&hdrKey);
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(srcDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      rv = opsDb->GetOfflineOpForKey(hdrKey, false, getter_AddRefs(op));
      bool offlineOpPlayedBack = true;
      if (NS_SUCCEEDED(rv) && op) {
        op->GetPlayingBack(&offlineOpPlayedBack);
        opsDb->RemoveOfflineOp(op);
        op = nullptr;
      }
      if (!WeAreOffline() && offlineOpPlayedBack) {
        // couldn't find offline op - it must have been played back already
        // so we should undo the transaction online.
        return nsImapMoveCopyMsgTxn::UndoTransaction();
      }

      if (!firstHdr) break;
      nsMsgKey msgKey;
      if (m_opType == nsIMsgOfflineImapOperation::kAddedHeader) {
        for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
          m_srcHdrs[i]->GetMessageKey(&msgKey);
          nsCOMPtr<nsIMsgDBHdr> mailHdr;
          rv = srcDB->GetMsgHdrForKey(msgKey, getter_AddRefs(mailHdr));
          if (mailHdr) srcDB->DeleteHeader(mailHdr, nullptr, false, false);
        }
        srcDB->Commit(true);
      } else if (m_opType == nsIMsgOfflineImapOperation::kDeletedMsg) {
        for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
          nsCOMPtr<nsIMsgDBHdr> undeletedHdr = m_srcHdrs[i];
          m_srcHdrs[i]->GetMessageKey(&msgKey);
          if (undeletedHdr) {
            nsCOMPtr<nsIMsgDBHdr> newHdr;
            srcDB->CopyHdrFromExistingHdr(msgKey, undeletedHdr, true,
                                          getter_AddRefs(newHdr));
          }
        }
        srcDB->Close(true);
        srcFolder->SummaryChanged();
      }
      break;
    }
    case nsIMsgOfflineImapOperation::kMsgMarkedDeleted: {
      nsMsgKey msgKey;
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        srcDB->MarkImapDeleted(msgKey, false, nullptr);
      }
    } break;
    default:
      break;
  }
  srcDB->Close(true);
  srcFolder->SummaryChanged();
  return NS_OK;
}

NS_IMETHODIMP nsImapOfflineTxn::RedoTransaction(void) {
  nsresult rv;

  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  if (NS_FAILED(rv) || !srcFolder) return rv;
  nsCOMPtr<nsIMsgOfflineImapOperation> op;
  nsCOMPtr<nsIDBFolderInfo> folderInfo;
  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> destDB;
  rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                       getter_AddRefs(srcDB));
  NS_ENSURE_SUCCESS(rv, rv);

  switch (m_opType) {
    case nsIMsgOfflineImapOperation::kMsgMoved:
    case nsIMsgOfflineImapOperation::kMsgCopy: {
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(srcDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey hdrKey;
        m_srcHdrs[i]->GetMessageKey(&hdrKey);
        rv = opsDb->GetOfflineOpForKey(hdrKey, false, getter_AddRefs(op));
        if (NS_SUCCEEDED(rv) && op) {
          nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
          if (dstFolder) {
            nsCString folderURI;
            dstFolder->GetURI(folderURI);

            if (m_opType == nsIMsgOfflineImapOperation::kMsgMoved)
              op->SetDestinationFolderURI(folderURI);  // offline move
            if (m_opType == nsIMsgOfflineImapOperation::kMsgCopy) {
              op->SetOperation(nsIMsgOfflineImapOperation::kMsgMoved);
              op->AddMessageCopyOperation(folderURI);  // offline copy
            }
            dstFolder->SummaryChanged();
          }
        } else if (!WeAreOffline()) {
          // couldn't find offline op - it must have been played back already
          // so we should redo the transaction online.
          return nsImapMoveCopyMsgTxn::RedoTransaction();
        }
      }
      break;
    }
    case nsIMsgOfflineImapOperation::kAddedHeader: {
      nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
      rv = srcFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                           getter_AddRefs(destDB));
      NS_ENSURE_SUCCESS(rv, rv);
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(destDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsCOMPtr<nsIMsgDBHdr> restoreHdr;
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        destDB->CopyHdrFromExistingHdr(msgKey, m_srcHdrs[i], true,
                                       getter_AddRefs(restoreHdr));
        rv = opsDb->GetOfflineOpForKey(msgKey, true, getter_AddRefs(op));
        if (NS_SUCCEEDED(rv) && op) {
          nsCString folderURI;
          srcFolder->GetURI(folderURI);
          op->SetSourceFolderURI(folderURI);
        }
      }
      dstFolder->SummaryChanged();
      destDB->Close(true);
    } break;
    case nsIMsgOfflineImapOperation::kDeletedMsg:
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        srcDB->DeleteMessage(msgKey, nullptr, true);
      }
      break;
    case nsIMsgOfflineImapOperation::kMsgMarkedDeleted:
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        srcDB->MarkImapDeleted(msgKey, true, nullptr);
      }
      break;
    case nsIMsgOfflineImapOperation::kFlagsChanged: {
      nsCOMPtr<nsIMsgOfflineOpsDatabase> opsDb = do_QueryInterface(srcDB, &rv);
      NS_ENSURE_SUCCESS(rv, rv);
      for (int32_t i = 0; i < m_srcHdrs.Count(); i++) {
        nsMsgKey msgKey;
        m_srcHdrs[i]->GetMessageKey(&msgKey);
        rv = opsDb->GetOfflineOpForKey(msgKey, true, getter_AddRefs(op));
        if (NS_SUCCEEDED(rv) && op) {
          imapMessageFlagsType newMsgFlags;
          op->GetNewFlags(&newMsgFlags);
          if (m_addFlags)
            op->SetFlagOperation(newMsgFlags | m_flags);
          else
            op->SetFlagOperation(newMsgFlags & ~m_flags);
        }
      }
      break;
    }
    default:
      break;
  }
  srcDB->Close(true);
  srcDB = nullptr;
  srcFolder->SummaryChanged();
  return NS_OK;
}
