/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_COMPOSE_SRC_NSMSGSENDLATER_H_
#define COMM_MAILNEWS_COMPOSE_SRC_NSMSGSENDLATER_H_

#include "nsCOMArray.h"
#include "nsIMsgFolder.h"
#include "nsIMsgSendListener.h"
#include "nsIMsgSendLaterListener.h"
#include "nsIMsgSendLater.h"
#include "nsIMsgStatusFeedback.h"
#include "nsTObserverArray.h"
#include "nsIObserver.h"
#include "nsITimer.h"
#include "nsCOMPtr.h"
#include "nsIMsgShutdown.h"
#include "nsIWeakReferenceUtils.h"

////////////////////////////////////////////////////////////////////////////////////
// This is the listener class for the send operation. We have to create this
// class to listen for message send completion and eventually notify the caller
////////////////////////////////////////////////////////////////////////////////////
class nsMsgSendLater;

class SendOperationListener : public nsIMsgSendListener,
                              public nsIMsgCopyServiceListener {
 public:
  explicit SendOperationListener(nsMsgSendLater* aSendLater);

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGSENDLISTENER
  NS_DECL_NSIMSGCOPYSERVICELISTENER

 private:
  virtual ~SendOperationListener();
  RefPtr<nsMsgSendLater> mSendLater;
};

class nsMsgSendLater : public nsIMsgSendLater,
                       public nsIFolderListener,
                       public nsIObserver,
                       public nsIUrlListener,
                       public nsIMsgShutdownTask

{
 public:
  nsMsgSendLater();
  nsresult Init();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGSENDLATER
  NS_DECL_NSIFOLDERLISTENER
  NS_DECL_NSISTREAMLISTENER
  NS_DECL_NSIREQUESTOBSERVER
  NS_DECL_NSIOBSERVER
  NS_DECL_NSIURLLISTENER
  NS_DECL_NSIMSGSHUTDOWNTASK

  // Methods needed for implementing interface...
  nsresult StartNextMailFileSend(nsresult prevStatus);
  nsresult CompleteMailFileSend();

  nsresult DeleteCurrentMessage();
  nsresult SetOrigMsgDisposition();
  // Necessary for creating a valid list of recipients
  nsresult BuildHeaders();
  nsresult DeliverQueuedLine(const char* line, int32_t length);
  nsresult RebufferLeftovers(char* startBuf, uint32_t aLen);
  nsresult BuildNewBuffer(const char* aBuf, uint32_t aCount,
                          uint32_t* totalBufSize);

  // methods for listener array processing...
  void NotifyListenersOnStartSending(uint32_t aTotalMessageCount);
  void NotifyListenersOnMessageStartSending(uint32_t aCurrentMessage,
                                            uint32_t aTotalMessage,
                                            nsIMsgIdentity* aIdentity);
  void NotifyListenersOnProgress(uint32_t aCurrentMessage,
                                 uint32_t aTotalMessage, uint32_t aSendPercent,
                                 uint32_t aCopyPercent);
  void NotifyListenersOnMessageSendError(uint32_t aCurrentMessage,
                                         nsresult aStatus,
                                         const char16_t* aMsg);
  void EndSendMessages(nsresult aStatus, const char16_t* aMsg,
                       uint32_t aTotalTried, uint32_t aSuccessful);

  bool OnSendStepFinished(nsresult aStatus);
  void OnCopyStepFinished(nsresult aStatus);

 private:
  // counters and things for enumeration
  uint32_t mTotalSentSuccessfully;
  uint32_t mTotalSendCount;
  nsCOMArray<nsIMsgDBHdr> mMessagesToSend;
  nsWeakPtr mMessageFolder;
  nsCOMPtr<nsIMsgStatusFeedback> mFeedback;

  virtual ~nsMsgSendLater();
  nsresult GetIdentityFromKey(const char* aKey, nsIMsgIdentity** aIdentity);
  nsresult ReparseDBIfNeeded(nsIUrlListener* aListener);
  nsresult InternalSendMessages(bool aUserInitiated, nsIMsgIdentity* aIdentity);
  nsresult StartTimer();

  nsTObserverArray<nsCOMPtr<nsIMsgSendLaterListener> > mListenerArray;
  nsCOMPtr<nsIMsgDBHdr> mMessage;
  nsCOMPtr<nsITimer> mTimer;
  bool mTimerSet;
  nsCOMPtr<nsIUrlListener> mShutdownListener;

  //
  // File output stuff...
  //
  nsCOMPtr<nsIFile> mTempFile;
  nsCOMPtr<nsIOutputStream> mOutFile;

  // For building headers and stream parsing...
  char* m_to;
  char* m_bcc;
  char* m_fcc;
  char* m_messageId;
  char* m_newsgroups;
  char* m_headers;
  int32_t m_flags;
  int32_t m_headersFP;
  bool m_inhead;
  int32_t m_headersPosition;
  int32_t m_bytesRead;
  int32_t m_position;
  int32_t m_flagsPosition;
  int32_t m_headersSize;
  char* mLeftoverBuffer;
  char* mIdentityKey;
  char* mAccountKey;
  char* mDraftInfo;

  bool mSendingMessages;
  bool mUserInitiated;
  nsCOMPtr<nsIMsgIdentity> mIdentity;
};

#endif  // COMM_MAILNEWS_COMPOSE_SRC_NSMSGSENDLATER_H_
