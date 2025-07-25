/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_ADDRBOOK_SRC_NSABOUTLOOKINTERFACE_H_
#define COMM_MAILNEWS_ADDRBOOK_SRC_NSABOUTLOOKINTERFACE_H_

#include "nsIAbOutlookInterface.h"

class nsAbOutlookInterface : public nsIAbOutlookInterface {
 public:
  nsAbOutlookInterface(void);

  NS_DECL_ISUPPORTS
  NS_DECL_NSIABOUTLOOKINTERFACE

 private:
  virtual ~nsAbOutlookInterface(void);
};

#endif  // COMM_MAILNEWS_ADDRBOOK_SRC_NSABOUTLOOKINTERFACE_H_
