# Changelog

All notable changes to GrammarForge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GHCR container image: `ghcr.io/legion-works/grammar-forge-bridge` published on every release.
- Bridge fast path: Harper (spelling/mechanics, ~10 ms) + GECToR-2024 (structural grammar, ONNX INT8, ~25 ms CPU) running in-process, with a per-sentence LRU cache and concurrent corrector execution.
- Bridge slow path: LLM escalation for low-confidence sentences, speaking the OpenAI-compatible API with configurable backend (llama.cpp default; vLLM, Ollama, LM Studio, remote supported). GRMR-native and chat-instruct prompt formats supported.
- LanguageTool compatibility: native `POST /v2/check` + `GET /v2/languages`, including UTF-16 code-unit offset conversion and `software.premium` surface.
- REST endpoints: `/correct`, `/rephrase`, `/tone`, `/complete`, `/synonyms`, `/signal`, `/health`, `/stats`.
- gRPC `RemoteRule` server for optional real-LT compose profile federation.
- Browser extension (WXT MV3, Chrome + Firefox): in-page overlay, popover, rephrase card, synonyms, stats, per-category highlights.
- Vencord plugin: Discord composer underlines, popover with apply + dictionary, Ctrl+. hotkey, rephrase, chat-bar button with hover pill.
- OpenCode TUI plugin: floating review card, inline completion ghost, per-suggestion category palette.
- Eval harness: 125-case cold golden set (`run_eval.py --require-exact`), CoNLL-14, BEA-19, JFLEG benchmarks via ERRANT scoring, clean-text false-positive gate against a 155-sentence corpus, MiniLM semantic-verifier calibration with Python↔Go equivalence probe.
- Personalisation: per-user reject suppression from the signal log, loaded via TTL-cached stale-while-revalidate snapshot.
- Dialect guard: VarCon-derived British/Canadian/Australian lexicon stops the LLM from "fixing" spelling of `colour`, `centre`, etc.
- Confidence calibration: per-bin ECE scoring on `/correct` confidence values with machine-enforceable eval gates.
- LLM retry with jittered backoff + consecutive-failure circuit breaker (per-backend, with metrics surface).
- Offline thesaurus (Moby Thesaurus II) backing `GET /synonyms`.
- User dictionary with hot-reload watcher, wired into Harper's merged-dict and LLM re-flag suppression.
- SQLite signal log (pure-Go `modernc.org/sqlite`) for correction events, edit-level tracking, and stats.
