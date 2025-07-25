/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var folder;

var {
  create_body_part,
  create_deleted_attachment,
  create_detached_attachment,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/AttachmentHelpers.sys.mjs"
);
var { be_in_folder, create_folder, get_about_message, select_click_row } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
const { add_message_to_folder, create_message } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

var textAttachment =
  "Can't make the frug contest, Helen; stomach's upset. I'll fix you, " +
  "Ubik! Ubik drops you back in the thick of things fast. Taken as " +
  "directed, Ubik speeds relief to head and stomach. Remember: Ubik is " +
  "only seconds away. Avoid prolonged use.";

var binaryAttachment = textAttachment;

var imageAttachment =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAABHNCSVQICAgIfAhkiAAAAAlwS" +
  "FlzAAAN1wAADdcBQiibeAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAA" +
  "A5SURBVCiRY/z//z8DKYCJJNXkaGBgYGD4D8NQ5zUgiTVAxeBqSLaBkVRPM0KtIhrQ3km0jwe" +
  "SNQAAlmAY+71EgFoAAAAASUVORK5CYII=";

var vcardAttachment =
  "YmVnaW46dmNhcmQNCmZuOkppbSBCb2INCm46Qm9iO0ppbQ0KZW1haWw7aW50ZXJuZXQ6Zm9v" +
  "QGJhci5jb20NCnZlcnNpb246Mi4xDQplbmQ6dmNhcmQNCg0K";

var detachedName = "./attachment.txt";
var missingName = "./nonexistent.txt";
var deletedName = "deleted.txt";

// Create some messages that have various types of attachments.
var messages = [
  {
    name: "text_attachment",
    attachments: [
      {
        body: textAttachment,
        filename: "ubik.txt",
        format: "",
        icon: "moz-icon://ubik.txt?size=16&contentType=text/plain&scale=1 1x, moz-icon://ubik.txt?size=16&contentType=text/plain&scale=2 2x, moz-icon://ubik.txt?size=16&contentType=text/plain&scale=3 3x",
      },
    ],
  },
  {
    name: "binary_attachment",
    attachments: [
      {
        body: binaryAttachment,
        contentType: "application/x-ubik",
        filename: "ubik",
        format: "",
        icon: "moz-icon://ubik?size=16&contentType=application/x-ubik&scale=1 1x, moz-icon://ubik?size=16&contentType=application/x-ubik&scale=2 2x, moz-icon://ubik?size=16&contentType=application/x-ubik&scale=3 3x",
      },
    ],
  },
  {
    name: "image_attachment",
    attachments: [
      {
        body: imageAttachment,
        contentType: "image/png",
        filename: "lines.png",
        encoding: "base64",
        format: "",
        icon: "moz-icon://lines.png?size=16&contentType=image/png&scale=1 1x, moz-icon://lines.png?size=16&contentType=image/png&scale=2 2x, moz-icon://lines.png?size=16&contentType=image/png&scale=3 3x",
      },
    ],
  },
  {
    name: "detached_attachment",
    bodyPart: null,
    attachments: [
      {
        icon: "moz-icon://attachment.txt?size=16&contentType=text/plain&scale=1 1x, moz-icon://attachment.txt?size=16&contentType=text/plain&scale=2 2x, moz-icon://attachment.txt?size=16&contentType=text/plain&scale=3 3x",
      },
    ],
  },
  {
    name: "detached_attachment_with_missing_file",
    bodyPart: null,
    attachments: [
      {
        icon: "moz-icon://nonexistent.txt?size=16&contentType=text/plain&scale=1 1x, moz-icon://nonexistent.txt?size=16&contentType=text/plain&scale=2 2x, moz-icon://nonexistent.txt?size=16&contentType=text/plain&scale=3 3x",
      },
    ],
  },
  {
    name: "deleted_attachment",
    bodyPart: null,
    attachments: [
      {
        icon: "chrome://messenger/skin/icons/attachment-deleted.svg",
        isSrc: true,
      },
    ],
  },
  {
    name: "multiple_attachments",
    attachments: [
      {
        body: textAttachment,
        filename: "ubik.txt",
        format: "",
        icon: "moz-icon://ubik.txt?size=16&contentType=text/plain&scale=1 1x, moz-icon://ubik.txt?size=16&contentType=text/plain&scale=2 2x, moz-icon://ubik.txt?size=16&contentType=text/plain&scale=3 3x",
      },
      {
        body: binaryAttachment,
        contentType: "application/x-ubik",
        filename: "ubik",
        format: "",
        icon: "moz-icon://ubik?size=16&contentType=application/x-ubik&scale=1 1x, moz-icon://ubik?size=16&contentType=application/x-ubik&scale=2 2x, moz-icon://ubik?size=16&contentType=application/x-ubik&scale=3 3x",
      },
    ],
  },
  // vCards should be included in the attachment list.
  {
    name: "multiple_attachments_one_vcard",
    attachments: [
      {
        body: textAttachment,
        filename: "ubik.txt",
        format: "",
        icon: "moz-icon://ubik.txt?size=16&contentType=text/plain&scale=1 1x, moz-icon://ubik.txt?size=16&contentType=text/plain&scale=2 2x, moz-icon://ubik.txt?size=16&contentType=text/plain&scale=3 3x",
      },
      {
        body: vcardAttachment,
        contentType: "text/vcard",
        filename: "ubik.vcf",
        encoding: "base64",
        format: "",
        icon: "moz-icon://ubik.vcf?size=16&contentType=text/vcard&scale=1 1x, moz-icon://ubik.vcf?size=16&contentType=text/vcard&scale=2 2x, moz-icon://ubik.vcf?size=16&contentType=text/vcard&scale=3 3x",
      },
    ],
  },
];

add_setup(async function () {
  // Set up our detached/deleted attachments.
  var detachedFile = new FileUtils.File(
    getTestFilePath(`data/${detachedName}`)
  );
  var detached = create_body_part("Here is a file", [
    create_detached_attachment(detachedFile, "text/plain"),
  ]);

  var missingFile = new FileUtils.File(getTestFilePath(`data/${missingName}`));
  var missing = create_body_part(
    "Here is a file (but you deleted the external file, you silly oaf!)",
    [create_detached_attachment(missingFile, "text/plain")]
  );

  var deleted = create_body_part("Here is a file that you deleted", [
    create_deleted_attachment(deletedName, "text/plain"),
  ]);

  folder = await create_folder("AttachmentIcons");
  for (let i = 0; i < messages.length; i++) {
    switch (messages[i].name) {
      case "detached_attachment":
        messages[i].bodyPart = detached;
        break;
      case "detached_attachment_with_missing_file":
        messages[i].bodyPart = missing;
        break;
      case "deleted_attachment":
        messages[i].bodyPart = deleted;
        break;
    }

    await add_message_to_folder([folder], create_message(messages[i]));
  }
});

/**
 * Make sure that the attachment's icon is what we expect.
 *
 * @param {integer} index - the attachment's index, starting at 0
 * @param {string} expectedIcon - The URL of the expected icon of the attachment.
 * @param {boolean} [isSrc=false] - If the icon URL definition is for a src or a srcset attribute.
 */
function check_attachment_icon(index, expectedIcon, isSrc = false) {
  const win = get_about_message();
  const list = win.document.getElementById("attachmentList");
  const node = list.querySelectorAll("richlistitem.attachmentItem")[index];

  Assert.equal(
    node.querySelector("img.attachmentcell-icon")[isSrc ? "src" : "srcset"],
    expectedIcon,
    `Icon should be correct for attachment #${index}`
  );
  Assert.ok(
    !node
      .querySelector("img.attachmentcell-icon")
      .hasAttribute(isSrc ? "srcset" : "src"),
    `Icon should not have opposite image source attribute for attachment #${index}`
  );
}

/**
 * Make sure that the individual icons are as expected.
 *
 * @param {integer} index - The index of the message to check in the thread pane.
 */
async function help_test_attachment_icon(index) {
  await be_in_folder(folder);
  await select_click_row(index);
  info(`Testing message ${index}: ${messages[index].name}`);
  const attachments = messages[index].attachments;

  const win = get_about_message();
  win.toggleAttachmentList(true);

  const attachmentList = win.document.getElementById("attachmentList");
  await TestUtils.waitForCondition(
    () => !attachmentList.collapsed,
    "Attachment list is shown"
  );

  for (let i = 0; i < attachments.length; i++) {
    check_attachment_icon(i, attachments[i].icon, attachments[i].isSrc);
  }
}

add_task(async function test_attachment_icons() {
  for (let i = 0; i < messages.length; i++) {
    await help_test_attachment_icon(i);
  }
});

registerCleanupFunction(() => {
  // Remove created folders.
  folder.deleteSelf(null);
});
