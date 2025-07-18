/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { MailConsts } = ChromeUtils.importESModule(
  "resource:///modules/MailConsts.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

registerCleanupFunction(() => {
  const tabmail = document.getElementById("tabmail");
  is(tabmail.tabInfo.length, 1);

  while (tabmail.tabInfo.length > 1) {
    tabmail.closeTab(tabmail.tabInfo[1]);
  }

  // Some tests that open new windows don't return focus to the main window
  // in a way that satisfies mochitest, and the test times out.
  Services.focus.focusedWindow = window;
  // Focus an element in the main window, then blur it again to avoid it
  // hijacking keypresses.
  const mainWindowElement = document.getElementById("button-appmenu");
  mainWindowElement.focus();
  mainWindowElement.blur();

  Services.prefs.clearUserPref("mail.pane_config.dynamic");
  Services.prefs.clearUserPref("mail.threadpane.listview");
});

function createAccount(type = "none") {
  let account;

  if (type == "local") {
    account = MailServices.accounts.createLocalMailAccount();
  } else {
    account = MailServices.accounts.createAccount();
    account.incomingServer = MailServices.accounts.createIncomingServer(
      `${account.key}user`,
      "localhost",
      type
    );
  }

  info(`Created account ${account.toString()}`);
  return account;
}

async function createSubfolder(parent, name) {
  parent.createSubfolder(name, null);
  return parent.getChildNamed(name);
}

function createMessages(folder, makeMessagesArg) {
  if (typeof makeMessagesArg == "number") {
    makeMessagesArg = { count: makeMessagesArg };
  }
  if (!createMessages.messageGenerator) {
    createMessages.messageGenerator = new MessageGenerator();
  }

  const messages =
    createMessages.messageGenerator.makeMessages(makeMessagesArg);
  const messageStrings = messages.map(message => message.toMessageString());
  folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessageBatch(messageStrings);
}

async function openMessageInTab(msgHdr) {
  if (!msgHdr.QueryInterface(Ci.nsIMsgDBHdr)) {
    throw new Error("No message passed to openMessageInTab");
  }

  // Ensure the behaviour pref is set to open a new tab. It is the default,
  // but you never know.
  const oldPrefValue = Services.prefs.getIntPref("mail.openMessageBehavior");
  Services.prefs.setIntPref(
    "mail.openMessageBehavior",
    MailConsts.OpenMessageBehavior.NEW_TAB
  );
  MailUtils.displayMessages([msgHdr]);
  Services.prefs.setIntPref("mail.openMessageBehavior", oldPrefValue);

  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const tab = win.document.getElementById("tabmail").currentTabInfo;
  const browser = tab.browser;

  await promiseMessageLoaded(browser, msgHdr);
  return tab;
}

async function openMessageInWindow(msgHdr) {
  if (!msgHdr.QueryInterface(Ci.nsIMsgDBHdr)) {
    throw new Error("No message passed to openMessageInWindow");
  }

  const messageWindowPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
    undefined,
    async win =>
      win.document.documentURI ==
      "chrome://messenger/content/messageWindow.xhtml"
  );
  MailUtils.openMessageInNewWindow(msgHdr);

  const messageWindow = await messageWindowPromise;
  const browser = messageWindow.document.getElementById("messagepane");

  await promiseMessageLoaded(browser, msgHdr);
  return messageWindow;
}

async function promiseMessageLoaded(browser, msgHdr) {
  let messageURI = msgHdr.folder.getUriForMsg(msgHdr);
  messageURI = MailServices.messageServiceFromURI(messageURI).getUrlForUri(
    messageURI,
    null
  );

  if (
    !browser.webProgress ||
    browser.webProgress.isLoadingDocument ||
    !browser.currentURI?.equals(messageURI)
  ) {
    await BrowserTestUtils.browserLoaded(
      browser,
      null,
      uri => uri == messageURI.spec
    );
  }
}

async function assertVisibility(element, isVisible, msg) {
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(element) == isVisible,
    `The ${element.id} should be ${isVisible ? "visible" : "hidden"}: ${msg}`
  );
}
