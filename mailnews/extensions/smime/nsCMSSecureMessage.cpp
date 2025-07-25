/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsCMSSecureMessage.h"

#include <string.h>

#include "ScopedNSSTypes.h"
#include "SharedCertVerifier.h"
#include "cms.h"
#include "mozilla/Logging.h"
#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsDependentSubstring.h"
#include "nsIInterfaceRequestor.h"
#include "nsServiceManagerUtils.h"
#include "nsISupports.h"
#include "nsIX509Cert.h"
#include "nsIX509CertDB.h"
#include "nsNSSComponent.h"
#include "nsNSSHelper.h"
#include "plbase64.h"

using namespace mozilla;
using namespace mozilla::psm;

// Standard ISupports implementation
// NOTE: Should these be the thread-safe versions?

/*****
 * nsCMSSecureMessage
 *****/

// Standard ISupports implementation
NS_IMPL_ISUPPORTS(nsCMSSecureMessage, nsICMSSecureMessage)

// nsCMSSecureMessage constructor
nsCMSSecureMessage::nsCMSSecureMessage() {
  // initialize superclass
}

// nsCMSMessage destructor
nsCMSSecureMessage::~nsCMSSecureMessage() {}

nsresult nsCMSSecureMessage::Init() {
  return EnsureNSSInitializedChromeOrContent() ? NS_OK : NS_ERROR_NOT_AVAILABLE;
}

nsresult nsCMSSecureMessage::CheckUsageOk(nsIX509Cert* aCert,
                                          SECCertificateUsage aUsage,
                                          bool* aCanBeUsed) {
  NS_ENSURE_ARG_POINTER(aCert);
  *aCanBeUsed = false;

  nsTArray<uint8_t> certBytes;
  nsresult rv = aCert->GetRawDER(certBytes);
  NS_ENSURE_SUCCESS(rv, rv);

  RefPtr<SharedCertVerifier> certVerifier(GetDefaultCertVerifier());
  NS_ENSURE_TRUE(certVerifier, NS_ERROR_UNEXPECTED);

  mozilla::psm::VerifyUsage usageForPkix;
  switch (aUsage) {
    case certificateUsageEmailSigner:
      usageForPkix = mozilla::psm::VerifyUsage::EmailSigner;
      break;
    case certificateUsageEmailRecipient:
      usageForPkix = mozilla::psm::VerifyUsage::EmailRecipient;
      break;
    default:
      return NS_ERROR_UNEXPECTED;
  }

  nsTArray<nsTArray<uint8_t>> unusedBuiltChain;
  // It's fine to skip OCSP, because this is called only from code
  // for selecting the user's own configured cert.
  if (certVerifier->VerifyCert(certBytes, usageForPkix, mozilla::pkix::Now(),
                               nullptr, nullptr, unusedBuiltChain,
                               CertVerifier::FLAG_LOCAL_ONLY) ==
      mozilla::pkix::Success) {
    *aCanBeUsed = true;
  }
  return NS_OK;
}

NS_IMETHODIMP nsCMSSecureMessage::CanBeUsedForEmailEncryption(
    nsIX509Cert* aCert, bool* aCanBeUsed) {
  return CheckUsageOk(aCert, certificateUsageEmailRecipient, aCanBeUsed);
}

NS_IMETHODIMP nsCMSSecureMessage::CanBeUsedForEmailSigning(nsIX509Cert* aCert,
                                                           bool* aCanBeUsed) {
  return CheckUsageOk(aCert, certificateUsageEmailSigner, aCanBeUsed);
}
