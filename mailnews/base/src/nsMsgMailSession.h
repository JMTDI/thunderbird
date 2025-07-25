/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGMAILSESSION_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGMAILSESSION_H_

#include "nsIMsgMailSession.h"
#include "nsISupports.h"
#include "nsCOMPtr.h"
#include "nsIMsgWindow.h"
#include "nsCOMArray.h"
#include "nsIMsgShutdown.h"
#include "nsIObserver.h"
#include "nsIMsgProgress.h"
#include "nsTObserverArray.h"
#include "nsIMsgUserFeedbackListener.h"
#include "nsIUrlListener.h"

///////////////////////////////////////////////////////////////////////////////////
// The mail session is a replacement for the old 4.x MSG_Master object. It
// contains mail session generic information such as the user's current mail
// identity, .... I'm starting this off as an empty interface and as people feel
// they need to add more information to it, they can. I think this is a better
// approach than trying to port over the old MSG_Master in its entirety as that
// had a lot of cruft in it....
//////////////////////////////////////////////////////////////////////////////////

// nsMsgMailSession also implements nsIFolderListener, in order to relay
// notifications to its registered listeners.
// Calling a method on the MailSession causes that method to be invoked upon
// all the registered listeners (but not listeners directly attached to
// folders!)
// In normal operation, most notifications will originate from the
// nsIMsgFolder.Notify*() functions, which invoke both folder-local
// listeners, and the global MailSession-registered ones).
class nsMsgMailSession : public nsIMsgMailSession, public nsIFolderListener {
 public:
  nsMsgMailSession();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIMSGMAILSESSION
  NS_DECL_NSIFOLDERLISTENER

  nsresult Init();
  nsresult GetSelectedLocaleDataDir(nsIFile* defaultsDir);

 protected:
  virtual ~nsMsgMailSession();

  struct folderListener {
    nsCOMPtr<nsIFolderListener> mListener;
    uint32_t mNotifyFlags;

    folderListener(nsIFolderListener* aListener, uint32_t aNotifyFlags)
        : mListener(aListener), mNotifyFlags(aNotifyFlags) {}
    folderListener(const folderListener& aListener)
        : mListener(aListener.mListener),
          mNotifyFlags(aListener.mNotifyFlags) {}
    ~folderListener() {}

    int operator==(nsIFolderListener* aListener) const {
      return mListener == aListener;
    }
    int operator==(const folderListener& aListener) const {
      return mListener == aListener.mListener &&
             mNotifyFlags == aListener.mNotifyFlags;
    }
  };

  nsTObserverArray<folderListener> mListeners;
  nsTObserverArray<nsCOMPtr<nsIMsgUserFeedbackListener> > mFeedbackListeners;

  nsCOMArray<nsIMsgWindow> mWindows;
  // stick this here temporarily
  nsCOMPtr<nsIMsgWindow> m_temporaryMsgWindow;
};

/********************************************************************************/

class nsMsgShutdownService : public nsIMsgShutdownService,
                             public nsIUrlListener,
                             public nsIObserver {
 public:
  nsMsgShutdownService();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGSHUTDOWNSERVICE
  NS_DECL_NSIURLLISTENER
  NS_DECL_NSIOBSERVER

 protected:
  nsresult ProcessNextTask();
  void AttemptShutdown();

 private:
  virtual ~nsMsgShutdownService();

  nsCOMArray<nsIMsgShutdownTask> mShutdownTasks;
  nsCOMPtr<nsIMsgProgress> mMsgProgress;
  uint32_t mTaskIndex;
  uint32_t mQuitMode;
  bool mProcessedShutdown;
  bool mQuitForced;
  bool mReadyToQuit;
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGMAILSESSION_H_
