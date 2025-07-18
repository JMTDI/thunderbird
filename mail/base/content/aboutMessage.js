/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals Enigmail, MailE10SUtils */

// mailCommon.js
/* globals commandController, DBViewWrapper, dbViewWrapperListener,
     nsMsgViewIndex_None, TreeSelection */
/* globals gDBView: true, gFolder: true, gViewWrapper: true */

// mailContext.js
/* globals mailContextMenu */

// msgHdrView.js
/* globals AdjustHeaderView ClearCurrentHeaders ClearPendingReadTimer
   HideMessageHeaderPane initFolderDBListener OnLoadMsgHeaderPane OnTagsChange
   OnUnloadMsgHeaderPane HandleAllAttachments AttachmentMenuController */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
ChromeUtils.defineESModuleGetters(
  this,
  {
    adaptMessageForDarkMode: "chrome://messenger/content/DarkReader.mjs",
  },
  { global: "current" }
);

ChromeUtils.defineESModuleGetters(this, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  UIDensity: "resource:///modules/UIDensity.sys.mjs",
  UIFontSize: "resource:///modules/UIFontSize.sys.mjs",
});

const messengerBundle = Services.strings.createBundle(
  "chrome://messenger/locale/messenger.properties"
);

const prefersDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

var gMessage, gMessageURI;
var autodetectCharset;

let messageScrolled = 0;
let reloadTimeout = null;
function timeoutReload() {
  if (reloadTimeout) {
    return;
  }
  // Clear the event queue before reloading the message. Several prefs may
  // be changed at once.
  reloadTimeout = setTimeout(() => {
    reloadTimeout = null;
    ReloadMessage();
  });
}

function getMessagePaneBrowser() {
  return document.getElementById("messagepane");
}

/**
 * Handle "resize" events on the messagepane.
 */
async function messagePaneOnResize() {
  const doc = getMessagePaneBrowser().contentDocument;
  // Bail out if it's http content or we don't have images.
  if (doc?.URL.startsWith("http") || !doc?.images) {
    return;
  }

  const availableWidth = Math.max(
    document.body.scrollWidth,
    window.visualViewport.width
  );

  const adjustImg = img => {
    if (img.hasAttribute("shrinktofit")) {
      // overflowing: Whether the image is overflowing visible area.
      img.toggleAttribute("overflowing", img.naturalWidth > img.clientWidth);
    } else if (img.hasAttribute("overflowing")) {
      const isOverflowing = img.clientWidth >= availableWidth;
      img.toggleAttribute("overflowing", isOverflowing);
      img.toggleAttribute("shrinktofit", !isOverflowing);
    }
  };

  for (const img of doc.querySelectorAll(
    "img:is([shrinktofit],[overflowing])"
  )) {
    if (img.closest("[href]")) {
      continue;
    }
    if (!img.complete) {
      img.addEventListener("load", event => adjustImg(event.target), {
        once: true,
      });
    } else {
      adjustImg(img);
    }
  }
}

function ReloadMessage() {
  if (!gMessageURI) {
    return;
  }
  displayMessage(gMessageURI, gViewWrapper);
}

function MailSetCharacterSet() {
  const messageService = MailServices.messageServiceFromURI(gMessageURI);
  gMessage = messageService.messageURIToMsgHdr(gMessageURI);
  messageService.loadMessage(
    gMessageURI,
    getMessagePaneBrowser().docShell,
    top.msgWindow,
    null,
    true
  );
  autodetectCharset = true;
}

window.addEventListener("DOMContentLoaded", event => {
  if (event.target != document) {
    return;
  }

  UIDensity.registerWindow(window);
  UIFontSize.registerWindow(window);

  OnLoadMsgHeaderPane();

  Enigmail.msg.messengerStartup();
  Enigmail.hdrView.hdrViewLoad();

  MailServices.mailSession.AddFolderListener(
    folderListener,
    Ci.nsIFolderListener.removed
  );

  preferenceObserver.init();
  Services.obs.addObserver(msgObserver, "message-content-updated");

  const browser = getMessagePaneBrowser();

  if (parent == top) {
    // Standalone message display? Focus the message pane.
    browser.focus();
  }

  if (window.parent == window.top) {
    mailContextMenu.init();
  }

  // There might not be a msgWindow variable on the top window
  // if we're e.g. showing a message in a dedicated window.
  // For a new profile, statusFeedback will be null at this point.
  if (top.msgWindow?.statusFeedback) {
    // Necessary plumbing to communicate status updates back to
    // the user.
    browser.docShell
      ?.QueryInterface(Ci.nsIWebProgress)
      .addProgressListener(
        top.msgWindow.statusFeedback,
        Ci.nsIWebProgress.NOTIFY_ALL
      );
  }

  if (Services.prefs.getBoolPref("mail.advance_on_spacebar")) {
    getMessagePaneBrowser().addEventListener("keydown", ev => {
      if (
        ev.key == " " &&
        !ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        ev.target.localName == "body"
      ) {
        ev.preventDefault();
        top.goDoCommand("cmd_space", ev);
      }
    });
  }

  window.dispatchEvent(
    new CustomEvent("aboutMessageLoaded", { bubbles: true })
  );

  window.addEventListener("MsgLoaded", msgObserver);
  prefersDarkQuery.addEventListener("change", msgObserver);

  const disableDarkReaderToggle = document.getElementById("disableDarkReader");
  disableDarkReaderToggle.checked = !Services.prefs.getBoolPref(
    "mail.dark-reader.enabled",
    true
  );
  document.l10n.setAttributes(
    disableDarkReaderToggle,
    disableDarkReaderToggle.checked
      ? "dark-message-mode-toggle-disabled"
      : "dark-message-mode-toggle-enabled"
  );
  disableDarkReaderToggle.addEventListener("click", e => {
    const messagePane = getMessagePaneBrowser();
    messageScrolled = messagePane.contentDocument.documentElement.scrollTop;
    Services.prefs.setBoolPref("mail.dark-reader.enabled", !e.target.checked);
    document.l10n.setAttributes(
      disableDarkReaderToggle,
      disableDarkReaderToggle.checked
        ? "dark-message-mode-toggle-disabled"
        : "dark-message-mode-toggle-enabled"
    );
    messagePane.focus();
  });
});

window.addEventListener("unload", () => {
  ClearPendingReadTimer();
  OnUnloadMsgHeaderPane();
  MailServices.mailSession.RemoveFolderListener(folderListener);
  preferenceObserver.cleanUp();
  Services.obs.removeObserver(msgObserver, "message-content-updated");
  window.removeEventListener("MsgLoaded", msgObserver);
  prefersDarkQuery.removeEventListener("change", msgObserver);
  gViewWrapper?.close();
});

/**
 * Display a message.
 *
 * @param {string} uri - The message URI.
 * @param {?DBViewWrapper} viewWrapper - View wrapper.
 */
function displayMessage(uri, viewWrapper) {
  // Clear the state flags, if this window is re-used.
  window.msgLoaded = false;
  window.msgLoading = false;

  // Clean up existing objects before starting again.
  ClearPendingReadTimer();
  gMessage = null;
  if (gViewWrapper && viewWrapper != gViewWrapper) {
    // Don't clean up gViewWrapper if we're going to reuse it. If we're inside
    // about:3pane, close the view wrapper, but don't call `onLeavingFolder`,
    // because about:3pane will do that if we're actually leaving the folder.
    gViewWrapper?.close(parent != top);
    gViewWrapper = null;
  }
  gDBView = null;

  gMessageURI = uri;
  ClearCurrentHeaders();

  if (!uri) {
    HideMessageHeaderPane();
    MailE10SUtils.loadAboutBlank(getMessagePaneBrowser());
    // Deactivate the message pane browser. This might not be the same browser
    // as the one in the previous line.
    getMessagePaneBrowser().docShellIsActive = false;
    window.msgLoaded = true;
    window.dispatchEvent(
      new CustomEvent("messageURIChanged", { bubbles: true, detail: uri })
    );
    return;
  }

  const messageService = MailServices.messageServiceFromURI(uri);
  gMessage = messageService.messageURIToMsgHdr(uri);
  gFolder = gMessage.folder;
  initFolderDBListener();

  messageHistory.push(uri);

  if (parent == top) {
    // This is needed for registering transactions on stand-alone windows.
    dbViewWrapperListener.msgWindow = parent.msgWindow;
  }

  if (!gViewWrapper) {
    if (gFolder) {
      if (viewWrapper) {
        gViewWrapper = viewWrapper.clone(dbViewWrapperListener);
      } else {
        gViewWrapper = new DBViewWrapper(dbViewWrapperListener);
        gViewWrapper._viewFlags = Ci.nsMsgViewFlagsType.kThreadedDisplay;
        gViewWrapper.open(gFolder);
      }
    } else {
      gViewWrapper = new DBViewWrapper(dbViewWrapperListener);
      gViewWrapper.openSearchView();
    }
  }
  gDBView = gViewWrapper.dbView;
  const selection = (gDBView.selection = new TreeSelection());
  selection.view = gDBView;
  const index = gDBView.findIndexOfMsgHdr(gMessage, true);
  selection.select(index == nsMsgViewIndex_None ? -1 : index);
  gDBView?.setJSTree({
    QueryInterface: ChromeUtils.generateQI(["nsIMsgJSTree"]),
    _inBatch: false,
    beginUpdateBatch() {
      this._inBatch = true;
    },
    endUpdateBatch() {
      this._inBatch = false;
    },
    ensureRowIsVisible() {},
    invalidate() {},
    invalidateRange() {},
    rowCountChanged(idx, count) {
      if (!gDBView.selection) {
        return;
      }
      const wasSuppressed = gDBView.selection.selectEventsSuppressed;
      gDBView.selection.selectEventsSuppressed = true;
      gDBView.selection.adjustSelection(idx, count);
      gDBView.selection.selectEventsSuppressed = wasSuppressed;
    },
    currentIndex: null,
  });

  const flags = gMessage.flags;
  if (flags & Ci.nsMsgMessageFlags.HasRe) {
    document.title = `Re: ${gMessage.mime2DecodedSubject || ""}`;
  } else {
    document.title = gMessage.mime2DecodedSubject;
  }

  if (parent.tabOrWindow) {
    // We could end up here before `tabOrWindow` has been set. If the parent
    // window is about:3pane, get it from there.
    window.tabOrWindow = parent.tabOrWindow;
  }

  const browser = getMessagePaneBrowser();
  const browserChanged = MailE10SUtils.changeRemoteness(browser, null);
  // If we're in a background tab, mark the docShell as inactive, so that the
  // message doesn't get marked as read by `autoMarkAsRead` or
  // `nsImapService::LoadMessage`.
  browser.docShellIsActive =
    Window.isInstance(window.tabOrWindow) || window.tabOrWindow?.selected;
  browser.docShell.allowAuth = false;
  browser.docShell.allowDNSPrefetch = false;

  // See nsMsgContentPolicy::SetDisableItemsOnMailNewsUrlDocshells().
  const SANDBOX_ALL_FLAGS = 0xfffff;
  const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;
  const SANDBOXED_ORIGIN = 0x10;
  const SANDBOXED_TOPLEVEL_NAVIGATION_USER_ACTIVATION = 0x20000;
  let sandboxFlags = SANDBOX_ALL_FLAGS;
  sandboxFlags &= ~SANDBOXED_AUXILIARY_NAVIGATION;
  sandboxFlags &= ~SANDBOXED_ORIGIN;
  sandboxFlags &= ~SANDBOXED_TOPLEVEL_NAVIGATION_USER_ACTIVATION;
  // Flags - contrary to sandbox csp values - *prevent* a given feature.
  browser.browsingContext.sandboxFlags = sandboxFlags;

  if (browserChanged) {
    browser.docShell
      ?.QueryInterface(Ci.nsIWebProgress)
      .addProgressListener(
        top.msgWindow.statusFeedback,
        Ci.nsIWebProgress.NOTIFY_ALL
      );
  }

  if (flags & Ci.nsMsgMessageFlags.Partial) {
    document.body.classList.add("partial-message");
  } else if (document.body.classList.contains("partial-message")) {
    document.body.classList.remove("partial-message");
    document.body.classList.add("completed-message");
  }

  // @implements {nsIUrlListener}
  const urlListener = {
    OnStartRunningUrl() {},
    OnStopRunningUrl(url) {
      window.msgLoading = true;
      window.dispatchEvent(
        new CustomEvent("messageURIChanged", { bubbles: true, detail: uri })
      );
      if (url instanceof Ci.nsIMsgMailNewsUrl && url.seeOtherURI) {
        // Show error page if needed.
        HideMessageHeaderPane();
        browser.browsingContext.sandboxFlags = 0;
        MailE10SUtils.loadURI(browser, url.seeOtherURI);
      }
      if (flags & Ci.nsMsgMessageFlags.New) {
        // Close any notification we might have about this message.
        Cc["@mozilla.org/system-alerts-service;1"]
          .getService(Ci.nsIAlertsService)
          .closeAlert(uri);
      }
    },
  };
  try {
    messageService.loadMessage(
      uri,
      browser.docShell,
      top.msgWindow,
      urlListener,
      false
    );
  } catch (ex) {
    if (ex.result != Cr.NS_ERROR_OFFLINE) {
      throw ex;
    }

    // TODO: This should be replaced with a real page, and made not ugly.
    let title = messengerBundle.GetStringFromName("nocachedbodytitle");
    // This string includes some HTML! Get rid of it.
    title = title.replace(/<\/?title>/gi, "");
    const body = messengerBundle.GetStringFromName("nocachedbodybody2");
    HideMessageHeaderPane();
    MailE10SUtils.loadURI(
      getMessagePaneBrowser(),
      "data:text/html;base64," +
        btoa(
          `<!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8" />
            <title>${title}</title>
          </head>
          <body>
            <h1>${title}</h1>
            <p>${body}</p>
          </body>
        </html>`
        )
    );
  }
  autodetectCharset = false;
}

var folderListener = {
  QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),

  onFolderRemoved() {},
  onMessageRemoved(parentFolder, msg) {
    messageHistory.onMessageRemoved(parentFolder, msg);
  },
};

var msgObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  observe(subject, topic, data) {
    if (
      topic == "message-content-updated" &&
      gMessageURI == subject.QueryInterface(Ci.nsISupportsString).data
    ) {
      // This notification is triggered after a partial pop3 message was
      // fully downloaded. The old message URI is now gone. To reload the
      // message, we display it with its new URI.
      displayMessage(data, gViewWrapper);
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "MsgLoaded":
        if (prefersDarkQuery.matches) {
          adaptMessageForDarkMode(getMessagePaneBrowser());
        }
        // Restore the scroll position of a message if it gets reloaded.
        if (messageScrolled) {
          getMessagePaneBrowser().contentDocument.documentElement.scrollTo({
            top: messageScrolled,
            behavior: "instant",
          });
          messageScrolled = 0;
        }
        break;
      case "change":
        timeoutReload();
        break;
    }
  },
};

var preferenceObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  _topics: [
    "mail.inline_attachments",
    "mail.show_headers",
    "mail.addressDisplayFormat",
    "mail.dark-reader.enabled",
    "mail.showCondensedAddresses",
    "mailnews.display.disallow_mime_handlers",
    "mailnews.display.html_as",
    "mailnews.display.prefer_plaintext",
    "mailnews.headers.showReferences",
    "rss.show.summary",
  ],

  init() {
    for (const topic of this._topics) {
      Services.prefs.addObserver(topic, this);
    }
  },

  cleanUp() {
    for (const topic of this._topics) {
      Services.prefs.removeObserver(topic, this);
    }
  },

  observe(subject, topic, data) {
    if (data == "mail.show_headers") {
      AdjustHeaderView(Services.prefs.getIntPref(data));
    }
    if (data == "mail.dark-reader.enabled") {
      document.getElementById("disableDarkReader").checked =
        !Services.prefs.getBoolPref(data);
    }
    timeoutReload();
  },
};

var messageHistory = {
  MAX_HISTORY_SIZE: 20,
  /**
   * @typedef {object} MessageHistoryEntry
   * @property {string} messageURI - URI of the message for this entry.
   * @property {string} folderURI - URI of the folder for this entry.
   */
  /**
   * @type {MessageHistoryEntry[]}
   */
  _history: [],
  _currentIndex: -1,
  /**
   * Remove the message from the history, cleaning up the state as needed in
   * the process.
   *
   * @param {nsIMsgFolder} parentFolder
   * @param {nsIMsgDBHdr} message
   */
  onMessageRemoved(parentFolder, message) {
    if (!this._history.length) {
      return;
    }
    const messageURI = parentFolder.generateMessageURI(message.messageKey);
    const folderURI = parentFolder.URI;
    const oldLength = this._history.length;
    let removedEntriesBeforeFuture = 0;
    this._history = this._history.filter((entry, index) => {
      const keepEntry =
        entry.messageURI !== messageURI || entry.folderURI !== folderURI;
      if (!keepEntry && index <= this._currentIndex) {
        ++removedEntriesBeforeFuture;
      }
      return keepEntry;
    });
    this._currentIndex -= removedEntriesBeforeFuture;
    // Correct for first entry getting removed while it's the current entry.
    if (this._history.length && this._currentIndex == -1) {
      this._currentIndex = 0;
    }
    if (oldLength === this._history.length) {
      return;
    }
    window.top.goUpdateCommand("cmd_goBack");
    window.top.goUpdateCommand("cmd_goForward");
  },
  /**
   * Get the actual index in the history based on a delta from the current
   * index.
   *
   * @param {number} delta - Relative delta from the current index. Forward is
   *   positive, backward is negative.
   * @returns {number} Absolute index in the history, bounded to the history
   *   size.
   */
  _getAbsoluteIndex(delta) {
    return Math.min(
      Math.max(this._currentIndex + delta, 0),
      this._history.length - 1
    );
  },
  /**
   * Add a message to the end of the history. Does nothing if the message is
   * already the current item. Moves the history forward by one step if the next
   * item already matches the given message. Else removes any "future" history
   * if the current position isn't the newest entry in the history.
   *
   * If the history is growing larger than what we want to keep, it is trimmed.
   *
   * Assumes the view is currently in the folder that should be comitted to
   * history.
   *
   * @param {string} messageURI - Message to add to the history.
   */
  push(messageURI) {
    if (!messageURI) {
      return;
    }
    const currentItem = this._history[this._currentIndex];
    const currentFolder = gFolder?.URI;
    if (
      currentItem &&
      messageURI === currentItem.messageURI &&
      currentFolder === currentItem.folderURI
    ) {
      return;
    }
    const nextMessageIndex = this._currentIndex + 1;
    let erasedFuture = false;
    if (nextMessageIndex < this._history.length) {
      const nextMessage = this._history[nextMessageIndex];
      if (
        nextMessage &&
        messageURI === nextMessage.messageURI &&
        currentFolder === nextMessage.folderURI
      ) {
        this._currentIndex = nextMessageIndex;
        if (this._currentIndex === 1) {
          window.top.goUpdateCommand("cmd_goBack");
        }
        if (this._currentIndex + 1 === this._history.length) {
          window.top.goUpdateCommand("cmd_goForward");
        }
        return;
      }
      this._history.splice(nextMessageIndex, Infinity);
      erasedFuture = true;
    }
    this._history.push({ messageURI, folderURI: currentFolder });
    this._currentIndex = nextMessageIndex;
    if (this._history.length > this.MAX_HISTORY_SIZE) {
      const amountOfItemsToRemove =
        this._history.length - this.MAX_HISTORY_SIZE;
      this._history.splice(0, amountOfItemsToRemove);
      this._currentIndex -= amountOfItemsToRemove;
    }
    if (!currentItem || this._currentIndex === 0) {
      window.top.goUpdateCommand("cmd_goBack");
    }
    if (erasedFuture) {
      window.top.goUpdateCommand("cmd_goForward");
    }
  },
  /**
   * Go forward or back in history relative to the current position.
   *
   * @param {number} delta
   * @returns {?MessageHistoryEntry} The message and folder URI that are now at
   *   the active position in the history. If null is returned, no action was
   *   taken.
   */
  pop(delta) {
    const targetIndex = this._getAbsoluteIndex(delta);
    if (this._currentIndex == targetIndex && gMessage) {
      return null;
    }
    this._currentIndex = targetIndex;
    window.top.goUpdateCommand("cmd_goBack");
    window.top.goUpdateCommand("cmd_goForward");
    return this._history[targetIndex];
  },
  /**
   * Get the current state of the message history.
   *
   * @returns {{entries: MessageHistoryEntry[], currentIndex: number}}
   *   A list of message and folder URIs as strings and the current index in the
   *   entries.
   */
  getHistory() {
    return { entries: this._history.slice(), currentIndex: this._currentIndex };
  },
  /**
   * Get a specific history entry relative to the current positon.
   *
   * @param {number} delta - Relative index to get the value of.
   * @returns {?MessageHistoryEntry} If found, the message and
   *   folder URI at the given position.
   */
  getMessageAt(delta) {
    if (!this._history.length) {
      return null;
    }
    return this._history[this._getAbsoluteIndex(delta)];
  },
  /**
   * Check if going forward or back in the history by the given steps is
   * possible. A special case is when no message is currently selected, going
   * back to relative position 0 (so the current index) is possible.
   *
   * @param {number} delta - Relative position to go to from the current index.
   * @returns {boolean} If there is a target available at that position in the
   *   current history.
   */
  canPop(delta) {
    const resultIndex = this._currentIndex + delta;
    return (
      resultIndex >= 0 &&
      resultIndex < this._history.length &&
      (resultIndex !== this._currentIndex || !gMessage)
    );
  },
  /**
   * Clear the message history, resetting it to its initial empty state.
   */
  clear() {
    this._history.length = 0;
    this._currentIndex = -1;
    window.top.goUpdateCommand("cmd_goBack");
    window.top.goUpdateCommand("cmd_goForward");
  },
};

commandController.registerCallback(
  "cmd_delete",
  () => commandController.doCommand("cmd_deleteMessage"),
  () => commandController.isCommandEnabled("cmd_deleteMessage")
);
commandController.registerCallback(
  "cmd_shiftDelete",
  () => commandController.doCommand("cmd_shiftDeleteMessage"),
  () => commandController.isCommandEnabled("cmd_shiftDeleteMessage")
);
commandController.registerCallback("cmd_find", () =>
  document.getElementById("findToolbar").onFindCommand()
);
commandController.registerCallback("cmd_findAgain", () =>
  document.getElementById("findToolbar").onFindAgainCommand(false)
);
commandController.registerCallback("cmd_findPrevious", () =>
  document.getElementById("findToolbar").onFindAgainCommand(true)
);
commandController.registerCallback("cmd_print", () => {
  top.PrintUtils.startPrintWindow(getMessagePaneBrowser().browsingContext, {});
});
commandController.registerCallback("cmd_fullZoomReduce", () => {
  top.ZoomManager.reduce();
});
commandController.registerCallback("cmd_fullZoomEnlarge", () => {
  top.ZoomManager.enlarge();
});
commandController.registerCallback("cmd_fullZoomReset", () => {
  top.ZoomManager.reset();
});
commandController.registerCallback("cmd_fullZoomToggle", () => {
  top.ZoomManager.toggleZoom();
});

// Attachments commands.
commandController.registerCallback(
  "cmd_openAllAttachments",
  () => HandleAllAttachments("open"),
  () => AttachmentMenuController.someFilesAvailable()
);

commandController.registerCallback(
  "cmd_saveAllAttachments",
  () => HandleAllAttachments("save"),
  () => AttachmentMenuController.someFilesAvailable()
);

commandController.registerCallback(
  "cmd_detachAllAttachments",
  () => HandleAllAttachments("detach"),
  () => AttachmentMenuController.canDetachFiles()
);

commandController.registerCallback(
  "cmd_deleteAllAttachments",
  () => HandleAllAttachments("delete"),
  () => AttachmentMenuController.canDetachFiles()
);
