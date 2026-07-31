# Changelog

## 0.1.0 — 2026-07-31

First release of **usturlab** — route every AI coding task to the best subscription you own.

### Routing engine
- User-defined rules (`.usturlab/rules.json`): keywords, file globs, languages, tags, prompt length; first match wins, per-rule failover chains
- `@provider:account/model` mentions bypass rules; `#tags` trigger tag rules
- Automatic failover on usage limits with per-provider cooldowns and stated reset times
- Real limit signals: Claude `rate_limit_event`, Codex/Gemini/Copilot message fingerprints; unsupported-model and rejected-resume runs self-heal instead of burning the chain

### Accounts & usage
- One-click onboarding per provider with auto-detected logins (no copy-paste); isolated profiles under `~/.usturlab/profiles`
- Multiple accounts per provider (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `HOME` override for Gemini); duplicate-identity guard
- Live usage: Claude 5h/weekly windows, Codex rate-limit snapshots read offline from session files, Copilot AI credits; identities (login e-mail) shown per account
- Env scrubbing so a stray `ANTHROPIC_API_KEY` etc. can never hijack subscription auth

### Chat
- Sidebar chat list (grouped by date) — conversations open as editor tabs, side-by-side runs supported, everything persists across restarts
- Mid-run messaging: injected live into running Claude sessions (stream-json stdin); queue or restart-and-merge strategies for other providers
- Slash commands on every model: Claude natives pass through, others get equivalent templates; custom commands via `.usturlab/commands.json`
- `@`/`#`/`/` autocomplete, brand-tinted reply blocks with official provider marks, finish notifications with durations

### Cross-provider platform
- MCP servers defined once (`.usturlab/mcp.json`) sync into every CLI's native config
- Shared project memory: all four providers read `AGENTS.md`
- Terminal mode: open any account's CLI interactively with the right environment

### Project
- pnpm monorepo: `@usturlab/core` (editor-agnostic engine, fully unit-tested) + VS Code extension (preact webviews)
- 57 automated tests + VS Code smoke suite; CI on macOS/Ubuntu; migration from the usrouter-era layout with zero re-login
