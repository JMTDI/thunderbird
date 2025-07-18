/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDER_H_
#define COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDER_H_

#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "nsIFolder.h"
#include "nsTString.h"

namespace mozilla::mailnews {

class FolderComparator;

class Folder : public nsIFolder {
 public:
  Folder() = delete;
  Folder(uint64_t aId, nsCString aName, uint64_t aFlags)
      : mId(aId), mName(aName), mFlags(aFlags) {};

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIFOLDER

  using nsIFolder::GetName;
  using nsIFolder::GetPath;

 protected:
  virtual ~Folder() {};

 private:
  friend class FolderComparator;
  friend class FolderDatabase;

  uint64_t mId;
  nsAutoCString mName;
  uint64_t mFlags;
  RefPtr<Folder> mRoot;
  RefPtr<Folder> mParent;
  Maybe<uint64_t> mOrdinal;
  nsTArray<RefPtr<Folder>> mChildren;

  void _GetDescendants(nsTArray<RefPtr<nsIFolder>>& aDescendants);
};

}  // namespace mozilla::mailnews

#endif  // COMM_MAILNEWS_DB_PANORAMA_SRC_FOLDER_H_
