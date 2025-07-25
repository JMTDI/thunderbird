/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgCompUtils.h"

#include "nsCOMPtr.h"
#include "nsStringFwd.h"
#include "prmem.h"
#include "nsIStringBundle.h"
#include "nsIIOService.h"
#include "nsIHttpProtocolHandler.h"
#include "nsMailHeaders.h"
#include "nsMsgI18N.h"
#include "nsINntpService.h"
#include "nsMimeTypes.h"
#include "nsDirectoryServiceDefs.h"
#include "nsIURI.h"
#include "nsMsgUtils.h"
#include "nsCExternalHandlerService.h"
#include "nsIMIMEService.h"
#include "nsIMsgCompUtils.h"
#include "nsIMsgMdnGenerator.h"
#include "nsServiceManagerUtils.h"
#include "nsComponentManagerUtils.h"
#include "nsCRTGlue.h"
#include <ctype.h>
#include "mozilla/dom/Element.h"
#include "mozilla/EncodingDetector.h"
#include "mozilla/Components.h"
#include "mozilla/Preferences.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/Unused.h"
#include "mozilla/ContentIterator.h"
#include "mozilla/dom/Document.h"
#include "nsIMIMEInfo.h"
#include "nsIMsgHeaderParser.h"
#include "nsIMutableArray.h"
#include "nsIRandomGenerator.h"
#include "nsID.h"

using mozilla::Preferences;

void msg_generate_message_id(nsIMsgIdentity* identity,
                             const nsACString& customHost,
                             nsACString& messageID);

NS_IMPL_ISUPPORTS(nsMsgCompUtils, nsIMsgCompUtils)

nsMsgCompUtils::nsMsgCompUtils() {}

nsMsgCompUtils::~nsMsgCompUtils() {}

NS_IMETHODIMP nsMsgCompUtils::MimeMakeSeparator(const char* prefix,
                                                char** _retval) {
  NS_ENSURE_ARG_POINTER(prefix);
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = mime_make_separator(prefix);
  return NS_OK;
}

NS_IMETHODIMP nsMsgCompUtils::MsgGenerateMessageId(nsIMsgIdentity* identity,
                                                   const nsACString& host,
                                                   nsACString& messageID) {
  // We don't check `host` because it's allowed to be a null pointer (which
  // means we should ignore it for message ID generation).
  NS_ENSURE_ARG_POINTER(identity);
  msg_generate_message_id(identity, host, messageID);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgCompUtils::DetectCharset(const nsACString& aContent,
                              nsACString& aCharset) {
  mozilla::UniquePtr<mozilla::EncodingDetector> detector =
      mozilla::EncodingDetector::Create();
  mozilla::Span<const uint8_t> src = mozilla::AsBytes(
      mozilla::Span(ToNewCString(aContent), aContent.Length()));
  mozilla::Unused << detector->Feed(src, true);
  auto encoding = detector->Guess(nullptr, true);
  encoding->Name(aCharset);
  return NS_OK;
}

//
// Create a file for the a unique temp file
// on the local machine. Caller must free memory
//
[[nodiscard]] nsresult nsMsgCreateTempFile(const char* tFileName,
                                           nsIFile** tFile) {
  if ((!tFileName) || (!*tFileName)) tFileName = "nsmail.tmp";

  nsresult rv =
      GetSpecialDirectoryWithFileName(NS_OS_TEMP_DIR, tFileName, tFile);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = (*tFile)->CreateUnique(nsIFile::NORMAL_FILE_TYPE, 00600);
  if (NS_FAILED(rv)) {
    NS_RELEASE(*tFile);
    return rv;
  }

  nsCOMPtr<nsPIExternalAppLauncher> appLauncher =
      do_GetService(NS_EXTERNALHELPERAPPSERVICE_CONTRACTID);
  if (appLauncher) {
    appLauncher->DeleteTemporaryFileOnExit(*tFile);
  }

  return NS_OK;
}

static void GenerateGlobalRandomBytes(unsigned char* buf, int32_t len) {
  // Attempt to generate bytes from system entropy-based RNG.
  nsCOMPtr<nsIRandomGenerator> randomGenerator =
      mozilla::components::RandomGenerator::Service();
  MOZ_ASSERT(randomGenerator, "nsIRandomGenerator service not retrievable");
  uint8_t* tempBuffer;
  nsresult rv = randomGenerator->GenerateRandomBytes(len, &tempBuffer);
  if (NS_SUCCEEDED(rv)) {
    memcpy(buf, tempBuffer, len);
    free(tempBuffer);
    return;
  }
  // nsIRandomGenerator failed -- fall back to low entropy PRNG.
  static bool firstTime = true;
  if (firstTime) {
    // Seed the random-number generator with current time so that
    // the numbers will be different every time we run.
    srand((unsigned)PR_Now());
    firstTime = false;
  }

  for (int32_t i = 0; i < len; i++) buf[i] = rand() % 256;
}

char* mime_make_separator(const char* prefix) {
  unsigned char rand_buf[13];
  GenerateGlobalRandomBytes(rand_buf, 12);

  return PR_smprintf(
      "------------%s"
      "%02X%02X%02X%02X"
      "%02X%02X%02X%02X"
      "%02X%02X%02X%02X",
      prefix, rand_buf[0], rand_buf[1], rand_buf[2], rand_buf[3], rand_buf[4],
      rand_buf[5], rand_buf[6], rand_buf[7], rand_buf[8], rand_buf[9],
      rand_buf[10], rand_buf[11]);
}

// Tests if the content of a string is a valid host name.
// In this case, a valid host name is any non-empty string that only contains
// letters (a-z + A-Z), numbers (0-9) and the characters '-', '_' and '.'.
static bool isValidHost(const nsCString& host) {
  if (host.IsEmpty()) {
    return false;
  }

  const auto* cur = host.BeginReading();
  const auto* end = host.EndReading();
  for (; cur < end; ++cur) {
    if (!isalpha(*cur) && !isdigit(*cur) && *cur != '-' && *cur != '_' &&
        *cur != '.') {
      return false;
    }
  }

  return true;
}

// Extract the domain name from an address.
// If none could be found (i.e. the address does not contain an '@' sign, or
// the value following it is not a valid domain), then nullptr is returned.
void msg_domain_name_from_address(const nsACString& address, nsACString& host) {
  auto atIndex = address.FindChar('@');

  if (address.IsEmpty() || atIndex == kNotFound) {
    return;
  }

  // Substring() should handle cases where we would go out of bounds (by
  // preventing the index from exceeding the length of the source string), so we
  // don't need to handle this here.
  host = Substring(address, atIndex + 1);
}

// Generate a value for a Message-Id header using the identity and optional
// hostname provided.
void msg_generate_message_id(nsIMsgIdentity* identity,
                             const nsACString& customHost,
                             nsACString& messageID) {
  nsCString host;

  // Check if the identity forces host name. This is sometimes the case when
  // using newsgroup.
  nsCString forcedFQDN;
  nsresult rv = identity->GetCharAttribute("FQDN", forcedFQDN);
  if (NS_SUCCEEDED(rv) && !forcedFQDN.IsEmpty()) {
    host = forcedFQDN;
  }

  // If no valid host name has been set, try using the value defined by the
  // caller, if any.
  if (!isValidHost(host)) {
    host = customHost;
  }

  // If no valid host name has been set, try extracting one from the email
  // address associated with the identity.
  if (!isValidHost(host)) {
    nsCString from;
    rv = identity->GetEmail(from);
    if (NS_SUCCEEDED(rv) && !from.IsEmpty()) {
      msg_domain_name_from_address(from, host);
    }
  }

  // If we still couldn't find a valid host name to use, we can't generate a
  // valid message ID, so bail, and let NNTP and SMTP generate them.
  if (!isValidHost(host)) {
    return;
  }

  // Generate 128-bit UUID for the local part of the ID. `nsID` provides us with
  // cryptographically-secure generation.
  nsID uuid = nsID::GenerateUUID();
  char uuidString[NSID_LENGTH];
  uuid.ToProvidedString(uuidString);
  // Drop first and last characters (curly braces).
  uuidString[NSID_LENGTH - 2] = 0;

  messageID.AppendPrintf("<%s@%s>", uuidString + 1, host.get());
}

// this is to guarantee the folded line will never be greater
// than 78 = 75 + CRLFLWSP
#define PR_MAX_FOLDING_LEN 75

/*static */ char* RFC2231ParmFolding(const char* parmName,
                                     const char* parmValue) {
  NS_ENSURE_TRUE(parmName && *parmName && parmValue && *parmValue, nullptr);

  bool needEscape;
  nsCString dupParm;
  nsCString charset("UTF-8");

  if (!mozilla::IsAsciiNullTerminated(parmValue)) {
    needEscape = true;
    dupParm.Assign(parmValue);
    MsgEscapeString(dupParm, nsINetUtil::ESCAPE_ALL, dupParm);
  } else {
    needEscape = false;
    dupParm.Adopt(msg_make_filename_qtext(parmValue, true));
  }

  int32_t parmNameLen = PL_strlen(parmName);
  int32_t parmValueLen = dupParm.Length();

  parmNameLen += 5;  // *=__'__'___ or *[0]*=__'__'__ or *[1]*=___ or *[0]="___"

  char* foldedParm = nullptr;

  if ((parmValueLen + parmNameLen + strlen("UTF-8")) < PR_MAX_FOLDING_LEN) {
    foldedParm = PL_strdup(parmName);
    if (needEscape) {
      NS_MsgSACat(&foldedParm, "*=");
      NS_MsgSACat(&foldedParm, "UTF-8");
      NS_MsgSACat(&foldedParm, "''");  // We don't support language.
    } else
      NS_MsgSACat(&foldedParm, "=\"");
    NS_MsgSACat(&foldedParm, dupParm.get());
    if (!needEscape) NS_MsgSACat(&foldedParm, "\"");
  } else {
    int curLineLen = 0;
    int counter = 0;
    char digits[32];
    char* start = dupParm.BeginWriting();
    char* end = NULL;
    char tmp = 0;

    while (parmValueLen > 0) {
      curLineLen = 0;
      if (counter == 0) {
        PR_FREEIF(foldedParm)
        foldedParm = PL_strdup(parmName);
      } else {
        NS_MsgSACat(&foldedParm, ";\r\n ");
        NS_MsgSACat(&foldedParm, parmName);
      }
      PR_snprintf(digits, sizeof(digits), "*%d", counter);
      NS_MsgSACat(&foldedParm, digits);
      curLineLen += PL_strlen(digits);
      if (needEscape) {
        NS_MsgSACat(&foldedParm, "*=");
        if (counter == 0) {
          NS_MsgSACat(&foldedParm, "UTF-8");
          NS_MsgSACat(&foldedParm, "''");  // We don't support language.
          curLineLen += strlen("UTF-8");
        }
      } else {
        NS_MsgSACat(&foldedParm, "=\"");
      }
      counter++;
      curLineLen += parmNameLen;
      if (parmValueLen <= PR_MAX_FOLDING_LEN - curLineLen)
        end = start + parmValueLen;
      else
        end = start + (PR_MAX_FOLDING_LEN - curLineLen);

      tmp = 0;
      if (*end && needEscape) {
        // Check to see if we are in the middle of escaped char.
        // We use ESCAPE_ALL, so every third character is a '%'.
        if (end - 1 > start && *(end - 1) == '%') {
          end -= 1;
        } else if (end - 2 > start && *(end - 2) == '%') {
          end -= 2;
        }
        // *end is now a '%'.
        // Check if the following UTF-8 octet is a continuation.
        while (end - 3 > start && (*(end + 1) == '8' || *(end + 1) == '9' ||
                                   *(end + 1) == 'A' || *(end + 1) == 'B')) {
          end -= 3;
        }
        tmp = *end;
        *end = 0;
      } else {
        tmp = *end;
        *end = 0;
      }
      NS_MsgSACat(&foldedParm, start);
      if (!needEscape) NS_MsgSACat(&foldedParm, "\"");

      parmValueLen -= (end - start);
      if (tmp) *end = tmp;
      start = end;
    }
  }

  return foldedParm;
}

bool mime_7bit_data_p(const char* string, uint32_t size) {
  if ((!string) || (!*string)) return true;

  char* ptr = (char*)string;
  for (uint32_t i = 0; i < size; i++) {
    if ((unsigned char)ptr[i] > 0x7F) return false;
  }
  return true;
}

// Strips whitespace, and expands newlines into newline-tab for use in
// mail headers.  Returns a new string or 0 (if it would have been empty.)
// If addr_p is true, the addresses will be parsed and reemitted as
// rfc822 mailboxes.
char* mime_fix_header_1(const char* string, bool addr_p, bool news_p) {
  char* new_string;
  const char* in;
  char* out;
  int32_t i, old_size, new_size;

  if (!string || !*string) return 0;

  if (addr_p) {
    return strdup(string);
  }

  old_size = PL_strlen(string);
  new_size = old_size;
  for (i = 0; i < old_size; i++)
    if (string[i] == '\r' || string[i] == '\n') new_size += 2;

  new_string = (char*)PR_Malloc(new_size + 1);
  if (!new_string) return 0;

  in = string;
  out = new_string;

  /* strip leading whitespace. */
  while (IS_SPACE(*in)) in++;

  /* replace CR, LF, or CRLF with CRLF-TAB. */
  while (*in) {
    if (*in == '\r' || *in == '\n') {
      if (*in == '\r' && in[1] == '\n') in++;
      in++;
      *out++ = '\r';
      *out++ = '\n';
      *out++ = '\t';
    } else if (news_p && *in == ',') {
      *out++ = *in++;
      /* skip over all whitespace after a comma. */
      while (IS_SPACE(*in)) in++;
    } else
      *out++ = *in++;
  }
  *out = 0;

  /* strip trailing whitespace. */
  while (out > in && IS_SPACE(out[-1])) *out-- = 0;

  /* If we ended up throwing it all away, use 0 instead of "". */
  if (!*new_string) {
    PR_Free(new_string);
    new_string = 0;
  }

  return new_string;
}

char* mime_fix_header(const char* string) {
  return mime_fix_header_1(string, false, false);
}

char* mime_fix_addr_header(const char* string) {
  return mime_fix_header_1(string, true, false);
}

char* mime_fix_news_header(const char* string) {
  return mime_fix_header_1(string, false, true);
}

bool mime_type_requires_b64_p(const char* type) {
  if (!type || !PL_strcasecmp(type, UNKNOWN_CONTENT_TYPE))
    // Unknown types don't necessarily require encoding.  (Note that
    // "unknown" and "application/octet-stream" aren't the same.)
    return false;

  else if (!PL_strncasecmp(type, "image/", 6) ||
           !PL_strncasecmp(type, "audio/", 6) ||
           !PL_strncasecmp(type, "video/", 6) ||
           !PL_strncasecmp(type, "application/", 12)) {
    // The following types are application/ or image/ types that are actually
    // known to contain textual data (meaning line-based, not binary, where
    // CRLF conversion is desired rather than disastrous.)  So, if the type
    // is any of these, it does not *require* base64, and if we do need to
    // encode it for other reasons, we'll probably use quoted-printable.
    // But, if it's not one of these types, then we assume that any subtypes
    // of the non-"text/" types are binary data, where CRLF conversion would
    // corrupt it, so we use base64 right off the bat.

    // The reason it's desirable to ship these as text instead of just using
    // base64 all the time is mainly to preserve the readability of them for
    // non-MIME users: if I mail a /bin/sh script to someone, it might not
    // need to be encoded at all, so we should leave it readable if we can.

    // This list of types was derived from the comp.mail.mime FAQ, section
    // 10.2.2, "List of known unregistered MIME types" on 2-Feb-96.
    static const char* app_and_image_types_which_are_really_text[] = {
        "application/mac-binhex40", /* APPLICATION_BINHEX */
        "application/pgp",          /* APPLICATION_PGP */
        "application/pgp-keys",
        "application/x-pgp-message", /* APPLICATION_PGP2 */
        "application/postscript",    /* APPLICATION_POSTSCRIPT */
        "application/x-uuencode",    /* APPLICATION_UUENCODE */
        "application/x-uue",         /* APPLICATION_UUENCODE2 */
        "application/uue",           /* APPLICATION_UUENCODE4 */
        "application/uuencode",      /* APPLICATION_UUENCODE3 */
        "application/sgml",
        "application/x-csh",
        "application/javascript",
        "application/ecmascript",
        "application/x-javascript",
        "application/x-latex",
        "application/x-macbinhex40",
        "application/x-ns-proxy-autoconfig",
        "application/x-www-form-urlencoded",
        "application/x-perl",
        "application/x-sh",
        "application/x-shar",
        "application/x-tcl",
        "application/x-tex",
        "application/x-texinfo",
        "application/x-troff",
        "application/x-troff-man",
        "application/x-troff-me",
        "application/x-troff-ms",
        "application/x-troff-ms",
        "application/x-wais-source",
        "image/x-bitmap",
        "image/x-pbm",
        "image/x-pgm",
        "image/x-portable-anymap",
        "image/x-portable-bitmap",
        "image/x-portable-graymap",
        "image/x-portable-pixmap", /* IMAGE_PPM */
        "image/x-ppm",
        "image/x-xbitmap", /* IMAGE_XBM */
        "image/x-xbm",     /* IMAGE_XBM2 */
        "image/xbm",       /* IMAGE_XBM3 */
        "image/x-xpixmap",
        "image/x-xpm",
        0};
    const char** s;
    for (s = app_and_image_types_which_are_really_text; *s; s++)
      if (!PL_strcasecmp(type, *s)) return false;

    /* All others must be assumed to be binary formats, and need Base64. */
    return true;
  }

  else
    return false;
}

//
// Some types should have a "charset=" parameter, and some shouldn't.
// This is what decides.
//
bool mime_type_needs_charset(const char* type) {
  /* Only text types should have charset. */
  if (!type || !*type)
    return false;
  else if (!PL_strncasecmp(type, "text", 4))
    return true;
  else
    return false;
}

// Given a string, convert it to 'qtext' (quoted text) for RFC822 header
// purposes.
char* msg_make_filename_qtext(const char* srcText, bool stripCRLFs) {
  /* newString can be at most twice the original string (every char quoted). */
  char* newString = (char*)PR_Malloc(PL_strlen(srcText) * 2 + 1);
  if (!newString) return NULL;

  const char* s = srcText;
  const char* end = srcText + PL_strlen(srcText);
  char* d = newString;

  while (*s) {
    // Put backslashes in front of existing backslashes, or double quote
    // characters.
    // If stripCRLFs is true, don't write out CRs or LFs. Otherwise,
    // write out a backslash followed by the CR but not
    // linear-white-space.
    // We might already have quoted pair of "\ " or "\\t" skip it.
    if (*s == '\\' || *s == '"' ||
        (!stripCRLFs &&
         (*s == '\r' && (s[1] != '\n' ||
                         (s[1] == '\n' && (s + 2) < end && !IS_SPACE(s[2]))))))
      *d++ = '\\';

    if (stripCRLFs && *s == '\r' && s[1] == '\n' && (s + 2) < end &&
        IS_SPACE(s[2])) {
      s += 3;  // skip CRLFLWSP
    } else {
      *d++ = *s++;
    }
  }
  *d = 0;

  return newString;
}

// Utility to create a nsIURI object...
nsresult nsMsgNewURL(nsIURI** aInstancePtrResult, const nsCString& aSpec) {
  nsresult rv = NS_OK;
  if (nullptr == aInstancePtrResult) return NS_ERROR_NULL_POINTER;
  nsCOMPtr<nsIIOService> pNetService = mozilla::components::IO::Service();
  NS_ENSURE_TRUE(pNetService, NS_ERROR_UNEXPECTED);
  if (aSpec.Find("://") == kNotFound && !StringBeginsWith(aSpec, "data:"_ns)) {
    // XXXjag Temporary fix for bug 139362 until the real problem(bug 70083) get
    // fixed
    nsAutoCString uri("http://"_ns);
    uri.Append(aSpec);
    rv = pNetService->NewURI(uri, nullptr, nullptr, aInstancePtrResult);
  } else
    rv = pNetService->NewURI(aSpec, nullptr, nullptr, aInstancePtrResult);
  return rv;
}

char* nsMsgGetLocalFileFromURL(const char* url) {
  char* finalPath;
  NS_ASSERTION(PL_strncasecmp(url, "file://", 7) == 0, "invalid url");
  finalPath = (char*)PR_Malloc(strlen(url));
  if (finalPath == NULL) return NULL;
  strcpy(finalPath, url + 6 + 1);
  return finalPath;
}

char* nsMsgParseURLHost(const char* url) {
  nsIURI* workURI = nullptr;
  nsresult rv;

  rv = nsMsgNewURL(&workURI, nsDependentCString(url));
  if (NS_FAILED(rv) || !workURI) return nullptr;

  nsAutoCString host;
  rv = workURI->GetHost(host);
  NS_IF_RELEASE(workURI);
  if (NS_FAILED(rv)) return nullptr;

  return ToNewCString(host);
}

char* GenerateFileNameFromURI(nsIURI* aURL) {
  nsresult rv;
  nsCString file;
  nsCString spec;
  char* returnString;
  char* cp = nullptr;
  char* cp1 = nullptr;

  rv = aURL->GetPathQueryRef(file);
  if (NS_SUCCEEDED(rv) && !file.IsEmpty()) {
    char* newFile = ToNewCString(file);
    if (!newFile) return nullptr;

    // strip '/'
    cp = PL_strrchr(newFile, '/');
    if (cp)
      ++cp;
    else
      cp = newFile;

    if (*cp) {
      if ((cp1 = PL_strchr(cp, '/'))) *cp1 = 0;
      if ((cp1 = PL_strchr(cp, '?'))) *cp1 = 0;
      if ((cp1 = PL_strchr(cp, '>'))) *cp1 = 0;
      if (*cp != '\0') {
        returnString = PL_strdup(cp);
        PR_FREEIF(newFile);
        return returnString;
      }
    } else
      return nullptr;
  }

  cp = nullptr;
  cp1 = nullptr;

  rv = aURL->GetSpec(spec);
  if (NS_SUCCEEDED(rv) && !spec.IsEmpty()) {
    char* newSpec = ToNewCString(spec);
    if (!newSpec) return nullptr;

    char *cp2 = NULL, *cp3 = NULL;

    // strip '"'
    cp2 = newSpec;
    while (*cp2 == '"') cp2++;
    if ((cp3 = PL_strchr(cp2, '"'))) *cp3 = 0;

    char* hostStr = nsMsgParseURLHost(cp2);
    if (!hostStr) hostStr = PL_strdup(cp2);

    bool isHTTP = false;
    if (NS_SUCCEEDED(aURL->SchemeIs("http", &isHTTP)) && isHTTP) {
      returnString = PR_smprintf("%s.html", hostStr);
      PR_FREEIF(hostStr);
    } else
      returnString = hostStr;

    PR_FREEIF(newSpec);
    return returnString;
  }

  return nullptr;
}

//
// This routine will generate a content id for use in a mail part.
// It will take the part number passed in as well as the email
// address. If the email address is null or invalid, we will simply
// use netscape.com for the interesting part. The content ID's will
// look like the following:
//
//      Content-ID: <part1.36DF1DCE.73B5A330@netscape.com>
//
char* mime_gen_content_id(uint32_t aPartNum, const char* aEmailAddress) {
  int32_t randLen = 5;
  unsigned char rand_buf1[5];
  unsigned char rand_buf2[5];
  const char* domain = nullptr;
  const char* defaultDomain = "@netscape.com";

  memset(rand_buf1, 0, randLen - 1);
  memset(rand_buf2, 0, randLen - 1);

  GenerateGlobalRandomBytes(rand_buf1, randLen);
  GenerateGlobalRandomBytes(rand_buf2, randLen);

  // Find the @domain.com string...
  if (aEmailAddress && *aEmailAddress)
    domain = const_cast<const char*>(PL_strchr(aEmailAddress, '@'));

  if (!domain) domain = defaultDomain;

  char* retVal = PR_smprintf(
      "part%d."
      "%02X%02X%02X%02X"
      "."
      "%02X%02X%02X%02X"
      "%s",
      aPartNum, rand_buf1[0], rand_buf1[1], rand_buf1[2], rand_buf1[3],
      rand_buf2[0], rand_buf2[1], rand_buf2[2], rand_buf2[3], domain);

  return retVal;
}

void GetFolderURIFromUserPrefs(nsMsgDeliverMode aMode, nsIMsgIdentity* identity,
                               nsCString& uri) {
  nsresult rv;
  uri.Truncate();

  // QueueForLater (Outbox)
  if (aMode == nsIMsgSend::nsMsgQueueForLater ||
      aMode == nsIMsgSend::nsMsgDeliverBackground) {
    rv = Preferences::GetCString("mail.default_sendlater_uri", uri);
    if (NS_FAILED(rv) || uri.IsEmpty())
      uri.AssignLiteral(ANY_SERVER);
    else {
      // check if uri is unescaped, and if so, escape it and reset the pef.
      if (uri.FindChar(' ') != kNotFound) {
        uri.ReplaceSubstring(" ", "%20");
        Preferences::SetCString("mail.default_sendlater_uri", uri);
      }
    }
    return;
  }

  if (!identity) return;

  nsCOMPtr<nsIMsgFolder> folder;
  if (aMode == nsIMsgSend::nsMsgSaveAsDraft) {  // SaveAsDraft (Drafts)
    rv = identity->GetOrCreateDraftsFolder(getter_AddRefs(folder));
  } else if (aMode ==
             nsIMsgSend::nsMsgSaveAsTemplate) {  // SaveAsTemplate (Templates)
    rv = identity->GetOrCreateTemplatesFolder(getter_AddRefs(folder));
  } else {
    bool doFcc = false;
    rv = identity->GetDoFcc(&doFcc);
    if (doFcc) {
      rv = identity->GetOrCreateFccFolder(getter_AddRefs(folder));
    }
  }
  if (folder) {
    uri = folder->URI();
  }
  return;
}

/**
 * Check if we should use format=flowed (RFC 2646) for a mail.
 * We will use format=flowed unless the preference tells us not to do so.
 * In this function we set all the serialiser flags.
 * 'formatted' is always 'true'.
 */
void GetSerialiserFlags(bool* flowed, bool* formatted) {
  *flowed = false;
  *formatted = true;

  // Set format=flowed as in RFC 2646 according to the preference.
  Preferences::GetBool("mailnews.send_plaintext_flowed", flowed);
}

already_AddRefed<nsIArray> GetEmbeddedObjects(
    mozilla::dom::Document* aDocument) {
  nsCOMPtr<nsIMutableArray> nodes = do_CreateInstance(NS_ARRAY_CONTRACTID);
  if (NS_WARN_IF(!nodes)) {
    return nullptr;
  }

  mozilla::PostContentIterator iter;
  nsresult rv = iter.Init(aDocument->GetRootElement());
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return nullptr;
  }

  // Loop through the content iterator for each content node.
  while (!iter.IsDone()) {
    nsINode* node = iter.GetCurrentNode();
    if (node->IsElement()) {
      mozilla::dom::Element* element = node->AsElement();

      // See if it's an image or also include all links.
      // Let mail decide which link to send or not
      if (element->IsAnyOfHTMLElements(nsGkAtoms::img, nsGkAtoms::a) ||
          (element->IsHTMLElement(nsGkAtoms::body) &&
           element->HasAttr(kNameSpaceID_None, nsGkAtoms::background))) {
        nodes->AppendElement(node);
      }
    }
    iter.Next();
  }

  return nodes.forget();
}
