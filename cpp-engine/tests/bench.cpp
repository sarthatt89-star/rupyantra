// Native timing of the C++ engine (WASM speed is measured separately by tests/bench.js).
#include "finance.h"

#include <chrono>
#include <cstdio>

template <class F> static double ms(F f) {
  const auto t = std::chrono::steady_clock::now();
  f();
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
}

int main() {
  volatile int sink = 0;
  std::printf("native C++ (-O2)\n");
  std::printf("  SIP Monte Carlo 5000 sims x 120 months : %8.2f ms\n", ms([&] { sink += rupeyantra_sip_monte_carlo(10000, 12, 15, 120, 5000, 12345); }));
  std::printf("  SIP Monte Carlo 50000 sims x 240 months: %8.2f ms\n", ms([&] { sink += rupeyantra_sip_monte_carlo(10000, 12, 15, 240, 50000, 12345); }));
  std::printf("  EMI batch 10000 loans                  : %8.2f ms\n", ms([&] {
    double* in = rupeyantra_batch_in_ptr();
    for (int i = 0; i < 10000; i++) { in[i * 3] = 100000 + i; in[i * 3 + 1] = 9; in[i * 3 + 2] = 120; }
    sink += rupeyantra_emi_batch(10000);
  }));
  std::printf("  Prepayment (20y loan)                  : %8.4f ms\n", ms([&] { for (int i = 0; i < 1000; i++) sink += rupeyantra_loan_prepayment(5000000, 8.5, 240, 10000, 0, 0); }) / 1000);
  return sink < 0;
}
