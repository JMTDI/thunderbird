/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

"use strict";

/* import-globals-from ../../../../components/compose/content/MsgComposeCommands.js */
/* import-globals-from ../../../../components/compose/content/addressingWidgetOverlay.js */
/* global MsgAccountManager */
/* global gCurrentIdentity */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { EnigmailFuncs } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/funcs.sys.mjs"
);
var { EnigmailArmor } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/armor.sys.mjs"
);
var { EnigmailKeyRing } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/keyRing.sys.mjs"
);
var { EnigmailConstants } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/constants.sys.mjs"
);
var { EnigmailDecryption } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/decryption.sys.mjs"
);
var { EnigmailEncryption } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/encryption.sys.mjs"
);
var { EnigmailMsgRead } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/msgRead.sys.mjs"
);
var { EnigmailMimeEncrypt } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/mimeEncrypt.sys.mjs"
);
var { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const { OpenPGPAlias } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/OpenPGPAlias.sys.mjs"
);
const { getMimeTreeFromUrl } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/MimeTree.sys.mjs"
);

var l10nOpenPGP = new Localization(["messenger/openpgp/openpgp.ftl"]);

var Enigmail = {};

Enigmail.msg = {
  editor: null,
  dirty: 0,
  // dirty means: composer contents were modified by this code, right?
  processed: null, // contains information for undo of inline signed/encrypt
  timeoutId: null, // TODO: once set, it's never reset
  sendPgpMime: true,

  sendProcess: false,
  composeBodyReady: false,
  modifiedAttach: null,
  draftSubjectEncrypted: false,
  attachOwnKeyObj: {
    attachedObj: null,
    attachedKey: null,
  },

  keyLookupDone: [],

  async composeStartup() {
    if (!gMsgCompose || !gMsgCompose.compFields) {
      throw new Error("OpenPGP initialization failed");
    }

    gMsgCompose.RegisterStateListener(Enigmail.composeStateListener);
    Enigmail.msg.composeBodyReady = false;

    await OpenPGPAlias.load().catch(console.error);

    Enigmail.msg.composeOpen();
  },

  getOriginalMsgUri() {
    const draftId = gMsgCompose.compFields.draftId;
    let msgUri = null;

    if (draftId) {
      // original message is draft
      msgUri = draftId.replace(/\?.*$/, "");
    } else if (gMsgCompose.originalMsgURI) {
      // original message is a "true" mail
      msgUri = gMsgCompose.originalMsgURI;
    }

    return msgUri;
  },

  /** @param {?string} msgUri */
  getMsgHdr(msgUri) {
    try {
      if (!msgUri) {
        msgUri = this.getOriginalMsgUri();
      }
      if (msgUri) {
        return gMessenger.msgHdrFromURI(msgUri);
      }
    } catch (ex) {
      // See also bug 1635648
      console.warn(`Get msg hdr failed for msgUri=${msgUri}`, ex);
    }
    return null;
  },

  getMsgProperties(draft, msgUri, msgHdr, mimeMsg, obtainedDraftFlagsObj) {
    obtainedDraftFlagsObj.value = false;

    const self = this;
    let properties = 0;
    try {
      if (msgHdr) {
        properties = msgHdr.getUint32Property("enigmail");

        if (draft) {
          if (self.getSavedDraftOptions(mimeMsg)) {
            obtainedDraftFlagsObj.value = true;
          }
          updateEncryptionDependencies();
        }
      }
    } catch (ex) {
      console.error(ex);
    }

    if (gEncryptedURIService.isEncrypted(msgUri)) {
      properties |= EnigmailConstants.DECRYPTION_OKAY;
    }

    return properties;
  },

  getSavedDraftOptions(mimeMsg) {
    if (!mimeMsg || !mimeMsg.headers.has("x-enigmail-draft-status")) {
      return false;
    }

    const stat = mimeMsg.headers.get("x-enigmail-draft-status").join("");
    if (stat.substr(0, 1) == "N") {
      switch (Number(stat.substr(1, 1))) {
        case 2:
          // treat as "user decision to enable encryption, disable auto"
          gUserTouchedSendEncrypted = true;
          gSendEncrypted = true;
          updateEncryptionDependencies();
          break;
        case 0:
          // treat as "user decision to disable encryption, disable auto"
          gUserTouchedSendEncrypted = true;
          gSendEncrypted = false;
          updateEncryptionDependencies();
          break;
        case 1:
        default:
          // treat as "no user decision, automatic mode"
          break;
      }

      switch (Number(stat.substr(2, 1))) {
        case 2:
          gSendSigned = true;
          gUserTouchedSendSigned = true;
          break;
        case 0:
          gUserTouchedSendSigned = true;
          gSendSigned = false;
          break;
        case 1:
        default:
          // treat as "no user decision, automatic mode, based on encryption or other prefs"
          break;
      }

      switch (Number(stat.substr(3, 1))) {
        case 1:
          break;
        case EnigmailConstants.ENIG_FORCE_SMIME:
          // 3
          gSelectedTechnologyIsPGP = false;
          break;
        case 2: // pgp/mime
        case 0: // inline
        default:
          gSelectedTechnologyIsPGP = true;
          break;
      }

      switch (Number(stat.substr(4, 1))) {
        case 1:
          gUserTouchedAttachMyPubKey = true;
          gAttachMyPublicPGPKey = true;
          break;
        case 2:
          gUserTouchedAttachMyPubKey = false;
          break;
        case 0:
        default:
          gUserTouchedAttachMyPubKey = true;
          gAttachMyPublicPGPKey = false;
          break;
      }

      switch (Number(stat.substr(4, 1))) {
        case 1:
          gUserTouchedAttachMyPubKey = true;
          gAttachMyPublicPGPKey = true;
          break;
        case 2:
          gUserTouchedAttachMyPubKey = false;
          break;
        case 0:
        default:
          gUserTouchedAttachMyPubKey = true;
          gAttachMyPublicPGPKey = false;
          break;
      }

      switch (Number(stat.substr(5, 1))) {
        case 1:
          gUserTouchedEncryptSubject = true;
          gEncryptSubject = true;
          break;
        case 2:
          gUserTouchedEncryptSubject = false;
          break;
        case 0:
        default:
          gUserTouchedEncryptSubject = true;
          gEncryptSubject = false;
          break;
      }
    }
    //Enigmail.msg.setOwnKeyStatus();
    return true;
  },

  composeOpen() {
    let msgUri = null;
    let msgHdr = null;

    msgUri = this.getOriginalMsgUri();
    if (msgUri) {
      msgHdr = this.getMsgHdr(msgUri);
      if (msgHdr) {
        try {
          const msgUrl = EnigmailMsgRead.getUrlFromUriSpec(msgUri);
          getMimeTreeFromUrl(msgUrl.spec, false, mimeMsg => {
            Enigmail.msg.continueComposeOpenWithMimeTree(
              msgUri,
              msgHdr,
              mimeMsg
            );
          });
        } catch (ex) {
          console.warn(ex);
          this.continueComposeOpenWithMimeTree(msgUri, msgHdr, null);
        }
      } else {
        this.continueComposeOpenWithMimeTree(msgUri, msgHdr, null);
      }
    } else {
      this.continueComposeOpenWithMimeTree(msgUri, msgHdr, null);
    }
  },

  continueComposeOpenWithMimeTree(msgUri, msgHdr, mimeMsg) {
    const selectedElement = document.activeElement;

    const msgIsDraft =
      gMsgCompose.type === Ci.nsIMsgCompType.Draft ||
      gMsgCompose.type === Ci.nsIMsgCompType.Template;

    if (!gSendEncrypted || msgIsDraft) {
      let useEncryptionUnlessWeHaveDraftInfo = false;
      let usePGPUnlessWeKnowOtherwise = false;
      let useSMIMEUnlessWeKnowOtherwise = false;

      if (msgIsDraft) {
        const globalSaysItsEncrypted =
          gEncryptedURIService &&
          gMsgCompose.originalMsgURI &&
          gEncryptedURIService.isEncrypted(gMsgCompose.originalMsgURI);

        if (globalSaysItsEncrypted) {
          useEncryptionUnlessWeHaveDraftInfo = true;
          useSMIMEUnlessWeKnowOtherwise = true;
        }
      }

      const obtainedDraftFlagsObj = { value: false };
      if (msgUri) {
        const msgFlags = this.getMsgProperties(
          msgIsDraft,
          msgUri,
          msgHdr,
          mimeMsg,
          obtainedDraftFlagsObj
        );
        if (msgFlags & EnigmailConstants.DECRYPTION_OKAY) {
          usePGPUnlessWeKnowOtherwise = true;
          useSMIMEUnlessWeKnowOtherwise = false;
        }
        if (msgIsDraft && obtainedDraftFlagsObj.value) {
          useEncryptionUnlessWeHaveDraftInfo = false;
          usePGPUnlessWeKnowOtherwise = false;
          useSMIMEUnlessWeKnowOtherwise = false;
        }
        if (!msgIsDraft) {
          if (msgFlags & EnigmailConstants.DECRYPTION_OKAY) {
            gSendEncrypted = true;
            updateEncryptionDependencies();
            gSelectedTechnologyIsPGP = true;
            useEncryptionUnlessWeHaveDraftInfo = false;
            usePGPUnlessWeKnowOtherwise = false;
            useSMIMEUnlessWeKnowOtherwise = false;
          }
        }
        this.removeAttachedKey();
      }

      if (useEncryptionUnlessWeHaveDraftInfo) {
        gSendEncrypted = true;
        updateEncryptionDependencies();
      }
      if (gSendEncrypted && !obtainedDraftFlagsObj.value) {
        gSendSigned = true;
      }
      if (usePGPUnlessWeKnowOtherwise) {
        gSelectedTechnologyIsPGP = true;
      } else if (useSMIMEUnlessWeKnowOtherwise) {
        gSelectedTechnologyIsPGP = false;
      }
    }

    // check for attached signature files and remove them
    var bucketList = document.getElementById("attachmentBucket");
    if (bucketList.hasChildNodes()) {
      var node = bucketList.firstChild;
      while (node) {
        if (node.attachment.contentType == "application/pgp-signature") {
          if (!this.findRelatedAttachment(bucketList, node)) {
            // Let's release the attachment object held by the node else it won't go away until the window is destroyed
            node.attachment = null;
            node = bucketList.removeChild(node);
          }
        }
        node = node.nextSibling;
      }
    }

    // If we removed all the children and the bucket wasn't meant
    // to stay open, close it.
    if (!Services.prefs.getBoolPref("mail.compose.show_attachment_pane")) {
      UpdateAttachmentBucket(bucketList.hasChildNodes());
    }

    if (selectedElement) {
      selectedElement.focus();
    }
  },

  // check if an signature is related to another attachment
  findRelatedAttachment(bucketList, node) {
    // check if filename ends with .sig
    if (node.attachment.name.search(/\.sig$/i) < 0) {
      return null;
    }

    var relatedNode = bucketList.firstChild;
    var findFile = node.attachment.name.toLowerCase();
    var baseAttachment = null;
    while (relatedNode) {
      if (relatedNode.attachment.name.toLowerCase() + ".sig" == findFile) {
        baseAttachment = relatedNode.attachment;
      }
      relatedNode = relatedNode.nextSibling;
    }
    return baseAttachment;
  },

  async attachOwnKey(id) {
    if (
      this.attachOwnKeyObj.attachedKey &&
      this.attachOwnKeyObj.attachedKey != id
    ) {
      // remove attached key if user ID changed
      this.removeAttachedKey();
    }
    const revokedIDs = EnigmailKeyRing.findRevokedPersonalKeysByEmail(
      gCurrentIdentity.email
    );

    if (!this.attachOwnKeyObj.attachedKey) {
      const hex = "0x" + id;
      var attachedObj = await this.extractAndAttachKey(
        hex,
        revokedIDs,
        gCurrentIdentity.email,
        true,
        true // one key plus revocations
      );
      if (attachedObj) {
        this.attachOwnKeyObj.attachedObj = attachedObj;
        this.attachOwnKeyObj.attachedKey = hex;
      }
    }
  },

  async extractAndAttachKey(
    primaryId,
    revokedIds,
    emailForFilename,
    warnOnError
  ) {
    var tmpFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tmpFile.append("key.asc");
    tmpFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

    // save file
    var exitCodeObj = {};
    var errorMsgObj = {};

    await EnigmailKeyRing.extractPublicKeys(
      [], // full
      [primaryId], // reduced
      revokedIds, // minimal
      tmpFile,
      exitCodeObj,
      errorMsgObj
    );
    if (exitCodeObj.value !== 0) {
      if (warnOnError) {
        Services.prompt.alert(window, null, errorMsgObj.value);
      }
      return null;
    }

    // create attachment
    var tmpFileURI = Services.io.newFileURI(tmpFile);
    var keyAttachment = Cc[
      "@mozilla.org/messengercompose/attachment;1"
    ].createInstance(Ci.nsIMsgAttachment);
    keyAttachment.url = tmpFileURI.spec;
    keyAttachment.name = primaryId.substr(-16, 16);
    if (keyAttachment.name.search(/^0x/) < 0) {
      keyAttachment.name = "0x" + keyAttachment.name;
    }
    let withRevSuffix = "";
    if (revokedIds && revokedIds.length) {
      withRevSuffix = "_and_old_rev";
    }
    keyAttachment.name =
      "OpenPGP_" + keyAttachment.name + withRevSuffix + ".asc";
    keyAttachment.temporary = true;
    keyAttachment.contentType = "application/pgp-keys";
    keyAttachment.size = tmpFile.fileSize;

    if (
      !gAttachmentBucket.itemChildren.find(
        item => item.attachment.name == keyAttachment.name
      )
    ) {
      await this.addAttachment(keyAttachment);
    }

    gContentChanged = true;
    return keyAttachment;
  },

  addAttachment(attachment) {
    return AddAttachments([attachment]);
  },

  removeAttachedKey() {
    const bucketList = document.getElementById("attachmentBucket");
    let node = bucketList.firstElementChild;

    if (bucketList.itemCount && this.attachOwnKeyObj.attachedObj) {
      // Undo attaching own key.
      while (node) {
        if (node.attachment.url == this.attachOwnKeyObj.attachedObj.url) {
          node = bucketList.removeChild(node);
          // Let's release the attachment object held by the node else it won't
          // go away until the window is destroyed.
          node.attachment = null;
          this.attachOwnKeyObj.attachedObj = null;
          this.attachOwnKeyObj.attachedKey = null;
          node = null; // exit loop.
        } else {
          node = node.nextSibling;
        }
      }

      // Update the visibility of the attachment pane.
      UpdateAttachmentBucket(bucketList.itemCount);
    }
  },

  // Used on send failure, to reset the pre-send modifications
  resetUpdatedFields() {
    this.removeAttachedKey();

    // reset subject
    const p = gMsgCompose?.compFields.composeSecure;
    if (p && EnigmailMimeEncrypt.isEnigmailCompField(p)) {
      const si = p.wrappedJSObject;
      if (si.originalSubject) {
        gMsgCompose.compFields.subject = si.originalSubject;
      }
    }
  },

  replaceEditorText(text) {
    this.editorSelectAll();
    // Overwrite text in clipboard for security
    // (Otherwise plaintext will be available in the clipbaord)

    if (this.editor.textLength > 0) {
      this.editorInsertText("Enigmail");
    } else {
      this.editorInsertText(" ");
    }

    this.editorSelectAll();
    this.editorInsertText(text);
  },

  /**
   * Determine if OpenPGP is enabled for the account.
   */
  isEnigmailEnabledForIdentity() {
    return !!gCurrentIdentity.getUnicharAttribute("openpgp_key_id");
  },

  /**
   * Check if encryption is possible (have keys for everyone or not).
   *
   * @returns {object} details. Details of invalid keys.
   * @returns {object[]} details.errArray
   * @returns {string[]} details.errArray[].addr email address.
   * @returns {string[]} details.errArray[].msg related error.
   */
  async determineSendFlags() {
    const detailsObj = {};
    var compFields = gMsgCompose.compFields;

    if (!Enigmail.msg.composeBodyReady) {
      compFields = Cc[
        "@mozilla.org/messengercompose/composefields;1"
      ].createInstance(Ci.nsIMsgCompFields);
    }
    Recipients2CompFields(compFields);

    // disabled, see bug 1625135
    // gMsgCompose.expandMailingLists();

    if (Enigmail.msg.isEnigmailEnabledForIdentity()) {
      var toAddrList = [];
      var recList;
      if (compFields.to) {
        recList = compFields.splitRecipients(compFields.to, true);
        this.addRecipients(toAddrList, recList);
      }
      if (compFields.cc) {
        recList = compFields.splitRecipients(compFields.cc, true);
        this.addRecipients(toAddrList, recList);
      }
      if (compFields.bcc) {
        recList = compFields.splitRecipients(compFields.bcc, true);
        this.addRecipients(toAddrList, recList);
      }

      let addresses = [];
      try {
        addresses = EnigmailFuncs.stripEmail(toAddrList.join(", ")).split(",");
      } catch (ex) {}

      // Resolve all the email addresses if possible.
      await EnigmailKeyRing.getValidKeysForAllRecipients(addresses, detailsObj);
      //this.autoPgpEncryption = (validKeyList !== null);
    }

    return detailsObj;
  },

  addRecipients(toAddrList, recList) {
    for (var i = 0; i < recList.length; i++) {
      try {
        toAddrList.push(
          EnigmailFuncs.stripEmail(recList[i].replace(/[",]/g, ""))
        );
      } catch (ex) {}
    }
  },

  setDraftStatus() {
    // Draft Status:
    // N (for new style) plus 5 digits:
    // 1: encryption
    // 2: signing
    // 3: PGP/MIME
    // 4: attach own key
    // 5: subject encrypted

    var draftStatus = "N";

    // Encryption:
    // 2 -> required/enabled
    // 0 -> disabled

    if (!gUserTouchedSendEncrypted && !gIsRelatedToEncryptedOriginal) {
      // After opening draft, it's allowed to use automatic decision.
      draftStatus += "1";
    } else {
      // After opening draft, use the same state that is set now.
      draftStatus += gSendEncrypted ? "2" : "0";
    }

    if (!gUserTouchedSendSigned) {
      // After opening draft, it's allowed to use automatic decision.
      draftStatus += "1";
    } else {
      // After opening draft, use the same state that is set now.
      // Signing:
      // 2 -> enabled
      // 0 -> disabled
      draftStatus += gSendSigned ? "2" : "0";
    }

    // MIME/technology
    // ENIG_FORCE_SMIME == 3 -> S/MIME
    // ENIG_FORCE_ALWAYS == 2 -> PGP/MIME
    // 0 -> PGP inline
    if (gSelectedTechnologyIsPGP) {
      // inline signing currently not implemented
      draftStatus += "2";
    } else {
      draftStatus += "3";
    }

    if (!gUserTouchedAttachMyPubKey) {
      draftStatus += "2";
    } else {
      draftStatus += gAttachMyPublicPGPKey ? "1" : "0";
    }

    if (!gUserTouchedEncryptSubject) {
      draftStatus += "2";
    } else {
      draftStatus += gSendEncrypted && gEncryptSubject ? "1" : "0";
    }

    gMsgCompose.compFields.setHeader("x-enigmail-draft-status", draftStatus);
  },

  getSenderUserId() {
    const keyId = gCurrentIdentity?.getUnicharAttribute("openpgp_key_id");
    return keyId ? "0x" + keyId : null;
  },

  /**
   * Manage the wrapping of inline signed mails
   *
   * @param {object} wrapresultObj - Result
   * @param {boolean} wrapresultObj.cancelled - true if send operation is to
   *   be cancelled, else false
   * @param {boolean} wrapresultObj.usePpgMime - true if message send option
   *   was changed to PGP/MIME, else false.
   */
  async wrapInLine(wrapresultObj) {
    wrapresultObj.cancelled = false;
    wrapresultObj.usePpgMime = false;
    try {
      var editor = gMsgCompose.editor.QueryInterface(Ci.nsIEditorMailSupport);
      var encoderFlags =
        Ci.nsIDocumentEncoder.OutputFormatted |
        Ci.nsIDocumentEncoder.OutputLFLineBreak;

      var wrapWidth = Services.prefs.getIntPref("mailnews.wraplength");
      if (wrapWidth > 0 && wrapWidth < 68 && editor.wrapWidth > 0) {
        const text = await l10nOpenPGP.formatValue("minimal-line-wrapping", {
          width: wrapWidth,
        });
        if (Services.prompt.confirm(window, null, text)) {
          wrapWidth = 68;
          Services.prefs.setIntPref("mailnews.wraplength", wrapWidth);
        }
      }

      if (wrapWidth && editor.wrapWidth > 0) {
        // First use standard editor wrap mechanism:
        editor.wrapWidth = wrapWidth - 2;
        editor.rewrap(true);
        editor.wrapWidth = wrapWidth;

        // Now get plaintext from editor
        var wrapText = this.editorGetContentAs("text/plain", encoderFlags);

        // split the lines into an array
        wrapText = wrapText.split(/\r\n|\r|\n/g);

        var i = 0;
        var excess = 0;
        // inspect all lines of mail text to detect if we still have excessive
        // lines which the "standard" editor wrapper leaves
        for (i = 0; i < wrapText.length; i++) {
          if (wrapText[i].length > wrapWidth) {
            excess = 1;
          }
        }

        if (excess) {
          // Excess lines detected.
          var resultObj = {};
          window.openDialog(
            "chrome://openpgp/content/ui/enigmailWrapSelection.xhtml",
            "",
            "dialog,modal,centerscreen",
            resultObj
          );
          try {
            if (resultObj.cancelled) {
              // cancel pressed -> do not send, return instead.
              wrapresultObj.cancelled = true;
              return;
            }
          } catch (ex) {
            // cancel pressed -> do not send, return instead.
            wrapresultObj.cancelled = true;
            return;
          }

          var limitedLine = "";
          var restOfLine = "";

          var WrapSelect = resultObj.Select;
          switch (WrapSelect) {
            case "0": // Selection: Force rewrap
              for (i = 0; i < wrapText.length; i++) {
                if (wrapText[i].length > wrapWidth) {
                  // If the current line is too long, limit it hard to wrapWidth
                  // and insert the rest as the next line into wrapText array
                  limitedLine = wrapText[i].slice(0, wrapWidth);
                  restOfLine = wrapText[i].slice(wrapWidth);

                  // We should add quotes at the beginning of "restOfLine",
                  // if limitedLine is a quoted line.
                  // However, this would be purely academic, because limitedLine
                  // will always be "standard"-wrapped by the editor-rewrapper
                  // at the space between quote sign (>) and the quoted text.

                  wrapText.splice(i, 1, limitedLine, restOfLine);
                }
              }
              break;
            case "1": // Selection: Send as is
              break;
            case "2": // Selection: Use MIME
              wrapresultObj.usePpgMime = true;
              break;
            case "3": // Selection: Edit manually -> do not send, return instead.
              wrapresultObj.cancelled = true;
              return;
          } //switch
        }
        // Now join all lines together again and feed it back into the compose editor.
        var newtext = wrapText.join("\n");
        this.replaceEditorText(newtext);
      }
    } catch (ex) {
      console.error("Wrap inline FAILED.", ex);
    }
  },

  /**
   * Save draft message. We do not want most of the other processing for
   * encrypted mails here...
   *
   * @param {boolean} senderKeyIsGnuPG - Whether sender key is from external GnuPG.
   */
  async saveDraftMessage(senderKeyIsGnuPG) {
    // If we have an encryption key configured, then encrypt saved
    // drafts by default, as a precaution. This is independent from the
    // final decision of sending the message encrypted or not.
    // However, we allow the user to disable encrypted drafts.
    const doEncrypt =
      Enigmail.msg.isEnigmailEnabledForIdentity() &&
      gCurrentIdentity.autoEncryptDrafts;

    this.setDraftStatus(doEncrypt);

    if (!doEncrypt) {
      try {
        const p = gMsgCompose?.compFields.composeSecure;
        if (EnigmailMimeEncrypt.isEnigmailCompField(p)) {
          p.wrappedJSObject.sendFlags = 0;
        }
      } catch (ex) {
        console.warn(ex);
      }
      return true;
    }

    let sendFlags =
      EnigmailConstants.SEND_PGP_MIME |
      EnigmailConstants.SEND_ENCRYPTED |
      EnigmailConstants.SEND_ENCRYPT_TO_SELF |
      EnigmailConstants.SAVE_MESSAGE;

    if (gEncryptSubject) {
      sendFlags |= EnigmailConstants.ENCRYPT_SUBJECT;
    }
    if (senderKeyIsGnuPG) {
      sendFlags |= EnigmailConstants.SEND_SENDER_KEY_EXTERNAL;
    }

    const fromAddr = this.getSenderUserId();
    const senderKeyUsable = await EnigmailEncryption.determineOwnKeyUsability(
      sendFlags,
      fromAddr,
      senderKeyIsGnuPG
    );
    if (senderKeyUsable.errorMsg) {
      let fullAlert = await document.l10n.formatValue(
        "msg-compose-cannot-save-draft"
      );
      fullAlert += " - " + senderKeyUsable.errorMsg;
      Services.prompt.alert(window, null, fullAlert);
      return false;
    }

    let secInfo;
    const param = gMsgCompose?.compFields.composeSecure;
    if (EnigmailMimeEncrypt.isEnigmailCompField(param)) {
      secInfo = param.wrappedJSObject;
    } else {
      try {
        secInfo = EnigmailMimeEncrypt.createMimeEncrypt(param);
        if (secInfo && gMsgCompose) {
          gMsgCompose.compFields.composeSecure = secInfo;
        }
      } catch (ex) {
        console.error("Saving draft FAILED.", ex);
        return false;
      }
    }

    secInfo.sendFlags = sendFlags;
    secInfo.UIFlags = 0;
    secInfo.senderEmailAddr = fromAddr;
    secInfo.recipients = "";
    secInfo.bccRecipients = "";
    secInfo.originalSubject = gMsgCompose.compFields.subject;
    this.dirty = 1;

    if (sendFlags & EnigmailConstants.ENCRYPT_SUBJECT) {
      gMsgCompose.compFields.subject = "";
    }

    return true;
  },

  getEncryptionFlags() {
    let f = 0;

    if (gSendEncrypted) {
      f |= EnigmailConstants.SEND_ENCRYPTED;
    } else {
      f &= ~EnigmailConstants.SEND_ENCRYPTED;
    }

    if (gSendSigned) {
      f |= EnigmailConstants.SEND_SIGNED;
    } else {
      f &= ~EnigmailConstants.SEND_SIGNED;
    }

    if (gSendEncrypted && gSendSigned) {
      if (Services.prefs.getBoolPref("mail.openpgp.separate_mime_layers")) {
        f |= EnigmailConstants.SEND_TWO_MIME_LAYERS;
      }
    }

    if (gSendEncrypted && gEncryptSubject) {
      f |= EnigmailConstants.ENCRYPT_SUBJECT;
    }

    return f;
  },

  resetDirty() {
    let newSecurityInfo = null;

    if (this.dirty) {
      // make sure the sendFlags are reset before the message is processed
      // (it may have been set by a previously cancelled send operation!)

      const si = gMsgCompose?.compFields.composeSecure;

      if (EnigmailMimeEncrypt.isEnigmailCompField(si)) {
        si.sendFlags = 0;
        si.originalSubject = gMsgCompose.compFields.subject;
      } else {
        try {
          newSecurityInfo = EnigmailMimeEncrypt.createMimeEncrypt(si);
          if (newSecurityInfo) {
            newSecurityInfo.sendFlags = 0;
            newSecurityInfo.originalSubject = gMsgCompose.compFields.subject;
            gMsgCompose.compFields.composeSecure = newSecurityInfo;
          }
        } catch (ex) {
          console.error(ex);
        }
      }
    }

    return newSecurityInfo;
  },

  /**
   * Determine message recipients.
   *
   * @param {integer} sendFlags - Send flags.
   * @returns {Promise<?object>} details - Details, or null if OpenPGP not set
   *   up for the current identity.
   * @returns {integer} details.sendFlags
   * @returns {string} details.fromAddr
   * @returns {string[]} details.toAddrList - To and Cc addresses.
   * @returns {integer[]} details.bccAddrList
   */
  async determineMsgRecipients(sendFlags) {
    let fromAddr = gCurrentIdentity.email;
    const toAddrList = [];
    const bccAddrList = [];

    if (!Enigmail.msg.isEnigmailEnabledForIdentity()) {
      return null;
    }

    let optSendFlags = 0;
    if (Services.prefs.getBoolPref("temp.openpgp.encryptToSelf")) {
      optSendFlags |= EnigmailConstants.SEND_ENCRYPT_TO_SELF;
    }

    sendFlags |= optSendFlags;

    var userIdValue = this.getSenderUserId();
    if (userIdValue) {
      fromAddr = userIdValue;
    }

    if (gMsgCompose.compFields.to) {
      const recList = gMsgCompose.compFields.splitRecipients(
        gMsgCompose.compFields.to,
        true
      );
      this.addRecipients(toAddrList, recList);
    }

    if (gMsgCompose.compFields.cc) {
      const recList = gMsgCompose.compFields.splitRecipients(
        gMsgCompose.compFields.cc,
        true
      );
      this.addRecipients(toAddrList, recList);
    }

    // We allow sending to Bcc recipients, we assume the user interface
    // has warned the user that there is no privacy of Bcc recipients.
    if (gMsgCompose.compFields.bcc) {
      const recList = gMsgCompose.compFields.splitRecipients(
        gMsgCompose.compFields.bcc,
        true
      );
      this.addRecipients(bccAddrList, recList);
    }

    return {
      sendFlags,
      optSendFlags,
      fromAddr,
      toAddrList,
      bccAddrList,
    };
  },

  prepareSending(sendFlags) {
    // perform confirmation dialog if necessary/requested
    if (
      sendFlags & EnigmailConstants.SEND_WITH_CHECK &&
      !this.messageSendCheck()
    ) {
      // Abort send
      if (!this.processed) {
        this.removeAttachedKey();
      }

      return false;
    }

    return true;
  },

  prepareSecurityInfo(
    sendFlags,
    uiFlags,
    rcpt,
    newSecurityInfo,
    autocryptGossipHeaders
  ) {
    if (!newSecurityInfo && gMsgCompose) {
      gMsgCompose.compFields.composeSecure =
        EnigmailMimeEncrypt.createMimeEncrypt(
          gMsgCompose.compFields.composeSecure
        );
      newSecurityInfo = gMsgCompose.compFields.composeSecure.wrappedJSObject;
    }

    newSecurityInfo.originalSubject = gMsgCompose.compFields.subject;
    newSecurityInfo.originalReferences = gMsgCompose.compFields.references;

    if (sendFlags & EnigmailConstants.SEND_ENCRYPTED) {
      if (sendFlags & EnigmailConstants.ENCRYPT_SUBJECT) {
        gMsgCompose.compFields.subject = "";
      }

      if (Services.prefs.getBoolPref("temp.openpgp.protectReferencesHdr")) {
        gMsgCompose.compFields.references = "";
      }
    }

    newSecurityInfo.sendFlags = sendFlags;
    newSecurityInfo.UIFlags = uiFlags;
    newSecurityInfo.senderEmailAddr = rcpt.fromAddr;
    newSecurityInfo.bccRecipients = rcpt.bccAddrStr;
    newSecurityInfo.autocryptGossipHeaders = autocryptGossipHeaders;

    return newSecurityInfo;
  },

  /**
   * @param {nsIMsgCompDeliverMode} msgSendType
   */
  async prepareSendMsg(msgSendType) {
    const senderKeyIsGnuPG =
      Services.prefs.getBoolPref("mail.openpgp.allow_external_gnupg") &&
      gCurrentIdentity.getBoolAttribute("is_gnupg_key_id");

    let sendFlags = this.getEncryptionFlags();

    switch (msgSendType) {
      case Ci.nsIMsgCompDeliverMode.SaveAsDraft:
      case Ci.nsIMsgCompDeliverMode.SaveAsTemplate:
      case Ci.nsIMsgCompDeliverMode.AutoSaveAsDraft:
        // Saving drafts is simpler and works differently than the rest of
        // OpenPGP. All rules except account-settings are ignored.
        return this.saveDraftMessage(senderKeyIsGnuPG);
    }

    if (
      !gMsgCompose.compFields.to &&
      !gMsgCompose.compFields.cc &&
      !gMsgCompose.compFields.bcc &&
      !gMsgCompose.compFields.newsgroups
    ) {
      throw new Error("No recipients specified!");
    }

    gMsgCompose.compFields.deleteHeader("x-enigmail-draft-status");

    const senderKeyId = gCurrentIdentity.getUnicharAttribute("openpgp_key_id");

    if ((gSendEncrypted || gSendSigned) && !senderKeyId) {
      const msgId = gSendEncrypted
        ? "cannot-send-enc-because-no-own-key"
        : "cannot-send-sig-because-no-own-key";
      const fullAlert = await document.l10n.formatValue(msgId, {
        key: gCurrentIdentity.email,
      });
      Services.prompt.alert(window, null, fullAlert);
      return false;
    }

    if (senderKeyIsGnuPG) {
      sendFlags |= EnigmailConstants.SEND_SENDER_KEY_EXTERNAL;
    }

    if ((gSendEncrypted || gSendSigned) && senderKeyId) {
      const senderKeyUsable = await EnigmailEncryption.determineOwnKeyUsability(
        sendFlags,
        senderKeyId,
        senderKeyIsGnuPG
      );
      if (senderKeyUsable.errorMsg) {
        const fullAlert = await document.l10n.formatValue(
          "cannot-use-own-key-because",
          {
            problem: senderKeyUsable.errorMsg,
          }
        );
        Services.prompt.alert(window, null, fullAlert);
        return false;
      }
    }

    let cannotEncryptMissingInfo = false;
    if (gSendEncrypted) {
      const canEncryptDetails = await this.determineSendFlags();
      if (canEncryptDetails.errArray.length != 0) {
        cannotEncryptMissingInfo = true;
      }
    }

    const newSecurityInfo = this.resetDirty();
    this.dirty = 1;

    const SIGN = EnigmailConstants.SEND_SIGNED;
    const ENCRYPT = EnigmailConstants.SEND_ENCRYPTED;

    try {
      this.modifiedAttach = null;

      // fill fromAddr, toAddrList, bcc etc
      const rcpt = await this.determineMsgRecipients(sendFlags);
      if (!rcpt) {
        return true;
      }
      sendFlags = rcpt.sendFlags;

      if (cannotEncryptMissingInfo) {
        showMessageComposeSecurityStatus(true);
        return false;
      }

      if (this.sendPgpMime) {
        // Use PGP/MIME
        sendFlags |= EnigmailConstants.SEND_PGP_MIME;
      }

      const toAddrStr = rcpt.toAddrList.join(", ");
      const bccAddrStr = rcpt.bccAddrList.join(", ");

      if (gAttachMyPublicPGPKey) {
        await this.attachOwnKey(senderKeyId);
      }

      const autocryptGossipHeaders = await this.getAutocryptGossip();

      var usingPGPMime =
        sendFlags & EnigmailConstants.SEND_PGP_MIME &&
        sendFlags & (ENCRYPT | SIGN);

      // ----------------------- Rewrapping code, taken from function "encryptInline"

      if (sendFlags & ENCRYPT && !usingPGPMime) {
        throw new Error("Sending encrypted inline not supported!");
      }
      if (sendFlags & SIGN && !usingPGPMime && gMsgCompose.composeHTML) {
        throw new Error(
          "Sending signed inline only supported for plain text composition!"
        );
      }

      // Check wrapping, if sign only and inline and plaintext
      if (
        sendFlags & SIGN &&
        !(sendFlags & ENCRYPT) &&
        !usingPGPMime &&
        !gMsgCompose.composeHTML
      ) {
        var wrapresultObj = {};

        await this.wrapInLine(wrapresultObj);

        if (wrapresultObj.usePpgMime) {
          sendFlags |= EnigmailConstants.SEND_PGP_MIME;
          usingPGPMime = EnigmailConstants.SEND_PGP_MIME;
        }
        if (wrapresultObj.cancelled) {
          return false;
        }
      }

      var uiFlags = EnigmailConstants.UI_INTERACTIVE;

      if (usingPGPMime) {
        uiFlags |= EnigmailConstants.UI_PGP_MIME;
      }

      if (sendFlags & (ENCRYPT | SIGN) && usingPGPMime) {
        // Use PGP/MIME.
        const composeSecure = this.prepareSecurityInfo(
          sendFlags,
          uiFlags,
          rcpt,
          newSecurityInfo,
          autocryptGossipHeaders
        );
        composeSecure.recipients = toAddrStr;
        composeSecure.bccRecipients = bccAddrStr;
      } else if (!this.processed && sendFlags & (ENCRYPT | SIGN)) {
        // Use inline PGP.
        const sendInfo = {
          sendFlags,
          fromAddr: rcpt.fromAddr,
          toAddr: toAddrStr,
          bccAddr: bccAddrStr,
          uiFlags,
          bucketList: document.getElementById("attachmentBucket"),
        };

        if (!(await this.signInline(sendInfo))) {
          return false;
        }
      }

      // update the list of attachments
      Attachments2CompFields(gMsgCompose.compFields);

      if (
        !this.prepareSending(
          sendFlags,
          rcpt.toAddrList.join(", "),
          toAddrStr + ", " + bccAddrStr,
          Services.io.offline
        )
      ) {
        return false;
      }
    } catch (ex) {
      console.warn("Prepare send message FAILED.", ex);
      return false;
    }

    // Make sure that we use base64 encoding for signed payload of
    // signed-only emails, only, because some MTAs rewrite the encoding
    // of message with a 7bit/8bit encoding.
    // We usually don't use base64 encoding for the inner payload of
    // encrypted messages, even if that payload is a signed message,
    // because we already have sufficient wrapping when using
    // encryption (avoiding unnecessary base64 layers saves space).
    // However, when using GPGME for signing, the UTF-8 bytes given to
    // GPGME might get incorrectly transformed, so let's use base64
    // here, too.
    // (We don't encode PGP/INLINE signed messages, that would be
    // against the intention.)
    if (
      usingPGPMime &&
      sendFlags & SIGN &&
      (senderKeyIsGnuPG || !(sendFlags & ENCRYPT))
    ) {
      gMsgCompose.compFields.forceMsgEncoding = true;
    }

    // The encryption process for PGP/MIME messages follows "here".
    return true;
  },

  async signInline(sendInfo) {
    // sign message using inline-PGP

    if (sendInfo.sendFlags & EnigmailConstants.SEND_ENCRYPTED) {
      throw new Error("Encryption not supported in inline messages!");
    }
    if (gMsgCompose.composeHTML) {
      throw new Error(
        "Signing inline only supported for plain text composition!"
      );
    }

    if (Services.prefs.getBoolPref("mail.strictly_mime")) {
      if (
        Services.prompt.confirm(
          null,
          null,
          await l10nOpenPGP.formatValue("quoted-printable-warn")
        )
      ) {
        Services.prefs.setBoolPref("mail.strictly_mime", false);
      }
    }

    var sendFlowed = Services.prefs.getBoolPref(
      "mailnews.send_plaintext_flowed"
    );
    var encoderFlags =
      Ci.nsIDocumentEncoder.OutputFormatted |
      Ci.nsIDocumentEncoder.OutputLFLineBreak;

    // plaintext: Wrapping code has been moved to superordinate function prepareSendMsg to enable interactive format switch

    var exitCodeObj = {};
    var statusFlagsObj = {};
    var errorMsgObj = {};
    var exitCode;

    // Get plain text
    // (Do we need to set the nsIDocumentEncoder.* flags?)
    var origText = this.editorGetContentAs("text/plain", encoderFlags);
    if (!origText) {
      origText = "";
    }

    if (origText.length > 0) {
      // Sign/encrypt body text

      var escText = origText; // Copy plain text for possible escaping

      if (sendFlowed) {
        // Prevent space stuffing a la RFC 2646 (format=flowed).
        escText = escText.replace(/^From /gm, "~From ");
        escText = escText.replace(/^>/gm, "|");
        escText = escText.replace(/^[ \t]+$/gm, "");
        escText = escText.replace(/^ /gm, "~ ");

        // Replace plain text and get it again.
        this.replaceEditorText(escText);

        escText = this.editorGetContentAs("text/plain", encoderFlags);
      }

      // Replace plain text and get it again (to avoid linewrapping problems)
      this.replaceEditorText(escText);

      escText = this.editorGetContentAs("text/plain", encoderFlags);

      // Encode plaintext to utf-8 from unicode
      var plainText = MailStringUtils.stringToByteString(escText);

      // this will sign, not encrypt
      var cipherText = EnigmailEncryption.encryptMessage(
        window,
        sendInfo.uiFlags,
        plainText,
        sendInfo.fromAddr,
        sendInfo.toAddr,
        sendInfo.bccAddr,
        sendInfo.sendFlags,
        exitCodeObj,
        statusFlagsObj,
        errorMsgObj
      );

      exitCode = exitCodeObj.value;

      if (cipherText && exitCode === 0) {
        // Encryption/signing succeeded; overwrite plaintext

        cipherText = cipherText.replace(/\r\n/g, "\n");

        // Decode ciphertext from utf-8 to unicode and overwrite
        this.replaceEditorText(MailStringUtils.byteStringToString(cipherText));

        // Save original text (for undo)
        this.processed = {
          origText,
        };
      } else {
        // Restore original text
        this.replaceEditorText(origText);

        if (sendInfo.sendFlags & EnigmailConstants.SEND_SIGNED) {
          // Encryption/signing failed

          this.sendAborted(window, errorMsgObj);
          return false;
        }
      }
    }

    return true;
  },

  async sendAborted(window, errorMsgObj) {
    if (errorMsgObj && errorMsgObj.value) {
      var txt = errorMsgObj.value;
      var txtLines = txt.split(/\r?\n/);
      var errorMsg = "";
      for (var i = 0; i < txtLines.length; ++i) {
        var line = txtLines[i];
        var tokens = line.split(/ /);
        // process most important business reasons for invalid recipient (and sender) errors:
        if (
          tokens.length == 3 &&
          (tokens[0] == "INV_RECP" || tokens[0] == "INV_SGNR")
        ) {
          var reason = tokens[1];
          var key = tokens[2];
          if (reason == "10") {
            errorMsg +=
              (await document.l10n.formatValue("key-not-trusted", { key })) +
              "\n";
          } else if (reason == "1") {
            errorMsg +=
              (await document.l10n.formatValue("key-not-found", { key })) +
              "\n";
          } else if (reason == "4") {
            errorMsg +=
              (await document.l10n.formatValue("key-revoked", { key })) + "\n";
          } else if (reason == "5") {
            errorMsg +=
              (await document.l10n.formatValue("key-expired", { key })) + "\n";
          }
        }
      }
      if (errorMsg !== "") {
        txt = errorMsg + "\n" + txt;
      }
      Services.prompt.alert(
        window,
        null,
        (await document.l10n.formatValue("send-aborted")) + "\n" + txt
      );
    } else {
      const [title, message] = await document.l10n.formatValues([
        { id: "send-aborted" },
        { id: "msg-compose-internal-error" },
      ]);
      Services.prompt.alert(window, title, message);
    }
  },

  messageSendCheck() {
    try {
      var warn = Services.prefs.getBoolPref("mail.warn_on_send_accel_key");

      if (warn) {
        var checkValue = {
          value: false,
        };
        var bundle = document.getElementById("bundle_composeMsgs");
        var buttonPressed = Services.prompt.confirmEx(
          window,
          bundle.getString("sendMessageCheckWindowTitle"),
          bundle.getString("sendMessageCheckLabel"),
          Services.prompt.BUTTON_TITLE_IS_STRING *
            Services.prompt.BUTTON_POS_0 +
            Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_1,
          bundle.getString("sendMessageCheckSendButtonLabel"),
          null,
          null,
          bundle.getString("CheckMsg"),
          checkValue
        );
        if (buttonPressed !== 0) {
          return false;
        }
        if (checkValue.value) {
          Services.prefs.setBoolPref("mail.warn_on_send_accel_key", false);
        }
      }
    } catch (ex) {}

    return true;
  },

  /**
   * Obtain all Autocrypt-Gossip header lines that should be included in
   * the outgoing message, excluding the sender's (from) email address.
   * If there is just one recipient (ignoring the from address),
   * no headers will be returned.
   *
   * @returns {string} - All header lines including line endings,
   *   could be the empty string.
   */
  async getAutocryptGossip() {
    const fromMail = EnigmailFuncs.stripEmail(gMsgCompose.compFields.from);
    const replyToMail = EnigmailFuncs.stripEmail(
      gMsgCompose.compFields.replyTo
    );

    let optionalReplyToGossip = "";
    if (replyToMail != fromMail) {
      optionalReplyToGossip = ", " + gMsgCompose.compFields.replyTo;
    }

    // Assumes that extractHeaderAddressMailboxes will separate all
    // entries with the sequence comma-space.
    const allEmails = MailServices.headerParser
      .extractHeaderAddressMailboxes(
        gMsgCompose.compFields.to +
          ", " +
          gMsgCompose.compFields.cc +
          optionalReplyToGossip
      )
      .split(/, /);

    // Use a Set to ensure we have each address only once.
    const uniqueEmails = new Set();
    for (const e of allEmails) {
      uniqueEmails.add(e);
    }

    // Potentially to/cc might contain the sender email address.
    // Remove it, if it's there.
    uniqueEmails.delete(fromMail);

    // When sending to yourself, only, allEmails.length is 0.
    // When sending to exactly one other person (with or without
    // "from" in to/cc), then allEmails.length is 1. In that scenario,
    // that recipient obviously already has their own key, and doesn't
    // need the gossip. The sender's key will be included in the
    // separate autocrypt (non-gossip) header.

    if (uniqueEmails.size < 2) {
      return "";
    }

    let gossip = "";
    for (const email of uniqueEmails) {
      const k = await EnigmailKeyRing.getRecipientAutocryptKeyForEmail(email);
      if (!k) {
        continue;
      }
      const keyData =
        " " + k.replace(/(.{72})/g, "$1\r\n ").replace(/\r\n $/, "");
      gossip +=
        "Autocrypt-Gossip: addr=" + email + "; keydata=\r\n" + keyData + "\r\n";
    }

    return gossip;
  },

  /**
   * To be called prior to completing send.
   *
   * @see onSendSMIME()
   * @param {nsIMsgCompDeliverMode} mode
   * @returns {boolean} true if sending should proceed.
   */
  async onSendOpenPGP(mode) {
    if (
      !gSelectedTechnologyIsPGP ||
      !Enigmail.msg.isEnigmailEnabledForIdentity()
    ) {
      return true;
    }
    try {
      return this.prepareSendMsg(mode);
    } catch (e) {
      console.error(`Prepare send msg FAILED: ${e.message}`, e);
      return false;
    }
  },

  async decryptQuote(interactive) {
    if (gWindowLocked || this.processed) {
      return;
    }

    var encoderFlags =
      Ci.nsIDocumentEncoder.OutputFormatted |
      Ci.nsIDocumentEncoder.OutputLFLineBreak;

    var docText = this.editorGetContentAs("text/plain", encoderFlags);

    var blockBegin = docText.indexOf("-----BEGIN PGP ");
    if (blockBegin < 0) {
      return;
    }

    // Determine indentation string
    var indentBegin = docText.substr(0, blockBegin).lastIndexOf("\n");
    var indentStr = docText.substring(indentBegin + 1, blockBegin);

    var beginIndexObj = {};
    var endIndexObj = {};
    var indentStrObj = {};
    var blockType = EnigmailArmor.locateArmoredBlock(
      docText,
      0,
      indentStr,
      beginIndexObj,
      endIndexObj,
      indentStrObj
    );
    if (blockType != "MESSAGE" && blockType != "SIGNED MESSAGE") {
      return;
    }

    var beginIndex = beginIndexObj.value;
    var endIndex = endIndexObj.value;

    var head = docText.substr(0, beginIndex);
    var tail = docText.substr(endIndex + 1);

    var pgpBlock = docText.substr(beginIndex, endIndex - beginIndex + 1);
    var indentRegexp;

    if (indentStr) {
      if (indentStr == "> ") {
        // replace ">> " with "> > " to allow correct quoting
        pgpBlock = pgpBlock.replace(/^>>/gm, "> >");
      }

      // Escape regex chars.
      const escapedIndent1 = indentStr.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&");

      // Delete indentation
      indentRegexp = new RegExp("^" + escapedIndent1, "gm");

      pgpBlock = pgpBlock.replace(indentRegexp, "");
      //tail     =     tail.replace(indentRegexp, "");

      if (indentStr.match(/[ \t]*$/)) {
        indentStr = indentStr.replace(/[ \t]*$/gm, "");
        // Escape regex chars.
        const escapedIndent2 = indentStr.replace(
          /[.*+\-?^${}()|[\]\\]/g,
          "\\$&"
        );
        indentRegexp = new RegExp("^" + escapedIndent2 + "$", "gm");

        pgpBlock = pgpBlock.replace(indentRegexp, "");
      }

      // Handle blank indented lines
      pgpBlock = pgpBlock.replace(/^[ \t]*>[ \t]*$/gm, "");
      //tail     =     tail.replace(/^[ \t]*>[ \t]*$/g, "");

      // Trim leading space in tail
      tail = tail.replace(/^\s*\n/m, "\n");
    }

    if (tail.search(/\S/) < 0) {
      // No non-space characters in tail; delete it
      tail = "";
    }

    // Encode ciphertext from unicode to utf-8
    var cipherText = MailStringUtils.stringToByteString(pgpBlock);

    // Decrypt message
    var signatureObj = {};
    signatureObj.value = "";
    var exitCodeObj = {};
    var statusFlagsObj = {};
    var userIdObj = {};
    var keyIdObj = {};
    var sigDetailsObj = {};
    var errorMsgObj = {};
    var blockSeparationObj = {};
    var encToDetailsObj = {};

    var uiFlags = EnigmailConstants.UI_UNVERIFIED_ENC_OK;

    var plainText = "";

    plainText = await EnigmailDecryption.decryptMessage(
      window,
      uiFlags,
      cipherText,
      null, // date
      signatureObj,
      exitCodeObj,
      statusFlagsObj,
      keyIdObj,
      userIdObj,
      sigDetailsObj,
      errorMsgObj,
      blockSeparationObj,
      encToDetailsObj
    );
    // Decode plaintext from "utf-8" to unicode
    plainText = MailStringUtils.byteStringToString(plainText).replace(
      /\r\n/g,
      "\n"
    );

    if (statusFlagsObj.value & EnigmailConstants.DECRYPTION_OKAY) {
      //this.setSendMode('encrypt');

      // TODO : Check, when is this code reached?
      // automatic enabling encryption currently depends on
      // adjustSignEncryptAfterIdentityChanged to be always reached
      gIsRelatedToEncryptedOriginal = true;
      gSendEncrypted = true;
      updateEncryptionDependencies();
    }

    var exitCode = exitCodeObj.value;

    if (exitCode !== 0) {
      // Error processing
      var errorMsg = errorMsgObj.value;

      var statusLines = errorMsg ? errorMsg.split(/\r?\n/) : [];

      var displayMsg;
      if (statusLines && statusLines.length) {
        // Display only first ten lines of error message
        while (statusLines.length > 10) {
          statusLines.pop();
        }

        displayMsg = statusLines.join("\n");

        if (interactive) {
          Services.prompt.alert(window, null, displayMsg);
        }
      }
    }

    if (blockType == "MESSAGE" && exitCode === 0 && plainText.length === 0) {
      plainText = " ";
    }

    if (!plainText) {
      if (blockType != "SIGNED MESSAGE") {
        return;
      }

      // Extract text portion of clearsign block
      plainText = EnigmailArmor.extractSignaturePart(
        pgpBlock,
        EnigmailConstants.SIGNATURE_TEXT
      );
    }

    var doubleDashSeparator = Services.prefs.getBoolPref(
      "temp.openpgp.doubleDashSeparator"
    );
    if (
      gMsgCompose.type != Ci.nsIMsgCompType.Template &&
      gMsgCompose.type != Ci.nsIMsgCompType.Draft &&
      doubleDashSeparator
    ) {
      var signOffset = plainText.search(/[\r\n]-- +[\r\n]/);

      if (signOffset < 0 && blockType == "SIGNED MESSAGE") {
        signOffset = plainText.search(/[\r\n]--[\r\n]/);
      }

      if (signOffset > 0) {
        // Strip signature portion of quoted message
        plainText = plainText.substr(0, signOffset + 1);
      }
    }

    this.editorSelectAll();

    if (head) {
      this.editorInsertText(head);
    }

    var quoteElement;

    if (indentStr) {
      quoteElement = this.editorInsertAsQuotation(plainText);
    } else {
      this.editorInsertText(plainText);
    }

    if (tail) {
      this.editorInsertText(tail);
    }

    if (statusFlagsObj.value & EnigmailConstants.DECRYPTION_OKAY) {
      this.checkInlinePgpReply(head, tail);
    }

    if (interactive) {
      return;
    }

    // Position cursor
    var replyOnTop = gCurrentIdentity.replyOnTop;

    if (!indentStr || !quoteElement) {
      replyOnTop = 1;
    }

    if (this.editor.selectionController) {
      var selection = this.editor.selectionController;
      selection.completeMove(false, false); // go to start;

      switch (replyOnTop) {
        case 0:
          // Position after quote
          this.editor.endOfDocument();
          if (tail) {
            for (let cPos = 0; cPos < tail.length; cPos++) {
              selection.characterMove(false, false); // move backwards
            }
          }
          break;

        case 2:
          // Select quote

          if (head) {
            for (let cPos = 0; cPos < head.length; cPos++) {
              selection.characterMove(true, false);
            }
          }
          selection.completeMove(true, true);
          if (tail) {
            for (let cPos = 0; cPos < tail.length; cPos++) {
              selection.characterMove(false, true); // move backwards
            }
          }
          break;

        default:
          // Position at beginning of document

          if (this.editor) {
            this.editor.beginningOfDocument();
          }
      }

      this.editor.selectionController.scrollSelectionIntoView(
        Ci.nsISelectionController.SELECTION_NORMAL,
        Ci.nsISelectionController.SELECTION_ANCHOR_REGION,
        Ci.nsISelectionController.SCROLL_SYNCHRONOUS
      );
    }
  },

  checkInlinePgpReply(head, tail) {
    let hLines = head.search(/[^\s>]/) < 0 ? 0 : 1;

    if (hLines > 0) {
      switch (gMsgCompose.type) {
        case Ci.nsIMsgCompType.Reply:
        case Ci.nsIMsgCompType.ReplyAll:
        case Ci.nsIMsgCompType.ReplyToSender:
        case Ci.nsIMsgCompType.ReplyToGroup:
        case Ci.nsIMsgCompType.ReplyToSenderAndGroup:
        case Ci.nsIMsgCompType.ReplyToList: {
          // if head contains at only a few line of text, we assume it's the
          // header above the quote (e.g. XYZ wrote:) and the user's signature

          const h = head.split(/\r?\n/);
          hLines = -1;

          for (let i = 0; i < h.length; i++) {
            if (h[i].search(/[^\s>]/) >= 0) {
              hLines++;
            }
          }
        }
      }
    }

    if (
      hLines > 0 &&
      (!gCurrentIdentity.sigOnReply || gCurrentIdentity.sigBottom)
    ) {
      // display warning if no signature on top of message
      this.displayPartialEncryptedWarning();
    } else if (hLines > 10) {
      this.displayPartialEncryptedWarning();
    } else if (
      tail.search(/[^\s>]/) >= 0 &&
      !(gCurrentIdentity.sigOnReply && gCurrentIdentity.sigBottom)
    ) {
      // display warning if no signature below message
      this.displayPartialEncryptedWarning();
    }
  },

  editorInsertText(plainText) {
    if (this.editor) {
      var mailEditor;
      try {
        mailEditor = this.editor.QueryInterface(Ci.nsIEditorMailSupport);
        mailEditor.insertTextWithQuotations(plainText);
      } catch (ex) {
        console.error("No mail editor.", ex);
        this.editor.insertText(plainText);
      }
    }
  },

  editorInsertAsQuotation(plainText) {
    if (this.editor) {
      var mailEditor;
      try {
        mailEditor = this.editor.QueryInterface(Ci.nsIEditorMailSupport);
      } catch (ex) {}

      if (!mailEditor) {
        return 0;
      }

      mailEditor.insertAsCitedQuotation(plainText, "", false);
      return 1;
    }
    return 0;
  },

  removeNotificationIfPresent(name) {
    const notif = gComposeNotification.getNotificationWithValue(name);
    if (notif) {
      gComposeNotification.removeNotification(notif);
    }
  },

  /**
   * When applicable, warns the user about their key expiring soon, or already
   * expired.
   */
  async warnUserOfSenderKeyExpiration() {
    this.removeNotificationIfPresent("openpgpSenderKeyExpiry");
    const senderKeyId = this.getSenderUserId();
    const key = EnigmailKeyRing.getKeyById(senderKeyId);
    if (!key?.expiryTime) {
      // No key, or doesn't expire.
      return;
    }
    let label;
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const expiresInDays = Math.floor(
      (key.expiryTime - nowInSeconds) / (24 * 60 * 60)
    );
    if (expiresInDays > 31) {
      return;
    }
    if (nowInSeconds > key.expiryTime) {
      // Key already expired
      label = {
        "l10n-id": "openpgp-selection-status-error",
        "l10n-args": { key: this.getSenderUserId() },
      };
    } else {
      // Will expire within the next 31 days.
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      label = {
        "l10n-id": "openpgp-selection-status-expiring-soon",
        "l10n-args": {
          key: this.getSenderUserId(),
          when: rtf.format(expiresInDays, "day"),
        },
      };
    }
    const buttons = [
      {
        "l10n-id": "settings-context-open-account-settings-item2",
        callback() {
          MsgAccountManager(
            "am-e2e.xhtml",
            MailServices.accounts.getServersForIdentity(gCurrentIdentity)[0]
          );
          Services.wm.getMostRecentWindow("mail:3pane")?.focus();
          return true;
        },
      },
    ];

    await gComposeNotification.appendNotification(
      "openpgpSenderKeyExpiry",
      {
        label,
        priority: gComposeNotification.PRIORITY_WARNING_MEDIUM,
      },
      buttons
    );
  },

  /**
   * Display a warning message if we are replying to or forwarding
   * a partially decrypted inline-PGP email
   */
  async displayPartialEncryptedWarning() {
    const [msgText, accessKey, label, detailsText] =
      await document.l10n.formatValues([
        { id: "msg-compose-partially-encrypted-short" },
        { id: "msg-compose-details-button-access-key" },
        { id: "msg-compose-details-button-label" },
        { id: "msg-compose-partially-encrypted-inlinePGP" },
      ]);
    await gComposeNotification.appendNotification(
      "notifyPartialDecrypt",
      {
        label: msgText,
        priority: gComposeNotification.PRIORITY_CRITICAL_MEDIUM,
      },
      [
        {
          accessKey,
          label,
          callback() {
            Services.prompt.alert(window, null, detailsText);
          },
        },
      ]
    );
  },

  editorSelectAll() {
    if (this.editor) {
      this.editor.selectAll();
    }
  },

  editorGetContentAs(mimeType, flags) {
    if (this.editor) {
      return this.editor.outputToString(mimeType, flags);
    }
    return null;
  },

  /**
   * Merge multiple  Re: Re: into one Re: in message subject
   */
  fixMessageSubject() {
    const subjElem = document.getElementById("msgSubject");
    if (subjElem) {
      const r = subjElem.value.replace(/^(Re: )+/, "Re: ");
      if (r !== subjElem.value) {
        subjElem.value = r;
        if (typeof subjElem.oninput === "function") {
          subjElem.oninput();
        }
      }
    }
  },
};

/**
 * @implements {nsIMsgComposeStateListener}
 */
Enigmail.composeStateListener = {
  NotifyComposeFieldsReady() {
    Enigmail.msg.editor = gMsgCompose.editor.QueryInterface(Ci.nsIEditor);
    if (!Enigmail.msg.editor) {
      return;
    }

    Enigmail.msg.fixMessageSubject();
  },

  ComposeProcessDone(aResult) {
    // Note: called after a mail was sent (or saved)

    if (aResult != Cr.NS_OK) {
      Enigmail.msg.removeAttachedKey();
    }

    // ensure that securityInfo is set back to S/MIME flags (especially required if draft was saved)
    if (gSMFields && gMsgCompose) {
      gMsgCompose.compFields.composeSecure = gSMFields;
    }
  },

  NotifyComposeBodyReady() {
    const isEmpty = Enigmail.msg.editor.documentIsEmpty;
    const isEditable = Enigmail.msg.editor.isDocumentEditable;
    Enigmail.msg.composeBodyReady = true;

    if (isEditable && !isEmpty) {
      if (!Enigmail.msg.timeoutId && !Enigmail.msg.dirty) {
        Enigmail.msg.timeoutId = setTimeout(function () {
          Enigmail.msg.decryptQuote(false);
        }, 0);
      }
    }

    // This must be called by the last registered NotifyComposeBodyReady()
    // stateListener. We need this in order to know when the entire init
    // sequence of the composeWindow has finished, so the WebExtension compose
    // API can do its final modifications.
    window.composeEditorReady = true;
    window.dispatchEvent(new CustomEvent("compose-editor-ready"));
  },

  SaveInFolderDone() {},
};

window.addEventListener(
  "compose-startup-done",
  Enigmail.msg.composeStartup.bind(Enigmail.msg),
  {
    capture: false,
    once: true,
  }
);

window.addEventListener("compose-window-unload", () => {
  if (gMsgCompose) {
    gMsgCompose.UnregisterStateListener(Enigmail.composeStateListener);
  }
});
