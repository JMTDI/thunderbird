/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test that the display names in email addresses are correctly shown in the
 * thread pane.
 */

"use strict";

var { ensure_card_exists } = ChromeUtils.importESModule(
  "resource://testing-common/mail/AddressBookHelpers.sys.mjs"
);
var { be_in_folder, create_folder, get_about_3pane } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
  );
var { add_message_to_folder, create_message } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

var folder;

var messages = [
  // Basic From header tests
  {
    name: "from_display_name_unquoted",
    headers: { From: "Carter Burke <cburke@wyutani.invalid>" },
    expected: {
      column: "from",
      value: "Carter Burke <cburke@wyutani.invalid>",
    },
  },
  {
    name: "from_display_name_quoted",
    headers: { From: '"Ellen Ripley" <eripley@wyutani.invalid>' },
    expected: {
      column: "from",
      value: "Ellen Ripley <eripley@wyutani.invalid>",
    },
  },
  {
    name: "from_display_name_with_comma",
    headers: { From: '"William Gorman, Lt." <wgorman@uscmc.invalid>' },
    expected: {
      column: "from",
      value: "William Gorman, Lt. <wgorman@uscmc.invalid>",
    },
  },
  {
    name: "from_email_raw",
    headers: { From: "dhicks@uscmc.invalid" },
    expected: { column: "from", value: "dhicks@uscmc.invalid" },
  },
  {
    name: "from_email_in_angle_brackets",
    headers: { From: "<whudson@uscmc.invalid>" },
    expected: { column: "from", value: "whudson@uscmc.invalid" },
  },

  // Basic To header tests
  {
    name: "to_display_name_unquoted",
    headers: { To: "Carter Burke <cburke@wyutani.invalid>" },
    expected: {
      column: "recipients",
      value: "Carter Burke <cburke@wyutani.invalid>",
    },
  },
  {
    name: "to_display_name_quoted",
    headers: { To: '"Ellen Ripley" <eripley@wyutani.invalid>' },
    expected: {
      column: "recipients",
      value: "Ellen Ripley <eripley@wyutani.invalid>",
    },
  },
  {
    name: "to_display_name_with_comma",
    headers: { To: '"William Gorman, Lt." <wgorman@uscmc.invalid>' },
    expected: {
      column: "recipients",
      value: "William Gorman, Lt. <wgorman@uscmc.invalid>",
    },
  },
  {
    name: "to_email_raw",
    headers: { To: "dhicks@uscmc.invalid" },
    expected: { column: "recipients", value: "dhicks@uscmc.invalid" },
  },
  {
    name: "to_email_in_angle_brackets",
    headers: { To: "<whudson@uscmc.invalid>" },
    expected: { column: "recipients", value: "whudson@uscmc.invalid" },
  },
  {
    name: "to_display_name_multiple",
    headers: {
      To:
        "Carter Burke <cburke@wyutani.invalid>, " +
        "Dwayne Hicks <dhicks@uscmc.invalid>",
    },
    expected: {
      column: "recipients",
      value:
        "Carter Burke <cburke@wyutani.invalid>, Dwayne Hicks <dhicks@uscmc.invalid>",
    },
  },

  // Address book tests
  {
    name: "from_in_abook",
    headers: { From: "Al Apone <aapone@uscmc.invalid>" },
    expected: { column: "from", value: "Sarge" },
  },
  {
    name: "to_in_abook",
    headers: { To: "Al Apone <aapone@uscmc.invalid>" },
    expected: { column: "recipients", value: "Sarge" },
  },
  {
    name: "to_in_abook_multiple_mixed",
    headers: {
      To:
        "Al Apone <aapone@uscmc.invalid>, " +
        "Rebeccah Jorden <rjorden@hadleys-hope.invalid>",
    },
    expected: {
      column: "recipients",
      value: "Sarge, Newt",
    },
  },

  // Esoteric tests; these mainly test that we're getting the expected info back
  // from the message header.
  {
    name: "from_display_name_multiple",
    headers: {
      From:
        "Carter Burke <cburke@wyutani.invalid>, " +
        "Dwayne Hicks <dhicks@uscmc.invalid>",
    },
    expected: {
      column: "from",
      value: "Carter Burke <cburke@wyutani.invalid> et al.",
    },
  },
  {
    name: "from_missing",
    headers: { From: null },
    expected: { column: "from", value: "" },
  },
  {
    name: "from_empty",
    headers: { From: "" },
    expected: { column: "from", value: "" },
  },
  {
    name: "from_invalid",
    headers: { From: "invalid" },
    expected: { column: "from", value: "invalid" },
  },
  {
    name: "from_and_sender_display_name",
    headers: {
      From: "Carter Burke <cburke@wyutani.invalid>",
      Sender: "The Company <thecompany@wyutani.invalid>",
    },
    expected: {
      column: "from",
      value: "Carter Burke <cburke@wyutani.invalid>",
    },
  },
  {
    name: "sender_and_no_from_display_name",
    headers: { From: null, Sender: "The Company <thecompany@wyutani.invalid>" },
    expected: {
      column: "from",
      value: "The Company <thecompany@wyutani.invalid>",
    },
  },
  {
    name: "to_missing",
    headers: { To: null },
    expected: { column: "recipients", value: "" },
  },
  {
    name: "to_empty",
    headers: { To: "" },
    expected: { column: "recipients", value: "" },
  },
  {
    name: "to_invalid",
    headers: { To: "invalid" },
    expected: { column: "recipients", value: "invalid" },
  },
  {
    name: "to_and_cc_display_name",
    headers: {
      To: "Carter Burke <cburke@wyutani.invalid>",
      Cc: "The Company <thecompany@wyutani.invalid>",
    },
    expected: {
      column: "recipients",
      value: "Carter Burke <cburke@wyutani.invalid>",
    },
  },
  {
    name: "cc_and_no_to_display_name",
    headers: { To: null, Cc: "The Company <thecompany@wyutani.invalid>" },
    expected: {
      column: "recipients",
      value: "The Company <thecompany@wyutani.invalid>",
    },
  },
];

var contacts = [
  { email: "aapone@uscmc.invalid", name: "Sarge" },
  { email: "rjorden@hadleys-hope.invalid", name: "Newt" },
];

add_setup(async function () {
  // Use an ascending order because this test relies on message arrays matching.
  Services.prefs.setIntPref("mailnews.default_sort_order", 1);

  folder = await create_folder("DisplayNameA");

  for (const message of messages) {
    await add_message_to_folder(
      [folder],
      create_message({
        clobberHeaders: message.headers,
      })
    );
  }

  for (const contact of contacts) {
    ensure_card_exists(contact.email, contact.name);
  }

  await be_in_folder(folder);

  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("mailnews.default_sort_order");
  });
});

async function check_display_name(index, columnName, expectedName) {
  let columnId;
  switch (columnName) {
    case "from":
      columnId = "senderCol";
      break;
    case "recipients":
      columnId = "recipientCol";
      break;
    default:
      throw new Error("unknown column name: " + columnName);
  }

  const cellText = get_about_3pane().gDBView.cellTextForColumn(index, columnId);
  Assert.equal(cellText, expectedName, columnName);
}

// Generate a test for each message in |messages|.
for (const [i, message] of messages.entries()) {
  this["test_" + message.name] = async function (index, msg) {
    await check_display_name(index, msg.expected.column, msg.expected.value);
  }.bind(this, i, message);
  add_task(this[`test_${message.name}`]);
}
