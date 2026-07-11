## What / why

<!-- Brief description of the change and the problem it solves. -->

## Gates

- [ ] Bridge: golangci-lint + `go test -race -cover ./...`
- [ ] Browser: oxlint + tsc + vitest
- [ ] Vencord: oxlint + tsc + vitest
- [ ] OpenCode: oxlint + tsc + vitest
- [ ] Eval: ruff + pytest

## Breaking changes

- [ ] No
- [ ] Yes (describe below)

## Eval gate

If this PR touches the correction pipeline (fast path, escalation, LLM prompt,
repair chains, reject suppression, semantic verifier):

- [ ] `python eval/run_eval.py --require-exact` passes
- [ ] Clean-FP eval at or below baseline
