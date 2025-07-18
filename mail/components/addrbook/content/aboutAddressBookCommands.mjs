/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* import-globals-from ./aboutAddressBook.js */

import commandController from "resource:///modules/CommandController.mjs";

const noOverlays = () => !detailsPane.isEditing && !SubDialog.hasDialogs;

commandController.registerCallback(
  "cmd_newCard",
  function (address, vCard) {
    // The unified toolbar button passes the mouse event as the first argument
    // to a command, so we need to make sure we got a string.
    if (typeof address === "string") {
      detailsPane.editNewContact(
        `BEGIN:VCARD\r\nEMAIL:${address}\r\nEND:VCARD\r\n`
      );
    } else {
      detailsPane.editNewContact(vCard);
    }
  },
  () => document.getElementById("books").canCreateContact() && noOverlays()
);

commandController.registerCallback("cmd_displayContact", function (card) {
  if (!card || !card.directoryUID) {
    return;
  }
  const book = MailServices.ab.getDirectoryFromUID(card.directoryUID);
  if (!book) {
    return;
  }

  cardsPane.searchInput.reset();
  booksList.selectedIndex = booksList.getIndexForUID(card.directoryUID);
  cardsPane.cardsList.selectedIndex = cardsPane.cardsList.view.getIndexForUID(
    card.UID
  );
});

commandController.registerCallback("cmd_editContact", function (card) {
  if (!card || !card.directoryUID) {
    return;
  }
  const book = MailServices.ab.getDirectoryFromUID(card.directoryUID);
  if (!book) {
    return;
  }

  cardsPane.searchInput.reset();
  booksList.selectedIndex = booksList.getIndexForUID(card.directoryUID);
  cardsPane.cardsList.selectedIndex = cardsPane.cardsList.view.getIndexForUID(
    card.UID
  );
  if (book && !book.readOnly) {
    detailsPane.editCurrentContact();
  }
});

commandController.registerCallback("cmd_print", function () {
  if (document.activeElement == booksList) {
    booksList.printSelected();
  } else {
    cardsPane.printSelected();
  }
});

// JS type is the default, but we also register the command with the explicit
// type for convenience.
commandController.registerCallback(
  "cmd_createAddressBook",
  function () {
    createBook();
  },
  noOverlays
);
commandController.registerCallback(
  "cmd_createAddressBookJS",
  function () {
    createBook();
  },
  noOverlays
);

commandController.registerCallback(
  "cmd_createAddressBookCARDDAV",
  function () {
    createBook(Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE);
  },
  noOverlays
);

commandController.registerCallback(
  "cmd_createAddressBookLDAP",
  function () {
    createBook(Ci.nsIAbManager.LDAP_DIRECTORY_TYPE);
  },
  noOverlays
);

commandController.registerCallback(
  "cmd_createList",
  function () {
    createList();
  },
  () => document.getElementById("books").canCreateList() && noOverlays()
);

commandController.registerCallback("cmd_importContacts", function () {
  importBook();
});

commandController.registerCallback("cmd_displayAddressBook", function (UID) {
  displayAddressBook(UID);
});
