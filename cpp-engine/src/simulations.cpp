#include <algorithm>
#include <new>
#include <vector>

#include "internal.h"

namespace {

const int kMinSims = 100;
const int kMaxSims = 200000;
const double kMaxWork = 5e7;  // simulations x steps per call; keeps one call well under a second

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
    const double u1 = uniform(), u2 = uniform();
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(two_pi * u2);
  }
};

double percentile(const std::vector<double>& sorted, double p) {
  const double idx = p * (double)(sorted.size() - 1);
  const size_t lo = (size_t)std::floor(idx);
  const size_t hi = (size_t)std::ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - (double)lo);
}

bool sims_ok(int sims) { return sims >= kMinSims && sims <= kMaxSims; }

// One growth step: mean growth factor g per step, volatility sigma per step (log-normal, mean exactly g).
struct Step {
  double mean_growth, sigma, mu;
  Step(double g, double sig) : mean_growth(g), sigma(sig), mu(std::log(g) - 0.5 * sig * sig) {}
  double draw(Rng& rng) const { return sigma == 0.0 ? mean_growth : std::exp(mu + sigma * rng.normal()); }
};

// Runs the paths. monthly > 0 => SIP (deposit at the start of every step); otherwise lumpsum of `lump`.
int run(double monthly, double lump, const Step& st, int steps, int sims, uint32_t seed, std::vector<double>& finals) {
  try {
    finals.resize((size_t)sims);
  } catch (const std::bad_alloc&) {
    return RY_ERR_MEMORY;
  }
  Rng rng((uint64_t)seed * 2654435761ULL + 1ULL);
  for (int s = 0; s < sims; s++) {
    double bal = monthly > 0 ? 0.0 : lump;
    for (int m = 0; m < steps; m++) {
      if (monthly > 0) bal += monthly;
      bal *= st.draw(rng);
    }
    finals[(size_t)s] = bal;
  }
  std::sort(finals.begin(), finals.end());
  return RY_OK;
}

int store_summary(const std::vector<double>& finals, double invested) {
  double sum = 0.0;
  int losses = 0;
  for (double v : finals) {
    sum += v;
    if (v < invested) losses++;
  }
  const double n = (double)finals.size();
  ry::begin(8);
  double* r = ry::res();
  r[RY_INVESTED] = invested;
  r[RY_P10] = percentile(finals, 0.10);
  r[RY_P50] = percentile(finals, 0.50);
  r[RY_P90] = percentile(finals, 0.90);
  r[RY_MEAN] = sum / n;
  r[RY_PROB_LOSS] = 100.0 * losses / n;
  r[RY_MIN] = finals.front();
  r[RY_MAX] = finals.back();
  for (int i = 0; i < 8; i++) {
    if (!ry::finite(r[i])) {
      ry::begin(0);
      return RY_ERR_RETURN;
    }
  }
  return RY_OK;
}

int check_sip(double monthly, double ret, double vol, int months, int sims) {
  if (!ry::amount_ok(monthly)) return RY_ERR_AMOUNT;
  if (!ry::in_range(ret, -50, 100)) return RY_ERR_RETURN;
  if (!ry::in_range(vol, 0, 100)) return RY_ERR_VOLATILITY;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;
  if (!sims_ok(sims) || (double)sims * months > kMaxWork) return RY_ERR_SIMULATIONS;
  return RY_OK;
}

Step monthly_step(double ret, double vol) {
  return Step(1.0 + ret / 1200.0, (vol / 100.0) / std::sqrt(12.0));
}

}  // namespace

extern "C" {

int rupeyantra_sip_monte_carlo(double monthly_amount, double annual_return_pct, double annual_volatility_pct,
                               int months, int simulations, uint32_t seed) {
  ry::begin(0);
  int rc = check_sip(monthly_amount, annual_return_pct, annual_volatility_pct, months, simulations);
  if (rc != RY_OK) return rc;
  std::vector<double> finals;
  rc = run(monthly_amount, 0.0, monthly_step(annual_return_pct, annual_volatility_pct), months, simulations, seed, finals);
  if (rc != RY_OK) return rc;
  return store_summary(finals, monthly_amount * months);
}

int rupeyantra_lumpsum_monte_carlo(double principal, double annual_return_pct, double annual_volatility_pct,
                                   int months, int compounds_per_year, int simulations, uint32_t seed) {
  ry::begin(0);
  if (!ry::amount_ok(principal)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_return_pct, -50, 100)) return RY_ERR_RETURN;
  if (!ry::in_range(annual_volatility_pct, 0, 100)) return RY_ERR_VOLATILITY;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;
  if (compounds_per_year < 1 || compounds_per_year > 365) return RY_ERR_COMPOUNDING;
  const int steps = std::max(1, (int)std::lround((double)compounds_per_year * months / 12.0));
  if (!sims_ok(simulations) || (double)simulations * steps > kMaxWork) return RY_ERR_SIMULATIONS;

  const double c = compounds_per_year;
  const Step st(1.0 + annual_return_pct / 100.0 / c, (annual_volatility_pct / 100.0) / std::sqrt(c));
  std::vector<double> finals;
  const int rc = run(0.0, principal, st, steps, simulations, seed, finals);
  if (rc != RY_OK) return rc;
  return store_summary(finals, principal);
}

int rupeyantra_sip_goal_probability(double monthly_amount, double annual_return_pct, double annual_volatility_pct,
                                    int months, double goal_amount, int simulations, uint32_t seed) {
  ry::begin(0);
  int rc = check_sip(monthly_amount, annual_return_pct, annual_volatility_pct, months, simulations);
  if (rc != RY_OK) return rc;
  if (!ry::amount_ok(goal_amount)) return RY_ERR_AMOUNT;
  std::vector<double> finals;
  rc = run(monthly_amount, 0.0, monthly_step(annual_return_pct, annual_volatility_pct), months, simulations, seed, finals);
  if (rc != RY_OK) return rc;
  int hit = 0;
  for (double v : finals) if (v >= goal_amount) hit++;
  const double median = percentile(finals, 0.50);
  if (!ry::finite(median)) return RY_ERR_RETURN;
  ry::begin(2);
  ry::res()[RY_GOAL_PROB] = 100.0 * hit / (double)finals.size();
  ry::res()[RY_GOAL_MEDIAN] = median;
  return RY_OK;
}

}  // extern "C"
