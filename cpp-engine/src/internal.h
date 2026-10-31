#ifndef RUPEYANTRA_INTERNAL_H
#define RUPEYANTRA_INTERNAL_H

#include <cmath>

#include "finance.h"

namespace ry {

const double kMaxAmount = 1e12;
const int kMaxMonths = 1200;

double* res();          // shared result buffer (RY_BUF_LEN doubles)
double* input();        // shared input buffer (RY_INPUT_LEN doubles)
void begin(int len);    // zero the result buffer and set its length (begin(0) = "no result")

inline bool finite(double x) { return std::isfinite(x); }
inline bool amount_ok(double x) { return finite(x) && x > 0 && x <= kMaxAmount; }
inline bool months_ok(int m) { return m >= 1 && m <= kMaxMonths; }
inline bool in_range(double x, double lo, double hi) { return finite(x) && x >= lo && x <= hi; }

// monthly EMI, reducing balance; rate in percent per year
double emi_value(double principal, double annual_rate_pct, int months);

}  // namespace ry

#endif
