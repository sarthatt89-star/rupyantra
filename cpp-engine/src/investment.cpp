#include "internal.h"

extern "C" {

int rupeyantra_sip(double monthly_amount, double annual_return_pct, int months) {
  ry::begin(0);
  if (!ry::amount_ok(monthly_amount)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_return_pct, -50, 100)) return RY_ERR_RETURN;
  if (!ry::months_ok(months)) return RY_ERR_MONTHS;

  const double r = annual_return_pct / 1200.0;
  const double invested = monthly_amount * months;
  // deposits at the start of each month (annuity-due), same convention as the JS engine
  const double fv = r == 0.0
      ? invested
      : monthly_amount * (std::expm1((double)months * std::log1p(r)) / r) * (1.0 + r);

  ry::begin(3);
  ry::res()[RY_SIP_INVESTED] = invested;
  ry::res()[RY_SIP_FV] = fv;
  ry::res()[RY_SIP_GAIN] = fv - invested;
  return RY_OK;
}

int rupeyantra_lumpsum(double principal, double annual_rate_pct, double years, int compounds_per_year) {
  ry::begin(0);
  if (!ry::amount_ok(principal)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_rate_pct, -50, 100)) return RY_ERR_RETURN;
  if (!ry::finite(years) || years <= 0 || years > 100) return RY_ERR_MONTHS;
  if (compounds_per_year < 1 || compounds_per_year > 365) return RY_ERR_COMPOUNDING;

  const double m = compounds_per_year;
  const double maturity = principal * std::exp(m * years * std::log1p(annual_rate_pct / 100.0 / m));

  ry::begin(2);
  ry::res()[RY_LUMP_MATURITY] = maturity;
  ry::res()[RY_LUMP_INTEREST] = maturity - principal;
  return RY_OK;
}

int rupeyantra_cagr(double start_value, double end_value, double years) {
  ry::begin(0);
  if (!ry::amount_ok(start_value) || !ry::amount_ok(end_value)) return RY_ERR_AMOUNT;
  if (!ry::finite(years) || years <= 0 || years > 100) return RY_ERR_MONTHS;

  ry::begin(1);
  ry::res()[RY_CAGR_PERCENT] = (std::pow(end_value / start_value, 1.0 / years) - 1.0) * 100.0;
  return RY_OK;
}

int rupeyantra_inflation(double amount, double annual_inflation_pct, double years) {
  ry::begin(0);
  if (!ry::amount_ok(amount)) return RY_ERR_AMOUNT;
  if (!ry::in_range(annual_inflation_pct, -20, 100)) return RY_ERR_RATE;
  if (!ry::finite(years) || years <= 0 || years > 100) return RY_ERR_MONTHS;

  const double factor = std::pow(1.0 + annual_inflation_pct / 100.0, years);
  ry::begin(3);
  ry::res()[RY_INFL_FUTURE] = amount * factor;                 // what today's amount will cost
  ry::res()[RY_INFL_EXTRA] = amount * factor - amount;
  ry::res()[RY_INFL_REAL_VALUE] = amount / factor;             // what today's amount will be worth in today's money
  return RY_OK;
}

int rupeyantra_real_return(double nominal_pct, double inflation_pct) {
  ry::begin(0);
  if (!ry::in_range(nominal_pct, -50, 100)) return RY_ERR_RETURN;
  if (!ry::in_range(inflation_pct, -20, 100)) return RY_ERR_RATE;

  ry::begin(1);
  ry::res()[RY_REAL_PERCENT] = ((1.0 + nominal_pct / 100.0) / (1.0 + inflation_pct / 100.0) - 1.0) * 100.0;
  return RY_OK;
}

}  // extern "C"
