/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../../base/content/aboutMessage.js */
/* import-globals-from ../../../../base/content/msgHdrView.js */
/* import-globals-from ../../../../base/content/msgSecurityPane.js */

/* global openpgpSink */ // enigmailMsgHdrViewOverlay.js

// TODO: check if this is safe
/* eslint-disable no-unsanitized/property */

var { openLinkExternally } = ChromeUtils.importESModule(
  "resource:///modules/LinkHelper.sys.mjs"
);
var { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  CollectedKeysDB: "chrome://openpgp/content/modules/CollectedKeysDB.sys.mjs",
  EnigmailArmor: "chrome://openpgp/content/modules/armor.sys.mjs",
  EnigmailConstants: "chrome://openpgp/content/modules/constants.sys.mjs",
  EnigmailData: "chrome://openpgp/content/modules/data.sys.mjs",
  EnigmailDecryption: "chrome://openpgp/content/modules/decryption.sys.mjs",
  EnigmailDialog: "chrome://openpgp/content/modules/dialog.sys.mjs",
  EnigmailFixExchangeMsg:
    "chrome://openpgp/content/modules/fixExchangeMsg.sys.mjs",
  EnigmailFuncs: "chrome://openpgp/content/modules/funcs.sys.mjs",
  EnigmailKey: "chrome://openpgp/content/modules/key.sys.mjs",
  EnigmailKeyRing: "chrome://openpgp/content/modules/keyRing.sys.mjs",
  EnigmailKeyServer: "chrome://openpgp/content/modules/keyserver.sys.mjs",
  EnigmailKeyserverURIs:
    "chrome://openpgp/content/modules/keyserverUris.sys.mjs",
  EnigmailMime: "chrome://openpgp/content/modules/mime.sys.mjs",
  EnigmailMsgRead: "chrome://openpgp/content/modules/msgRead.sys.mjs",
  EnigmailPersistentCrypto:
    "chrome://openpgp/content/modules/persistentCrypto.sys.mjs",
  EnigmailSingletons: "chrome://openpgp/content/modules/singletons.sys.mjs",
  EnigmailStreams: "chrome://openpgp/content/modules/streams.sys.mjs",
  EnigmailTrust: "chrome://openpgp/content/modules/trust.sys.mjs",
  EnigmailVerify: "chrome://openpgp/content/modules/mimeVerify.sys.mjs",
  EnigmailWindows: "chrome://openpgp/content/modules/windows.sys.mjs",
  getMimeTreeFromUrl: "chrome://openpgp/content/modules/MimeTree.sys.mjs",
  KeyLookupHelper: "chrome://openpgp/content/modules/keyLookupHelper.sys.mjs",
  MailStringUtils: "resource:///modules/MailStringUtils.sys.mjs",
  MimeParser: "resource:///modules/mimeParser.sys.mjs",
  PgpSqliteDb2: "chrome://openpgp/content/modules/sqliteDb.sys.mjs",
  RNP: "chrome://openpgp/content/modules/RNP.sys.mjs",
});

ChromeUtils.defineLazyGetter(this, "l10n", () => {
  return new Localization(["messenger/openpgp/openpgp.ftl"], true);
});

var Enigmail = {};

Enigmail.msg = {
  decryptedMessage: null,
  securityInfo: null,
  messagePane: null,
  decryptButton: null,
  savedHeaders: null,
  removeListener: false,
  enableExperiments: false,
  headersList: [
    "content-transfer-encoding",
    "x-enigmail-version",
    "x-pgp-encoding-format",
    //"autocrypt-setup-message",
  ],
  buggyMailType: null,
  changedAttributes: [],
  allAttachmentsDone: false,
  messageDecryptDone: false,
  showPartialDecryptionReminder: false,

  get notificationBox() {
    return gMessageNotificationBar.msgNotificationBar;
  },

  removeNotification(value) {
    const item = this.notificationBox.getNotificationWithValue(value);
    // Remove the notification only if the user didn't previously close it.
    if (item) {
      this.notificationBox.removeNotification(item, true);
    }
  },

  messengerStartup() {
    Enigmail.msg.messagePane = document.getElementById("messagepane");

    Enigmail.msg.savedHeaders = null;

    Enigmail.msg.decryptButton = document.getElementById(
      "button-enigmail-decrypt"
    );

    setTimeout(function () {
      // if nothing happened, then load all keys after 1 hour
      // to trigger the key check
      EnigmailKeyRing.getAllKeys();
    }, 3600 * 1000); // 1 hour

    // Need to add event listener to Enigmail.msg.messagePane to make it work
    // Adding to msgFrame doesn't seem to work
    Enigmail.msg.messagePane.addEventListener(
      "unload",
      Enigmail.msg.messageFrameUnload.bind(Enigmail.msg),
      true
    );

    EnigmailMsgRead.ensureExtraAddonHeaders();
    gMessageListeners.push(Enigmail.msg.messageListener);
    Enigmail.msg.messageListener.onEndHeaders();
  },

  messageListener: {
    onStartHeaders() {
      Enigmail.hdrView.reset();
      Enigmail.msg.mimeParts = null;

      /*
      if ("autocrypt" in gExpandedHeaderView) {
        delete gExpandedHeaderView.autocrypt;
      }
      */
      if ("openpgp" in gExpandedHeaderView) {
        delete gExpandedHeaderView.openpgp;
      }
    },
    onEndHeaders() {},
    onEndAttachments() {},
  },

  /*
  viewSecurityInfo(event, displaySmimeMsg) {
    if (event && event.button !== 0) {
      return;
    }

    if (gSignatureStatus >= 0 || gEncryptionStatus >= 0) {
      showMessageReadSecurityInfo();
    } else if (Enigmail.msg.securityInfo) {
      this.viewOpenpgpInfo();
    } else {
      showMessageReadSecurityInfo();
    }
  },
  */

  clearLastMessage() {
    EnigmailSingletons.clearLastDecryptedMessage();
  },

  messageReload() {
    this.clearLastMessage();
    ReloadMessage();
  },

  reloadCompleteMsg() {
    this.clearLastMessage();
    ReloadMessage();
  },

  /**
   * Handle messagePane "unload" event.
   */
  messageFrameUnload() {
    Enigmail.msg.savedHeaders = null;
    for (const value of [
      "decryptInlinePGReminder",
      "decryptInlinePG",
      "brokenExchangeProgress",
      "hasNestedEncryptedParts",
      "hasNestedSignedParts",
      "hasConflictingKeyOpenPGP",
    ]) {
      this.removeNotification(value);
    }
    Enigmail.msg.showPartialDecryptionReminder = false;

    let element = document.getElementById("openpgpKeyBox");
    if (element) {
      element.hidden = true;
    }
    element = document.getElementById("signatureKeyBox");
    if (element) {
      element.hidden = true;
      element.removeAttribute("keyid");
    }

    Enigmail.msg.securityInfo = null;

    Enigmail.msg.allAttachmentsDone = false;
    Enigmail.msg.messageDecryptDone = false;

    const cryptoBox = document.getElementById("cryptoBox");
    if (cryptoBox) {
      cryptoBox.removeAttribute("decryptDone");
    }

    Enigmail.msg.toAndCCSet = null;
    Enigmail.msg.authorEmail = "";

    Enigmail.msg.keyCollectCandidates = new Map();

    Enigmail.msg.attachedKeys = [];
    Enigmail.msg.attachedSenderEmailKeysIndex = [];

    Enigmail.msg.autoProcessPgpKeyAttachmentTransactionID++;
    Enigmail.msg.autoProcessPgpKeyAttachmentCount = 0;
    Enigmail.msg.autoProcessPgpKeyAttachmentProcessed = 0;
    Enigmail.msg.unhideMissingSigKeyBoxIsTODO = false;
    Enigmail.msg.missingSigKey = null;
    Enigmail.msg.buggyMailType = null;
  },

  getCurrentMsgUriSpec() {
    return gMessageURI || "";
  },

  getCurrentMsgUrl() {
    var uriSpec = this.getCurrentMsgUriSpec();
    return EnigmailMsgRead.getUrlFromUriSpec(uriSpec);
  },

  /**
   * Check that handler for multipart/signed is set to Enigmail.
   * if handler is different, change it and reload message.
   *
   * @returns {boolean}
   *  - true if handler is OK
   *  - false if handler was changed and message is reloaded
   */
  checkPgpmimeHandler() {
    if (
      EnigmailVerify.currentCtHandler !== EnigmailConstants.MIME_HANDLER_PGPMIME
    ) {
      EnigmailVerify.registerPGPMimeHandler();
      this.messageReload();
      return false;
    }
    return true;
  },

  async notifyMessageDecryptDone() {
    Enigmail.msg.messageDecryptDone = true;
    await Enigmail.msg.processAfterAttachmentsAndDecrypt();

    // Show the partial inline encryption reminder only if the decryption action
    // came from a partially inline encrypted message.
    if (Enigmail.msg.showPartialDecryptionReminder) {
      Enigmail.msg.showPartialDecryptionReminder = false;

      await this.notificationBox.appendNotification(
        "decryptInlinePGReminder",
        {
          label: await document.l10n.formatValue(
            "openpgp-reminder-partial-display"
          ),
          priority: this.notificationBox.PRIORITY_INFO_HIGH,
        },
        null
      );
    }
  },

  // analyse message header and decrypt/verify message
  async messageDecrypt(event, isAuto) {
    const interactive = !!event;

    this.mimeParts = null;

    let contentType = "text/plain";
    if ("content-type" in currentHeaderData) {
      contentType = currentHeaderData["content-type"].headerValue;
    }

    // don't parse message if we know it's a PGP/MIME message
    if (
      contentType.search(/^multipart\/encrypted(;|$)/i) === 0 &&
      contentType.search(/application\/pgp-encrypted/i) > 0
    ) {
      this.movePEPsubject();
      await this.messageDecryptCb(interactive, isAuto, null);
      await this.notifyMessageDecryptDone();
      return;
    } else if (
      contentType.search(/^multipart\/signed(;|$)/i) === 0 &&
      contentType.search(/application\/pgp-signature/i) > 0
    ) {
      this.movePEPsubject();
      await this.messageDecryptCb(interactive, isAuto, null);
      await this.notifyMessageDecryptDone();
      return;
    }

    const url = this.getCurrentMsgUrl();
    if (!url) {
      await Enigmail.msg.messageDecryptCb(interactive, isAuto, null);
      await Enigmail.msg.notifyMessageDecryptDone();
      return;
    }
    await new Promise(resolve => {
      getMimeTreeFromUrl(url.spec, false, async function (mimeMsg) {
        await Enigmail.msg.messageDecryptCb(interactive, isAuto, mimeMsg);
        await Enigmail.msg.notifyMessageDecryptDone();
        resolve();
      });
    });
  },

  /***
   * Walk through the (sub-) mime tree and determine PGP/MIME encrypted and
   * signed message parts
   *
   * @param {object} mimePart - Parent object to walk through (see createPartObj).
   * @param {object} resultObj - An object containing two arrays.
   * @param {string[]} resultObj.encrypted - Encrypted partNums.
   * @param {string[]} resultObj.signed - Signed partNums.
   */
  enumerateMimeParts(mimePart, resultObj) {
    try {
      var ct = mimePart.fullContentType;
      if (typeof ct == "string") {
        ct = ct.replace(/[\r\n]/g, " ");
        if (ct.search(/multipart\/signed.*application\/pgp-signature/i) >= 0) {
          resultObj.signed.push(mimePart.partNum);
        } else if (ct.search(/application\/pgp-encrypted/i) >= 0) {
          resultObj.encrypted.push(mimePart.partNum);
        }
      }
    } catch (ex) {
      // catch exception if no headers or no content-type defined.
    }

    for (const i in mimePart.subParts) {
      this.enumerateMimeParts(mimePart.subParts[i], resultObj);
    }
  },

  async messageDecryptCb(event, isAuto, mimeMsg) {
    let contentType = "";
    try {
      if (!mimeMsg) {
        try {
          contentType = currentHeaderData["content-type"].headerValue;
        } catch (ex) {
          contentType = "text/plain";
        }
        mimeMsg = {
          partNum: "1",
          headers: {
            has() {
              return false;
            },
            contentType: {
              type: contentType,
              mediatype: "",
              subtype: "",
            },
          },
          fullContentType: contentType,
          body: "",
          parent: null,
          subParts: [],
        };
      }

      // Copy selected headers
      Enigmail.msg.savedHeaders = {
        autocrypt: [],
      };

      for (const h in currentHeaderData) {
        if (h.search(/^autocrypt\d*$/) === 0) {
          Enigmail.msg.savedHeaders.autocrypt.push(
            currentHeaderData[h].headerValue
          );
        }
      }

      if (!mimeMsg.fullContentType) {
        mimeMsg.fullContentType = "text/plain";
      }

      Enigmail.msg.savedHeaders["content-type"] = mimeMsg.fullContentType;
      this.mimeParts = mimeMsg;

      for (var index = 0; index < Enigmail.msg.headersList.length; index++) {
        var headerName = Enigmail.msg.headersList[index];
        var headerValue = "";

        if (mimeMsg.headers.has(headerName)) {
          const h = mimeMsg.headers.get(headerName);
          if (Array.isArray(h)) {
            headerValue = h.join("");
          } else {
            headerValue = h;
          }
        }
        Enigmail.msg.savedHeaders[headerName] = headerValue;
      }

      var msgSigned =
        mimeMsg.fullContentType.search(/^multipart\/signed/i) === 0 &&
        EnigmailMime.getProtocol(mimeMsg.fullContentType).search(
          /^application\/pgp-signature/i
        ) === 0;
      var msgEncrypted =
        mimeMsg.fullContentType.search(/^multipart\/encrypted/i) === 0 &&
        EnigmailMime.getProtocol(mimeMsg.fullContentType).search(
          /^application\/pgp-encrypted/i
        ) === 0;

      var resultObj = {
        encrypted: [],
        signed: [],
      };
      if (mimeMsg.subParts.length > 0) {
        this.enumerateMimeParts(mimeMsg, resultObj);
        msgSigned = msgSigned || resultObj.signed.length > 0;
        msgEncrypted = msgEncrypted || resultObj.encrypted.length > 0;

        /*
        if (
          "autocrypt-setup-message" in Enigmail.msg.savedHeaders &&
          Enigmail.msg.savedHeaders["autocrypt-setup-message"].toLowerCase() ===
            "v1"
        ) {
          if (
            currentAttachments[0].contentType.search(
              /^application\/autocrypt-setup$/i
            ) === 0
          ) {
            Enigmail.hdrView.displayAutoCryptSetupMsgHeader();
            return;
          }
        }
        */

        // HACK for Zimbra OpenPGP Zimlet
        // Zimbra illegally changes attachment content-type to application/pgp-encrypted which interfers with below
        // see https://sourceforge.net/p/enigmail/bugs/600/

        try {
          if (
            mimeMsg.subParts.length > 1 &&
            mimeMsg.headers.has("x-mailer") &&
            mimeMsg.headers.get("x-mailer")[0].includes("ZimbraWebClient") &&
            mimeMsg.subParts[0].fullContentType.includes("text/plain") &&
            mimeMsg.fullContentType.includes("multipart/mixed") &&
            mimeMsg.subParts[1].fullContentType.includes(
              "application/pgp-encrypted"
            )
          ) {
            await this.messageParse(
              event,
              false,
              Enigmail.msg.savedHeaders["content-transfer-encoding"],
              this.getCurrentMsgUriSpec(),
              isAuto
            );
            return;
          }
        } catch (ex) {
          console.warn(ex);
        }

        // HACK for MS-EXCHANGE-Server Problem:
        // check for possible bad mime structure due to buggy exchange server:
        // - multipart/mixed Container with
        //   - application/pgp-encrypted Attachment with name "PGPMIME Versions Identification"
        //   - application/octet-stream Attachment with name "encrypted.asc" having the encrypted content in base64
        // - see:
        //   - http://www.mozilla-enigmail.org/forum/viewtopic.php?f=4&t=425
        //   - http://sourceforge.net/p/enigmail/forum/support/thread/4add2b69/

        // iPGMail produces a similar broken structure, see here:
        //   - https://sourceforge.net/p/enigmail/forum/support/thread/afc9c246/#5de7

        // Don't attempt to detect again, if we have already decided
        // it's a buggy exchange message (buggyMailType is already set).

        if (
          !Enigmail.msg.buggyMailType &&
          mimeMsg.subParts.length == 3 &&
          mimeMsg.fullContentType.search(/multipart\/mixed/i) >= 0 &&
          mimeMsg.subParts[0].fullContentType.search(/multipart\/encrypted/i) <
            0 &&
          mimeMsg.subParts[0].fullContentType.search(
            /(text\/(plain|html)|multipart\/alternative)/i
          ) >= 0 &&
          mimeMsg.subParts[1].fullContentType.search(
            /application\/pgp-encrypted/i
          ) >= 0
        ) {
          if (
            mimeMsg.subParts[1].fullContentType.search(
              /multipart\/encrypted/i
            ) < 0 &&
            mimeMsg.subParts[1].fullContentType.search(
              /PGP\/?MIME Versions? Identification/i
            ) >= 0 &&
            mimeMsg.subParts[2].fullContentType.search(
              /application\/octet-stream/i
            ) >= 0 &&
            mimeMsg.subParts[2].fullContentType.search(/encrypted.asc/i) >= 0
          ) {
            this.buggyMailType = "exchange";
          } else {
            this.buggyMailType = "iPGMail";
          }
          await this.buggyMailHeader();
          return;
        }
      }

      var contentEncoding = "";
      var msgUriSpec = this.getCurrentMsgUriSpec();

      if (Enigmail.msg.savedHeaders) {
        contentType = Enigmail.msg.savedHeaders["content-type"];
        contentEncoding =
          Enigmail.msg.savedHeaders["content-transfer-encoding"];
      }

      const smime =
        /^multipart\/signed/i.test(contentType) &&
        /^application\/pkcs7-signature/i.test(
          EnigmailMime.getProtocol(contentType)
        );
      if (!smime && (msgSigned || msgEncrypted)) {
        // PGP/MIME messages

        if (!Enigmail.msg.checkPgpmimeHandler()) {
          return;
        }

        // TODO Clarify: why reload?
        if (!isAuto) {
          Enigmail.msg.messageReload(false);
        }
        return;
      }

      // inline-PGP messages
      await this.messageParse(
        event,
        false,
        contentEncoding,
        msgUriSpec,
        isAuto
      );
    } catch (ex) {
      console.error("Parsing inline-PGP failed.", ex);
    }
  },

  /**
   * Display header about reparing buggy MS-Exchange messages.
   */
  async buggyMailHeader() {
    const uri = this.getCurrentMsgUrl();
    openpgpSink.updateSecurityStatus(
      0,
      0,
      0,
      "",
      "",
      "",
      "",
      "",
      uri.spec,
      "",
      "1"
    );

    // Warn that we can't fix a message that was opened from a local file.
    if (!gFolder) {
      await Enigmail.msg.notificationBox.appendNotification(
        "brokenExchange",
        {
          label: await document.l10n.formatValue(
            "openpgp-broken-exchange-opened"
          ),
          priority: Enigmail.msg.notificationBox.PRIORITY_WARNING_MEDIUM,
        },
        null
      );
      return;
    }

    const buttons = [
      {
        "l10n-id": "openpgp-broken-exchange-repair",
        popup: null,
        callback() {
          Enigmail.msg.fixBuggyExchangeMail();
          return false; // Close notification.
        },
      },
    ];

    await Enigmail.msg.notificationBox.appendNotification(
      "brokenExchange",
      {
        label: await document.l10n.formatValue("openpgp-broken-exchange-info"),
        priority: Enigmail.msg.notificationBox.PRIORITY_WARNING_MEDIUM,
      },
      buttons
    );
  },

  getFirstPGPMessageType(msgText) {
    const indexEncrypted = msgText.indexOf("-----BEGIN PGP MESSAGE-----");
    const indexSigned = msgText.indexOf("-----BEGIN PGP SIGNED MESSAGE-----");
    if (indexEncrypted >= 0) {
      if (
        indexSigned == -1 ||
        (indexSigned >= 0 && indexEncrypted < indexSigned)
      ) {
        return "encrypted";
      }
    }

    if (indexSigned >= 0) {
      return "signed";
    }

    return "";
  },

  trimIfEncrypted(msgText) {
    // If it's an encrypted message, we want to trim (at least) the
    // separator line between the header and the content.
    // However, trimming all lines should be safe.

    if (Enigmail.msg.getFirstPGPMessageType(msgText) == "encrypted") {
      // \xA0 is non-breaking-space
      msgText = msgText.replace(/^[ \t\xA0]+/gm, "");
    }
    return msgText;
  },

  async viewPacketDump() {
    if (!Enigmail.hdrView.packetDump) {
      return;
    }

    const prefix = (await l10n.formatValue("debug-log-title")) + "\n\n";

    this.setDisplayToText(prefix + Enigmail.hdrView.packetDump);
  },

  async messageParse(
    interactive,
    importOnly,
    contentEncoding,
    msgUriSpec,
    isAuto,
    pbMessageIndex = "0"
  ) {
    var bodyElement = this.getBodyElement();
    if (!bodyElement) {
      return;
    }

    const topElement = bodyElement;
    var msgText = null;
    var foundIndex = -1;

    let bodyElementFound = false;
    let hasHeadOrTailNode = false;

    if (bodyElement.firstChild) {
      let node = bodyElement.firstChild;
      while (node) {
        if (
          node.firstChild &&
          node.firstChild.nodeName.toUpperCase() == "LEGEND" &&
          node.firstChild.className == "moz-mime-attachment-header-name"
        ) {
          // we reached the area where inline attachments are displayed
          // --> don't try to decrypt displayed inline attachments
          break;
        }
        if (node.nodeName === "DIV") {
          if (bodyElementFound) {
            hasHeadOrTailNode = true;
            break;
          }

          foundIndex = node.textContent.indexOf("-----BEGIN PGP");

          if (foundIndex < 0) {
            hasHeadOrTailNode = true;
            node = node.nextSibling;
            continue;
          }

          if (
            node.textContent.indexOf("-----BEGIN PGP SIGNED MESSAGE-----") !=
              foundIndex &&
            node.textContent.indexOf("-----BEGIN PGP MESSAGE-----") !=
              foundIndex
          ) {
            foundIndex = -1;
            node = node.nextSibling;
            continue;
          }

          if (foundIndex === 0) {
            bodyElement = node;
            bodyElementFound = true;
          } else if (
            foundIndex > 0 &&
            node.textContent.substr(foundIndex - 1, 1).search(/[\r\n]/) === 0
          ) {
            bodyElement = node;
            bodyElementFound = true;
          }
        }
        node = node.nextSibling;
      }
    }

    if (foundIndex >= 0 && !this.hasInlineQuote(topElement)) {
      const beginIndex = {};
      const endIndex = {};
      const indentStr = {};

      if (
        Enigmail.msg.savedHeaders["content-type"].search(/^text\/html/i) === 0
      ) {
        const p = Cc["@mozilla.org/parserutils;1"].createInstance(
          Ci.nsIParserUtils
        );
        msgText = p.convertToPlainText(
          topElement.innerHTML,
          Ci.nsIDocumentEncoder.OutputRaw |
            Ci.nsIDocumentEncoder.OutputBodyOnly,
          0
        );
      } else {
        msgText = bodyElement.textContent;
      }

      if (!isAuto) {
        const blockType = EnigmailArmor.locateArmoredBlock(
          msgText,
          0,
          "",
          beginIndex,
          endIndex,
          indentStr
        );
        if (!blockType) {
          msgText = "";
        } else {
          msgText = msgText.substring(beginIndex.value, endIndex.value + 1);
        }
      }

      msgText = this.trimIfEncrypted(msgText);
    }

    if (!msgText) {
      // No PGP content
      return;
    }

    const charset = currentCharacterSet;
    msgText = EnigmailData.convertFromUnicode(msgText, charset);
    if (isAuto) {
      const ht =
        hasHeadOrTailNode || this.hasHeadOrTailBesidesInlinePGP(msgText);
      if (ht) {
        let infoId;
        let buttonId;
        if (
          ht & EnigmailConstants.UNCERTAIN_SIGNATURE ||
          Enigmail.msg.getFirstPGPMessageType(msgText) == "signed"
        ) {
          infoId = "openpgp-partially-signed";
          buttonId = "openpgp-partial-verify-button";
        } else {
          infoId = "openpgp-partially-encrypted";
          buttonId = "openpgp-partial-decrypt-button";
        }

        const [description, buttonLabel] = await document.l10n.formatValues([
          { id: infoId },
          { id: buttonId },
        ]);

        const buttons = [
          {
            label: buttonLabel,
            popup: null,
            callback() {
              Enigmail.msg.processOpenPGPSubset();
              return false; // Close notification.
            },
          },
        ];

        await this.notificationBox.appendNotification(
          "decryptInlinePG",
          {
            label: description,
            priority: this.notificationBox.PRIORITY_INFO_HIGH,
          },
          buttons
        );
        return;
      }
    }

    var mozPlainText = bodyElement.innerHTML.search(/class="moz-text-plain"/);

    if (mozPlainText >= 0 && mozPlainText < 40) {
      // workaround for too much expanded emoticons in plaintext msg
      var r = new RegExp(
        /( )(;-\)|:-\)|;\)|:\)|:-\(|:\(|:-\\|:-P|:-D|:-\[|:-\*|>:o|8-\)|:-\$|:-X|=-O|:-!|O:-\)|:'\()( )/g
      );
      if (msgText.search(r) >= 0) {
        // Fixing emoticons.
        msgText = msgText.replace(r, "$2");
      }
    }

    // ignoring text following armored block

    var mailNewsUrl = EnigmailMsgRead.getUrlFromUriSpec(msgUriSpec);
    var urlSpec = mailNewsUrl ? mailNewsUrl.spec : "";
    const retry = 1;

    await Enigmail.msg.messageParseCallback(
      msgText,
      EnigmailDecryption.getMsgDate(window),
      contentEncoding,
      charset,
      interactive,
      importOnly,
      urlSpec,
      "",
      retry,
      "", // head
      "", // tail
      msgUriSpec,
      isAuto,
      pbMessageIndex
    );
  },

  /**
   * @param {Node} mainNode - The node to check.
   * @returns {boolean} true if an inline quote is found
   */
  hasInlineQuote(mainNode) {
    if (mainNode.innerHTML.search(/<blockquote.*-----BEGIN PGP /i) < 0) {
      return false;
    }
    const searchQuotedPgp = function (node) {
      if (
        node.nodeName.toLowerCase() === "blockquote" &&
        node.textContent.includes("-----BEGIN PGP ")
      ) {
        return true;
      }
      if (node.firstChild && searchQuotedPgp(node.firstChild)) {
        return true;
      }

      if (node.nextSibling && searchQuotedPgp(node.nextSibling)) {
        return true;
      }
      return false;
    };
    return searchQuotedPgp(mainNode);
  },

  hasHeadOrTailBesidesInlinePGP(msgText) {
    const startIndex = msgText.search(/-----BEGIN PGP (SIGNED )?MESSAGE-----/m);
    const endIndex = msgText.indexOf("-----END PGP");
    let hasHead = false;
    let hasTail = false;
    let crypto = 0;

    if (startIndex > 0) {
      const pgpMsg = msgText.match(
        /(-----BEGIN PGP (SIGNED )?MESSAGE-----)/m
      )[0];
      if (pgpMsg.search(/SIGNED/) > 0) {
        crypto = EnigmailConstants.UNCERTAIN_SIGNATURE;
      } else {
        crypto = EnigmailConstants.DECRYPTION_FAILED;
      }
      const startSection = msgText.substr(0, startIndex - 1);
      hasHead = startSection.search(/\S/) >= 0;
    }

    if (endIndex > startIndex) {
      const nextLine = msgText.substring(endIndex).search(/[\n\r]/);
      if (nextLine > 0) {
        hasTail = msgText.substring(endIndex + nextLine).search(/\S/) >= 0;
      }
    }

    if (hasHead || hasTail) {
      return EnigmailConstants.PARTIALLY_PGP | crypto;
    }

    return 0;
  },

  async processOpenPGPSubset() {
    Enigmail.msg.showPartialDecryptionReminder = true;
    await this.messageDecrypt(null, false);
  },

  /**
   * Get the body of the message pane contentDocument.
   *
   * @returns {?HTMLBodyElement}
   */
  getBodyElement() {
    const msgFrame = document.getElementById("messagepane");
    if (!msgFrame || !msgFrame.contentDocument) {
      return null;
    }
    return msgFrame.contentDocument.getElementsByTagName("body")[0];
  },

  async messageParseCallback(
    msgText,
    msgDate,
    contentEncoding,
    charset,
    interactive,
    importOnly,
    messageUrl,
    signature,
    retry,
    head,
    tail,
    msgUriSpec,
    isAuto,
    pbMessageIndex
  ) {
    if (!msgText) {
      return;
    }

    var plainText;
    var exitCode;
    var newSignature = "";
    var statusFlags = 0;
    var extStatusFlags = 0;

    var errorMsgObj = {
      value: "",
    };
    var keyIdObj = {};
    var userIdObj = {};
    var sigDetailsObj = {};
    var extraDetailsObj = {};

    var blockSeparationObj = {
      value: "",
    };

    if (importOnly) {
      // Import public key
      await this.importKeyFromMsgBody(msgText);
      return;
    }
    // See https://www.rfc-editor.org/rfc/rfc4880#section-6
    // An implementation MAY implement this key and any
    //   translations it cares to; an implementation MAY ignore it and
    //   assume all text is UTF-8.
    const armorHeaders = EnigmailArmor.getArmorHeaders(msgText);
    if ("charset" in armorHeaders) {
      charset = armorHeaders.charset;
    }

    var exitCodeObj = {};
    var statusFlagsObj = {};
    var signatureObj = {};
    signatureObj.value = signature;

    var uiFlags = interactive
      ? EnigmailConstants.UI_INTERACTIVE |
        // EnigmailConstants.UI_ALLOW_KEY_IMPORT |
        EnigmailConstants.UI_UNVERIFIED_ENC_OK
      : 0;

    plainText = await EnigmailDecryption.decryptMessage(
      window,
      uiFlags,
      msgText,
      msgDate,
      signatureObj,
      exitCodeObj,
      statusFlagsObj,
      keyIdObj,
      userIdObj,
      sigDetailsObj,
      errorMsgObj,
      blockSeparationObj,
      extraDetailsObj
    );
    exitCode = exitCodeObj.value;
    newSignature = signatureObj.value;

    if (plainText === "" && exitCode === 0) {
      plainText = " ";
    }

    statusFlags = statusFlagsObj.value;
    extStatusFlags = statusFlagsObj.ext;

    var errorMsg = errorMsgObj.value;

    if (importOnly) {
      if (interactive && errorMsg) {
        Services.prompt.alert(window, null, errorMsg);
      }
      return;
    }

    var displayedUriSpec = Enigmail.msg.getCurrentMsgUriSpec();
    if (!msgUriSpec || displayedUriSpec == msgUriSpec) {
      if (exitCode && !statusFlags) {
        // Failure, but we don't know why it failed.
        // Peek inside msgText, and check what kind of content it is,
        // so we can show a minimal error.

        const msgType = Enigmail.msg.getFirstPGPMessageType(msgText);
        if (msgType == "encrypted") {
          statusFlags = EnigmailConstants.DECRYPTION_FAILED;
        } else if (msgType == "signed") {
          statusFlags = EnigmailConstants.BAD_SIGNATURE;
        }
      }

      Enigmail.hdrView.updatePgpStatus(
        exitCode,
        statusFlags,
        extStatusFlags,
        keyIdObj.value,
        userIdObj.value,
        sigDetailsObj.value,
        errorMsg,
        null, // blockSeparation
        extraDetailsObj.value
      );
    }

    var noSecondTry =
      EnigmailConstants.GOOD_SIGNATURE |
      EnigmailConstants.EXPIRED_SIGNATURE |
      EnigmailConstants.EXPIRED_KEY_SIGNATURE |
      EnigmailConstants.EXPIRED_KEY |
      EnigmailConstants.REVOKED_KEY |
      EnigmailConstants.NO_PUBKEY |
      EnigmailConstants.NO_SECKEY |
      EnigmailConstants.IMPORTED_KEY |
      EnigmailConstants.MISSING_PASSPHRASE |
      EnigmailConstants.BAD_PASSPHRASE |
      EnigmailConstants.UNKNOWN_ALGO |
      EnigmailConstants.DECRYPTION_OKAY |
      EnigmailConstants.OVERFLOWED;

    if (exitCode !== 0 && !(statusFlags & noSecondTry)) {
      // Bad signature/armor
      if (retry == 1) {
        msgText = MailStringUtils.stringToByteString(msgText);
        console.warn(`Retrying decrypt; retry=${retry}, msgText=${msgText}`);
        await Enigmail.msg.messageParseCallback(
          msgText,
          msgDate,
          contentEncoding,
          charset,
          interactive,
          importOnly,
          messageUrl,
          signature,
          retry + 1,
          head,
          tail,
          msgUriSpec,
          isAuto,
          pbMessageIndex
        );
        return;
      } else if (retry == 2) {
        console.warn(`Retrying decrypt; retry=${retry} - direct decrypt`);
        // Try to verify signature by accessing raw message text directly
        // (avoid recursion by setting retry parameter to false on callback)
        newSignature = "";
        await Enigmail.msg.msgDirectDecrypt(
          interactive,
          importOnly,
          contentEncoding,
          charset,
          newSignature,
          0,
          head,
          tail,
          msgUriSpec,
          msgDate,
          Enigmail.msg.messageParseCallback,
          isAuto
        );
        return;
      } else if (retry == 3) {
        msgText = MailStringUtils.stringToByteString(msgText);
        console.warn(`Retrying decrypt; retry=${retry}, msgText=${msgText}`);
        await Enigmail.msg.messageParseCallback(
          msgText,
          msgDate,
          contentEncoding,
          charset,
          interactive,
          importOnly,
          messageUrl,
          null,
          retry + 1,
          head,
          tail,
          msgUriSpec,
          isAuto,
          pbMessageIndex
        );
        return;
      }
    }

    if (!plainText) {
      // Show the subset that we cannot process, together with status.
      plainText = msgText;
    }

    if (retry >= 2) {
      plainText = EnigmailData.convertFromUnicode(
        MailStringUtils.byteStringToString(plainText),
        charset
      );
    }

    // TODO: what is blockSeparation ? How to emulate with RNP?
    /*
    if (blockSeparationObj.value.includes(" ")) {
      var blocks = blockSeparationObj.value.split(/ /);
      var blockInfo = blocks[0].split(/:/);
      plainText =
          "*Parts of the message have NOT been signed nor encrypted*",
        "\n\n" +
        plainText.substr(0, blockInfo[1]) +
        "\n\n" +
        "*Multiple message blocks found -- decryption/verification aborted*";
    }
    */

    // Save decrypted message status, headers, and content
    var headerList = {
      subject: "",
      from: "",
      date: "",
      to: "",
      cc: "",
    };

    if (!gViewAllHeaders) {
      for (let index = 0; index < headerList.length; index++) {
        headerList[index] = "";
      }
    } else {
      for (let index = 0; index < gExpandedHeaderList.length; index++) {
        headerList[gExpandedHeaderList[index].name] = "";
      }

      for (const headerName in currentHeaderData) {
        headerList[headerName] = "";
      }
    }

    for (const headerName in headerList) {
      if (currentHeaderData[headerName]) {
        headerList[headerName] = currentHeaderData[headerName].headerValue;
      }
    }

    // WORKAROUND
    if (headerList.cc == headerList.to) {
      headerList.cc = "";
    }

    var hasAttachments = currentAttachments && currentAttachments.length;
    var attachmentsEncrypted = true;

    for (const attachment of currentAttachments) {
      if (!Enigmail.msg.checkEncryptedAttach(attachment)) {
        if (
          !EnigmailMsgRead.checkSignedAttachment(attachment, currentAttachments)
        ) {
          attachmentsEncrypted = false;
        }
      }
    }

    // don't display decrypted message if message selection has changed
    displayedUriSpec = Enigmail.msg.getCurrentMsgUriSpec();
    if (msgUriSpec && displayedUriSpec && displayedUriSpec != msgUriSpec) {
      return;
    }
    let msgContent = "";
    if (hasAttachments && !attachmentsEncrypted) {
      msgContent =
        "\r\n" +
        EnigmailData.convertFromUnicode(
          l10n.formatValueSync("enig-content-note"),
          charset
        ) +
        "\r\n\r\n";
    }
    msgContent += plainText;

    msgContent = MailStringUtils.byteStringToString(msgContent, charset);
    this.setDisplayToText(msgContent);
  },

  /**
   * Replace visible message with the provided text.
   *
   * @param {string} messageContent - The content to show.
   */
  setDisplayToText(messageContent) {
    const bodyElement = Enigmail.msg.getBodyElement();
    if (!bodyElement.firstChild) {
      return;
    }

    let node = bodyElement.firstChild;
    let divFound = false;
    while (node) {
      if (node.nodeName == "DIV") {
        if (divFound) {
          node.innerHTML = "";
        } else {
          // for safety reasons, we replace the complete visible message with
          // the decrypted or signed part (bug 983)
          divFound = true;
          node.innerHTML = EnigmailFuncs.formatPlaintextMsg(messageContent);
          Enigmail.msg.movePEPsubject();
        }
      }
      node = node.nextSibling;
    }

    if (divFound) {
      return;
    }

    let preFound = false;

    // if no <DIV> node is found, try with <PRE> (bug 24762)
    node = bodyElement.firstChild;
    while (node) {
      if (node.nodeName == "PRE") {
        if (preFound) {
          node.innerHTML = "";
        } else {
          preFound = true;
          node.innerHTML = EnigmailFuncs.formatPlaintextMsg(messageContent);
          Enigmail.msg.movePEPsubject();
        }
      }
      node = node.nextSibling;
    }
  },

  async importAttachedSenderKey() {
    for (const info of Enigmail.msg.attachedSenderEmailKeysIndex) {
      await EnigmailKeyRing.importKeyDataWithConfirmation(
        window,
        [info.keyInfo],
        Enigmail.msg.attachedKeys[info.idx],
        true,
        ["0x" + info.keyInfo.fpr]
      );
    }
  },

  async searchSignatureKey() {
    const keyId = document
      .getElementById("signatureKeyBox")
      .getAttribute("keyid");
    if (!keyId) {
      return false;
    }
    return KeyLookupHelper.lookupAndImportByKeyID(
      "interactive-import",
      window,
      keyId,
      true
    );
  },

  notifySigKeyMissing(keyId) {
    Enigmail.msg.missingSigKey = keyId;
    if (
      Enigmail.msg.allAttachmentsDone &&
      Enigmail.msg.messageDecryptDone &&
      Enigmail.msg.autoProcessPgpKeyAttachmentProcessed ==
        Enigmail.msg.autoProcessPgpKeyAttachmentCount
    ) {
      Enigmail.msg.unhideMissingSigKeyBox();
    } else {
      Enigmail.msg.unhideMissingSigKeyBoxIsTODO = true;
    }
  },

  unhideMissingSigKeyBox() {
    let sigKeyIsAttached = false;
    for (const info of Enigmail.msg.attachedSenderEmailKeysIndex) {
      if (info.keyInfo.keyId == Enigmail.msg.missingSigKey) {
        sigKeyIsAttached = true;
        break;
      }
    }
    if (!sigKeyIsAttached) {
      const b = document.getElementById("signatureKeyBox");
      b.removeAttribute("hidden");
      b.setAttribute("keyid", Enigmail.msg.missingSigKey);
    }
  },

  async importKeyFromMsgBody(msgData) {
    const beginIndexObj = {};
    const endIndexObj = {};
    const indentStrObj = {};
    const blockType = EnigmailArmor.locateArmoredBlock(
      msgData,
      0,
      "",
      beginIndexObj,
      endIndexObj,
      indentStrObj
    );
    if (!blockType || blockType !== "PUBLIC KEY BLOCK") {
      return;
    }

    const keyData = msgData.substring(beginIndexObj.value, endIndexObj.value);

    const errorMsgObj = {};
    const preview = await EnigmailKey.getKeyListFromKeyBlock(
      keyData,
      errorMsgObj,
      true,
      true,
      false
    );
    if (preview && errorMsgObj.value === "") {
      await EnigmailKeyRing.importKeyDataWithConfirmation(
        window,
        preview,
        keyData,
        false
      );
    } else {
      document.l10n.formatValue("preview-failed").then(value => {
        Services.prompt.alert(window, null, value + "\n" + errorMsgObj.value);
      });
    }
  },

  /**
   * Extract the subject from the 1st content line and move it to the subject line
   */
  movePEPsubject() {
    const bodyElement = this.getBodyElement();
    if (
      bodyElement.textContent.search(/^\r?\n?Subject: [^\r\n]+\r?\n\r?\n/i) ===
        0 &&
      "subject" in currentHeaderData &&
      currentHeaderData.subject.headerValue === "pEp"
    ) {
      const m = EnigmailMime.extractSubjectFromBody(bodyElement.textContent);
      if (m) {
        let node = bodyElement.firstChild;
        let found = false;

        while (!found && node) {
          if (node.nodeName == "DIV") {
            node.innerHTML = EnigmailFuncs.formatPlaintextMsg(m.messageBody);
            found = true;
          }
          node = node.nextSibling;
        }

        // if no <DIV> node is found, try with <PRE> (bug 24762)
        node = bodyElement.firstChild;
        while (!found && node) {
          if (node.nodeName == "PRE") {
            node.innerHTML = EnigmailFuncs.formatPlaintextMsg(m.messageBody);
            found = true;
          }
          node = node.nextSibling;
        }

        Enigmail.hdrView.setSubject(m.subject, gMessage);
      }
    }
  },

  /**
   * Fix broken PGP/MIME messages from MS-Exchange by replacing the broken original
   * message with a fixed copy.
   */
  async fixBuggyExchangeMail() {
    await this.notificationBox.appendNotification(
      "brokenExchangeProgress",
      {
        label: await document.l10n.formatValue("openpgp-broken-exchange-wait"),
        priority: this.notificationBox.PRIORITY_INFO_HIGH,
      },
      null
    );

    const msg = gMessage;
    EnigmailFixExchangeMsg.fixExchangeMessage(msg, this.buggyMailType)
      .then(_msgKey => {
        // Display the new message which now has the key msgKey.
        // TODO: scope is about:message, and this doesn't work
        // parent.gDBView.selectMsgByKey(msgKey);
        // ReloadMessage();
      })
      .catch(async function () {
        Services.prompt.alert(
          window,
          null,
          await l10n.formatValue("fix-broken-exchange-msg-failed")
        );
      });

    // Remove the brokenExchangeProgress notification at the end of the process.
    this.removeNotification("brokenExchangeProgress");
  },

  // check if the attachment could be encrypted
  checkEncryptedAttach(attachment) {
    return (
      attachment.name.match(/\.(gpg|pgp|asc)$/i) ||
      (attachment.contentType.match(/^application\/pgp(-.*)?$/i) &&
        attachment.contentType.search(/^application\/pgp-signature/i) < 0)
    );
  },

  async msgDirectDecrypt(
    interactive,
    importOnly,
    contentEncoding,
    charset,
    signature,
    bufferSize,
    head,
    tail,
    msgUriSpec,
    msgDate,
    callbackFunction,
    isAuto
  ) {
    const mailNewsUrl = this.getCurrentMsgUrl();
    if (!mailNewsUrl) {
      return;
    }

    const PromiseStreamListener = function () {
      this._promise = new Promise((resolve, reject) => {
        this._resolve = resolve;
        this._reject = reject;
      });
      this._data = null;
      this._stream = null;
    };

    PromiseStreamListener.prototype = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),

      onStartRequest() {
        this.data = "";
        this.inStream = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
      },

      onStopRequest(request, statusCode) {
        if (statusCode != Cr.NS_OK) {
          this._reject(`Streaming failed: ${statusCode}`);
          return;
        }

        const start = this.data.indexOf("-----BEGIN PGP");
        let end = this.data.indexOf("-----END PGP");

        if (start >= 0 && end > start) {
          const tStr = this.data.substr(end);
          const n = tStr.indexOf("\n");
          const r = tStr.indexOf("\r");
          let lEnd = -1;
          if (n >= 0 && r >= 0) {
            lEnd = Math.min(r, n);
          } else if (r >= 0) {
            lEnd = r;
          } else if (n >= 0) {
            lEnd = n;
          }

          if (lEnd >= 0) {
            end += lEnd;
          }

          const data = Enigmail.msg.trimIfEncrypted(
            this.data.substring(start, end + 1)
          );

          const currentMsgURL = Enigmail.msg.getCurrentMsgUrl();
          const urlSpec = currentMsgURL ? currentMsgURL.spec : "";

          const l = urlSpec.length;
          if (urlSpec.substr(0, l) != mailNewsUrl.spec.substr(0, l)) {
            console.warn(`Msg url mismatch: ${currentMsgURL} vs ${urlSpec}`);
            this._reject(`Msg url mismatch: ${currentMsgURL} vs ${urlSpec}`);
            return;
          }

          Enigmail.msg
            .messageParseCallback(
              data,
              msgDate,
              contentEncoding,
              charset,
              interactive,
              importOnly,
              mailNewsUrl.spec,
              signature,
              3,
              head,
              tail,
              msgUriSpec,
              isAuto
            )
            .then(() => this._resolve(this.data));
        }
      },

      onDataAvailable(request, stream, off, count) {
        this.inStream.init(stream);
        this.data += this.inStream.read(count);
      },

      get promise() {
        return this._promise;
      },
    };

    const streamListener = new PromiseStreamListener();
    const msgSvc = MailServices.messageServiceFromURI(msgUriSpec);
    msgSvc.streamMessage(
      msgUriSpec,
      streamListener,
      top.msgWindow,
      null,
      false,
      null,
      false
    );
    await streamListener;
  },

  revealAttachments(index) {
    if (!index) {
      index = 0;
    }

    if (index < currentAttachments.length) {
      this.handleAttachment(
        "revealName/" + index.toString(),
        currentAttachments[index]
      );
    }
  },

  /**
   * Set up some event handlers for the attachment items in #attachmentList.
   */
  handleAttachmentEvent() {
    const attList = document.getElementById("attachmentList");

    for (const att of attList.itemChildren) {
      att.addEventListener("click", this.attachmentItemClick.bind(this), true);
    }
  },

  /**
   * Handle a selected attachment (decrypt & open or save).
   *
   * @param {string} actionType
   */
  handleAttachmentSel(actionType) {
    const contextMenu = document.getElementById("attachmentItemContext");
    const anAttachment = contextMenu.attachments[0];

    switch (actionType) {
      case "saveAttachment":
      case "openAttachment":
      case "importKey":
      case "revealName":
        this.handleAttachment(actionType, anAttachment);
        break;
      case "verifySig":
        this.verifyDetachedSignature(anAttachment);
        break;
    }
  },

  /**
   * Verify the signature of the given attachment, but utilizing another of
   * the messages attachments which seems to contain the signature of the
   * attachment.
   *
   * @param {AttachmentInfo} attachment - The attachment to verify.
   */
  async verifyDetachedSignature(attachment) {
    const sigAttachment = EnigmailMsgRead.checkSignedAttachment(
      attachment,
      currentAttachments
    );
    if (!sigAttachment) {
      Services.prompt.alert(
        window,
        null,
        l10n.formatValueSync("attachment-no-match-to-signature", {
          attachment: attachment.name,
        })
      );
      return;
    }
    const isEncrypted =
      /.pgp$/i.test(attachment.name) &&
      currentAttachments.some(
        a => a.name == attachment.name.replace(/\.pgp$/i, ".sig")
      );

    const outFile1 = Services.dirsvc.get("TmpD", Ci.nsIFile);
    outFile1.append(attachment.name);
    outFile1.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

    const buffer = await attachment.fetchAttachment();
    await IOUtils.write(outFile1.path, new Uint8Array(buffer));

    if (isEncrypted) {
      // Try to decrypt message if we suspect the message is encrypted.
      // If it fails we will just verify the encrypted data.
      const readBinaryFile = async () => {
        const data = await IOUtils.read(outFile1.path);
        return MailStringUtils.uint8ArrayToByteString(data);
      };
      await EnigmailDecryption.decryptAttachment(
        window,
        outFile1,
        attachment.name,
        readBinaryFile,
        {},
        {},
        {}
      );
    }

    const outFile2 = Services.dirsvc.get("TmpD", Ci.nsIFile);
    outFile2.append(sigAttachment.name);
    outFile2.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

    const buffer2 = await sigAttachment.fetchAttachment();
    await IOUtils.write(outFile2.path, new Uint8Array(buffer2));

    if (await RNP.verifyAttachment(outFile1.path, outFile2.path)) {
      Services.prompt.alert(
        window,
        null,
        l10n.formatValueSync("signature-verified-ok", {
          attachment: attachment.name,
        })
      );
    } else {
      Services.prompt.alert(
        window,
        null,
        l10n.formatValueSync("signature-verify-failed", {
          attachment: attachment.name,
        })
      );
    }

    outFile1.remove(false);
    outFile2.remove(false);
  },

  /**
   * Take action on attachments.
   *
   * @param {string} actionType - Type of action.
   * @param {AttachmentInfo} attachment - The attachment.
   */
  handleAttachment(actionType, attachment) {
    const bufferListener = EnigmailStreams.newStringStreamListener(
      async data => {
        Enigmail.msg.decryptAttachmentCallback(actionType, attachment, data);
      }
    );
    const msgUri = Services.io.newURI(attachment.url);
    const channel = EnigmailStreams.createChannel(msgUri);
    channel.asyncOpen(bufferListener, msgUri);
  },

  setAttachmentName(attachment, newLabel, index) {
    var attList = document.getElementById("attachmentList");
    if (attList) {
      var attNode = attList.firstChild;
      while (attNode) {
        if (attNode.getAttribute("name") == attachment.name) {
          attNode.setAttribute("name", newLabel);
        }
        attNode = attNode.nextSibling;
      }
    }

    if (typeof attachment.displayName == "undefined") {
      attachment.name = newLabel;
    } else {
      attachment.displayName = newLabel;
    }

    if (index && index.length > 0) {
      this.revealAttachments(parseInt(index, 10) + 1);
    }
  },

  /**
   * Decrypt attachment callback.
   *
   * @param {string} actionType
   * @param {AttachmentInfo} attachment
   * @param {string} data
   */
  async decryptAttachmentCallback(actionType, attachment, data) {
    var exitCodeObj = {};
    var statusFlagsObj = {};
    var errorMsgObj = {};
    var exitStatus = -1;

    var outFile;
    const rawFileName = attachment.name.replace(/\.(asc|pgp|gpg)$/i, "");

    if (actionType == "saveAttachment") {
      const title = l10n.formatValueSync("save-attachment-header");
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker
      );
      fp.init(window.browsingContext, title, Ci.nsIFilePicker.modeSave);
      fp.defaultString = rawFileName;
      try {
        const lastSaveDir = Services.prefs.getComplexValue(
          "messenger.save.dir",
          Ci.nsIFile
        );
        fp.displayDirectory = lastSaveDir;
      } catch (e) {} // Pref may not be set, yet.
      fp.appendFilters(Ci.nsIFilePicker.filterAll);
      const rv = await new Promise(resolve => fp.open(resolve));
      if (rv == Ci.nsIFilePicker.returnCancel || !fp.file) {
        return;
      }
      Services.prefs.setComplexValue(
        "messenger.save.dir",
        Ci.nsIFile,
        fp.file.parent
      );
      outFile = fp.file;
    } else if (actionType.substr(0, 10) == "revealName") {
      // TODO: We don't have code yet to extract the original filename
      // from an encrypted data block.
      const origFilename = attachment.name;
      Enigmail.msg.setAttachmentName(
        attachment,
        origFilename + ".pgp",
        actionType.substr(11, 10)
      );
      return;
    } else {
      // open
      outFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
      outFile.append(rawFileName);
      outFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    }

    if (actionType == "importKey") {
      var preview = await EnigmailKey.getKeyListFromKeyBlock(
        data,
        errorMsgObj,
        true,
        true,
        false
      );

      if (errorMsgObj.value !== "" || !preview || preview.length === 0) {
        // try decrypting the attachment
        exitStatus = await EnigmailDecryption.decryptAttachment(
          window,
          outFile,
          attachment.name,
          data,
          exitCodeObj,
          statusFlagsObj,
          errorMsgObj
        );
        if (exitStatus && exitCodeObj.value === 0) {
          // success decrypting, let's try again
          data = String.fromCharCode(...(await IOUtils.read(outFile.path)));
          preview = await EnigmailKey.getKeyListFromKeyBlock(
            data,
            errorMsgObj,
            true,
            true,
            false
          );
        }
      }

      if (preview && errorMsgObj.value === "") {
        await EnigmailKeyRing.importKeyDataWithConfirmation(
          window,
          preview,
          data,
          false
        );
      } else {
        document.l10n.formatValue("preview-failed").then(value => {
          Services.prompt.alert(window, null, value + "\n" + errorMsgObj.value);
        });
      }
      outFile.remove(true);
      return;
    }

    exitStatus = await EnigmailDecryption.decryptAttachment(
      window,
      outFile,
      attachment.name,
      data,
      exitCodeObj,
      statusFlagsObj,
      errorMsgObj
    );

    if (!exitStatus || exitCodeObj.value !== 0) {
      exitStatus = false;
      if (
        statusFlagsObj.value & EnigmailConstants.DECRYPTION_OKAY &&
        statusFlagsObj.value & EnigmailConstants.UNCERTAIN_SIGNATURE
      ) {
        if (actionType == "openAttachment") {
          const [title, button] = await document.l10n.formatValues([
            { id: "decrypt-ok-no-sig" },
            { id: "msg-ovl-button-cont-anyway" },
          ]);

          exitStatus = !Services.prompt.confirmEx(
            window,
            null,
            title,
            Services.prompt.STD_OK_CANCEL_BUTTONS,
            button,
            null,
            null,
            null,
            {}
          );
        } else {
          Services.prompt.alert(
            window,
            null,
            await document.l10n.formatValue("decrypt-ok-no-sig")
          );
        }
      } else {
        let msg = await document.l10n.formatValue("failed-decrypt");
        if (errorMsgObj.errorMsg) {
          msg += "\n\n" + errorMsgObj.errorMsg;
        }
        Services.prompt.alert(window, null, msg);
        exitStatus = false;
      }
    }
    if (exitStatus) {
      if (statusFlagsObj.value & EnigmailConstants.IMPORTED_KEY) {
        if (exitCodeObj.keyList) {
          const importKeyList = exitCodeObj.keyList.map(a => a.id);
          EnigmailDialog.keyImportDlg(window, importKeyList);
        }
      } else if (statusFlagsObj.value & EnigmailConstants.DISPLAY_MESSAGE) {
        HandleSelectedAttachments("open");
      } else if (
        statusFlagsObj.value & EnigmailConstants.DISPLAY_MESSAGE ||
        actionType == "openAttachment"
      ) {
        const outFileUri = Services.io.newFileURI(outFile);
        const fileExt = outFile.leafName.replace(/(.*\.)(\w+)$/, "$2");
        if (fileExt) {
          Cc["@mozilla.org/uriloader/external-helper-app-service;1"]
            .getService(Ci.nsPIExternalAppLauncher)
            .deleteTemporaryFileOnExit(outFile);

          try {
            const mimeService = Cc["@mozilla.org/mime;1"].getService(
              Ci.nsIMIMEService
            );
            const fileMimeType = mimeService.getTypeFromFile(outFile);
            const fileMimeInfo = mimeService.getFromTypeAndExtension(
              fileMimeType,
              fileExt
            );
            fileMimeInfo.launchWithFile(outFile);
          } catch (ex) {
            // if the attachment file type is unknown, an exception is thrown,
            // so let it be handled by a browser window
            openLinkExternally(outFileUri.asciiSpec, { addToHistory: false });
          }
        } else {
          // open the attachment using an external application
          openLinkExternally(outFileUri.asciiSpec, { addToHistory: false });
        }
      }
    }
  },

  /**
   * Open an encrypted attachment item.
   */
  attachmentItemClick(event) {
    const attachment = event.currentTarget.attachment;
    if (this.checkEncryptedAttach(attachment)) {
      if (event.button === 0 && event.detail == 2) {
        // double click
        this.handleAttachment("openAttachment", attachment);
        event.stopPropagation();
      }
    }
  },

  async searchKeysOnInternet(event) {
    return KeyLookupHelper.lookupAndImportByEmail(
      "interactive-import",
      window,
      event.currentTarget.parentNode.headerField?.emailAddress,
      true
    );
  },

  /**
   * Process key data from a message.
   *
   * @param {string} keyData - The key data.
   * @param {boolean} isBinaryAutocrypt - false if ASCII armored data.
   * @param {string} [description] - Key source description, if any.
   */
  async commonProcessAttachedKey(keyData, isBinaryAutocrypt, description) {
    if (!keyData) {
      return;
    }

    // Processing is slow for some types of keys.
    // We want to avoid automatic key import/updates for users who
    // have OpenPGP disabled (no account has an OpenPGP key configured).
    if (
      !MailServices.accounts.allIdentities.find(id =>
        id.getUnicharAttribute("openpgp_key_id")
      )
    ) {
      return;
    }

    const errorMsgObj = {};
    const preview = await EnigmailKey.getKeyListFromKeyBlock(
      keyData,
      errorMsgObj,
      true,
      true,
      false,
      true
    );

    // If we cannot analyze the keyblock, or if it's empty, or if we
    // got an error message, then the key is bad and shouldn't be used.
    if (!preview || !preview.length || errorMsgObj.value) {
      return;
    }

    this.fetchParticipants();

    for (const newKey of preview) {
      const oldKey = EnigmailKeyRing.getKeyById(newKey.fpr);
      if (!oldKey) {
        // If the key is unknown, an expired key cannot help us
        // for anything new, so don't use it.
        if (newKey.keyTrust == "e") {
          continue;
        }

        // Potentially merge the revocation into CollectedKeysDB, it if
        // already has that key.
        if (newKey.keyTrust == "r") {
          const db = await CollectedKeysDB.getInstance();
          const existing = await db.findKeyForFingerprint(newKey.fpr);
          if (existing) {
            const key = await db.mergeExisting(newKey, newKey.pubKey, {
              uri: `mid:${gMessage.messageId}`,
              type: isBinaryAutocrypt ? "autocrypt" : "attachment",
              description,
            });
            await db.storeKey(key);
            Services.obs.notifyObservers(null, "openpgp-key-change");
          }
          continue;
        }

        // It doesn't make sense to import a public key,
        // if we have a secret key for that email address.
        // Because, if we are the owner of that email address, why would
        // we need a public key referring to our own email address,
        // sent to us by someone else?

        let keyInOurName = false;
        for (const userId of newKey.userIds) {
          if (userId.type !== "uid") {
            continue;
          }
          if (EnigmailTrust.isInvalid(userId.keyTrust)) {
            continue;
          }
          if (
            await EnigmailKeyRing.hasSecretKeyForEmail(
              EnigmailFuncs.getEmailFromUserID(userId.userId).toLowerCase()
            )
          ) {
            keyInOurName = true;
            break;
          }
        }
        if (keyInOurName) {
          continue;
        }

        // Only advertise the key for import if it contains a user ID
        // that points to the email author email address.
        let relatedParticipantEmailAddress = null;
        if (this.hasUserIdForEmail(newKey.userIds, this.authorEmail)) {
          relatedParticipantEmailAddress = this.authorEmail;
        }

        if (relatedParticipantEmailAddress) {
          // If it's a non expired, non revoked new key, in the email
          // author's name (email address match), then offer it for
          // manual (immediate) import.
          const nextIndex = Enigmail.msg.attachedKeys.length;
          const info = {
            fpr: "0x" + newKey.fpr,
            idx: nextIndex,
            keyInfo: newKey,
            binary: isBinaryAutocrypt,
          };
          Enigmail.msg.attachedSenderEmailKeysIndex.push(info);
          Enigmail.msg.attachedKeys.push(newKey.pubKey);
        }

        // We want to collect keys for potential later use, however,
        // we also want to avoid that an attacker can send us a large
        // number of keys to poison our cache, so we only collect keys
        // that are related to the author or one of the recipients.
        // Also, we don't want a public key, if we already have a
        // secret key for that email address.

        if (!relatedParticipantEmailAddress) {
          // Not related to the author
          for (const toOrCc of this.toAndCCSet) {
            if (this.hasUserIdForEmail(newKey.userIds, toOrCc)) {
              // Might be ok to import, so remember to which email
              // the key is related and leave the loop.
              relatedParticipantEmailAddress = toOrCc;
              break;
            }
          }
        }

        if (relatedParticipantEmailAddress) {
          // It seems OK to import, however, don't import yet.
          // Wait until after we have processed all attachments to
          // the current message. Because we don't want to import
          // multiple keys for the same email address, that wouldn't
          // make sense. Remember the import candidate, and postpone
          // until we are done looking at all attachments.

          if (this.keyCollectCandidates.has(relatedParticipantEmailAddress)) {
            // The email contains more than one public key for this
            // email address.
            this.keyCollectCandidates.set(relatedParticipantEmailAddress, {
              skip: true,
            });
          } else {
            const candidate = {};
            candidate.skip = false;
            candidate.newKeyObj = newKey;
            candidate.pubKey = newKey.pubKey;
            candidate.source = {
              uri: `mid:${gMessage.messageId}`,
              type: isBinaryAutocrypt ? "autocrypt" : "attachment",
              description,
            };
            this.keyCollectCandidates.set(
              relatedParticipantEmailAddress,
              candidate
            );
          }
        }

        // done with processing for new keys (!oldKey)
        continue;
      }

      // The key is known (we have an oldKey), then it makes sense to
      // import, even if it's expired/revoked, to learn about the
      // changed validity.

      // Also, we auto import/merge such keys, even if the sender
      // doesn't match any key user ID. Why is this useful?
      // If I am Alice, and the email is from Bob, the email could have
      // Charlie's revoked or extended key attached. It's useful for
      // me to learn that.

      // User IDs are another reason. The key might contain a new
      // additional user ID, or a revoked user ID.
      // That's relevant for Autocrypt headers, which only have one user
      // ID. If we had imported the key with just one user ID in the
      // past, and now we're being sent the same key for a different
      // user ID, we must not skip it, even if it the validity is the
      // same.
      // Let's update on all possible changes of the user ID list,
      // additions, removals, differences.

      let shouldUpdate = false;

      // new validity?
      if (
        oldKey.expiryTime < newKey.expiryTime ||
        (oldKey.keyTrust != "r" && newKey.keyTrust == "r")
      ) {
        shouldUpdate = true;
      } else if (
        oldKey.userIds.length != newKey.userIds.length ||
        !oldKey.userIds.every((el, ix) => el === newKey.userIds[ix])
      ) {
        shouldUpdate = true;
      }

      if (!shouldUpdate) {
        continue;
      }

      if (
        !(await EnigmailKeyRing.importKeyDataSilent(
          window,
          newKey.pubKey,
          isBinaryAutocrypt,
          "0x" + newKey.fpr
        ))
      ) {
        console.warn(`Silent import failed for key 0x${newKey.fpr}`);
      }
    }
  },

  /**
   * Show the import key notification.
   */
  async unhideImportKeyBox() {
    Enigmail.hdrView.notifyHasKeyAttached();
    document.getElementById("openpgpKeyBox").removeAttribute("hidden");

    // Check if the proposed key to import was previously accepted.
    const hasAreadyAcceptedOther =
      await PgpSqliteDb2.hasAnyPositivelyAcceptedKeyForEmail(
        Enigmail.msg.authorEmail
      );
    if (hasAreadyAcceptedOther) {
      await Enigmail.msg.notificationBox.appendNotification(
        "hasConflictingKeyOpenPGP",
        {
          label: await document.l10n.formatValue("openpgp-be-careful-new-key", {
            email: Enigmail.msg.authorEmail,
          }),
          priority: Enigmail.msg.notificationBox.PRIORITY_INFO_HIGH,
        },
        null
      );
    }
  },

  /*
   * This function is called from several places. Any call may trigger
   * the final processing for this message, it depends on the amount
   * of attachments present, and whether we decrypt immediately, or
   * after a delay (for inline encryption).
   */
  async processAfterAttachmentsAndDecrypt() {
    // Return early if message processing isn't ready yet.
    if (!Enigmail.msg.allAttachmentsDone || !Enigmail.msg.messageDecryptDone) {
      return;
    }

    // Return early if we haven't yet processed all attachments.
    if (
      Enigmail.msg.autoProcessPgpKeyAttachmentProcessed <
      Enigmail.msg.autoProcessPgpKeyAttachmentCount
    ) {
      return;
    }

    if (Enigmail.msg.unhideMissingSigKeyBoxIsTODO) {
      Enigmail.msg.unhideMissingSigKeyBox();
    }

    // We have already processed all attached pgp-keys, we're ready
    // to make final decisions on how to notify the user about
    // available or missing keys.
    // If we already found a good key for the sender's email
    // in attachments, then don't look at the autocrypt header.
    if (Enigmail.msg.attachedSenderEmailKeysIndex.length) {
      this.unhideImportKeyBox();
    } else if (
      Enigmail.msg.savedHeaders &&
      "autocrypt" in Enigmail.msg.savedHeaders &&
      Enigmail.msg.savedHeaders.autocrypt.length > 0 &&
      "from" in currentHeaderData
    ) {
      const fromAddr = EnigmailFuncs.stripEmail(
        currentHeaderData.from.headerValue
      ).toLowerCase();
      // There might be multiple headers, we only want the one
      // matching the sender's address.
      for (const ac of Enigmail.msg.savedHeaders.autocrypt) {
        const acAddr = MimeParser.getParameter(ac, "addr");
        if (fromAddr == acAddr) {
          let senderAutocryptKey;
          try {
            senderAutocryptKey = atob(
              MimeParser.getParameter(ac.replace(/ /g, ""), "keydata")
            );
          } catch {}
          if (senderAutocryptKey) {
            // Make sure to let the message load before doing potentially *very*
            // time consuming auto processing (seconds!?).
            await new Promise(resolve => ChromeUtils.idleDispatch(resolve));
            await this.commonProcessAttachedKey(senderAutocryptKey, true);

            if (Enigmail.msg.attachedSenderEmailKeysIndex.length) {
              this.unhideImportKeyBox();
            }
          }
        }
      }
    }

    for (const gossipKey of EnigmailSingletons.lastDecryptedMessage.gossip) {
      await this.commonProcessAttachedKey(gossipKey, true);
    }

    if (this.keyCollectCandidates && this.keyCollectCandidates.size) {
      const db = await CollectedKeysDB.getInstance();

      for (const candidate of this.keyCollectCandidates.values()) {
        if (candidate.skip) {
          continue;
        }
        // If key is known in the db: merge + update.
        const key = await db.mergeExisting(
          candidate.newKeyObj,
          candidate.pubKey,
          candidate.source
        );

        await db.storeKey(key);
        Services.obs.notifyObservers(null, "openpgp-key-change");
      }
    }

    // Should we notify the user about available encrypted nested parts,
    // which have not been automatically decrypted?
    if (
      EnigmailSingletons.isRecentUriWithNestedEncryptedPart(
        Enigmail.msg.getCurrentMsgUriSpec()
      )
    ) {
      const buttons = [
        {
          "l10n-id": "openpgp-show-encrypted-parts",
          popup: null,
          callback() {
            top.viewEncryptedPart(Enigmail.msg.getCurrentMsgUriSpec());
            return true; // keep notification
          },
        },
      ];

      await Enigmail.msg.notificationBox
        .appendNotification(
          "hasNestedEncryptedParts",
          {
            label: await document.l10n.formatValue(
              "openpgp-has-nested-encrypted-parts"
            ),
            priority: Enigmail.msg.notificationBox.PRIORITY_INFO_HIGH,
          },
          buttons
        )
        .catch(console.warn);
    }

    document.dispatchEvent(
      new CustomEvent("openpgpprocessed", {
        detail: { messageDecryptDone: true },
      })
    );

    // Should we notify the user about available signed nested parts?
    if (
      EnigmailSingletons.isRecentUriWithNestedSignedPart(
        Enigmail.msg.getCurrentMsgUriSpec()
      )
    ) {
      const buttons = [
        {
          "l10n-id": "openpgp-show-signed-parts",
          popup: null,
          callback() {
            top.viewSignedPart(Enigmail.msg.getCurrentMsgUriSpec());
            return true; // keep notification
          },
        },
      ];

      Enigmail.msg.notificationBox.appendNotification(
        "hasNestedSignedParts",
        {
          label: { "l10n-id": "openpgp-has-nested-signed-parts" },
          priority: Enigmail.msg.notificationBox.PRIORITY_INFO_HIGH,
        },
        buttons
      );
    }
  },

  async notifyEndAllAttachments() {
    Enigmail.msg.allAttachmentsDone = true;

    if (!Enigmail.msg.autoProcessPgpKeyAttachmentCount) {
      await Enigmail.msg.processAfterAttachmentsAndDecrypt();
    }
  },

  toAndCCSet: null,
  authorEmail: "",

  // Used to remember the list of keys that we might want to add to
  // our cache of seen keys. Will be used after we are done looking
  // at all attachments.
  keyCollectCandidates: new Map(),

  attachedKeys: [],
  attachedSenderEmailKeysIndex: [], // each: {idx (to-attachedKeys), keyInfo, binary}

  fetchParticipants() {
    if (this.toAndCCSet) {
      return;
    }

    // toAndCCSet non-null indicates that we already fetched.
    this.toAndCCSet = new Set();

    // This message may have already disappeared.
    if (!gMessage) {
      return;
    }

    let addresses = MailServices.headerParser.parseEncodedHeader(
      gMessage.author
    );
    if (addresses.length) {
      this.authorEmail = addresses[0].email.toLowerCase();
    }

    addresses = MailServices.headerParser.parseEncodedHeader(
      gMessage.recipients + "," + gMessage.ccList
    );
    for (const addr of addresses) {
      this.toAndCCSet.add(addr.email.toLowerCase());
    }
  },

  hasUserIdForEmail(userIds, authorEmail) {
    authorEmail = authorEmail.toLowerCase();

    for (const id of userIds) {
      if (id.type !== "uid") {
        continue;
      }

      if (
        EnigmailFuncs.getEmailFromUserID(id.userId).toLowerCase() == authorEmail
      ) {
        return true;
      }
    }
    return false;
  },

  autoProcessPgpKeyAttachmentTransactionID: 0,
  autoProcessPgpKeyAttachmentCount: 0,
  autoProcessPgpKeyAttachmentProcessed: 0,
  unhideMissingSigKeyBoxIsTODO: false,
  unhideMissingSigKey: null,

  autoProcessPgpKeyAttachment(attachment) {
    if (
      attachment.contentType != "application/pgp-keys" &&
      !attachment.name.endsWith(".asc")
    ) {
      return;
    }

    Enigmail.msg.autoProcessPgpKeyAttachmentCount++;

    const bufferListener = EnigmailStreams.newStringStreamListener(
      async data => {
        // Make sure to let the message load before doing potentially *very*
        // time consuming auto processing (seconds!?).
        await new Promise(resolve => ChromeUtils.idleDispatch(resolve));
        await this.commonProcessAttachedKey(data, false, attachment.name);
        Enigmail.msg.autoProcessPgpKeyAttachmentProcessed++;
        if (
          Enigmail.msg.autoProcessPgpKeyAttachmentProcessed ==
          Enigmail.msg.autoProcessPgpKeyAttachmentCount
        ) {
          await Enigmail.msg.processAfterAttachmentsAndDecrypt();
        }
      }
    );
    const msgUri = Services.io.newURI(attachment.url);
    const channel = EnigmailStreams.createChannel(msgUri);
    channel.asyncOpen(bufferListener, msgUri);
  },

  /**
   * Populate the message security popup panel with OpenPGP data.
   */
  async loadOpenPgpMessageSecurityInfo() {
    let sigInfoWithDateLabel = null;
    let sigInfoLabel = null;
    let sigInfo = null;
    let sigClass = null;
    let wantToShowDate = false;

    // All scenarios that set wantToShowDate to true should set both
    // sigInfoWithDateLabel and sigInfoLabel, to ensure we have a
    // fallback label, if the date is unavailable.
    switch (Enigmail.hdrView.msgSignatureState) {
      case EnigmailConstants.MSG_SIG_NONE:
        sigInfoLabel = "openpgp-no-sig";
        sigClass = "none";
        sigInfo = "openpgp-no-sig-info";
        break;

      case EnigmailConstants.MSG_SIG_UNCERTAIN_KEY_UNAVAILABLE:
        sigInfoLabel = "openpgp-uncertain-sig";
        sigClass = "unknown";
        sigInfo = "openpgp-sig-uncertain-no-key";
        break;

      case EnigmailConstants.MSG_SIG_UNCERTAIN_UID_MISMATCH:
        sigInfoLabel = "openpgp-uncertain-sig";
        sigInfoWithDateLabel = "openpgp-uncertain-sig-with-date";
        wantToShowDate = true;
        sigClass = "mismatch";
        sigInfo = "openpgp-sig-uncertain-uid-mismatch";
        break;

      case EnigmailConstants.MSG_SIG_UNCERTAIN_KEY_NOT_ACCEPTED:
        sigInfoLabel = "openpgp-uncertain-sig";
        sigInfoWithDateLabel = "openpgp-uncertain-sig-with-date";
        wantToShowDate = true;
        sigClass = "unknown";
        sigInfo = "openpgp-sig-uncertain-not-accepted";
        break;

      case EnigmailConstants.MSG_SIG_INVALID_KEY_REJECTED:
        sigInfoLabel = "openpgp-invalid-sig";
        sigInfoWithDateLabel = "openpgp-invalid-sig-with-date";
        wantToShowDate = true;
        sigClass = "mismatch";
        sigInfo = "openpgp-sig-invalid-rejected";
        break;

      case EnigmailConstants.MSG_SIG_INVALID_DATE_MISMATCH:
        sigInfoLabel = "openpgp-bad-date-sig";
        sigInfoWithDateLabel = "openpgp-bad-date-sig-with-date";
        wantToShowDate = true;
        sigClass = "mismatch";
        sigInfo = "openpgp-sig-invalid-date-mismatch";
        break;

      case EnigmailConstants.MSG_SIG_INVALID:
        sigInfoLabel = "openpgp-invalid-sig";
        sigInfoWithDateLabel = "openpgp-invalid-sig-with-date";
        wantToShowDate = true;
        sigClass = "mismatch";
        sigInfo = "openpgp-sig-invalid-technical-problem";
        break;

      case EnigmailConstants.MSG_SIG_VALID_KEY_UNVERIFIED:
        sigInfoLabel = "openpgp-good-sig";
        sigInfoWithDateLabel = "openpgp-good-sig-with-date";
        wantToShowDate = true;
        sigClass = "unverified";
        sigInfo = "openpgp-sig-valid-unverified";
        break;

      case EnigmailConstants.MSG_SIG_VALID_KEY_VERIFIED:
        sigInfoLabel = "openpgp-good-sig";
        sigInfoWithDateLabel = "openpgp-good-sig-with-date";
        wantToShowDate = true;
        sigClass = "verified";
        sigInfo = "openpgp-sig-valid-verified";
        break;

      case EnigmailConstants.MSG_SIG_VALID_SELF:
        sigInfoLabel = "openpgp-good-sig";
        sigInfoWithDateLabel = "openpgp-good-sig-with-date";
        wantToShowDate = true;
        sigClass = "ok";
        sigInfo = "openpgp-sig-valid-own-key";
        break;

      default:
        console.error(
          "Unexpected msgSignatureState: " + Enigmail.hdrView.msgSignatureState
        );
    }

    const signatureLabel = document.getElementById("signatureLabel");
    if (wantToShowDate && Enigmail.hdrView.msgSignatureDate) {
      const date = new Services.intl.DateTimeFormat(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(Enigmail.hdrView.msgSignatureDate);
      document.l10n.setAttributes(signatureLabel, sigInfoWithDateLabel, {
        date,
      });
    } else {
      document.l10n.setAttributes(signatureLabel, sigInfoLabel);
    }

    // Remove the second class to properly update the signature icon.
    signatureLabel.classList.remove(signatureLabel.classList.item(1));
    signatureLabel.classList.add(sigClass);

    const signatureExplanation = document.getElementById(
      "signatureExplanation"
    );
    // eslint-disable-next-line mozilla/prefer-formatValues
    signatureExplanation.textContent = await document.l10n.formatValue(sigInfo);

    let encInfoLabel = null;
    let encInfo = null;
    let encClass = null;

    switch (Enigmail.hdrView.msgEncryptionState) {
      case EnigmailConstants.MSG_ENC_NONE:
        encInfoLabel = "openpgp-enc-none";
        encInfo = "openpgp-enc-none-label";
        encClass = "none";
        break;

      case EnigmailConstants.MSG_ENC_NO_SECRET_KEY:
        encInfoLabel = "openpgp-enc-invalid-label";
        encInfo = "openpgp-enc-invalid";
        encClass = "notok";
        break;

      case EnigmailConstants.MSG_ENC_FAILURE:
        encInfoLabel = "openpgp-enc-invalid-label";
        encInfo = "openpgp-enc-clueless";
        encClass = "notok";
        break;

      case EnigmailConstants.MSG_ENC_OK:
        encInfoLabel = "openpgp-enc-valid-label";
        encInfo = "openpgp-enc-valid";
        encClass = "ok";
        break;

      default:
        console.error(
          "Unexpected msgEncryptionState: " +
            Enigmail.hdrView.msgEncryptionState
        );
    }

    document.getElementById("techLabel").textContent = "- OpenPGP";

    const encryptionLabel = document.getElementById("encryptionLabel");
    // eslint-disable-next-line mozilla/prefer-formatValues
    encryptionLabel.textContent = await document.l10n.formatValue(encInfoLabel);

    // Remove the second class to properly update the encryption icon.
    encryptionLabel.classList.remove(encryptionLabel.classList.item(1));
    encryptionLabel.classList.add(encClass);

    document.getElementById("encryptionExplanation").textContent =
      // eslint-disable-next-line mozilla/prefer-formatValues
      await document.l10n.formatValue(encInfo);

    document.getElementById("packetDumpView").hidden =
      !Enigmail.hdrView.packetDump;

    if (Enigmail.hdrView.msgSignatureKeyId) {
      const sigKeyInfo = EnigmailKeyRing.getKeyById(
        Enigmail.hdrView.msgSignatureKeyId
      );

      document.getElementById("signatureKey").collapsed = false;

      if (
        sigKeyInfo &&
        sigKeyInfo.keyId != Enigmail.hdrView.msgSignatureKeyId
      ) {
        document.l10n.setAttributes(
          document.getElementById("signatureKeyId"),
          "openpgp-sig-key-id-with-subkey-id",
          {
            key: `0x${sigKeyInfo.keyId}`,
            subkey: `0x${Enigmail.hdrView.msgSignatureKeyId}`,
          }
        );
      } else {
        document.l10n.setAttributes(
          document.getElementById("signatureKeyId"),
          "openpgp-sig-key-id",
          {
            key: `0x${Enigmail.hdrView.msgSignatureKeyId}`,
          }
        );
      }

      if (sigKeyInfo) {
        document.getElementById("viewSignatureKey").collapsed = false;
      }
    }

    let myIdToSkipInList;
    if (
      Enigmail.hdrView.msgEncryptionKeyId &&
      Enigmail.hdrView.msgEncryptionKeyId.keyId
    ) {
      myIdToSkipInList = Enigmail.hdrView.msgEncryptionKeyId.keyId;

      // If we were given a separate primaryKeyId, it means keyId is a subkey.
      const havePrimaryId = !!Enigmail.hdrView.msgEncryptionKeyId.primaryKeyId;
      document.getElementById("encryptionKey").collapsed = false;

      if (havePrimaryId) {
        document.l10n.setAttributes(
          document.getElementById("encryptionKeyId"),
          "openpgp-enc-key-with-subkey-id",
          {
            key: `0x${Enigmail.hdrView.msgEncryptionKeyId.primaryKeyId}`,
            subkey: `0x${Enigmail.hdrView.msgEncryptionKeyId.keyId}`,
          }
        );
      } else {
        document.l10n.setAttributes(
          document.getElementById("encryptionKeyId"),
          "openpgp-enc-key-id",
          {
            key: `0x${Enigmail.hdrView.msgEncryptionKeyId.keyId}`,
          }
        );
      }

      if (
        EnigmailKeyRing.getKeyById(Enigmail.hdrView.msgEncryptionKeyId.keyId)
      ) {
        document.getElementById("viewEncryptionKey").collapsed = false;
      }
    }

    const otherLabel = document.getElementById("otherLabel");
    if (myIdToSkipInList) {
      document.l10n.setAttributes(
        otherLabel,
        "openpgp-other-enc-additional-key-ids"
      );
    } else {
      document.l10n.setAttributes(otherLabel, "openpgp-other-enc-all-key-ids");
    }

    if (!Enigmail.hdrView.msgEncryptionAllKeyIds) {
      return;
    }

    const keyList = document.getElementById("otherEncryptionKeysList");
    // Remove all the previously populated keys.
    while (keyList.lastChild) {
      keyList.removeChild(keyList.lastChild);
    }

    let showExtraKeysList = false;
    for (const key of Enigmail.hdrView.msgEncryptionAllKeyIds) {
      if (key.keyId == myIdToSkipInList) {
        continue;
      }

      const container = document.createXULElement("vbox");
      container.classList.add("other-key-row");

      const havePrimaryId2 = !!key.primaryKeyId;
      const keyInfo = EnigmailKeyRing.getKeyById(
        havePrimaryId2 ? key.primaryKeyId : key.keyId
      );

      // Use textContent for label XUl elements to enable text wrapping.

      if (keyInfo?.userId) {
        const name = document.createXULElement("label");
        name.classList.add("openpgp-key-name");
        name.setAttribute("context", "simpleCopyPopup");
        name.textContent = keyInfo.userId;
        container.appendChild(name);
      }

      const id = document.createXULElement("label");
      id.setAttribute("context", "simpleCopyPopup");
      id.classList.add("openpgp-key-id");
      id.textContent = havePrimaryId2
        ? ` 0x${key.primaryKeyId} (0x${key.keyId})`
        : ` 0x${key.keyId}`;
      container.appendChild(id);

      keyList.appendChild(container);
      showExtraKeysList = true;
    }

    // Show extra keys if present in the message.
    document.getElementById("otherEncryptionKeys").collapsed =
      !showExtraKeysList;
  },
};
