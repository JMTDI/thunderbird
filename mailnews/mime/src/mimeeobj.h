/* -*- Mode: C; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_MIME_SRC_MIMEEOBJ_H_
#define COMM_MAILNEWS_MIME_SRC_MIMEEOBJ_H_

#include "mimeleaf.h"

/* The MimeExternalObject class represents MIME parts which contain data
   which cannot be displayed inline -- application/octet-stream and any
   other type that is not otherwise specially handled.  (This is not to
   be confused with MimeExternalBody, which is the handler for the
   message/external-object MIME type only.)
 */

typedef struct MimeExternalObjectClass MimeExternalObjectClass;
typedef struct MimeExternalObject MimeExternalObject;

struct MimeExternalObjectClass {
  MimeLeafClass leaf;
};

extern "C" MimeExternalObjectClass mimeExternalObjectClass;

struct MimeExternalObject {
  MimeLeaf leaf;
};

#define MimeExternalObjectClassInitializer(ITYPE, CSUPER) \
  {MimeLeafClassInitializer(ITYPE, CSUPER)}

typedef struct MimeSuppressedCryptoClass MimeSuppressedCryptoClass;
typedef struct MimeSuppressedCrypto MimeSuppressedCrypto;

struct MimeSuppressedCryptoClass {
  MimeExternalObjectClass eobj;
};

extern "C" MimeSuppressedCryptoClass mimeSuppressedCryptoClass;

struct MimeSuppressedCrypto {
  MimeExternalObject eobj;
};

#define MimeSuppressedCryptoClassInitializer(ITYPE, CSUPER) \
  {MimeExternalObjectClassInitializer(ITYPE, CSUPER)}

#endif  // COMM_MAILNEWS_MIME_SRC_MIMEEOBJ_H_
