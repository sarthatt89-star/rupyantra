#include "internal.h"

namespace {

double slab_tax(const double* in, double income) {
  const int n = (int)in[RY_TAXIN_SLABS];
  double tax = 0.0, lower = 0.0;
  for (int i = 0; i < n; i++) {
    const double upper = (i == n - 1) ? 1e300 : in[RY_TAXIN_SLAB0 + 2 * i];
    const double rate = in[RY_TAXIN_SLAB0 + 2 * i + 1];
    if (income > lower) {
      const double top = income < upper ? income : upper;
      tax += (top - lower) * rate / 100.0;
    }
    lower = upper;
  }
  return tax;
}

struct Rebate { double tax_after; double rebate; };

Rebate after_rebate(const double* in, double income) {
  const double slab = slab_tax(in, income);
  const double limit = in[RY_TAXIN_REBATE_LIMIT];
  double rebate = 0.0;
  if (limit > 0) {
    if (income <= limit) {
      rebate = in[RY_TAXIN_REBATE_MAX] < slab ? in[RY_TAXIN_REBATE_MAX] : slab;
    } else if (in[RY_TAXIN_REBATE_RELIEF] == 1.0) {
      const double excess = income - limit;       // marginal relief: tax never exceeds income above the limit
      if (slab > excess) rebate = slab - excess;
    }
  }
  return { slab - rebate, rebate };
}

bool valid_rules(const double* in) {
  if (!ry::in_range(in[RY_TAXIN_INCOME], 0, ry::kMaxAmount)) return false;

  const double ns = in[RY_TAXIN_SLABS];
  if (!ry::finite(ns) || ns != std::floor(ns) || ns < 1 || ns > 10) return false;
  const int n = (int)ns;
  double prev = 0.0;
  for (int i = 0; i < n; i++) {
    const double upper = in[RY_TAXIN_SLAB0 + 2 * i];
    const double rate = in[RY_TAXIN_SLAB0 + 2 * i + 1];
    if (!ry::in_range(rate, 0, 100)) return false;
    if (i < n - 1) {
      if (!ry::finite(upper) || upper <= prev) return false;
      prev = upper;
    }
  }

  if (!ry::in_range(in[RY_TAXIN_REBATE_LIMIT], 0, ry::kMaxAmount)) return false;
  if (!ry::in_range(in[RY_TAXIN_REBATE_MAX], 0, ry::kMaxAmount)) return false;
  if (in[RY_TAXIN_REBATE_RELIEF] != 0.0 && in[RY_TAXIN_REBATE_RELIEF] != 1.0) return false;

  const double sc = in[RY_TAXIN_SURCH_COUNT];
  if (!ry::finite(sc) || sc != std::floor(sc) || sc < 0 || sc > 6) return false;
  double prev_t = 0.0;
  for (int i = 0; i < (int)sc; i++) {
    const double t = in[RY_TAXIN_SURCH0 + 2 * i];
    const double rate = in[RY_TAXIN_SURCH0 + 2 * i + 1];
    if (!ry::finite(t) || t <= prev_t || !ry::in_range(rate, 0, 100)) return false;
    prev_t = t;
  }
  return ry::in_range(in[RY_TAXIN_CESS], 0, 100);
}

}  // namespace

extern "C" {

int rupeyantra_tax_compute(void) {
  ry::begin(0);
  const double* in = ry::input();
  if (!valid_rules(in)) return RY_ERR_TAX;

  const double income = in[RY_TAXIN_INCOME];
  const double slab = slab_tax(in, income);
  const Rebate rb = after_rebate(in, income);

  // surcharge: highest tier whose threshold the income exceeds, with marginal relief
  double surcharge = 0.0;
  const int tiers = (int)in[RY_TAXIN_SURCH_COUNT];
  int k = -1;
  for (int i = 0; i < tiers; i++) {
    if (income > in[RY_TAXIN_SURCH0 + 2 * i]) k = i;
  }
  if (k >= 0) {
    const double rate = in[RY_TAXIN_SURCH0 + 2 * k + 1];
    const double threshold = in[RY_TAXIN_SURCH0 + 2 * k];
    const double prev_rate = k > 0 ? in[RY_TAXIN_SURCH0 + 2 * (k - 1) + 1] : 0.0;
    surcharge = rb.tax_after * rate / 100.0;
    const double at_threshold = after_rebate(in, threshold).tax_after * (1.0 + prev_rate / 100.0);
    const double limit_total = at_threshold + (income - threshold);
    if (rb.tax_after + surcharge > limit_total) {
      surcharge = limit_total - rb.tax_after;
      if (surcharge < 0.0) surcharge = 0.0;
    }
  }

  const double cess = (rb.tax_after + surcharge) * in[RY_TAXIN_CESS] / 100.0;
  const double total = rb.tax_after + surcharge + cess;

  ry::begin(9);
  double* r = ry::res();
  r[RY_TAXOUT_SLAB] = slab;
  r[RY_TAXOUT_REBATE] = rb.rebate;
  r[RY_TAXOUT_AFTER_REBATE] = rb.tax_after;
  r[RY_TAXOUT_SURCHARGE] = surcharge;
  r[RY_TAXOUT_CESS] = cess;
  r[RY_TAXOUT_TOTAL] = total;
  r[RY_TAXOUT_EFFECTIVE] = income > 0 ? total / income * 100.0 : 0.0;
  r[RY_TAXOUT_MONTHLY] = total / 12.0;
  r[RY_TAXOUT_ROUNDED] = std::round(total / 10.0) * 10.0; // tax is payable rounded to the nearest 10 rupees
  return RY_OK;
}

}  // extern "C"
