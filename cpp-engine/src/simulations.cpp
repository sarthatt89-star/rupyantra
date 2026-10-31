#include "finance.h"

#include <algorithm>
#include <cmath>
#include <new>
#include <vector>

namespace {

const int kMaxMonths = 1200;
const int kMinSims = 100;
const int kMaxSims = 200000;
const double kMaxAmount = 1e12;

double g_result[RY_RESULT_LEN];

struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed) {}
  uint64_t next() {
    uint64_t z = (s += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
  }
  double uniform() { return ((next() >> 11) + 0.5) * (1.0 / 9007199254740992.0); }
  double normal() {
    const double two_pi = 6.283185307179586476925286766559;
    double u1 = uniform(), u2 = uniform();
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(two_pi * u2);
  }
};

double percentile(const std::vector<double>& sorted, double p) {
  double idx = p * (double)(sorted.size() - 1);
  size_t lo = (size_t)std::floor(idx);
  size_t hi = (size_t)std::ceil(idx);
  double frac = idx - (double)lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

}  // namespace

extern "C" {

int rupeyantra_sip_monte_carlo(double monthly_amount, double annual_return_pct,
                               double annual_volatility_pct, int months,
                               int simulations, uint32_t seed) {
  for (int i = 0; i < RY_RESULT_LEN; i++) g_result[i] = 0.0;

  if (!std::isfinite(monthly_amount) || monthly_amount <= 0 || monthly_amount > kMaxAmount) return RY_ERR_AMOUNT;
  if (!std::isfinite(annual_return_pct) || annual_return_pct < -50 || annual_return_pct > 100) return RY_ERR_RETURN;
  if (!std::isfinite(annual_volatility_pct) || annual_volatility_pct < 0 || annual_volatility_pct > 100) return RY_ERR_VOLATILITY;
  if (months < 1 || months > kMaxMonths) return RY_ERR_MONTHS;
  if (simulations < kMinSims || simulations > kMaxSims) return RY_ERR_SIMULATIONS;

  const double mean_growth = 1.0 + annual_return_pct / 1200.0;
  const double sigma_m = (annual_volatility_pct / 100.0) / std::sqrt(12.0);
  const double mu_m = std::log(mean_growth) - 0.5 * sigma_m * sigma_m;
  const double invested = monthly_amount * months;

  std::vector<double> finals;
  try {
    finals.resize((size_t)simulations);
  } catch (const std::bad_alloc&) {
    return RY_ERR_MEMORY;
  }

  Rng rng((uint64_t)seed * 2654435761ULL + 1ULL);
  double sum = 0.0;
  int losses = 0;

  for (int s = 0; s < simulations; s++) {
    double bal = 0.0;
    for (int m = 0; m < months; m++) {
      double growth = sigma_m == 0.0 ? mean_growth : std::exp(mu_m + sigma_m * rng.normal());
      bal = (bal + monthly_amount) * growth;
    }
    finals[(size_t)s] = bal;
    sum += bal;
    if (bal < invested) losses++;
  }

  std::sort(finals.begin(), finals.end());

  g_result[RY_INVESTED] = invested;
  g_result[RY_P10] = percentile(finals, 0.10);
  g_result[RY_P50] = percentile(finals, 0.50);
  g_result[RY_P90] = percentile(finals, 0.90);
  g_result[RY_MEAN] = sum / (double)simulations;
  g_result[RY_PROB_LOSS] = 100.0 * (double)losses / (double)simulations;
  g_result[RY_MIN] = finals.front();
  g_result[RY_MAX] = finals.back();

  for (int i = 0; i < RY_RESULT_LEN; i++) {
    if (!std::isfinite(g_result[i])) {
      for (int j = 0; j < RY_RESULT_LEN; j++) g_result[j] = 0.0;
      return RY_ERR_RETURN;
    }
  }
  return RY_OK;
}

const double* rupeyantra_result_ptr(void) { return g_result; }
int rupeyantra_result_len(void) { return RY_RESULT_LEN; }
int rupeyantra_version(void) { return 1; }

}  // extern "C"
