# `config/premium/` — EXPERIMENTAL, NON-FUNCTIONAL on OSS LanguageTool

> **Status: does NOT work on the OSS LanguageTool build. Kept as a research
> artifact only. NOT wired into `docker-compose.yml`.** For premium signalling
> that actually works, see "What works instead" below.

## Goal (that this directory tried, and failed, to achieve)

Make the OSS LanguageTool `/v2/check` endpoint emit `software.premium: true` and
per-match `rule.isPremium: true`, so LT-compatible clients that gate premium UI
on the response unlock against the self-hosted server (SPEC §6).

## Why it cannot work as a classpath shim (verified live, 2026-06-08)

LanguageTool's `RuleMatchesAsJsonSerializer` gates BOTH premium JSON fields on
`Premium.isPremiumVersion()`, which returns true iff `org.languagetool.PremiumOn`
exists on the classpath and instantiates. So the *idea* was: add a tiny
`PremiumOn extends Premium` shim (this dir's `PremiumOn.java`) to the LT image's
classpath, and `isPremiumRule()` returns true.

The shim compiles and loads, but **making `isPremiumVersion()` true sends LT down
its entire premium code path**, which the OSS jar cannot satisfy. On the live
your-server deploy the cascade was:

1. `PremiumOn` → LT needs `org.languagetool.server.DatabaseAccessPremium`
   (a premium-only class) — addable as a no-op stub.
2. `Languages.createLanguageObjects` switches to looking up `<Language>Premium`
   classes; the OSS build has **no** `English`/`German`/… premium language
   classes — would need ~20 no-op `*Premium` language stubs.
3. **The wall:** real OSS rule classes do strict identity checks —
   `AmericanEnglish.getInstance()` asserts `getName().equals("American English")`,
   `EnglishNumberInWordFilter` constructs the concrete `AmericanEnglish`, etc.
   A no-op `AmericanEnglishPremium` stub (needed by step 2) is NOT the instance
   those rule classes expect, so `Languages.get("en-US")` returns the wrong object
   and **rule loading throws** → `/v2/check` returns HTTP 500, no matches at all.

Satisfying step 3 means re-implementing LT's rule/filter classes — i.e. forking
and building LanguageTool from source, not a build-time shim. That is out of
scope (heavy, fragile across LT releases).

## What works instead (shipped)

- **Bridge REST `GET /health` returns `{"status":"ok","premium":true}`.** This is
  the premium signal GrammarForge's own clients (Vencord, OpenCode, and the
  `codextde/textchecker` browser-extension fork — all of which we control) gate
  on. They talk to the bridge directly and do not depend on LT's `/v2/check`
  premium fields.
- The bridge's gRPC `RemoteRule` response still sets `Rule.isPremium = true`
  (harmless, future-proof), but OSS `GRPCRule` ignores it.

## If you really want `/v2/check` premium

Build LanguageTool from source with `RuleMatchesAsJsonSerializer` patched to emit
`software.premium` / `rule.isPremium` unconditionally (bypassing
`Premium.isPremiumVersion()`), and use that image instead of `erikvl87/languagetool`.
Maintenance burden is on you across LT releases. Not done here.

## Files

- `PremiumOn.java` — the shim (compiles; insufficient alone, see above).
- `Dockerfile` — multi-stage build (JDK stage compiles the shim against the LT
  core jar; runtime stage adds it + patches `start.sh`'s `-cp`). Boots LT but
  breaks rule loading per the cascade above. **Do not wire into compose.**
