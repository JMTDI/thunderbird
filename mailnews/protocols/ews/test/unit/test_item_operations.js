/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { localAccountUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/LocalAccountUtils.sys.mjs"
);
var { EwsServer, RemoteFolder } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/EwsServer.sys.mjs"
);

var incomingServer;

/**
 * @type {EwsServer}
 */
var ewsServer;

const ewsIdPropertyName = "ewsId";

add_setup(async function () {
  // Ensure we have an on-disk profile.
  do_get_profile();

  // Create a new mock EWS server, and start it.
  ewsServer = new EwsServer({ version: "Exchange2013" });
  ewsServer.start();

  // Create and configure the EWS incoming server.
  incomingServer = localAccountUtils.create_incoming_server(
    "ews",
    ewsServer.port,
    "user",
    "password"
  );
  incomingServer.setStringValue(
    "ews_url",
    `http://127.0.0.1:${ewsServer.port}/EWS/Exchange.asmx`
  );

  registerCleanupFunction(() => {
    ewsServer.stop();
    incomingServer.closeCachedConnections();
  });
});

/**
 * Construct the test structure required for copying or moving items.
 *
 * The `prefix` argument indicates the prefix to apply to the folders
 * constructed for the test setup. This function will create two folders on the
 * remote server: `<prefix>_folder1` and `<prefix>_folder2`, and will place two
 * items in `<prefix>_folder1` named `<prefix>_a` and `<prefix>_b`. This
 * function returns a tuple with the names of the two folders as the first two
 * elements and the folders themselves as the second two elements.
 *
 * @param {string} prefix
 * @returns {[string, string, nsIMsgFolder, nsIMsgFolder]}
 */
async function setup_item_copymove_structure(prefix) {
  // Create two folders for the copy/move tests.
  const folder1Name = `${prefix}_folder1`;
  const folder2Name = `${prefix}_folder2`;
  ewsServer.appendRemoteFolder(
    new RemoteFolder(folder1Name, "root", folder1Name, folder1Name)
  );
  ewsServer.appendRemoteFolder(
    new RemoteFolder(folder2Name, "root", folder2Name, folder2Name)
  );

  const rootFolder = incomingServer.rootFolder;
  incomingServer.getNewMessages(rootFolder, null, null);

  await TestUtils.waitForCondition(
    () => rootFolder.getChildNamed(folder2Name),
    "waiting for folders to exist."
  );

  const folder1 = rootFolder.getChildNamed(folder1Name);
  Assert.ok(!!folder1, `${folder1Name} should exist.`);
  const folder2 = rootFolder.getChildNamed(folder2Name);
  Assert.ok(!!folder2, `${folder2Name} should exist.`);

  ewsServer.addNewItemOrMoveItemToFolder(`${prefix}_a`, folder1Name);
  ewsServer.addNewItemOrMoveItemToFolder(`${prefix}_b`, folder1Name);

  incomingServer.getNewMessages(folder1, null, null);

  await TestUtils.waitForCondition(
    () => folder1.getTotalMessages(false) == 2,
    `Waiting for messages to appear in ${folder1Name}`
  );
  Assert.equal(
    folder2.getTotalMessages(false),
    0,
    `${folder2Name} should be empty.`
  );

  return [folder1Name, folder2Name, folder1, folder2];
}

add_task(async function test_move_item() {
  const [folder1Name, folder2Name, folder1, folder2] =
    await setup_item_copymove_structure("move");

  const headers = [];
  [...folder1.messages].forEach(header => headers.push(header));

  // Initiate the move operation.
  const isMove = true;
  folder2.copyMessages(folder1, headers, isMove, null, null, true, false);

  await TestUtils.waitForCondition(
    () => folder2.getTotalMessages(false) == 2,
    `Waiting for messages to appear in ${folder2Name}`
  );

  await TestUtils.waitForCondition(
    () => folder1.getTotalMessages(false) == 0,
    `Waiting for messages to disappear in ${folder1Name}`
  );

  Assert.equal(
    ewsServer.getContainingFolderId("move_a"),
    folder2Name,
    `Item move_a should be in ${folder2Name}`
  );
  Assert.equal(
    ewsServer.getContainingFolderId("move_b"),
    folder2Name,
    `Item move_b should be in ${folder2Name}`
  );
  Assert.equal(
    folder1.getTotalMessages(false),
    0,
    `${folder1Name} should be empty`
  );
  Assert.equal(
    folder2.getTotalMessages(false),
    2,
    `${folder2Name} should have 2 messages`
  );
});

add_task(async function test_copy_item() {
  const [folder1Name, folder2Name, folder1, folder2] =
    await setup_item_copymove_structure("copy");

  const headers = [];
  [...folder1.messages].forEach(header => headers.push(header));

  // Initiate the copy operation.
  const isMove = false;
  folder2.copyMessages(folder1, headers, isMove, null, null, true, false);

  await TestUtils.waitForCondition(
    () => folder2.getTotalMessages(false) == 2,
    `Waiting for messages to appear in ${folder2Name}`
  );

  Assert.equal(
    folder1.getTotalMessages(false),
    2,
    `${folder1Name} should contain 2 messages`
  );
  Assert.equal(
    folder2.getTotalMessages(false),
    2,
    `${folder2Name} should contain 2 messages`
  );
  Assert.equal(
    ewsServer.getContainingFolderId("copy_a"),
    folder1Name,
    `Item copy_a should be in ${folder1Name}`
  );
  Assert.equal(
    ewsServer.getContainingFolderId("copy_b"),
    folder1Name,
    `Item copy_b should be in ${folder1Name}`
  );
  Assert.equal(
    ewsServer.getContainingFolderId("copy_a_copy"),
    folder2Name,
    `Item copy_a_copy should be in ${folder2Name}`
  );
  Assert.equal(
    ewsServer.getContainingFolderId("copy_b_copy"),
    folder2Name,
    `Item copy_b_copy should be in ${folder2Name}`
  );
});

add_task(async function test_move_folder() {
  const parent1Name = "parent1";
  const parent2Name = "parent2";
  const childName = "child";

  ewsServer.appendRemoteFolder(
    new RemoteFolder(parent1Name, "root", parent1Name, parent1Name)
  );
  ewsServer.appendRemoteFolder(
    new RemoteFolder(parent2Name, "root", parent2Name, parent2Name)
  );
  ewsServer.appendRemoteFolder(
    new RemoteFolder(childName, parent1Name, childName, childName)
  );

  const rootFolder = incomingServer.rootFolder;
  incomingServer.getNewMessages(rootFolder, null, null);

  await TestUtils.waitForCondition(
    () => !!rootFolder.getChildNamed(parent2Name),
    "Waiting for parent folders to exist"
  );

  const parent1 = rootFolder.getChildNamed(parent1Name);
  Assert.ok(!!parent1, `${parent1Name} should exist.`);
  const parent2 = rootFolder.getChildNamed(parent2Name);
  Assert.ok(!!parent2, `${parent2Name} should exist.`);

  await TestUtils.waitForCondition(
    () => !!parent1.getChildNamed(childName),
    "Waiting for child folder to exist."
  );

  const child = parent1.getChildNamed(childName);
  Assert.ok(!!child, `${childName} should exist in ${parent1Name}`);

  parent2.copyFolder(child, true, null, null);

  await TestUtils.waitForCondition(
    () => !!parent2.getChildNamed(childName),
    `Waiting for ${childName} to exist in ${parent2Name}`
  );

  Assert.ok(
    !parent1.getChildNamed(childName),
    `${childName} should not exist in ${parent1Name}`
  );
  Assert.ok(
    !!parent2.getChildNamed(childName),
    `${childName} should exist in ${parent2Name}`
  );
});
