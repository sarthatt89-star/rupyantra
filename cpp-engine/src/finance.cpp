#include "internal.h"

namespace {
double g_result[RY_BUF_LEN];
int g_len = 0;
double g_input[RY_INPUT_LEN];
}  // namespace

namespace ry {

double* res() { return g_result; }
double* input() { return g_input; }

void begin(int len) {
  for (int i = 0; i < RY_BUF_LEN; i++) g_result[i] = 0.0;
  g_len = len < 0 ? 0 : (len > RY_BUF_LEN ? RY_BUF_LEN : len);
}

double emi_value(double principal, double annual_rate_pct, int months) {
  const double r = annual_rate_pct / 1200.0;
  if (r == 0.0) return principal / months;
  // expm1/log1p keep this accurate for very small rates
  const double growth_minus_1 = std::expm1((double)months * std::log1p(r));
  return principal * r * (1.0 + growth_minus_1) / growth_minus_1;
}

}  // namespace ry

extern "C" {

const double* rupeyantra_result_ptr(void) { return g_result; }
int rupeyantra_result_len(void) { return g_len; }
double* rupeyantra_input_ptr(void) { return g_input; }
int rupeyantra_input_len(void) { return RY_INPUT_LEN; }
int rupeyantra_version(void) { return 2; }

}  // extern "C"
