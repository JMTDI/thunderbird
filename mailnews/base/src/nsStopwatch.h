/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSSTOPWATCH_H_
#define COMM_MAILNEWS_BASE_SRC_NSSTOPWATCH_H_

#include "nsIStopwatch.h"

class nsStopwatch : public nsIStopwatch {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSISTOPWATCH

  nsStopwatch();

 private:
  virtual ~nsStopwatch();

  /// Wall-clock start time in seconds since unix epoch.
  double fStartRealTimeSecs;
  /// Wall-clock stop time in seconds since unix epoch.
  double fStopRealTimeSecs;
  /// CPU-clock start time in seconds (of CPU time used since app start)
  double fStartCpuTimeSecs;
  /// CPU-clock stop time in seconds (of CPU time used since app start)
  double fStopCpuTimeSecs;
  /// Total wall-clock time elapsed in seconds.
  double fTotalRealTimeSecs;
  /// Total CPU time elapsed in seconds.
  double fTotalCpuTimeSecs;

  /// Is the timer running?
  bool fRunning;

  static double GetRealTime();
  static double GetCPUTime();
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSSTOPWATCH_H_
