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

enum {
  RY_INVESTED = 0,
  RY_P10 = 1,
  RY_P50 = 2,
  RY_P90 = 3,
  RY_MEAN = 4,
  RY_PROB_LOSS = 5,
  RY_MIN = 6,
  RY_MAX = 7,
  RY_RESULT_LEN = 8
};

enum {
  RY_OK = 0,
  RY_ERR_AMOUNT = 1,
  RY_ERR_RETURN = 2,
  RY_ERR_VOLATILITY = 3,
  RY_ERR_MONTHS = 4,
  RY_ERR_SIMULATIONS = 5,
  RY_ERR_MEMORY = 6
};

RY_EXPORT int rupeyantra_sip_monte_carlo(double monthly_amount, double annual_return_pct,
                                         double annual_volatility_pct, int months,
                                         int simulations, uint32_t seed);

RY_EXPORT const double* rupeyantra_result_ptr(void);
RY_EXPORT int rupeyantra_result_len(void);
RY_EXPORT int rupeyantra_version(void);

#ifdef __cplusplus
}
#endif

#endif
