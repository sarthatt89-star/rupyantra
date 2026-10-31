#ifndef RUPEYANTRA_FINANCE_H
#define RUPEYANTRA_FINANCE_H

#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define RY_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define RY_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ---- sizes ---- */
enum {
  RY_BUF_LEN = 1024,        /* result buffer, in doubles */
  RY_INPUT_LEN = 40,        /* input buffer, in doubles */
  RY_BATCH_MAX = 10000,     /* loans per batch call */
  RY_SCHED_COLS = 5,        /* yearly schedule: year, opening, principal, interest, closing */
  RY_SWEEP_COLS = 3,        /* rate table: rate, emi, total interest */
  RY_SWEEP_MAX_ROWS = 200
};

/* ---- return codes (the JS bridge uses the same numbers) ---- */
enum {
  RY_OK = 0,
  RY_ERR_AMOUNT = 1,
  RY_ERR_RETURN = 2,
  RY_ERR_VOLATILITY = 3,
  RY_ERR_MONTHS = 4,
  RY_ERR_SIMULATIONS = 5,
  RY_ERR_MEMORY = 6,
  RY_ERR_RATE = 7,
  RY_ERR_PREPAY = 8,
  RY_ERR_TAX = 9,
  RY_ERR_RANGE = 10,
  RY_ERR_BATCH = 11,
  RY_ERR_COMPOUNDING = 12
};

/* ---- result slots: simulations ---- */
enum {
  RY_INVESTED = 0, RY_P10 = 1, RY_P50 = 2, RY_P90 = 3,
  RY_MEAN = 4, RY_PROB_LOSS = 5, RY_MIN = 6, RY_MAX = 7
};
enum { RY_GOAL_PROB = 0, RY_GOAL_MEDIAN = 1 };

/* ---- result slots: loans ---- */
enum { RY_EMI_EMI = 0, RY_EMI_TOTAL = 1, RY_EMI_INTEREST = 2, RY_EMI_MONTHS = 3 };
enum {
  RY_PP_BASE_EMI = 0, RY_PP_BASE_MONTHS = 1, RY_PP_BASE_INTEREST = 2, RY_PP_NEW_MONTHS = 3,
  RY_PP_NEW_INTEREST = 4, RY_PP_INTEREST_SAVED = 5, RY_PP_MONTHS_SAVED = 6, RY_PP_TOTAL_PAID = 7
};

/* ---- result slots: investments ---- */
enum { RY_SIP_INVESTED = 0, RY_SIP_FV = 1, RY_SIP_GAIN = 2 };
enum { RY_LUMP_MATURITY = 0, RY_LUMP_INTEREST = 1 };
enum { RY_CAGR_PERCENT = 0 };
enum { RY_INFL_FUTURE = 0, RY_INFL_EXTRA = 1, RY_INFL_REAL_VALUE = 2 };
enum { RY_REAL_PERCENT = 0 };

/* ---- tax: input buffer layout (10 slabs of [upper, rate], 6 surcharge tiers of [above, rate]) ---- */
enum {
  RY_TAXIN_INCOME = 0,
  RY_TAXIN_SLABS = 1,
  RY_TAXIN_SLAB0 = 2,
  RY_TAXIN_REBATE_LIMIT = 22,
  RY_TAXIN_REBATE_MAX = 23,
  RY_TAXIN_REBATE_RELIEF = 24,
  RY_TAXIN_SURCH_COUNT = 25,
  RY_TAXIN_SURCH0 = 26,
  RY_TAXIN_CESS = 38
};
enum {
  RY_TAXOUT_SLAB = 0, RY_TAXOUT_REBATE = 1, RY_TAXOUT_AFTER_REBATE = 2, RY_TAXOUT_SURCHARGE = 3,
  RY_TAXOUT_CESS = 4, RY_TAXOUT_TOTAL = 5, RY_TAXOUT_EFFECTIVE = 6, RY_TAXOUT_MONTHLY = 7,
  RY_TAXOUT_ROUNDED = 8
};

/* ---- shared buffers ---- */
RY_EXPORT const double* rupeyantra_result_ptr(void);
RY_EXPORT int rupeyantra_result_len(void);
RY_EXPORT double* rupeyantra_input_ptr(void);
RY_EXPORT int rupeyantra_input_len(void);
RY_EXPORT int rupeyantra_version(void);
RY_EXPORT double* rupeyantra_batch_in_ptr(void);
RY_EXPORT const double* rupeyantra_batch_out_ptr(void);
RY_EXPORT int rupeyantra_batch_capacity(void);

/* ---- loans ---- */
RY_EXPORT int rupeyantra_emi(double principal, double annual_rate_pct, int months);
RY_EXPORT int rupeyantra_emi_schedule_yearly(double principal, double annual_rate_pct, int months);
RY_EXPORT int rupeyantra_loan_prepayment(double principal, double annual_rate_pct, int months,
                                         double extra_monthly, double lump_sum, int lump_after_month);
RY_EXPORT int rupeyantra_emi_rate_sweep(double principal, int months, double rate_from_pct,
                                        double rate_to_pct, double step_pct);
RY_EXPORT int rupeyantra_emi_batch(int count);

/* ---- investments ---- */
RY_EXPORT int rupeyantra_sip(double monthly_amount, double annual_return_pct, int months);
RY_EXPORT int rupeyantra_lumpsum(double principal, double annual_rate_pct, double years, int compounds_per_year);
RY_EXPORT int rupeyantra_cagr(double start_value, double end_value, double years);
RY_EXPORT int rupeyantra_inflation(double amount, double annual_inflation_pct, double years);
RY_EXPORT int rupeyantra_real_return(double nominal_pct, double inflation_pct);

/* ---- simulations ---- */
RY_EXPORT int rupeyantra_sip_monte_carlo(double monthly_amount, double annual_return_pct,
                                         double annual_volatility_pct, int months,
                                         int simulations, uint32_t seed);
RY_EXPORT int rupeyantra_lumpsum_monte_carlo(double principal, double annual_return_pct,
                                             double annual_volatility_pct, int months,
                                             int compounds_per_year, int simulations, uint32_t seed);
RY_EXPORT int rupeyantra_sip_goal_probability(double monthly_amount, double annual_return_pct,
                                              double annual_volatility_pct, int months,
                                              double goal_amount, int simulations, uint32_t seed);

/* ---- tax (reads the input buffer) ---- */
RY_EXPORT int rupeyantra_tax_compute(void);

#ifdef __cplusplus
}
#endif

#endif
