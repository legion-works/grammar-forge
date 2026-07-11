# Security

## Supported version

The latest commit on `master` — this is a self-hosted single-user tool, not a
continuously-released SaaS. Only the current release is in scope for advisories.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting**:

1. Go to the **Security** tab → **Report a vulnerability**.
2. Describe the issue with steps to reproduce. Include bridge version and
   deployment details (Docker / bare-metal, GPU / CPU, LLM backend).
3. Do **not** open a public issue for security vulnerabilities.

**Response window:** best-effort, target 7 days for acknowledgement. This is a
one-maintainer project — response time scales with severity.

## Scope

The bridge binds `localhost` (and optionally LAN) by design. It has no
authentication layer — that is deliberate for a single-user local tool. If you
expose the bridge to an untrusted network, you are operating outside the
security model. See the README threat model for context.

Reports about the following are in scope:

- Remote code execution via the correction / rephrase / completion / signal
  endpoints.
- Information disclosure (leaking configured API keys, correction text, or the
  signal log to unintended consumers).
- Container escape from the Docker Compose deployment.

The following are out of scope:

- LAN-side access by a user already on the same machine / network — the bridge
  is an unprotected local service by design.
- Attacks requiring physical access to the host.
- LLM prompt injection (text sent to the LLM is user-supplied; the LLM backend
  is user-managed).
