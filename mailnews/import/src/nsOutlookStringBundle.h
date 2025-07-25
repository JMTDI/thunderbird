/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMPORT_SRC_NSOUTLOOKSTRINGBUNDLE_H_
#define COMM_MAILNEWS_IMPORT_SRC_NSOUTLOOKSTRINGBUNDLE_H_

#include "nsCOMPtr.h"
#include "nsString.h"

class nsIStringBundle;

class nsOutlookStringBundle {
 public:
  static char16_t* GetStringByID(int32_t stringID);
  static void GetStringByID(int32_t stringID, nsString& result);
  static void GetStringBundle(void);
  static void FreeString(char16_t* pStr) { free(pStr); }
  static void Cleanup(void);

 private:
  static nsCOMPtr<nsIStringBundle> m_pBundle;
};

#define OUTLOOKIMPORT_NAME 2000
#define OUTLOOKIMPORT_DESCRIPTION 2010
#define OUTLOOKIMPORT_MAILBOX_SUCCESS 2002
#define OUTLOOKIMPORT_MAILBOX_BADPARAM 2003
#define OUTLOOKIMPORT_MAILBOX_CONVERTERROR 2004
#define OUTLOOKIMPORT_ADDRNAME 2005
#define OUTLOOKIMPORT_ADDRESS_SUCCESS 2006
#define OUTLOOKIMPORT_ADDRESS_BADPARAM 2007
#define OUTLOOKIMPORT_ADDRESS_BADSOURCEFILE 2008
#define OUTLOOKIMPORT_ADDRESS_CONVERTERROR 2009

#endif  // COMM_MAILNEWS_IMPORT_SRC_NSOUTLOOKSTRINGBUNDLE_H_
