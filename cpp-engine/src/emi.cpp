#include <algorithm>

#include "internal.h"

namespace {
double g_batch_in[RY_BATCH_MAX * 3];
double g_batch_out[RY_BATCH_MAX * 2];
}  // namespace

extern "C" {

int rupeyantra_emi(double principal, double annual_rate_pct, int months) {
  ry::begin(0);
  if (!ry::amount_ok(principal)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_rate_pct, 0, 100)) return RY_ERR_RATE;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;

  const double emi = ry::emi_value(principal, annual_rate_pct, months);
  ry::begin(4);
  double* r = ry::res();
  r[RY_EMI_EMI] = emi;
  r[RY_EMI_TOTAL] = emi * months;
  r[RY_EMI_INTEREST] = emi * months - principal;
  r[RY_EMI_MONTHS] = months;
  return RY_OK;
}

int rupeyantra_emi_schedule_yearly(double principal, double annual_rate_pct, int months) {
  ry::begin(0);
  if (!ry::amount_ok(principal)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_rate_pct, 0, 100)) return RY_ERR_RATE;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;

  const double rm = annual_rate_pct / 1200.0;
  const double emi = ry::emi_value(principal, annual_rate_pct, months);
  const int rows = (months + 11) / 12;

  ry::begin(1 + rows * RY_SCHED_COLS);
  double* r = ry::res();
  r[0] = rows;

  double bal = principal;
  for (int y = 0; y < rows; y++) {
    double* row = r + 1 + y * RY_SCHED_COLS;
    const double opening = bal;
    double principal_paid = 0.0, interest_paid = 0.0;
    const int last = std::min(months, (y + 1) * 12);
    for (int m = y * 12; m < last; m++) {
      const double interest = bal * rm;
      const double princ = emi - interest;
      bal -= princ;
      principal_paid += princ;
      interest_paid += interest;
    }
    if (y == rows - 1 && std::fabs(bal) < 0.01) bal = 0.0; // float residue only
    row[0] = y + 1;
    row[1] = opening;
    row[2] = principal_paid;
    row[3] = interest_paid;
    row[4] = bal;
  }
  return RY_OK;
}

int rupeyantra_loan_prepayment(double principal, double annual_rate_pct, int months,
                               double extra_monthly, double lump_sum, int lump_after_month) {
  ry::begin(0);
  if (!ry::amount_ok(principal)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_rate_pct, 0, 100)) return RY_ERR_RATE;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;
  if (!ry::in_range(extra_monthly, 0, ry::kMaxAmount) || !ry::in_range(lump_sum, 0, ry::kMaxAmount)) return RY_ERR_PREPAY;
  if (lump_sum > 0 && (lump_after_month < 1 || lump_after_month > months)) return RY_ERR_PREPAY;

  const double rm = annual_rate_pct / 1200.0;
  const double emi = ry::emi_value(principal, annual_rate_pct, months);
  const double base_interest = emi * months - principal;

  double bal = principal, paid = 0.0, interest_total = 0.0;
  int used = 0;
  for (int m = 1; m <= months; m++) {
    if (bal <= 0.005) break;
    const double interest = bal * rm;
    const double pay = std::min(emi, bal + interest);
    bal -= pay - interest;
    const double extra = std::min(extra_monthly, bal);
    bal -= extra;
    paid += pay + extra;
    interest_total += interest;
    if (lump_sum > 0 && m == lump_after_month) {
      const double l = std::min(lump_sum, bal);
      bal -= l;
      paid += l;
    }
    used = m;
    if (bal <= 0.005) break;
  }

  ry::begin(8);
  double* r = ry::res();
  r[RY_PP_BASE_EMI] = emi;
  r[RY_PP_BASE_MONTHS] = months;
  r[RY_PP_BASE_INTEREST] = base_interest;
  r[RY_PP_NEW_MONTHS] = used;
  r[RY_PP_NEW_INTEREST] = interest_total;
  r[RY_PP_INTEREST_SAVED] = base_interest - interest_total;
  r[RY_PP_MONTHS_SAVED] = months - used;
  r[RY_PP_TOTAL_PAID] = paid;
  return RY_OK;
}

int rupeyantra_emi_rate_sweep(double principal, int months, double rate_from_pct,
                              double rate_to_pct, double step_pct) {
  ry::begin(0);
  if (!ry::amount_ok(principal)) return RY_ERR_AMOUNT;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;
  if (!ry::in_range(rate_from_pct, 0, 100) || !ry::in_range(rate_to_pct, 0, 100)) return RY_ERR_RATE;
  if (!ry::finite(step_pct) || step_pct <= 0 || rate_from_pct > rate_to_pct) return RY_ERR_RANGE;

  const double span = (rate_to_pct - rate_from_pct) / step_pct;
  if (span > RY_SWEEP_MAX_ROWS - 1 + 1e-9) return RY_ERR_RANGE;
  const int rows = (int)std::floor(span + 1e-9) + 1;

  ry::begin(1 + rows * RY_SWEEP_COLS);
  double* r = ry::res();
  r[0] = rows;
  for (int i = 0; i < rows; i++) {
    const double rate = rate_from_pct + i * step_pct;
    const double emi = ry::emi_value(principal, rate, months);
    double* row = r + 1 + i * RY_SWEEP_COLS;
    row[0] = rate;
    row[1] = emi;
    row[2] = emi * months - principal;
  }
  return RY_OK;
}

double* rupeyantra_batch_in_ptr(void) { return g_batch_in; }
const double* rupeyantra_batch_out_ptr(void) { return g_batch_out; }
int rupeyantra_batch_capacity(void) { return RY_BATCH_MAX; }

int rupeyantra_emi_batch(int count) {
  ry::begin(0);
  if (count < 1 || count > RY_BATCH_MAX) return RY_ERR_BATCH;

  int invalid = 0;
  for (int i = 0; i < count; i++) {
    const double p = g_batch_in[i * 3];
    const double rate = g_batch_in[i * 3 + 1];
    const double mm = g_batch_in[i * 3 + 2];
    const bool ok = ry::amount_ok(p) && ry::in_range(rate, 0, 100) && ry::in_range(mm, 1, ry::kMaxMonths);
    if (!ok) {
      g_batch_out[i * 2] = 0.0;
      g_batch_out[i * 2 + 1] = 0.0;
      invalid++;
      continue;
    }
    const int months = (int)std::lround(mm);
    const double emi = ry::emi_value(p, rate, months);
    g_batch_out[i * 2] = emi;
    g_batch_out[i * 2 + 1] = emi * months - p;
  }

  ry::begin(2);
  ry::res()[0] = invalid;
  ry::res()[1] = count;
  return RY_OK;
}

}  // extern "C"
