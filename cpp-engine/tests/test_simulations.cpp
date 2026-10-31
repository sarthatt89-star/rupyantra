#include "finance.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

static int failures = 0;

#define CHECK(cond, msg)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::printf("FAIL: %s\n", msg);                      \
      failures++;                                          \
    } else {                                               \
      std::printf("ok:   %s\n", msg);                      \
    }                                                      \
  } while (0)

static double closed_form_sip(double P, double rate_pct, int n) {
  double r = rate_pct / 1200.0, bal = 0.0;
  for (int i = 0; i < n; i++) bal = (bal + P) * (1.0 + r);
  return bal;
}

int main() {
  const double* out = rupeyantra_result_ptr();

  CHECK(rupeyantra_sip_monte_carlo(10000, 12, 0, 120, 1000, 1) == RY_OK, "zero-vol call succeeds");
  CHECK(std::fabs(out[RY_P50] - closed_form_sip(10000, 12, 120)) < 0.01, "zero-vol median == closed form");
  CHECK(std::fabs(out[RY_P50] - 2323390.7635) < 0.01, "zero-vol median == known answer 2323390.76");
  CHECK(std::fabs(out[RY_INVESTED] - 1200000.0) < 1e-9, "invested = 12,00,000");
  CHECK(out[RY_PROB_LOSS] == 0.0, "no loss when return is positive and vol is zero");

  CHECK(rupeyantra_sip_monte_carlo(10000, 12, 15, 120, 20000, 42) == RY_OK, "vol call succeeds");
  CHECK(out[RY_MIN] <= out[RY_P10] && out[RY_P10] <= out[RY_P50] && out[RY_P50] <= out[RY_P90] && out[RY_P90] <= out[RY_MAX],
        "min <= p10 <= p50 <= p90 <= max");
  CHECK(out[RY_P10] < out[RY_P90], "spread exists with volatility");
  double det = closed_form_sip(10000, 12, 120);
  CHECK(std::fabs(out[RY_MEAN] - det) / det < 0.02, "mean within 2% of deterministic value");

  rupeyantra_sip_monte_carlo(5000, 10, 18, 60, 5000, 7);
  double a = out[RY_P50], b = out[RY_P10];
  rupeyantra_sip_monte_carlo(5000, 10, 18, 60, 5000, 7);
  CHECK(a == out[RY_P50] && b == out[RY_P10], "same seed gives same result");

  rupeyantra_sip_monte_carlo(10000, 0, 25, 36, 10000, 3);
  CHECK(out[RY_PROB_LOSS] > 0.0 && out[RY_PROB_LOSS] < 100.0, "loss probability is between 0 and 100 for 0% return, 25% vol");

  CHECK(rupeyantra_sip_monte_carlo(-1, 12, 15, 120, 1000, 1) == RY_ERR_AMOUNT, "negative amount rejected");
  CHECK(rupeyantra_sip_monte_carlo(1000, 500, 15, 120, 1000, 1) == RY_ERR_RETURN, "return 500% rejected");
  CHECK(rupeyantra_sip_monte_carlo(1000, 12, -5, 120, 1000, 1) == RY_ERR_VOLATILITY, "negative volatility rejected");
  CHECK(rupeyantra_sip_monte_carlo(1000, 12, 15, 0, 1000, 1) == RY_ERR_MONTHS, "0 months rejected");
  CHECK(rupeyantra_sip_monte_carlo(1000, 12, 15, 5000, 1000, 1) == RY_ERR_MONTHS, "5000 months rejected");
  CHECK(rupeyantra_sip_monte_carlo(1000, 12, 15, 12, 10, 1) == RY_ERR_SIMULATIONS, "10 simulations rejected");
  CHECK(rupeyantra_sip_monte_carlo(1000, 12, 15, 12, 5000000, 1) == RY_ERR_SIMULATIONS, "5,000,000 simulations rejected");
  CHECK(rupeyantra_sip_monte_carlo(NAN, 12, 15, 12, 1000, 1) == RY_ERR_AMOUNT, "NaN amount rejected");
  CHECK(out[RY_P50] == 0.0, "results cleared after an error");

  std::printf(failures ? "\n%d test(s) FAILED\n" : "\nall tests passed\n", failures);
  return failures ? 1 : 0;
}
