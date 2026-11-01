// Tiny command-line wrapper used only by the C++ vs JS comparison test (never shipped to the website).
// stdin: one command per line.  stdout: "ok v1 v2 ..." or "err <code>".
#include "finance.h"

#include <cstdio>
#include <cstring>

static void out(int rc) {
  if (rc != RY_OK) { std::printf("err %d\n", rc); return; }
  const double* r = rupeyantra_result_ptr();
  std::printf("ok");
  for (int i = 0; i < rupeyantra_result_len(); i++) std::printf(" %.12g", r[i]);
  std::printf("\n");
}

int main() {
  char cmd[32];
  double a, b, c, d, e, f;
  int m;
  while (std::scanf("%31s", cmd) == 1) {
    if (!std::strcmp(cmd, "emi") && std::scanf("%lf %lf %d", &a, &b, &m) == 3) out(rupeyantra_emi(a, b, m));
    else if (!std::strcmp(cmd, "sched") && std::scanf("%lf %lf %d", &a, &b, &m) == 3) out(rupeyantra_emi_schedule_yearly(a, b, m));
    else if (!std::strcmp(cmd, "sip") && std::scanf("%lf %lf %d", &a, &b, &m) == 3) out(rupeyantra_sip(a, b, m));
    else if (!std::strcmp(cmd, "lump") && std::scanf("%lf %lf %lf %d", &a, &b, &c, &m) == 4) out(rupeyantra_lumpsum(a, b, c, m));
    else if (!std::strcmp(cmd, "cagr") && std::scanf("%lf %lf %lf", &a, &b, &c) == 3) out(rupeyantra_cagr(a, b, c));
    else if (!std::strcmp(cmd, "infl") && std::scanf("%lf %lf %lf", &a, &b, &c) == 3) out(rupeyantra_inflation(a, b, c));
    else if (!std::strcmp(cmd, "prepay") && std::scanf("%lf %lf %d %lf %lf %lf", &a, &b, &m, &c, &d, &e) == 6) out(rupeyantra_loan_prepayment(a, b, m, c, d, (int)e));
    else if (!std::strcmp(cmd, "sweep") && std::scanf("%lf %d %lf %lf %lf", &a, &m, &b, &c, &d) == 5) out(rupeyantra_emi_rate_sweep(a, m, b, c, d));
    else { std::printf("err -1\n"); return 1; }
  }
  (void)f;
  return 0;
}
