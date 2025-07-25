/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsStreamConverter.h"

#include <stdio.h>

#include "nsCOMPtr.h"
#include "nscore.h"
#include "prmem.h"
#include "prprf.h"
#include "prlog.h"
#include "plstr.h"
#include "mimemoz2.h"
#include "nsMimeTypes.h"
#include "nsString.h"
#include "nsIPipe.h"
#include "nsNetUtil.h"
#include "nsIMsgQuote.h"
#include "nsNetUtil.h"
#include "mozITXTToHTMLConv.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsINntpUrl.h"
#include "nsICategoryManager.h"
#include "nsMsgUtils.h"
#include "mozilla/Components.h"
#include "mozilla/Preferences.h"

using mozilla::Preferences;

#define PREF_MAIL_DISPLAY_GLYPH "mail.display_glyph"
#define PREF_MAIL_DISPLAY_STRUCT "mail.display_struct"

////////////////////////////////////////////////////////////////
// Bridge routines for new stream converter XP-COM interface
////////////////////////////////////////////////////////////////

extern "C" void* mime_bridge_create_draft_stream(
    nsIMimeEmitter* newEmitter, nsStreamConverter* newPluginObj2, nsIURI* uri,
    nsMimeOutputType format_out);

extern "C" void* bridge_create_stream(nsIMimeEmitter* newEmitter,
                                      nsStreamConverter* newPluginObj2,
                                      nsIURI* uri, nsMimeOutputType format_out,
                                      uint32_t whattodo, nsIChannel* aChannel) {
  if ((format_out == nsMimeOutput::nsMimeMessageDraftOrTemplate) ||
      (format_out == nsMimeOutput::nsMimeMessageEditorTemplate))
    return mime_bridge_create_draft_stream(newEmitter, newPluginObj2, uri,
                                           format_out);
  else
    return mime_bridge_create_display_stream(newEmitter, newPluginObj2, uri,
                                             format_out, whattodo, aChannel);
}

void bridge_destroy_stream(void* newStream) {
  nsMIMESession* stream = (nsMIMESession*)newStream;
  if (!stream) return;

  PR_FREEIF(stream);
}

void bridge_set_output_type(void* bridgeStream, nsMimeOutputType aType) {
  nsMIMESession* session = (nsMIMESession*)bridgeStream;

  if (session) {
    mime_stream_data* msd = session->data_object.AsMimeStreamData();
    if (!msd) {
      return;
    }

    msd->format_out = aType;  // output format type
  }
}

nsresult bridge_new_new_uri(void* bridgeStream, nsIURI* aURI,
                            int32_t aOutputType) {
  nsMIMESession* session = (nsMIMESession*)bridgeStream;
  const char** fixup_pointer = nullptr;

  if (session) {
    if (session->data_object) {
      bool* override_charset = nullptr;
      char** default_charset = nullptr;
      char** url_name = nullptr;

      if ((aOutputType == nsMimeOutput::nsMimeMessageDraftOrTemplate) ||
          (aOutputType == nsMimeOutput::nsMimeMessageEditorTemplate)) {
        mime_draft_data* mdd = session->data_object.AsMimeDraftData();
        if (mdd && mdd->options) {
          default_charset = &(mdd->options->default_charset);
          override_charset = &(mdd->options->override_charset);
          url_name = &(mdd->url_name);
        }
      } else {
        mime_stream_data* msd = session->data_object.AsMimeStreamData();
        if (msd && msd->options) {
          default_charset = &(msd->options->default_charset);
          override_charset = &(msd->options->override_charset);
          url_name = &(msd->url_name);
          fixup_pointer = &(msd->options->url);
        }
      }

      if (default_charset && override_charset && url_name) {
        // Check whether we need to auto-detect the charset.
        nsCOMPtr<nsIMsgI18NUrl> i18nUrl(do_QueryInterface(aURI));
        if (i18nUrl) {
          bool autodetectCharset = false;
          nsresult rv = i18nUrl->GetAutodetectCharset(&autodetectCharset);
          if (NS_SUCCEEDED(rv) && autodetectCharset) {
            *override_charset = true;
            *default_charset = nullptr;
          } else {
            *override_charset = false;
            // Special treatment for news: URLs. Get the server default charset.
            nsCOMPtr<nsINntpUrl> nntpURL(do_QueryInterface(aURI));
            if (nntpURL) {
              nsCString charset;
              rv = nntpURL->GetCharset(charset);
              if (NS_SUCCEEDED(rv)) {
                *default_charset = ToNewCString(charset);
              } else {
                *default_charset = strdup("UTF-8");
              }
            } else {
              *default_charset = strdup("UTF-8");
            }
          }
        }
        nsAutoCString urlString;
        if (NS_SUCCEEDED(aURI->GetSpec(urlString))) {
          if (!urlString.IsEmpty()) {
            free(*url_name);
            *url_name = ToNewCString(urlString);
            if (!(*url_name)) return NS_ERROR_OUT_OF_MEMORY;

            // rhp: Ugh, this is ugly...but it works.
            if (fixup_pointer) *fixup_pointer = (const char*)*url_name;
          }
        }
      }
    }
  }

  return NS_OK;
}

static int mime_headers_callback(MimeClosure closure, MimeHeaders* headers) {
  NS_ASSERTION(closure && headers, "null mime stream data or headers");
  if (!closure || !headers) return 0;

  // This doesn't get called on draft operations.
  mime_stream_data* msd = closure.AsMimeStreamData();
  if (!msd) {
    return 0;
  }

  NS_ASSERTION(!msd->headers, "non-null mime stream data headers");
  msd->headers = MimeHeaders_copy(headers);
  return 0;
}

nsresult bridge_set_mime_stream_converter_listener(
    void* bridgeStream, nsIMimeStreamConverterListener* listener,
    nsMimeOutputType aOutputType) {
  nsMIMESession* session = (nsMIMESession*)bridgeStream;

  if ((session) && (session->data_object)) {
    if ((aOutputType == nsMimeOutput::nsMimeMessageDraftOrTemplate) ||
        (aOutputType == nsMimeOutput::nsMimeMessageEditorTemplate)) {
      mime_draft_data* mdd = session->data_object.AsMimeDraftData();
      if (mdd && mdd->options) {
        if (listener) {
          mdd->options->caller_need_root_headers = true;
          mdd->options->decompose_headers_info_fn = mime_headers_callback;
        } else {
          mdd->options->caller_need_root_headers = false;
          mdd->options->decompose_headers_info_fn = nullptr;
        }
      }
    } else {
      mime_stream_data* msd = session->data_object.AsMimeStreamData();
      if (msd && msd->options) {
        if (listener) {
          msd->options->caller_need_root_headers = true;
          msd->options->decompose_headers_info_fn = mime_headers_callback;
        } else {
          msd->options->caller_need_root_headers = false;
          msd->options->decompose_headers_info_fn = nullptr;
        }
      }
    }
  }

  return NS_OK;
}

// find a query element in a url and return a pointer to its data
// (query must be in the form "query=")
static const char* FindQueryElementData(const char* aUrl, const char* aQuery) {
  if (aUrl && aQuery) {
    size_t queryLen = 0;  // we don't call strlen until we need to
    aUrl = PL_strcasestr(aUrl, aQuery);
    while (aUrl) {
      if (!queryLen) queryLen = strlen(aQuery);
      if (*(aUrl - 1) == '&' || *(aUrl - 1) == '?') return aUrl + queryLen;
      aUrl = PL_strcasestr(aUrl + queryLen, aQuery);
    }
  }
  return nullptr;
}

// case-sensitive test for string prefixing. If |string| is prefixed
// by |prefix| then a pointer to the next character in |string| following
// the prefix is returned. If it is not a prefix then |nullptr| is returned.
static const char* SkipPrefix(const char* aString, const char* aPrefix) {
  while (*aPrefix)
    if (*aPrefix++ != *aString++) return nullptr;
  return aString;
}

//
// Utility routines needed by this interface
//
nsresult nsStreamConverter::DetermineOutputFormat(const char* aUrl,
                                                  nsMimeOutputType* aNewType) {
  // sanity checking
  NS_ENSURE_ARG_POINTER(aNewType);
  if (!aUrl || !*aUrl) {
    // default to html for the entire document
    *aNewType = nsMimeOutput::nsMimeMessageQuoting;
    mOutputFormat = "text/html";
    return NS_OK;
  }

  // shorten the url that we test for the query strings by skipping directly
  // to the part where the query strings begin.
  const char* queryPart = PL_strchr(aUrl, '?');

  // First, did someone pass in a desired output format. They will be able to
  // pass in any content type (i.e. image/gif, text/html, etc...but the "/" will
  // have to be represented via the "%2F" value
  const char* format = FindQueryElementData(queryPart, "outformat=");
  if (format) {
    // NOTE: I've done a file contents search of every file (*.*) in the mozilla
    // directory tree and there is not a single location where the string
    // "outformat" is added to any URL. It appears that this code has been
    // orphaned off by a change elsewhere and is no longer required. It will be
    // removed in the future unless someone complains.
    MOZ_ASSERT(false, "Is this code actually being used?");

    while (*format == ' ') ++format;

    if (*format) {
      mOverrideFormat = "raw";

      // set mOutputFormat to the supplied format, ensure that we replace any
      // %2F strings with the slash character
      const char* nextField = PL_strpbrk(format, "&; ");
      mOutputFormat.Assign(format, nextField ? nextField - format : -1);
      mOutputFormat.ReplaceSubstring("%2F", "/");
      mOutputFormat.ReplaceSubstring("%2f", "/");

      // Don't muck with this data!
      *aNewType = nsMimeOutput::nsMimeMessageRaw;
      return NS_OK;
    }
  }

  // is this is a part that should just come out raw
  const char* part = FindQueryElementData(queryPart, "part=");
  if (part && !mToType.EqualsLiteral("application/xhtml+xml")) {
    // default for parts
    mOutputFormat = "raw";
    *aNewType = nsMimeOutput::nsMimeMessageRaw;

    // if we are being asked to fetch a part....it should have a
    // content type appended to it...if it does, we want to remember
    // that as mOutputFormat
    const char* typeField = FindQueryElementData(queryPart, "type=");
    if (typeField && !strncmp(typeField, "application/x-message-display",
                              sizeof("application/x-message-display") - 1)) {
      const char* secondTypeField = FindQueryElementData(typeField, "type=");
      if (secondTypeField) typeField = secondTypeField;
    }
    if (typeField) {
      // store the real content type...mOutputFormat gets deleted later on...
      // and make sure we only get our own value.
      char* nextField = PL_strchr(typeField, '&');
      mRealContentType.Assign(typeField,
                              nextField ? nextField - typeField : -1);
      if (mRealContentType.EqualsLiteral("message/rfc822")) {
        mRealContentType = "application/x-message-display";
        mOutputFormat = "text/html";
        *aNewType = nsMimeOutput::nsMimeMessageBodyDisplay;
      } else if (mRealContentType.EqualsLiteral(
                     "application/x-message-display")) {
        mRealContentType = "";
        mOutputFormat = "text/html";
        *aNewType = nsMimeOutput::nsMimeMessageBodyDisplay;
      }
    }

    return NS_OK;
  }

  const char* emitter = FindQueryElementData(queryPart, "emitter=");
  if (emitter) {
    const char* remainder = SkipPrefix(emitter, "js");
    if (remainder && (!*remainder || *remainder == '&'))
      mOverrideFormat = "application/x-js-mime-message";
  }

  // if using the header query
  const char* header = FindQueryElementData(queryPart, "header=");
  if (header) {
    struct HeaderType {
      const char* headerType;
      const char* outputFormat;
      nsMimeOutputType mimeOutputType;
    };

    // place most commonly used options at the top
    static const struct HeaderType rgTypes[] = {
        {"filter", "text/html", nsMimeOutput::nsMimeMessageFilterSniffer},
        {"quotebody", "text/html", nsMimeOutput::nsMimeMessageBodyQuoting},
        {"print", "text/html", nsMimeOutput::nsMimeMessagePrintOutput},
        {"only", "text/xml", nsMimeOutput::nsMimeMessageHeaderDisplay},
        {"none", "text/html", nsMimeOutput::nsMimeMessageBodyDisplay},
        {"quote", "text/html", nsMimeOutput::nsMimeMessageQuoting},
        {"saveas", "text/html", nsMimeOutput::nsMimeMessageSaveAs},
        {"src", "text/plain", nsMimeOutput::nsMimeMessageSource},
        {"attach", "raw", nsMimeOutput::nsMimeMessageAttach}};

    // find the requested header in table, ensure that we don't match on a
    // prefix by checking that the following character is either null or the
    // next query element
    const char* remainder;
    for (uint32_t n = 0; n < std::size(rgTypes); ++n) {
      remainder = SkipPrefix(header, rgTypes[n].headerType);
      if (remainder && (*remainder == '\0' || *remainder == '&')) {
        mOutputFormat = rgTypes[n].outputFormat;
        *aNewType = rgTypes[n].mimeOutputType;
        return NS_OK;
      }
    }
  }

  // default to html for just the body
  mOutputFormat = "text/html";
  *aNewType = nsMimeOutput::nsMimeMessageBodyDisplay;

  return NS_OK;
}

nsresult nsStreamConverter::InternalCleanup(void) {
  if (mBridgeStream) {
    bridge_destroy_stream(mBridgeStream);
    mBridgeStream = nullptr;
  }

  return NS_OK;
}

/*
 * Inherited methods for nsMimeConverter
 */
nsStreamConverter::nsStreamConverter() {
  // Init member variables...
  mBridgeStream = nullptr;
  mOutputFormat = "text/html";
  mAlreadyKnowOutputType = false;
  mForwardInline = false;
  mForwardInlineFilter = false;
  mOverrideComposeFormat = false;
  mOutputType = nsMimeOutput::nsMimeUnknown;
  mPendingRequest = nullptr;
}

nsStreamConverter::~nsStreamConverter() { InternalCleanup(); }

NS_IMPL_ISUPPORTS(nsStreamConverter, nsIStreamListener, nsIRequestObserver,
                  nsIStreamConverter, nsIMimeStreamConverter)

///////////////////////////////////////////////////////////////
// nsStreamConverter definitions....
///////////////////////////////////////////////////////////////

NS_IMETHODIMP nsStreamConverter::Init(nsIURI* aURI,
                                      nsIStreamListener* aOutListener,
                                      nsIChannel* aChannel) {
  NS_ENSURE_ARG_POINTER(aURI);

  nsresult rv = NS_OK;
  mOutListener = aOutListener;
  mOutgoingChannel = aChannel;

  // mscott --> we need to look at the url and figure out what the correct
  // output type is...
  nsMimeOutputType newType = mOutputType;
  if (!mAlreadyKnowOutputType) {
    nsAutoCString urlSpec;
    rv = aURI->GetSpecIgnoringRef(urlSpec);
    DetermineOutputFormat(urlSpec.get(), &newType);
    mAlreadyKnowOutputType = true;
    mOutputType = newType;
  }

  switch (newType) {
    case nsMimeOutput::nsMimeMessageHeaderDisplay:  // the split header/body
                                                    // display
      mOutputFormat = "text/xml";
      break;
    case nsMimeOutput::nsMimeMessageBodyDisplay:  // the split header/body
                                                  // display
      mOutputFormat = "text/html";
      break;

    case nsMimeOutput::nsMimeMessageQuoting:      // all HTML quoted output
    case nsMimeOutput::nsMimeMessageSaveAs:       // Save as operation
    case nsMimeOutput::nsMimeMessageBodyQuoting:  // only HTML body quoted
                                                  // output
    case nsMimeOutput::nsMimeMessagePrintOutput:  // all Printing output
      mOutputFormat = "text/html";
      break;

    case nsMimeOutput::nsMimeMessageAttach:
    case nsMimeOutput::nsMimeMessageDecrypt:
    case nsMimeOutput::nsMimeMessageRaw:  // the raw RFC822 data and attachments
      mOutputFormat = "raw";
      break;

    case nsMimeOutput::nsMimeMessageSource:  // the raw RFC822 data (view
                                             // source) and attachments
      mOutputFormat = "text/plain";
      mOverrideFormat = "raw";
      break;

    case nsMimeOutput::nsMimeMessageDraftOrTemplate:  // Loading drafts &
                                                      // templates
      mOutputFormat = "message/draft";
      break;

    case nsMimeOutput::nsMimeMessageEditorTemplate:  // Loading templates into
                                                     // editor
      mOutputFormat = "text/html";
      break;

    case nsMimeOutput::nsMimeMessageFilterSniffer:  // output all displayable
                                                    // part as raw
      mOutputFormat = "text/html";
      break;

    default:
      NS_ERROR("this means I made a mistake in my assumptions");
  }

  // the following output channel stream is used to fake the content type for
  // people who later call into us..
  nsCString contentTypeToUse;
  GetContentType(getter_Copies(contentTypeToUse));
  // mscott --> my theory is that we don't need this fake outgoing channel.
  // Let's use the original channel and just set our content type ontop of the
  // original channel...

  aChannel->SetContentType(contentTypeToUse);

  // rv = NS_NewInputStreamChannel(getter_AddRefs(mOutgoingChannel), aURI,
  // nullptr, contentTypeToUse, -1); if (NS_FAILED(rv))
  //    return rv;

  // Set system principal for this document, which will be dynamically generated

  // We will first find an appropriate emitter in the repository that supports
  // the requested output format...note, the special exceptions are
  // nsMimeMessageDraftOrTemplate or nsMimeMessageEditorTemplate where we don't
  // need any emitters
  //

  if ((newType != nsMimeOutput::nsMimeMessageDraftOrTemplate) &&
      (newType != nsMimeOutput::nsMimeMessageEditorTemplate)) {
    nsAutoCString categoryName("@mozilla.org/messenger/mimeemitter;1?type=");
    if (!mOverrideFormat.IsEmpty())
      categoryName += mOverrideFormat;
    else
      categoryName += mOutputFormat;

    nsCOMPtr<nsICategoryManager> catman =
        mozilla::components::CategoryManager::Service();
    nsCString contractID;
    catman->GetCategoryEntry("mime-emitter", categoryName, contractID);
    if (!contractID.IsEmpty()) categoryName = contractID;

    mEmitter = do_CreateInstance(categoryName.get(), &rv);

    if ((NS_FAILED(rv)) || (!mEmitter)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  }

  // initialize our emitter
  if (mEmitter) {
    // Now we want to create a pipe which we'll use for converting the data.
    nsCOMPtr<nsIPipe> pipe = do_CreateInstance("@mozilla.org/pipe;1");
    rv = pipe->Init(true, true, 4096, 8);
    NS_ENSURE_SUCCESS(rv, rv);

    // These always succeed because the pipe is initialized above.
    MOZ_ALWAYS_SUCCEEDS(pipe->GetInputStream(getter_AddRefs(mInputStream)));
    MOZ_ALWAYS_SUCCEEDS(pipe->GetOutputStream(getter_AddRefs(mOutputStream)));

    mEmitter->Initialize(aURI, aChannel, newType);
    mEmitter->SetPipe(mInputStream, mOutputStream);
    mEmitter->SetOutputListener(aOutListener);
  }

  uint32_t whattodo = mozITXTToHTMLConv::kURLs;
  if (Preferences::GetBool(PREF_MAIL_DISPLAY_GLYPH, true)) {
    whattodo = whattodo | mozITXTToHTMLConv::kGlyphSubstitution;
  }
  if (Preferences::GetBool(PREF_MAIL_DISPLAY_STRUCT, true)) {
    whattodo = whattodo | mozITXTToHTMLConv::kStructPhrase;
  }

  if (mOutputType == nsMimeOutput::nsMimeMessageSource)
    return NS_OK;
  else {
    mBridgeStream =
        bridge_create_stream(mEmitter, this, aURI, newType, whattodo, aChannel);
    if (!mBridgeStream)
      return NS_ERROR_OUT_OF_MEMORY;
    else {
      SetStreamURI(aURI);

      // Do we need to setup an Mime Stream Converter Listener?
      if (mMimeStreamConverterListener)
        bridge_set_mime_stream_converter_listener((nsMIMESession*)mBridgeStream,
                                                  mMimeStreamConverterListener,
                                                  mOutputType);

      return NS_OK;
    }
  }
}

NS_IMETHODIMP nsStreamConverter::GetContentType(char** aOutputContentType) {
  if (!aOutputContentType) return NS_ERROR_NULL_POINTER;

  // since this method passes a string through an IDL file we need to use
  // nsMemory to allocate it and not strdup!
  //  (1) check to see if we have a real content type...use it first...
  if (!mRealContentType.IsEmpty())
    *aOutputContentType = ToNewCString(mRealContentType);
  else if (mOutputFormat.EqualsLiteral("raw"))
    *aOutputContentType =
        (char*)moz_xmemdup(UNKNOWN_CONTENT_TYPE, sizeof(UNKNOWN_CONTENT_TYPE));
  else
    *aOutputContentType = ToNewCString(mOutputFormat);
  return NS_OK;
}

//
// This is the type of output operation that is being requested by libmime. The
// types of output are specified by nsIMimeOutputType enum
//
nsresult nsStreamConverter::SetMimeOutputType(nsMimeOutputType aType) {
  mAlreadyKnowOutputType = true;
  mOutputType = aType;
  if (mBridgeStream) bridge_set_output_type(mBridgeStream, aType);
  return NS_OK;
}

//
// This is needed by libmime for MHTML link processing...this is the URI
// associated with this input stream
//
nsresult nsStreamConverter::SetStreamURI(nsIURI* aURI) {
  mURI = aURI;
  if (mBridgeStream)
    return bridge_new_new_uri((nsMIMESession*)mBridgeStream, aURI, mOutputType);
  else
    return NS_OK;
}

nsresult nsStreamConverter::SetMimeHeadersListener(
    nsIMimeStreamConverterListener* listener, nsMimeOutputType aType) {
  mMimeStreamConverterListener = listener;
  bridge_set_mime_stream_converter_listener((nsMIMESession*)mBridgeStream,
                                            listener, aType);
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetForwardInline(bool aForwardInline) {
  mForwardInline = aForwardInline;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetForwardToAddress(nsAString& aAddress) {
  aAddress = mForwardToAddress;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetForwardToAddress(const nsAString& aAddress) {
  mForwardToAddress = aAddress;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetOverrideComposeFormat(bool* aResult) {
  if (!aResult) return NS_ERROR_NULL_POINTER;
  *aResult = mOverrideComposeFormat;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetOverrideComposeFormat(bool aOverrideComposeFormat) {
  mOverrideComposeFormat = aOverrideComposeFormat;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetForwardInline(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = mForwardInline;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetForwardInlineFilter(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = mForwardInlineFilter;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetForwardInlineFilter(bool aForwardInlineFilter) {
  mForwardInlineFilter = aForwardInlineFilter;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetIdentity(nsIMsgIdentity** aIdentity) {
  if (!aIdentity) return NS_ERROR_NULL_POINTER;
  // We don't have an identity for the local folders account,
  // we will return null but it is not an error!
  NS_IF_ADDREF(*aIdentity = mIdentity);
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetIdentity(nsIMsgIdentity* aIdentity) {
  mIdentity = aIdentity;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetOriginalMsgURI(const nsACString& originalMsgURI) {
  mOriginalMsgURI = originalMsgURI;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetOriginalMsgURI(nsACString& result) {
  result = mOriginalMsgURI;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::SetOrigMsgHdr(nsIMsgDBHdr* aMsgHdr) {
  mOrigMsgHdr = aMsgHdr;
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::GetOrigMsgHdr(nsIMsgDBHdr** aMsgHdr) {
  if (!aMsgHdr) return NS_ERROR_NULL_POINTER;
  NS_IF_ADDREF(*aMsgHdr = mOrigMsgHdr);
  return NS_OK;
}

/////////////////////////////////////////////////////////////////////////////
// Methods for nsIStreamListener...
/////////////////////////////////////////////////////////////////////////////
//
// Notify the client that data is available in the input stream.  This
// method is called whenever data is written into the input stream by the
// networking library...
//
nsresult nsStreamConverter::OnDataAvailable(nsIRequest* request,
                                            nsIInputStream* aIStream,
                                            uint64_t sourceOffset,
                                            uint32_t aLength) {
  nsresult rc = NS_OK;  // should this be an error instead?
  uint32_t written;

  nsCOMPtr<nsIInputStream> stream = aIStream;
  NS_ENSURE_TRUE(stream, NS_ERROR_NULL_POINTER);
  char* buf = (char*)PR_Malloc(aLength);
  if (!buf) return NS_ERROR_OUT_OF_MEMORY; /* we couldn't allocate the object */

  uint32_t readLen;
  stream->Read(buf, aLength, &readLen);

  // We need to filter out any null characters else we will have a lot of
  // trouble as we use c string everywhere in mime
  char* readPtr;
  char* endPtr = buf + readLen;

  // First let see if the stream contains null characters
  for (readPtr = buf; readPtr < endPtr && *readPtr; readPtr++);

  // Did we find a null character? Then, we need to cleanup the stream
  if (readPtr < endPtr) {
    char* writePtr = readPtr;
    for (readPtr++; readPtr < endPtr; readPtr++) {
      if (!*readPtr) continue;

      *writePtr = *readPtr;
      writePtr++;
    }
    readLen = writePtr - buf;
  }

  if (mOutputType == nsMimeOutput::nsMimeMessageSource) {
    rc = NS_OK;
    if (mEmitter) {
      rc = mEmitter->Write(Substring(buf, buf + readLen), &written);
    }
  } else if (mBridgeStream) {
    nsMIMESession* tSession = (nsMIMESession*)mBridgeStream;
    // XXX Casting int to nsresult
    rc = static_cast<nsresult>(
        tSession->put_block((nsMIMESession*)mBridgeStream, buf, readLen));
  }

  PR_FREEIF(buf);
  return rc;
}

/////////////////////////////////////////////////////////////////////////////
// Methods for nsIRequestObserver
/////////////////////////////////////////////////////////////////////////////
//
// Notify the observer that the URL has started to load.  This method is
// called only once, at the beginning of a URL load.
//
nsresult nsStreamConverter::OnStartRequest(nsIRequest* request) {
  // here's a little bit of hackery....
  // since the mime converter is now between the channel
  // and the
  if (request) {
    nsCOMPtr<nsIChannel> channel = do_QueryInterface(request);
    if (channel) {
      nsCString contentType;
      GetContentType(getter_Copies(contentType));

      channel->SetContentType(contentType);
    }
  }

  // forward the start request to any listeners
  if (mOutListener) {
    if (mOutputType == nsMimeOutput::nsMimeMessageRaw) {
      // we need to delay the on start request until we have figure out the real
      // content type
      mPendingRequest = request;
    } else
      mOutListener->OnStartRequest(request);
  }

  return NS_OK;
}

//
// Notify the observer that the URL has finished loading.  This method is
// called once when the networking library has finished processing the
//
nsresult nsStreamConverter::OnStopRequest(nsIRequest* request,
                                          nsresult status) {
  // Make sure we fire any pending OnStartRequest before we do OnStop.
  FirePendingStartRequest();

  //
  // Now complete the stream!
  //
  if (mBridgeStream) {
    nsMIMESession* tSession = (nsMIMESession*)mBridgeStream;

    if (mMimeStreamConverterListener) {
      MimeHeaders** workHeaders = nullptr;

      if ((mOutputType == nsMimeOutput::nsMimeMessageDraftOrTemplate) ||
          (mOutputType == nsMimeOutput::nsMimeMessageEditorTemplate)) {
        mime_draft_data* mdd = tSession->data_object.AsMimeDraftData();
        if (mdd) {
          workHeaders = &(mdd->headers);
        }
      } else {
        mime_stream_data* msd = tSession->data_object.AsMimeStreamData();
        if (msd) {
          workHeaders = &(msd->headers);
        }
      }

      if (workHeaders) {
        nsresult rv;
        nsCOMPtr<nsIMimeHeaders> mimeHeaders =
            do_CreateInstance(NS_IMIMEHEADERS_CONTRACTID, &rv);

        if (NS_SUCCEEDED(rv)) {
          if (*workHeaders)
            mimeHeaders->Initialize(Substring((*workHeaders)->all_headers,
                                              (*workHeaders)->all_headers_fp));
          mMimeStreamConverterListener->OnHeadersReady(mimeHeaders);
        } else
          mMimeStreamConverterListener->OnHeadersReady(nullptr);
      }

      mMimeStreamConverterListener = nullptr;  // release our reference
    }

    tSession->complete((nsMIMESession*)mBridgeStream);
  }

  //
  // Now complete the emitter and do necessary cleanup!
  //
  if (mEmitter) {
    mEmitter->Complete();
  }

  // First close the output stream...
  if (mOutputStream) mOutputStream->Close();

  if (mOutgoingChannel) {
    nsCOMPtr<nsILoadGroup> loadGroup;
    mOutgoingChannel->GetLoadGroup(getter_AddRefs(loadGroup));
    if (loadGroup) loadGroup->RemoveRequest(mOutgoingChannel, nullptr, status);
  }

  // Make sure to do necessary cleanup!
  InternalCleanup();

  // forward on top request to any listeners
  if (mOutListener) mOutListener->OnStopRequest(request, status);

  mAlreadyKnowOutputType = false;

  // since we are done converting data, lets close all the objects we own...
  // this helps us fix some circular ref counting problems we are running
  // into...
  Close();

  // Time to return...
  return NS_OK;
}

nsresult nsStreamConverter::Close() {
  mOutgoingChannel = nullptr;
  mEmitter = nullptr;
  mOutListener = nullptr;
  return NS_OK;
}

// nsIStreamConverter implementation

// No synchronous conversion at this time.
NS_IMETHODIMP nsStreamConverter::Convert(nsIInputStream* aFromStream,
                                         const char* aFromType,
                                         const char* aToType,
                                         nsISupports* aCtxt,
                                         nsIInputStream** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

// Stream converter service calls this to initialize the actual stream converter
// (us).
NS_IMETHODIMP nsStreamConverter::AsyncConvertData(const char* aFromType,
                                                  const char* aToType,
                                                  nsIStreamListener* aListener,
                                                  nsISupports* aCtxt) {
  nsresult rv = NS_OK;
  nsCOMPtr<nsIMsgQuote> aMsgQuote = do_QueryInterface(aCtxt, &rv);
  nsCOMPtr<nsIChannel> aChannel;

  if (aMsgQuote) {
    nsCOMPtr<nsIMimeStreamConverterListener> quoteListener;
    rv = aMsgQuote->GetQuoteListener(getter_AddRefs(quoteListener));
    if (quoteListener)
      SetMimeHeadersListener(quoteListener, nsMimeOutput::nsMimeMessageQuoting);
    rv = aMsgQuote->GetQuoteChannel(getter_AddRefs(aChannel));
  } else {
    aChannel = do_QueryInterface(aCtxt, &rv);
  }

  mFromType = aFromType;
  mToType = aToType;

  NS_ASSERTION(aChannel && NS_SUCCEEDED(rv),
               "mailnews mime converter has to have the channel passed in...");
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsIURI> aUri;
  aChannel->GetURI(getter_AddRefs(aUri));
  return Init(aUri, aListener, aChannel);
}

NS_IMETHODIMP nsStreamConverter::FirePendingStartRequest() {
  if (mPendingRequest && mOutListener) {
    mOutListener->OnStartRequest(mPendingRequest);
    mPendingRequest = nullptr;
  }
  return NS_OK;
}

NS_IMETHODIMP
nsStreamConverter::MaybeRetarget(nsIRequest* request) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsStreamConverter::GetConvertedType(const nsACString& aFromType,
                                                  nsIChannel* aChannel,
                                                  nsACString& aToType) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

// Methods for nsIThreadRetargetableStreamListener

nsresult nsStreamConverter::OnDataFinished(nsresult aStatusCode) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

nsresult nsStreamConverter::CheckListenerChain() {
  return NS_ERROR_NOT_IMPLEMENTED;
}
