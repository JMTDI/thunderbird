/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgSearchValue.h"
#include "nsIMsgFolder.h"
#include "nsMsgUtils.h"
#include "nsString.h"

nsMsgSearchValueImpl::nsMsgSearchValueImpl(nsMsgSearchValue* aInitialValue) {
  mValue = *aInitialValue;
}

nsMsgSearchValueImpl::~nsMsgSearchValueImpl() {}

NS_IMPL_ISUPPORTS(nsMsgSearchValueImpl, nsIMsgSearchValue)

NS_IMPL_GETSET(nsMsgSearchValueImpl, Priority, nsMsgPriorityValue,
               mValue.u.priority)
NS_IMPL_GETSET(nsMsgSearchValueImpl, Status, uint32_t, mValue.u.msgStatus)
NS_IMPL_GETSET(nsMsgSearchValueImpl, Size, uint32_t, mValue.u.size)
NS_IMPL_GETSET(nsMsgSearchValueImpl, MsgKey, nsMsgKey, mValue.u.key)
NS_IMPL_GETSET(nsMsgSearchValueImpl, Age, int32_t, mValue.u.age)
NS_IMPL_GETSET(nsMsgSearchValueImpl, Date, PRTime, mValue.u.date)
NS_IMPL_GETSET(nsMsgSearchValueImpl, Attrib, nsMsgSearchAttribValue,
               mValue.attribute)
NS_IMPL_GETSET(nsMsgSearchValueImpl, JunkStatus, uint32_t, mValue.u.junkStatus)
NS_IMPL_GETSET(nsMsgSearchValueImpl, JunkPercent, uint32_t,
               mValue.u.junkPercent)

NS_IMETHODIMP
nsMsgSearchValueImpl::GetFolder(nsIMsgFolder** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  NS_ENSURE_TRUE(mValue.attribute == nsMsgSearchAttrib::FolderInfo,
                 NS_ERROR_ILLEGAL_VALUE);
  NS_IF_ADDREF(*aResult = mValue.u.folder);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchValueImpl::SetFolder(nsIMsgFolder* aValue) {
  NS_ENSURE_TRUE(mValue.attribute == nsMsgSearchAttrib::FolderInfo,
                 NS_ERROR_ILLEGAL_VALUE);
  mValue.u.folder = aValue;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchValueImpl::GetStr(nsAString& aResult) {
  NS_ENSURE_TRUE(IS_STRING_ATTRIBUTE(mValue.attribute), NS_ERROR_ILLEGAL_VALUE);
  aResult = mValue.utf16String;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchValueImpl::SetStr(const nsAString& aValue) {
  NS_ENSURE_TRUE(IS_STRING_ATTRIBUTE(mValue.attribute), NS_ERROR_ILLEGAL_VALUE);
  CopyUTF16toUTF8(aValue, mValue.utf8String);
  mValue.utf16String = aValue;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchValueImpl::GetUtf8Str(nsACString& aResult) {
  NS_ENSURE_TRUE(IS_STRING_ATTRIBUTE(mValue.attribute), NS_ERROR_ILLEGAL_VALUE);
  aResult = mValue.utf8String;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchValueImpl::ToString(nsAString& aResult) {
  aResult.AssignLiteral("[nsIMsgSearchValue: ");
  if (IS_STRING_ATTRIBUTE(mValue.attribute)) {
    aResult.Append(mValue.utf16String);
    return NS_OK;
  }

  switch (mValue.attribute) {
    case nsMsgSearchAttrib::Priority:
    case nsMsgSearchAttrib::Date:
    case nsMsgSearchAttrib::MsgStatus:
    case nsMsgSearchAttrib::MessageKey:
    case nsMsgSearchAttrib::Size:
    case nsMsgSearchAttrib::AgeInDays:
    case nsMsgSearchAttrib::FolderInfo:
    case nsMsgSearchAttrib::JunkStatus:
    case nsMsgSearchAttrib::JunkPercent: {
      nsAutoString tempInt;
      tempInt.AppendInt(mValue.attribute);

      aResult.AppendLiteral("type=");
      aResult.Append(tempInt);
    } break;
    default:
      NS_ERROR("Unknown search value type");
  }

  aResult.Append(']');

  return NS_OK;
}
