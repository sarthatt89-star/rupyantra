// Native tests for loans, investments, simulations (extra) and the tax slab engine.
// Expected values were computed independently (plain Python loops / hand maths).
#include "finance.h"

#include <cmath>
#include <cstdio>

static int failures = 0;

#define CHECK(cond, msg)                      \
  do {                                        \
    if (!(cond)) {                            \
      std::printf("FAIL: %s\n", msg);         \
      failures++;                             \
    } else {                                  \
      std::printf("ok:   %s\n", msg);         \
    }                                         \
  } while (0)

static bool near(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

int main() {
  const double* r = rupeyantra_result_ptr();

  /* ---------- EMI ---------- */
  CHECK(rupeyantra_emi(5000000, 8.5, 240) == RY_OK, "emi call ok");
  CHECK(near(r[RY_EMI_EMI], 43391.16167, 0.001), "emi 50L 8.5% 20y = 43391.16");
  CHECK(near(r[RY_EMI_TOTAL], 10413878.80, 0.05), "emi total payment");
  CHECK(near(r[RY_EMI_INTEREST], 5413878.80, 0.05), "emi total interest");
  CHECK(rupeyantra_result_len() == 4, "emi result length 4");

  CHECK(rupeyantra_emi(120000, 0, 12) == RY_OK && near(r[RY_EMI_EMI], 10000.0, 1e-9), "emi zero rate = P/n");
  CHECK(rupeyantra_emi(1200000, 1e-9, 120) == RY_OK && near(r[RY_EMI_EMI], 10000.0, 1e-3), "emi tiny rate stays stable");
  CHECK(rupeyantra_emi(1000000, 10, 60) == RY_OK && near(r[RY_EMI_EMI], 21247.0447, 0.001), "emi 10L 10% 5y");
  CHECK(rupeyantra_emi(-1, 8, 12) == RY_ERR_AMOUNT, "emi negative principal rejected");
  CHECK(rupeyantra_emi(1000, 101, 12) == RY_ERR_RATE, "emi rate 101 rejected");
  CHECK(rupeyantra_emi(1000, 8, 0) == RY_ERR_MONTHS, "emi 0 months rejected");
  CHECK(rupeyantra_emi(1000, NAN, 12) == RY_ERR_RATE, "emi NaN rate rejected");

  /* ---------- yearly schedule ---------- */
  CHECK(rupeyantra_emi_schedule_yearly(5000000, 8.5, 240) == RY_OK, "schedule call ok");
  {
    int rows = (int)r[0];
    double sum_p = 0, sum_i = 0;
    for (int y = 0; y < rows; y++) {
      sum_p += r[1 + y * RY_SCHED_COLS + 2];
      sum_i += r[1 + y * RY_SCHED_COLS + 3];
    }
    CHECK(rows == 20, "schedule has 20 yearly rows");
    CHECK(near(sum_p, 5000000, 0.01), "schedule principal adds up to loan amount");
    CHECK(near(sum_i, 5413878.80, 0.05), "schedule interest adds up to total interest");
    CHECK(near(r[1 + 19 * RY_SCHED_COLS + 4], 0.0, 0.01), "schedule closes at zero");
    CHECK(near(r[1 + 0 * RY_SCHED_COLS + 1], 5000000, 1e-9), "schedule opens at principal");
  }
  CHECK(rupeyantra_emi_schedule_yearly(100000, 10, 18) == RY_OK && (int)r[0] == 2, "18 months => 2 rows");

  /* ---------- prepayment ---------- */
  CHECK(rupeyantra_loan_prepayment(5000000, 8.5, 240, 10000, 0, 0) == RY_OK, "prepay extra monthly ok");
  CHECK((int)r[RY_PP_NEW_MONTHS] == 155, "extra 10,000/month => 155 months");
  CHECK(near(r[RY_PP_NEW_INTEREST], 3235157.58, 0.5), "extra 10,000/month => interest 32,35,158");
  CHECK(near(r[RY_PP_INTEREST_SAVED], 2178721.22, 0.5), "extra 10,000/month => interest saved");
  CHECK((int)r[RY_PP_MONTHS_SAVED] == 85, "extra 10,000/month => 85 months saved");

  CHECK(rupeyantra_loan_prepayment(5000000, 8.5, 240, 0, 500000, 12) == RY_OK, "prepay lump sum ok");
  CHECK((int)r[RY_PP_NEW_MONTHS] == 192, "lump 5L after 12 months => 192 months");
  CHECK(near(r[RY_PP_INTEREST_SAVED], 1603690.73, 0.5), "lump 5L => interest saved");

  CHECK(rupeyantra_loan_prepayment(5000000, 8.5, 240, 10000, 500000, 12) == RY_OK, "prepay both ok");
  CHECK((int)r[RY_PP_NEW_MONTHS] == 131, "both => 131 months");
  CHECK(near(r[RY_PP_TOTAL_PAID], 7476532.67, 0.5), "both => total paid");

  CHECK(rupeyantra_loan_prepayment(5000000, 8.5, 240, 0, 0, 0) == RY_OK && (int)r[RY_PP_NEW_MONTHS] == 240 &&
        near(r[RY_PP_INTEREST_SAVED], 0.0, 0.01), "no prepayment => nothing changes");
  CHECK(rupeyantra_loan_prepayment(100000, 10, 12, 1e9, 0, 0) == RY_OK && (int)r[RY_PP_NEW_MONTHS] == 1, "huge extra closes loan in month 1");
  CHECK(rupeyantra_loan_prepayment(1000, 8, 12, 0, 500, 13) == RY_ERR_PREPAY, "lump month beyond tenure rejected");
  CHECK(rupeyantra_loan_prepayment(1000, 8, 12, -5, 0, 0) == RY_ERR_PREPAY, "negative extra rejected");

  /* ---------- rate sweep ---------- */
  CHECK(rupeyantra_emi_rate_sweep(5000000, 240, 7, 10, 1) == RY_OK && (int)r[0] == 4, "sweep 7..10 step 1 => 4 rows");
  CHECK(near(r[1 + 0 * RY_SWEEP_COLS + 1], 38764.9468, 0.001), "sweep 7% emi");
  CHECK(near(r[1 + 3 * RY_SWEEP_COLS + 1], 48251.0823, 0.001), "sweep 10% emi");
  CHECK(near(r[1 + 1 * RY_SWEEP_COLS + 0], 8.0, 1e-12), "sweep row rate = 8");
  CHECK(rupeyantra_emi_rate_sweep(5000000, 240, 10, 7, 1) == RY_ERR_RANGE, "sweep from > to rejected");
  CHECK(rupeyantra_emi_rate_sweep(5000000, 240, 0, 100, 0.01) == RY_ERR_RANGE, "sweep too many rows rejected");
  CHECK(rupeyantra_emi_rate_sweep(5000000, 240, 7, 7, 1) == RY_OK && (int)r[0] == 1, "sweep single rate");

  /* ---------- batch ---------- */
  {
    double* in = rupeyantra_batch_in_ptr();
    const double* out = rupeyantra_batch_out_ptr();
    in[0] = 5000000; in[1] = 8.5; in[2] = 240;
    in[3] = 1000000; in[4] = 10;  in[5] = 60;
    in[6] = -5;      in[7] = 10;  in[8] = 60;   /* invalid */
    CHECK(rupeyantra_emi_batch(3) == RY_OK, "batch ok");
    CHECK((int)r[0] == 1 && (int)r[1] == 3, "batch: 1 invalid row out of 3");
    CHECK(near(out[0], 43391.16167, 0.001) && near(out[2], 21247.0447, 0.001), "batch emis correct");
    CHECK(out[4] == 0.0 && out[5] == 0.0, "batch invalid row gives zeros");
    CHECK(rupeyantra_emi_batch(0) == RY_ERR_BATCH && rupeyantra_emi_batch(RY_BATCH_MAX + 1) == RY_ERR_BATCH, "batch count limits");
    for (int i = 0; i < RY_BATCH_MAX; i++) { in[i * 3] = 100000 + i; in[i * 3 + 1] = 9; in[i * 3 + 2] = 120; }
    CHECK(rupeyantra_emi_batch(RY_BATCH_MAX) == RY_OK && (int)r[0] == 0, "batch of 10,000 loans ok");
  }

  /* ---------- investments ---------- */
  CHECK(rupeyantra_sip(10000, 12, 120) == RY_OK, "sip ok");
  CHECK(near(r[RY_SIP_INVESTED], 1200000, 1e-9) && near(r[RY_SIP_FV], 2323390.7635, 0.01) &&
        near(r[RY_SIP_GAIN], 1123390.7635, 0.01), "sip 10,000 x 10y @12% known answer");
  CHECK(rupeyantra_sip(5000, 0, 24) == RY_OK && near(r[RY_SIP_FV], 120000, 1e-9), "sip zero return = invested");
  CHECK(rupeyantra_sip(5000, -60, 24) == RY_ERR_RETURN, "sip return -60 rejected");

  CHECK(rupeyantra_lumpsum(100000, 7, 5, 4) == RY_OK && near(r[RY_LUMP_MATURITY], 141477.8196, 0.01) &&
        near(r[RY_LUMP_INTEREST], 41477.8196, 0.01), "lumpsum 1L 7% 5y quarterly");
  CHECK(rupeyantra_lumpsum(100000, 8, 3, 12) == RY_OK && near(r[RY_LUMP_MATURITY], 127023.7052, 0.01), "lumpsum monthly compounding");
  CHECK(rupeyantra_lumpsum(100000, 8, 3, 0) == RY_ERR_COMPOUNDING, "lumpsum 0 compounding rejected");

  CHECK(rupeyantra_cagr(100000, 200000, 5) == RY_OK && near(r[RY_CAGR_PERCENT], 14.8698355, 1e-6), "cagr doubling in 5y");
  CHECK(rupeyantra_cagr(100000, 50000, 5) == RY_OK && r[RY_CAGR_PERCENT] < 0, "cagr negative when value falls");
  CHECK(rupeyantra_cagr(0, 100, 5) == RY_ERR_AMOUNT, "cagr zero start rejected");

  CHECK(rupeyantra_inflation(100000, 6, 10) == RY_OK && near(r[RY_INFL_FUTURE], 179084.7697, 0.01) &&
        near(r[RY_INFL_EXTRA], 79084.7697, 0.01) && near(r[RY_INFL_REAL_VALUE], 55839.4777, 0.01), "inflation 1L 6% 10y");
  CHECK(rupeyantra_real_return(12, 6) == RY_OK && near(r[RY_REAL_PERCENT], 5.6603774, 1e-6), "real return 12% vs 6% inflation");

  /* ---------- extra simulations ---------- */
  CHECK(rupeyantra_lumpsum_monte_carlo(100000, 7, 0, 60, 4, 1000, 1) == RY_OK &&
        near(r[RY_P50], 141477.8196, 0.01), "lumpsum MC zero vol equals lumpsum formula");
  CHECK(rupeyantra_lumpsum_monte_carlo(100000, 7, 18, 60, 4, 20000, 9) == RY_OK &&
        r[RY_P10] < r[RY_P50] && r[RY_P50] < r[RY_P90] && near(r[RY_MEAN], 141477.8, 141477.8 * 0.02),
        "lumpsum MC spread and mean ~ deterministic");
  CHECK(rupeyantra_lumpsum_monte_carlo(100000, 7, 18, 60, 0, 1000, 9) == RY_ERR_COMPOUNDING, "lumpsum MC bad compounding rejected");

  CHECK(rupeyantra_sip_goal_probability(10000, 12, 0, 120, 2000000, 1000, 1) == RY_OK && near(r[RY_GOAL_PROB], 100.0, 1e-9),
        "goal below final value => 100%");
  CHECK(rupeyantra_sip_goal_probability(10000, 12, 0, 120, 3000000, 1000, 1) == RY_OK && near(r[RY_GOAL_PROB], 0.0, 1e-9),
        "goal above final value => 0%");
  {
    rupeyantra_sip_goal_probability(10000, 12, 15, 120, 2000000, 20000, 5);
    double p_low = r[RY_GOAL_PROB];
    rupeyantra_sip_goal_probability(10000, 12, 15, 120, 3000000, 20000, 5);
    double p_high = r[RY_GOAL_PROB];
    CHECK(p_low > p_high && p_low > 0 && p_low < 100 && p_high > 0 && p_high < 100, "goal probability falls as target rises");
  }
  CHECK(rupeyantra_sip_goal_probability(10000, 12, 15, 120, -5, 1000, 1) == RY_ERR_AMOUNT, "goal negative target rejected");

  /* ---------- tax slab engine (synthetic slabs, logic only) ---------- */
  {
    double* in = rupeyantra_input_ptr();
    auto reset = [&]() {
      for (int i = 0; i < RY_INPUT_LEN; i++) in[i] = 0;
      in[RY_TAXIN_SLABS] = 3;
      in[RY_TAXIN_SLAB0 + 0] = 1000; in[RY_TAXIN_SLAB0 + 1] = 0;
      in[RY_TAXIN_SLAB0 + 2] = 2000; in[RY_TAXIN_SLAB0 + 3] = 10;
      in[RY_TAXIN_SLAB0 + 4] = 0;    in[RY_TAXIN_SLAB0 + 5] = 20; /* last slab: unlimited */
    };

    reset(); in[RY_TAXIN_INCOME] = 500;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_TOTAL], 0, 1e-9), "tax: income in nil slab => 0");
    reset(); in[RY_TAXIN_INCOME] = 3000;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_SLAB], 300, 1e-9) && near(r[RY_TAXOUT_TOTAL], 300, 1e-9),
          "tax: 3000 => 100 + 200 = 300");
    CHECK(near(r[RY_TAXOUT_EFFECTIVE], 10.0, 1e-9) && near(r[RY_TAXOUT_MONTHLY], 25.0, 1e-9), "tax: effective 10% and monthly 25");

    reset(); in[RY_TAXIN_INCOME] = 3000; in[RY_TAXIN_CESS] = 4;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_CESS], 12, 1e-9) && near(r[RY_TAXOUT_TOTAL], 312, 1e-9), "tax: 4% cess");
    CHECK(near(r[RY_TAXOUT_ROUNDED], 310, 1e-9), "tax: rounded to nearest 10");

    /* rebate: limit 2000, max 100, marginal relief on */
    reset(); in[RY_TAXIN_REBATE_LIMIT] = 2000; in[RY_TAXIN_REBATE_MAX] = 100; in[RY_TAXIN_REBATE_RELIEF] = 1;
    in[RY_TAXIN_INCOME] = 2000;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_TOTAL], 0, 1e-9), "tax: rebate wipes tax at the limit");
    in[RY_TAXIN_INCOME] = 2100;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_TOTAL], 100, 1e-9) && near(r[RY_TAXOUT_REBATE], 20, 1e-9),
          "tax: marginal relief caps tax at income above the limit");
    in[RY_TAXIN_INCOME] = 2200;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_TOTAL], 140, 1e-9), "tax: no relief once tax < excess income");
    in[RY_TAXIN_REBATE_RELIEF] = 0; in[RY_TAXIN_INCOME] = 2100;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_TOTAL], 120, 1e-9), "tax: no relief when flag is off");

    /* surcharge tiers (10000 -> 10%, 20000 -> 15%) with marginal relief, cess 4% */
    reset(); in[RY_TAXIN_SURCH_COUNT] = 2;
    in[RY_TAXIN_SURCH0 + 0] = 10000; in[RY_TAXIN_SURCH0 + 1] = 10;
    in[RY_TAXIN_SURCH0 + 2] = 20000; in[RY_TAXIN_SURCH0 + 3] = 15;
    in[RY_TAXIN_CESS] = 4;
    in[RY_TAXIN_INCOME] = 10000;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_SURCHARGE], 0, 1e-9), "surcharge: none exactly at the threshold");
    in[RY_TAXIN_INCOME] = 12000;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_SURCHARGE], 210, 1e-9) && near(r[RY_TAXOUT_TOTAL], 2100 + 210 + 92.4, 1e-9),
          "surcharge: 10% tier, no relief needed");
    in[RY_TAXIN_INCOME] = 10100;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_SURCHARGE], 80, 1e-9) && near(r[RY_TAXOUT_TOTAL], 1872, 1e-9),
          "surcharge: marginal relief just above threshold");
    in[RY_TAXIN_INCOME] = 25000;
    CHECK(rupeyantra_tax_compute() == RY_OK && near(r[RY_TAXOUT_SURCHARGE], 705, 1e-9) && near(r[RY_TAXOUT_TOTAL], 5621.2, 1e-9),
          "surcharge: 15% tier");

    /* invalid rule sets are rejected */
    reset(); in[RY_TAXIN_INCOME] = -1;
    CHECK(rupeyantra_tax_compute() == RY_ERR_TAX, "tax: negative income rejected");
    reset(); in[RY_TAXIN_INCOME] = 100; in[RY_TAXIN_SLABS] = 0;
    CHECK(rupeyantra_tax_compute() == RY_ERR_TAX, "tax: zero slabs rejected");
    reset(); in[RY_TAXIN_INCOME] = 100; in[RY_TAXIN_SLAB0 + 2] = 500;
    CHECK(rupeyantra_tax_compute() == RY_ERR_TAX, "tax: slab limits must ascend");
    reset(); in[RY_TAXIN_INCOME] = 100; in[RY_TAXIN_SLAB0 + 1] = 150;
    CHECK(rupeyantra_tax_compute() == RY_ERR_TAX, "tax: rate above 100 rejected");
    reset(); in[RY_TAXIN_INCOME] = 100; in[RY_TAXIN_CESS] = NAN;
    CHECK(rupeyantra_tax_compute() == RY_ERR_TAX, "tax: NaN cess rejected");
    CHECK(rupeyantra_result_len() == 0 && r[RY_TAXOUT_TOTAL] == 0.0, "tax: failed call leaves no result");
  }

  CHECK(rupeyantra_version() == 2, "version is 2");

  std::printf(failures ? "\n%d test(s) FAILED\n" : "\nall core tests passed\n", failures);
  return failures ? 1 : 0;
}
