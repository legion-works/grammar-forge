# Contributing

## Development setup

### Bridge (Go)

- **Go 1.26+** required.
- Build: `task bridge:build` or `cd bridge && go build -tags ORT ./cmd/grammarforge`.
- Native libraries (Harper CGo + ONNX Runtime) are fetched by `scripts/fetch-models.sh`.
- CI builds without `-tags ORT` use a stub fast path (consults only the LLM).

### Clients (TypeScript)

- **pnpm** required. Each client is a self-contained pnpm workspace:
  - `clients/browser/` — WXT browser extension (Chrome + Firefox)
  - `clients/vencord/` — Vencord plugin
  - `clients/opencode/` — OpenCode TUI plugin
- Per-client scripts: `pnpm install`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`.
- Browser extension: run `pnpm run prepare` before typecheck so `#imports` resolves.

### Eval harness (Python)

- **uv** (or venv + pip). Create venv: `cd eval && uv venv && uv pip install -r <(uv pip compile pyproject.toml)`.
- Run: `python -m pytest eval/` or `cd eval && ./run_all.sh`.

## Gates

These must pass before a PR is reviewed:

| Layer | Gate |
|---|---|
| Bridge | `cd bridge && golangci-lint run && go test -race -cover ./...` |
| Browser | `cd clients/browser && oxlint && pnpm run prepare && tsc --noEmit && vitest run` |
| Vencord | `cd clients/vencord && oxlint && tsc --noEmit && vitest run` |
| OpenCode | `cd clients/opencode && oxlint && tsc --noEmit && vitest run` |
| Eval | `cd eval && ruff format --check && ruff check && python -m pytest` |

### Golden-eval gate

Any change that touches the correction pipeline (fast path, escalation policy,
LLM prompt, repair chains, reject suppression, semantic verifier) must pass the
full cold golden eval **before merge**:

```bash
cd eval && python run_eval.py --require-exact
```

See `eval/README.md` for the complete protocol (CoNLL-14, BEA-19, JFLEG, clean-FP).

## Commits

**Conventional Commits are required.** The release automation (`release-please`)
parses the commit history for version bumps and changelog generation. Use one of:

```
feat: …       (minor bump)
fix: …        (patch bump)
docs: …       (no bump)
chore: …      (no bump)
refactor: …   (no bump)
test: …       (no bump)
ci: …         (no bump)
```

Breaking changes: append `!` after the type (`feat!: …`) or include
`BREAKING CHANGE:` in the body footer.

## Branch model

- **`dev`** — integration branch. Open PRs against `dev`.
- **`master`** — release-only. Updated by release-please via merge from `dev`.
- Feature branches fork from and rebase onto `dev`.

## Hooks

Install lefthook (one-liner):

```bash
lefthook install
```

Pre-commit runs: gitleaks, golangci-lint (bridge), oxlint + tsc (each TS client).
