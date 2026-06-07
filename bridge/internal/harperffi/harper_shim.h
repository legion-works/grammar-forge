#ifndef GF_HARPER_SHIM_H
#define GF_HARPER_SHIM_H
#include "harper.h"

static inline Lint* gf_lint_at(Lint** arr, int32_t i) { return arr[i]; }
#endif
