/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { OpenPGPTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mail/OpenPGPTestUtils.sys.mjs"
);

const OPENPGP_TEST_DIR = do_get_file("../../../../test/browser/openpgp");
const OPENPGP_KEY_PATH = PathUtils.join(
  OPENPGP_TEST_DIR.path,
  "data",
  "keys",
  "alice@openpgp.example-0xf231550c4f47e38e-secret.asc"
);

add_setup(async () => {
  await OpenPGPTestUtils.initOpenPGP();
});

/**
 * Test the messages.getRaw and messages.getFull functions. Since each message
 * is unique and there are minor differences between the account
 * implementations, we don't compare exactly with a reference message.
 */
add_task(async function test_plain_mv2() {
  const _account = await createAccount();
  const _folder = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test1"
  );
  await createMessages(_folder, 1);

  const extension = ExtensionTestUtils.loadExtension({
    background: async () => {
      const accounts = await browser.accounts.list();
      browser.test.assertEq(1, accounts.length);

      for (const account of accounts) {
        const folder = account.folders.find(f => f.name == "test1");
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);

        const [message] = messages;

        // Expected message content:
        // -------------------------
        // From andy@anway.invalid
        // Content-Type: text/plain; charset=ISO-8859-1; format=flowed
        // Subject: Big Meeting Today
        // From: "Andy Anway" <andy@anway.invalid>
        // To: "Bob Bell" <bob@bell.invalid>
        // Message-Id: <0@made.up.invalid>
        // Date: Wed, 06 Nov 2019 22:37:40 +1300
        //
        // Hello Bob Bell!
        //

        browser.test.assertEq("Big Meeting Today", message.subject);
        browser.test.assertEq(
          "Andy Anway <andy@anway.invalid>",
          message.author
        );

        // The msgHdr of NNTP messages have no recipients.
        if (account.type != "nntp") {
          browser.test.assertEq(
            "Bob Bell <bob@bell.invalid>",
            message.recipients[0]
          );
        }

        const strMessage_1 = await browser.messages.getRaw(message.id);
        browser.test.assertEq("string", typeof strMessage_1);
        const strMessage_2 = await browser.messages.getRaw(message.id, {
          data_format: "BinaryString",
        });
        browser.test.assertEq("string", typeof strMessage_2);
        const fileMessage_3 = await browser.messages.getRaw(message.id, {
          data_format: "File",
        });
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(fileMessage_3 instanceof File);
        // Since we do not have utf-8 chars in the test message, the returned BinaryString is
        // identical to the return value of File.text().
        const strMessage_3 = await fileMessage_3.text();

        for (let strMessage of [strMessage_1, strMessage_2, strMessage_3]) {
          // Fold Windows line-endings \r\n to \n.
          strMessage = strMessage.replace(/\r/g, "");
          browser.test.assertTrue(
            strMessage.includes("Subject: Big Meeting Today\n")
          );
          browser.test.assertTrue(
            strMessage.includes('From: "Andy Anway" <andy@anway.invalid>\n')
          );
          browser.test.assertTrue(
            strMessage.includes('To: "Bob Bell" <bob@bell.invalid>\n')
          );
          browser.test.assertTrue(strMessage.includes("Hello Bob Bell!"));
        }

        // {
        //   "contentType": "message/rfc822",
        //   "headers": {
        //     "content-type": ["message/rfc822"],
        //     "subject": ["Big Meeting Today"],
        //     "from": ["\"Andy Anway\" <andy@anway.invalid>"],
        //     "to": ["\"Bob Bell\" <bob@bell.invalid>"],
        //     "message-id": ["<0@made.up.invalid>"],
        //     "date": ["Wed, 06 Nov 2019 22:37:40 +1300"]
        //   },
        //   "partName": "",
        //   "size": 17,
        //   "parts": [
        //     {
        //       "body": "Hello Bob Bell!\n\n",
        //       "contentType": "text/plain",
        //       "headers": {
        //         "content-type": ["text/plain; charset=ISO-8859-1; format=flowed"]
        //       },
        //       "partName": "1",
        //       "size": 17
        //     }
        //   ]
        // }

        const fullMessage = await browser.messages.getFull(message.id);
        browser.test.log(JSON.stringify(fullMessage));
        browser.test.assertEq("object", typeof fullMessage);
        browser.test.assertEq("message/rfc822", fullMessage.contentType);

        browser.test.assertEq("object", typeof fullMessage.headers);
        for (const header of [
          "content-type",
          "date",
          "from",
          "message-id",
          "subject",
          "to",
        ]) {
          browser.test.assertTrue(Array.isArray(fullMessage.headers[header]));
          browser.test.assertEq(1, fullMessage.headers[header].length);
        }
        browser.test.assertEq(
          "Big Meeting Today",
          fullMessage.headers.subject[0]
        );
        browser.test.assertEq(
          "Andy Anway <andy@anway.invalid>",
          fullMessage.headers.from[0]
        );
        browser.test.assertEq(
          "Bob Bell <bob@bell.invalid>",
          fullMessage.headers.to[0]
        );

        browser.test.assertTrue(Array.isArray(fullMessage.parts));
        browser.test.assertEq(1, fullMessage.parts.length);
        browser.test.assertEq("object", typeof fullMessage.parts[0]);
        browser.test.assertEq(
          "Hello Bob Bell!",
          fullMessage.parts[0].body.trimRight()
        );
      }

      browser.test.notifyPass("finished");
    },
    manifest: {
      manifest_version: 2,
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();

  cleanUpAccount(_account);
});

add_task(async function test_plain_mv3() {
  const _account = await createAccount();
  const _folder = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test1"
  );
  await createMessages(_folder, 1);

  const extension = ExtensionTestUtils.loadExtension({
    background: async () => {
      const accounts = await browser.accounts.list(true);
      browser.test.assertEq(1, accounts.length);

      for (const account of accounts) {
        const folder = account.rootFolder.subFolders.find(
          f => f.name == "test1"
        );
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(1, messages.length);

        const [message] = messages;

        // Expected message content:
        // -------------------------
        // From chris@clarke.invalid
        // Content-Type: text/plain; charset=ISO-8859-1; format=flowed
        // Subject: Small Party Tomorrow
        // From: "Chris Clarke" <chris@clarke.invalid>
        // To: "David Davol" <david@davol.invalid>
        // Message-Id: <1@made.up.invalid>
        // Date: Tue, 01 Feb 2000 01:00:00 +0100
        //
        // Hello David Davol!
        //

        browser.test.assertEq("Small Party Tomorrow", message.subject);
        browser.test.assertEq(
          "Chris Clarke <chris@clarke.invalid>",
          message.author
        );

        // The msgHdr of NNTP messages have no recipients.
        if (account.type != "nntp") {
          browser.test.assertEq(
            "David Davol <david@davol.invalid>",
            message.recipients[0]
          );
        }

        const fileMessage_1 = await browser.messages.getRaw(message.id);
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(fileMessage_1 instanceof File);
        // Since we do not have utf-8 chars in the test message, the returned
        // BinaryString is identical to the return value of File.text().
        const strMessage_1 = await fileMessage_1.text();

        const strMessage_2 = await browser.messages.getRaw(message.id, {
          data_format: "BinaryString",
        });
        browser.test.assertEq("string", typeof strMessage_2);

        const fileMessage_3 = await browser.messages.getRaw(message.id, {
          data_format: "File",
        });
        // eslint-disable-next-line mozilla/use-isInstance
        browser.test.assertTrue(fileMessage_3 instanceof File);
        const strMessage_3 = await fileMessage_3.text();

        for (let strMessage of [strMessage_1, strMessage_2, strMessage_3]) {
          // Fold Windows line-endings \r\n to \n.
          strMessage = strMessage.replace(/\r/g, "");
          browser.test.assertTrue(
            strMessage.includes("Subject: Small Party Tomorrow\n")
          );
          browser.test.assertTrue(
            strMessage.includes('From: "Chris Clarke" <chris@clarke.invalid>\n')
          );
          browser.test.assertTrue(
            strMessage.includes('To: "David Davol" <david@davol.invalid>\n')
          );
          browser.test.assertTrue(strMessage.includes("Hello David Davol!"));
        }

        // {
        //   "contentType": "message/rfc822",
        //   "headers": {
        //     "content-type": ["message/rfc822"],
        //     "subject": ["Small Party Tomorrow"],
        //     "from": ["\"Chris Clarke\" <chris@clarke.invalid>"],
        //     "to": ["\"David Davol\" <David Davol>"],
        //     "message-id": ["<1@made.up.invalid>"],
        //     "date": ["Tue, 01 Feb 2000 01:00:00 +0100"]
        //   },
        //   "partName": "",
        //   "size": 20,
        //   "parts": [
        //     {
        //       "body": "David Davol!\n\n",
        //       "contentType": "text/plain",
        //       "headers": {
        //         "content-type": ["text/plain; charset=ISO-8859-1; format=flowed"]
        //       },
        //       "partName": "1",
        //       "size": 20
        //     }
        //   ]
        // }

        const fullMessage = await browser.messages.getFull(message.id);
        browser.test.log(JSON.stringify(fullMessage));
        browser.test.assertEq("object", typeof fullMessage);
        browser.test.assertEq("message/rfc822", fullMessage.contentType);

        browser.test.assertEq("object", typeof fullMessage.headers);
        for (const header of [
          "content-type",
          "date",
          "from",
          "message-id",
          "subject",
          "to",
        ]) {
          browser.test.assertTrue(Array.isArray(fullMessage.headers[header]));
          browser.test.assertEq(1, fullMessage.headers[header].length);
        }
        browser.test.assertEq(
          "Small Party Tomorrow",
          fullMessage.headers.subject[0]
        );
        browser.test.assertEq(
          "Chris Clarke <chris@clarke.invalid>",
          fullMessage.headers.from[0]
        );
        browser.test.assertEq(
          "David Davol <david@davol.invalid>",
          fullMessage.headers.to[0]
        );

        browser.test.assertTrue(Array.isArray(fullMessage.parts));
        browser.test.assertEq(1, fullMessage.parts.length);
        browser.test.assertEq("object", typeof fullMessage.parts[0]);
        browser.test.assertEq(
          "Hello David Davol!",
          fullMessage.parts[0].body.trimRight()
        );
      }

      browser.test.notifyPass("finished");
    },
    manifest: {
      manifest_version: 3,
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();

  cleanUpAccount(_account);
});

/**
 * Test that mime parsers for all message types retrieve the correctly decoded
 * headers and bodies. Bodies should not be returned, if it is an attachment.
 * Sizes are not checked for.
 */
add_task(async function test_encoding() {
  const _account = await createAccount();
  const _folder = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test1"
  );

  // Main body with disposition inline, base64 encoded,
  // subject is UTF-8 encoded word.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample01.eml").path
  );
  // A multipart/mixed mime message, to header is iso-8859-1 encoded word,
  // body is quoted printable with iso-8859-1, attachments with different names
  // and filenames.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample02.eml").path
  );
  // Message with attachment only, From header is iso-8859-1 encoded word.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample03.eml").path
  );
  // Message with koi8-r + base64 encoded body, subject is koi8-r encoded word.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample04.eml").path
  );
  // Message with windows-1251 + base64 encoded body, subject is windows-1251
  // encoded word.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample05.eml").path
  );
  // Message without plain/text content-type.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample06.eml").path
  );
  // A multipart/alternative message without plain/text content-type.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample07.eml").path
  );
  // A multipart/related message with an embedded image.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/sample08.eml").path
  );
  // A message with utf-8 encoded from and to header, which have an encoded comma
  // and should be quoted after RFC2047 decoding.
  await createMessageFromFile(
    _folder,
    do_get_file("messages/utf8MailboxStrings.eml").path
  );

  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const accounts = await browser.accounts.list();
        browser.test.assertEq(1, accounts.length);
        const account = accounts[0];

        const expectedData = {
          "01.eml@mime.sample": {
            msgHeaders: {
              subject: "αλφάβητο",
              author: "Bug Reporter <new@thunderbird.bug>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Bug Reporter <new@thunderbird.bug>"],
                newsgroups: ["gmane.comp.mozilla.thundebird.user"],
                subject: ["αλφάβητο"],
                date: ["Thu, 27 May 2021 21:23:35 +0100"],
                "message-id": ["<01.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "text/plain",
                  partName: "1",
                  size: 0,
                  body: "Άλφα\n",
                  headers: {
                    "content-type": ["text/plain; charset=utf-8;"],
                    "content-transfer-encoding": ["base64"],
                    "content-disposition": ["inline"],
                  },
                },
              ],
            },
          },
          "02.eml@mime.sample": {
            msgHeaders: {
              subject: "Test message from Microsoft Outlook 00",
              author: "Doug Sauder <doug@example.com>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Doug Sauder <doug@example.com>"],
                to: ["Heinz Müller <mueller@example.com>"],
                subject: ["Test message from Microsoft Outlook 00"],
                date: ["Wed, 17 May 2000 19:32:47 -0400"],
                "message-id": ["<02.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
                "x-priority": ["3 (Normal)"],
                "x-msmail-priority": ["Normal"],
                "x-mailer": [
                  "Microsoft Outlook IMO, Build 9.0.2416 (9.0.2910.0)",
                ],
                importance: ["Normal"],
                "x-mimeole": ["Produced By Microsoft MimeOLE V5.00.2314.1300"],
              },
              parts: [
                {
                  contentType: "multipart/mixed",
                  partName: "1",
                  size: 0,
                  headers: {
                    "content-type": [
                      'multipart/mixed; boundary="----=_NextPart_000_0002_01BFC036.AE309650"',
                    ],
                  },
                  parts: [
                    {
                      contentType: "text/plain",
                      partName: "1.1",
                      size: 0,
                      body: `\nDie Hasen und die Frösche \n \n`,
                      headers: {
                        "content-type": ['text/plain; charset="iso-8859-1"'],
                        "content-transfer-encoding": ["quoted-printable"],
                      },
                    },
                    {
                      contentType: "image/png",
                      partName: "1.2",
                      size: 0,
                      name: "blueball2.png",
                      headers: {
                        "content-type": ['image/png; name="blueball1.png"'],
                        "content-transfer-encoding": ["base64"],
                        "content-disposition": [
                          'attachment; filename="blueball2.png"',
                        ],
                      },
                    },
                    {
                      contentType: "image/png",
                      partName: "1.3",
                      size: 0,
                      name: "greenball.png",
                      headers: {
                        "content-type": ['image/png; name="greenball.png"'],
                        "content-transfer-encoding": ["base64"],
                        "content-disposition": ["attachment"],
                      },
                    },
                    {
                      contentType: "image/png",
                      partName: "1.4",
                      size: 0,
                      name: "redball.png",
                      headers: {
                        "content-type": ["image/png"],
                        "content-transfer-encoding": ["base64"],
                        "content-disposition": [
                          'attachment; filename="redball.png"',
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
          "03.eml@mime.sample": {
            msgHeaders: {
              subject: "Test message from Microsoft Outlook 00",
              author: "Heinz Müller <mueller@example.com>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Heinz Müller <mueller@example.com>"],
                to: ["Joe Blow <jblow@example.com>"],
                subject: ["Test message from Microsoft Outlook 00"],
                date: ["Wed, 17 May 2000 19:35:05 -0400"],
                "message-id": ["<03.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
                "x-priority": ["3 (Normal)"],
                "x-msmail-priority": ["Normal"],
                "x-mailer": [
                  "Microsoft Outlook IMO, Build 9.0.2416 (9.0.2910.0)",
                ],
                importance: ["Normal"],
                "x-mimeole": ["Produced By Microsoft MimeOLE V5.00.2314.1300"],
              },
              parts: [
                {
                  contentType: "image/png",
                  name: "doubelspace  ball.png",
                  partName: "1",
                  size: 0,
                  headers: {
                    "content-type": ['image/png; name="doubelspace  ball.png"'],
                    "content-transfer-encoding": ["base64"],
                    "content-disposition": [
                      'attachment; filename="doubelspace  ball.png"',
                    ],
                  },
                },
              ],
            },
          },
          "04.eml@mime.sample": {
            msgHeaders: {
              subject: "Алфавит",
              author: "Bug Reporter <new@thunderbird.bug>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Bug Reporter <new@thunderbird.bug>"],
                newsgroups: ["gmane.comp.mozilla.thundebird.user"],
                subject: ["Алфавит"],
                date: ["Sun, 27 May 2001 21:23:35 +0100"],
                "message-id": ["<04.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "text/plain",
                  partName: "1",
                  size: 0,
                  body: "Вопрос\n",
                  headers: {
                    "content-type": ["text/plain; charset=koi8-r;"],
                    "content-transfer-encoding": ["base64"],
                  },
                },
              ],
            },
          },
          "05.eml@mime.sample": {
            msgHeaders: {
              subject: "Алфавит",
              author: "Bug Reporter <new@thunderbird.bug>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Bug Reporter <new@thunderbird.bug>"],
                newsgroups: ["gmane.comp.mozilla.thundebird.user"],
                subject: ["Алфавит"],
                date: ["Sun, 27 May 2001 21:23:35 +0100"],
                "message-id": ["<05.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "text/plain",
                  partName: "1",
                  size: 0,
                  body: "Вопрос\n",
                  headers: {
                    "content-type": ["text/plain; charset=windows-1251;"],
                    "content-transfer-encoding": ["base64"],
                  },
                },
              ],
            },
          },
          "06.eml@mime.sample": {
            msgHeaders: {
              subject: "I have no content type",
              author: "Bug Reporter <new@thunderbird.bug>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Bug Reporter <new@thunderbird.bug>"],
                newsgroups: ["gmane.comp.mozilla.thundebird.user"],
                subject: ["I have no content type"],
                date: ["Sun, 27 May 2001 21:23:35 +0100"],
                "message-id": ["<06.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "text/plain",
                  partName: "1",
                  size: 0,
                  body: "No content type\n",
                  headers: {
                    "content-type": ["text/plain"],
                  },
                },
              ],
            },
          },
          "07.eml@mime.sample": {
            msgHeaders: {
              subject: "Default content-types",
              author: "Doug Sauder <dwsauder@example.com>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["Doug Sauder <dwsauder@example.com>"],
                to: ["Heinz <mueller@example.com>"],
                subject: ["Default content-types"],
                date: ["Fri, 19 May 2000 00:29:55 -0400"],
                "message-id": ["<07.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "multipart/alternative",
                  partName: "1",
                  size: 0,
                  headers: {
                    "content-type": [
                      'multipart/alternative; boundary="=====================_714967308==_.ALT"',
                    ],
                  },
                  parts: [
                    {
                      contentType: "text/plain",
                      partName: "1.1",
                      size: 0,
                      body: "Die Hasen\n",
                      headers: {
                        "content-type": ["text/plain"],
                        "content-transfer-encoding": ["quoted-printable"],
                      },
                    },
                    {
                      contentType: "text/html",
                      partName: "1.2",
                      size: 0,
                      body: "<html><body><b>Die Hasen</b></body></html>\n",
                      headers: {
                        "content-type": ["text/html"],
                      },
                    },
                  ],
                },
              ],
            },
          },
          "08.eml@mime.sample": {
            msgHeaders: {
              subject: "Embedded Image",
              author: "John <john@example.com>",
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: ["John <john@example.com>"],
                to: ["user@invalid"],
                subject: ["Embedded Image"],
                date: ["Wed, 29 May 2024 15:26:47 +0200"],
                "message-id": ["<08.eml@mime.sample>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "multipart/related",
                  headers: {
                    "content-language": ["en-US"],
                    "content-type": [
                      `multipart/related; boundary="------------XDhTrqqN5B126r5Y7JBH0YyJ"`,
                    ],
                  },
                  size: 0,
                  partName: "1",
                  parts: [
                    {
                      contentType: "text/html",
                      headers: {
                        "content-type": ["text/html; charset=UTF-8"],
                        "content-transfer-encoding": ["7bit"],
                      },
                      size: 0,
                      partName: "1.1",
                      body: `<!DOCTYPE html>\r\n<html>\r\n  <head>\r\n    <meta http-equiv=\"content-type\" content=\"text/html; charset=UTF-8\">\r\n  </head>\r\n  <body>\r\n    <p>Example body</p>\r\n    <img moz-do-not-send=\"false\"\r\n      src=\"cid:part1.FxEY2Ivx.xSFtCdX4@example.com\" alt=\"\" width=\"1\"\r\n      height=\"1\" class=\"\">\r\n    <p>with embedded image.<br>\r\n    </p>\r\n    <br>\r\n  </body>\r\n</html>`,
                    },
                    {
                      contentType: "image/png",
                      headers: {
                        "content-type": [
                          `image/png; name="blue_pixel_1x1.png"`,
                        ],
                        "content-disposition": [
                          `inline; filename="blue_pixel_1x1.png"`,
                        ],
                        "content-id": ["<part1.FxEY2Ivx.xSFtCdX4@example.com>"],
                        "content-transfer-encoding": ["base64"],
                      },
                      size: 0,
                      name: "blue_pixel_1x1.png",
                      partName: "1.2",
                    },
                  ],
                },
              ],
            },
          },
          "1919244@thunderbird.bug": {
            msgHeaders: {
              subject: "Message for Bug 1919244",
              author: `"Hörst, Kenny" <K.Hoerst@invalid>`,
              recipients:
                account.type == "nntp"
                  ? []
                  : [
                      `"Hörst, Kenny" <K.Hoerst@invalid>`,
                      "Bug Reporter <new@thunderbird.bug>",
                    ],
            },
            msgParts: {
              contentType: "message/rfc822",
              partName: "",
              size: 0,
              decryptionStatus: "none",
              headers: {
                from: [`"Hörst, Kenny" <K.Hoerst@invalid>`],
                to: [
                  `"Hörst, Kenny" <K.Hoerst@invalid>, Bug Reporter <new@thunderbird.bug>`,
                ],
                subject: ["Message for Bug 1919244"],
                date: ["Mon, 23 Sep 2024 16:16:47 +0200"],
                "message-id": ["<1919244@thunderbird.bug>"],
                "mime-version": ["1.0"],
                "content-type": ["message/rfc822"],
              },
              parts: [
                {
                  contentType: "text/plain",
                  partName: "1",
                  size: 0,
                  body: "Test\n",
                  headers: {
                    "content-type": [
                      "text/plain; charset=UTF-8; format=flowed",
                    ],
                    "content-transfer-encoding": ["7bit"],
                  },
                },
              ],
            },
          },
        };

        function checkMsgHeaders(expected, actual) {
          // Check if all expected properties are there.
          for (const property of Object.keys(expected)) {
            browser.test.assertEq(
              expected.hasOwnProperty(property),
              actual.hasOwnProperty(property),
              `expected property ${property} is present`
            );
            // Check property content.
            if (Array.isArray(expected[property])) {
              window.assertDeepEqual(
                expected[property],
                actual[property],
                `property ${property} is correct (object)`
              );
            } else {
              browser.test.assertEq(
                expected[property],
                actual[property],
                `property ${property} is correct`
              );
            }
          }
        }

        function checkMsgParts(expected, actual) {
          // Check if all expected properties are there.
          for (const property of Object.keys(expected)) {
            browser.test.assertEq(
              expected.hasOwnProperty(property),
              actual.hasOwnProperty(property),
              `expected property ${property} is present`
            );
            if (
              ["parts", "headers", "size"].includes(property) ||
              (["body"].includes(property) && expected[property] == "")
            ) {
              continue;
            }
            // Check property content.
            browser.test.assertEq(
              JSON.stringify(expected[property].replaceAll("\r\n", "\n")),
              JSON.stringify(actual[property].replaceAll("\r\n", "\n")),
              `property ${property} is correct`
            );
          }

          // Check for unexpected properties.
          for (const property of Object.keys(actual)) {
            browser.test.assertEq(
              expected.hasOwnProperty(property),
              actual.hasOwnProperty(property),
              `property ${property} is expected`
            );
          }

          // Check if all expected headers are there.
          if (expected.headers) {
            for (const header of Object.keys(expected.headers)) {
              browser.test.assertEq(
                expected.headers.hasOwnProperty(header),
                actual.headers.hasOwnProperty(header),
                `expected header ${header} is present`
              );
              // Check header content.
              // Note: jsmime does not eat TABs after a CLRF.
              browser.test.assertEq(
                expected.headers[header].toString().replaceAll("\t", " "),
                actual.headers[header].toString().replaceAll("\t", " "),
                `header ${header} is correct`
              );
            }
            // Check for unexpected headers.
            // (But don't worry about new x-mozilla-* ones that get slipped in
            // during writes to the offline store).
            const x_moz_headers = [
              "x-mozilla-status",
              "x-mozilla-status2",
              "x-mozilla-status-keys",
            ];
            for (const header of Object.keys(actual.headers)) {
              if (x_moz_headers.includes(header)) {
                continue;
              }

              browser.test.assertEq(
                expected.headers.hasOwnProperty(header),
                actual.headers.hasOwnProperty(header),
                `header ${header} is expected`
              );
            }
          }

          // Check sub-parts.
          browser.test.assertEq(
            Array.isArray(expected.parts),
            Array.isArray(actual.parts),
            `has sub-parts`
          );
          if (Array.isArray(expected.parts)) {
            browser.test.assertEq(
              expected.parts.length,
              actual.parts.length,
              "number of parts"
            );
            for (const i in expected.parts) {
              checkMsgParts(expected.parts[i], actual.parts[i]);
            }
          }
        }

        const folder = account.folders.find(f => f.name == "test1");
        const { messages } = await browser.messages.list(folder.id);
        browser.test.assertEq(9, messages.length);

        for (const message of messages) {
          const fullMessage = await browser.messages.getFull(message.id);
          browser.test.assertEq("object", typeof fullMessage);
          const expected = expectedData[message.headerMessageId];
          checkMsgHeaders(expected.msgHeaders, message);
          checkMsgParts(expected.msgParts, fullMessage);
        }

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 2,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();

  cleanUpAccount(_account);
});

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_openpgp() {
    const _account = await createAccount();
    const _identity = addIdentity(_account);
    const _folder = await createSubfolder(
      _account.incomingServer.rootFolder,
      "test1"
    );

    // Load an encrypted message.

    const messagePath = PathUtils.join(
      OPENPGP_TEST_DIR.path,
      "data",
      "eml",
      "unsigned-encrypted-to-0xf231550c4f47e38e-from-0xfbfcc82a015e7330.eml"
    );
    await createMessageFromFile(_folder, messagePath);

    const extension = ExtensionTestUtils.loadExtension({
      files: {
        "background.js": async () => {
          const [account] = await browser.accounts.list();
          const folder = account.folders.find(f => f.name == "test1");

          // Read the message, without the key set up. The headers should be
          // readable, but not the message itself.

          const { messages } = await browser.messages.list(folder.id);
          browser.test.assertEq(1, messages.length);

          const [message] = messages;
          browser.test.assertEq("...", message.subject);
          browser.test.assertEq(
            "Bob Babbage <bob@openpgp.example>",
            message.author
          );
          browser.test.assertEq("alice@openpgp.example", message.recipients[0]);

          // getFull({decrypt: false}) should succeed without keys.
          const fullEncrypted1 = await browser.messages.getFull(message.id, {
            decrypt: false,
          });
          browser.test.assertEq(
            "skipped",
            fullEncrypted1.decryptionStatus,
            "The decryptionStatus should be correct"
          );

          // getRaw({decrypt: false}) should succeed without keys.
          const rawMessage = await browser.messages.getRaw(message.id, {
            decrypt: false,
          });
          browser.test.assertTrue(
            rawMessage.includes("multipart/encrypted"),
            "Should find the encrypted message"
          );

          // getRaw({decrypt: true}) should fail without keys.
          await browser.test.assertRejects(
            browser.messages.getRaw(message.id, { decrypt: true }),
            `Error decrypting message ${message.id}`,
            "browser.messages.getRaw({decrypt: true}) should reject, if the keys are not available."
          );

          // getFull() should not be able to decrypt the message and not return
          // any parts.
          const fullMessage = await browser.messages.getFull(message.id, {
            decrypt: true,
          });
          browser.test.log(JSON.stringify(fullMessage));
          browser.test.assertEq("object", typeof fullMessage);
          browser.test.assertEq("message/rfc822", fullMessage.contentType);

          browser.test.assertEq("object", typeof fullMessage.headers);
          for (const header of [
            "content-type",
            "date",
            "from",
            "message-id",
            "subject",
            "to",
          ]) {
            browser.test.assertTrue(Array.isArray(fullMessage.headers[header]));
            browser.test.assertEq(1, fullMessage.headers[header].length);
          }
          browser.test.assertEq("...", fullMessage.headers.subject[0]);
          browser.test.assertEq(
            "Bob Babbage <bob@openpgp.example>",
            fullMessage.headers.from[0]
          );
          browser.test.assertEq(
            "alice@openpgp.example",
            fullMessage.headers.to[0]
          );

          // Decryption failed, parts should be omitted.
          browser.test.assertEq(
            "fail",
            fullMessage.decryptionStatus,
            "should find the correct decryptionStatus"
          );
          browser.test.assertEq(
            0,
            fullMessage.parts.length,
            "parts should be omitted"
          );

          // Now set up the key and read the message again. It should all be
          // there this time.

          await window.sendMessage("load key");

          const { messages: messages_with_key } = await browser.messages.list(
            folder.id
          );
          browser.test.assertEq(1, messages_with_key.length);
          const [message_with_key] = messages_with_key;
          // FIXME: The messageHeader still has the encrypted subject, only after
          // the UI has displayed and decrypted the message, the subject gets
          // updated.
          browser.test.assertEq("...", message_with_key.subject);
          browser.test.assertEq(
            "Bob Babbage <bob@openpgp.example>",
            message_with_key.author
          );
          browser.test.assertEq(
            "alice@openpgp.example",
            message_with_key.recipients[0]
          );

          const fullDecrypted = await browser.messages.getFull(
            message_with_key.id,
            {
              decrypt: true,
            }
          );
          browser.test.log(JSON.stringify(fullDecrypted));
          browser.test.assertEq("object", typeof fullDecrypted);
          browser.test.assertEq("message/rfc822", fullDecrypted.contentType);

          browser.test.assertEq("object", typeof fullDecrypted.headers);
          for (const header of [
            "content-type",
            "date",
            "from",
            "message-id",
            "subject",
            "to",
          ]) {
            browser.test.assertTrue(
              Array.isArray(fullDecrypted.headers[header])
            );
            browser.test.assertEq(1, fullDecrypted.headers[header].length);
          }
          browser.test.assertEq(
            "Unsigned Encrypted",
            fullDecrypted.headers.subject[0]
          );
          browser.test.assertEq(
            "Bob Babbage <bob@openpgp.example>",
            fullDecrypted.headers.from[0]
          );
          browser.test.assertEq(
            "alice@openpgp.example",
            fullDecrypted.headers.to[0]
          );

          browser.test.assertEq("success", fullDecrypted.decryptionStatus);
          browser.test.assertTrue(Array.isArray(fullDecrypted.parts));
          browser.test.assertEq(1, fullDecrypted.parts.length);

          let part = fullDecrypted.parts[0];
          browser.test.assertEq("object", typeof part);
          browser.test.assertEq("multipart/mixed", part.contentType);
          browser.test.assertTrue(Array.isArray(part.parts));
          browser.test.assertEq(1, part.parts.length);

          part = part.parts[0];
          browser.test.assertEq("object", typeof part);
          browser.test.assertEq("multipart/mixed", part.contentType);
          browser.test.assertTrue(Array.isArray(part.parts));
          browser.test.assertEq(1, part.parts.length);

          part = part.parts[0];
          browser.test.assertEq("object", typeof part);
          browser.test.assertEq("text/plain", part.contentType);
          browser.test.assertEq(
            "Sundays are nothing without callaloo.",
            part.body.trimRight()
          );

          // getFull({decrypt: false}) should succeed with loaded keys.
          const fullEncrypted2 = await browser.messages.getFull(message.id, {
            decrypt: false,
          });
          browser.test.assertEq("...", fullEncrypted2.headers.subject[0]);
          browser.test.assertEq("skipped", fullEncrypted2.decryptionStatus);

          // getRaw({decrypt: false}) should succeed.
          const rawMessage2 = await browser.messages.getRaw(message.id, {
            decrypt: false,
          });
          browser.test.assertTrue(
            rawMessage2.includes("multipart/encrypted"),
            "Should find the encrypted message"
          );

          // getRaw({decrypt: true}) should succeed.
          const rawMessage3 = await browser.messages.getRaw(message.id, {
            decrypt: true,
          });
          browser.test.assertFalse(
            rawMessage3.includes("multipart/encrypted"),
            "Should not find the encrypted message"
          );

          browser.test.notifyPass("finished");
        },
        "utils.js": await getUtilsJS(),
      },
      manifest: {
        manifest_version: 2,
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesRead"],
      },
    });

    await extension.startup();

    await extension.awaitMessage("load key");
    info(`Adding key from ${OPENPGP_KEY_PATH}`);
    const [id] = await OpenPGPTestUtils.importPrivateKey(
      null,
      new FileUtils.File(OPENPGP_KEY_PATH)
    );
    _identity.setUnicharAttribute("openpgp_key_id", id);
    extension.sendMessage();

    await extension.awaitFinish("finished");
    await extension.unload();

    cleanUpAccount(_account);
  }
);

add_task(async function test_attached_message_with_missing_headers() {
  const _account = await createAccount();
  const _folder = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test1"
  );

  await createMessageFromFile(
    _folder,
    do_get_file("messages/attachedMessageWithMissingHeaders.eml").path
  );

  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const accounts = await browser.accounts.list();
        browser.test.assertEq(1, accounts.length);

        for (const account of accounts) {
          const folder = account.folders.find(f => f.name == "test1");
          const { messages } = await browser.messages.list(folder.id);
          browser.test.assertEq(1, messages.length);

          const msg = messages[0];
          const attachments = await browser.messages.listAttachments(msg.id);
          browser.test.assertEq(
            attachments.length,
            1,
            "Should have found the correct number of attachments"
          );

          const attachedMessage = attachments[0].message;
          browser.test.assertTrue(
            !!attachedMessage,
            "Should have found an attached message"
          );
          browser.test.assertEq(
            attachedMessage.date.getTime(),
            0,
            "The date should be correct"
          );
          browser.test.assertEq(
            attachedMessage.subject,
            "",
            "The subject should be empty"
          );
          browser.test.assertEq(
            attachedMessage.author,
            "",
            "The author should be empty"
          );
          browser.test.assertEq(
            attachedMessage.headerMessageId,
            "sample-attached.eml@mime.sample",
            "The headerMessageId should be correct"
          );
          window.assertDeepEqual(
            attachedMessage.recipients,
            [],
            "The recipients should be correct"
          );
        }

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 2,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();

  cleanUpAccount(_account);
});

add_task(async function test_get_deleted_messages() {
  const _account = await createAccount();
  const _folder = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test1"
  );
  await createMessages(_folder, 10);

  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const accounts = await browser.accounts.list();
        browser.test.assertEq(
          1,
          accounts.length,
          "Should find the correct number of accounts"
        );
        const foundMessages = new Map();

        for (const account of accounts) {
          const messageIds = [];

          const folder = account.folders.find(f => f.name == "test1");
          const { messages: listMessages } = await browser.messages.list(
            folder.id
          );
          browser.test.assertEq(
            10,
            listMessages.length,
            "Should find the correct number of messages"
          );
          const { messages: queryMessages } = await browser.messages.query({
            folderId: folder.id,
          });
          browser.test.assertEq(
            10,
            queryMessages.length,
            "Should find the correct number of messages"
          );

          let counts = 0;
          for (const msg of listMessages) {
            messageIds.push(msg.id);
            const header = await browser.messages.get(msg.id);
            if (header) {
              counts++;
            }
          }
          browser.test.assertEq(
            10,
            counts,
            "Should find the correct number of messages"
          );
          foundMessages.set(account.id, messageIds);
        }

        await window.sendMessage("markSomeAsIMAPDeleted", 3);

        for (const account of accounts) {
          const folder = account.folders.find(f => f.name == "test1");
          const { messages: listMessages } = await browser.messages.list(
            folder.id
          );
          browser.test.assertEq(
            7,
            listMessages.length,
            "Should find the correct number of messages"
          );
          const { messages: queryMessages } = await browser.messages.query({
            folderId: folder.id,
          });
          browser.test.assertEq(
            7,
            queryMessages.length,
            "Should find the correct number of messages"
          );

          const messageIds = foundMessages.get(account.id);
          let goodCounts = 0;
          let badCounts = 0;
          for (const msgId of messageIds) {
            try {
              const header = await browser.messages.get(msgId);
              if (header) {
                goodCounts++;
              }
            } catch (ex) {
              badCounts++;
            }
          }
          browser.test.assertEq(
            7,
            goodCounts,
            "Should find the correct number of messages"
          );
          browser.test.assertEq(
            3,
            badCounts,
            "Should find the correct number of skipped messages"
          );
        }

        await window.sendMessage("markSomeAsExpunged", 6);

        for (const account of accounts) {
          const folder = account.folders.find(f => f.name == "test1");
          const { messages: listMessages } = await browser.messages.list(
            folder.id
          );
          browser.test.assertEq(
            4,
            listMessages.length,
            "Should find the correct number of messages"
          );
          const { messages: queryMessages } = await browser.messages.query({
            folderId: folder.id,
          });
          browser.test.assertEq(
            4,
            queryMessages.length,
            "Should find the correct number of messages"
          );

          const messageIds = foundMessages.get(account.id);
          let goodCounts = 0;
          let badCounts = 0;
          for (const msgId of messageIds) {
            try {
              const header = await browser.messages.get(msgId);
              if (header) {
                goodCounts++;
              }
            } catch (ex) {
              badCounts++;
            }
          }
          browser.test.assertEq(
            4,
            goodCounts,
            "Should find the correct number of messages"
          );
          browser.test.assertEq(
            6,
            badCounts,
            "Should find the correct number of skipped messages"
          );
        }

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 2,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["accountsRead", "messagesRead"],
    },
  });

  extension.onMessage("markSomeAsIMAPDeleted", count => {
    const messages = _folder.messages;
    while (messages.hasMoreElements() && count > 0) {
      const msg = messages.getNext();
      msg.flags |= Ci.nsMsgMessageFlags.IMAPDeleted;
      count--;
    }
    extension.sendMessage();
  });

  extension.onMessage("markSomeAsExpunged", count => {
    const messages = _folder.messages;
    while (messages.hasMoreElements() && count > 0) {
      const msg = messages.getNext();
      msg.flags |= Ci.nsMsgMessageFlags.Expunged;
      count--;
    }
    extension.sendMessage();
  });

  await extension.startup();
  await extension.awaitFinish("finished");
  await extension.unload();

  cleanUpAccount(_account);
});
