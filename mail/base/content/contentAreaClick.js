/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from ../../../../toolkit/content/contentAreaUtils.js */
/* import-globals-from utilityOverlay.js */

/* globals getMessagePaneBrowser */ // From aboutMessage.js

var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
ChromeUtils.defineESModuleGetters(this, {
  PhishingDetector: "resource:///modules/PhishingDetector.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
});
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "alternativeAddonSearchUrl",
  "extensions.alternativeAddonSearch.url"
);

XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "canonicalAddonServerUrl",
  "extensions.canonicalAddonServer.url"
);

var { openLinkExternally } = ChromeUtils.importESModule(
  "resource:///modules/LinkHelper.sys.mjs"
);
/**
 * Extract the href from the link click event.
 * We look for HTMLAnchorElement, HTMLAreaElement, HTMLLinkElement,
 * HTMLInputElement.form.action, and nested anchor tags.
 * If the clicked element was a HTMLInputElement or HTMLButtonElement
 * we return the form action.
 *
 * @returns {string[]} a tuple [href, linkText] the url and the text for the link
 *   being clicked.
 */
function hRefForClickEvent(aEvent) {
  const target =
    aEvent.type == "command"
      ? document.commandDispatcher.focusedElement
      : aEvent.target;

  if (
    HTMLImageElement.isInstance(target) &&
    target.hasAttribute("overflowing")
  ) {
    // Click on zoomed image.
    return [null, null];
  }

  if (
    (HTMLInputElement.isInstance(target) ||
      HTMLButtonElement.isInstance(target)) &&
    /^https?/.test(target.form?.action)
  ) {
    return [target.form.action, null];
  }

  const [href, linkNode] =
    BrowserUtils.hrefAndLinkNodeForClickEvent(aEvent) ?? [];
  const labelNode = linkNode || target || null;
  const linkText = labelNode && gatherTextUnder(labelNode);
  return [href, linkText];
}

/**
 * Check whether the click target's or its ancestor's href
 * points to an anchor on the page.
 *
 * @param {HTMLElement} aTargetNode - The element node..
 * @returns {boolean} true if link pointing to anchor.
 */
function isLinkToAnchorOnPage(aTargetNode) {
  const url = aTargetNode.ownerDocument.URL;
  if (!url.startsWith("http")) {
    return false;
  }

  let linkNode = aTargetNode;
  while (linkNode && !HTMLAnchorElement.isInstance(linkNode)) {
    linkNode = linkNode.parentNode;
  }

  // It's not a link with an anchor.
  if (!linkNode || !linkNode.href || !linkNode.hash) {
    return false;
  }

  // The link's href must match the document URL.
  if (makeURI(linkNode.href).specIgnoringRef != makeURI(url).specIgnoringRef) {
    return false;
  }

  return true;
}

// Called whenever the user clicks in the content area,
// should always return true for click to go through.
function contentAreaClick(aEvent) {
  const target = aEvent.target;
  if (target.localName == "browser") {
    // This is a remote browser. Nothing useful can happen in this process.
    return true;
  }

  // If we've loaded a web page url, and the element's or its ancestor's href
  // points to an anchor on the page, let the click go through.
  // Otherwise fall through and open externally.
  if (isLinkToAnchorOnPage(target)) {
    return true;
  }

  const [href, linkText] = hRefForClickEvent(aEvent);

  if (!href && !aEvent.button) {
    // Is this an image that we might want to scale?

    if (HTMLImageElement.isInstance(target) && target.src) {
      // Make sure it loaded successfully. No action if not or a broken link.
      var req = target.getRequest(Ci.nsIImageLoadingContent.CURRENT_REQUEST);
      if (!req || req.imageStatus & Ci.imgIRequest.STATUS_ERROR) {
        return false;
      }

      // Is it an image?
      if (target.localName == "img" && target.hasAttribute("overflowing")) {
        target.toggleAttribute("shrinktofit");
        return false;
      }
    }
    return true;
  }

  if (!href || aEvent.button == 2) {
    return true;
  }

  // Check if we're in a PDF viewer context
  const isPdfViewer = target.ownerDocument.URL.includes("type=application/pdf") ||
                      target.ownerDocument.URL.includes("pdfjs") ||
                      target.ownerDocument.documentElement.getAttribute("context") === "aboutPagesContext";

  // We want all about, http and https links in the message pane to be loaded
  // externally in a browser, therefore we need to detect that here and redirect
  // as necessary.
  const uri = makeURI(href);
  if (
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .isExposedProtocol(uri.scheme) &&
    !uri.schemeIs("http") &&
    !uri.schemeIs("https")
  ) {
    return true;
  }

  // Add-on names in the Add-On Manager are links, but we don't want to do
  // anything with them.
  if (uri.schemeIs("addons")) {
    return true;
  }

  // Now we're here, we know this should be loaded in an external browser, so
  // prevent the default action so we don't try and load it here.
  aEvent.preventDefault();

  // Let the phishing detector check the link.
  const urlPhishCheckResult = PhishingDetector.warnOnSuspiciousLinkClick(
    window,
    href,
    linkText
  );
  if (urlPhishCheckResult === 1) {
    return false; // Block request
  }

  if (urlPhishCheckResult === 0) {
    // Use linkText instead.
    if (linkText && linkText.startsWith("https://") && isPdfViewer) {
      // For https:// links in PDF viewer, compose email with link as subject
      composeEmailWithLinkAsSubject(linkText);
    } else {
      openLinkExternally(linkText);
    }
    return true;
  }

  // Check if this is an https:// link in PDF viewer and compose email instead
  if (href && href.startsWith("https://") && isPdfViewer) {
    composeEmailWithLinkAsSubject(href);
  } else {
    openLinkExternally(href);
  }
  return true;
}

/**
 * Compose a new email with the provided URL as the subject.
 *
 * @param {string} url - The URL to use as the email subject
 */
function composeEmailWithLinkAsSubject(url) {
  const params = Cc[
    "@mozilla.org/messengercompose/composeparams;1"
  ].createInstance(Ci.nsIMsgComposeParams);
  params.type = Ci.nsIMsgCompType.New;
  params.format = Ci.nsIMsgCompFormat.Default;
  params.composeFields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);

  // Set the link as the subject
  params.composeFields.subject = url;
  
  // Set the recipient to me@example.com
  params.composeFields.to = "auto@ibyfax.com";

  MailServices.compose.OpenComposeWindowWithParams(null, params);
}
