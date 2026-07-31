# usrouter

**Route every AI coding task to the best subscription you own.**

usrouter is an open-source VS Code extension for people who juggle multiple AI subscriptions — two Claude accounts, a ChatGPT plan for Codex, a Google AI subscription, GitHub Copilot. You register all of them once; usrouter then routes each task to the right account and model using **your own routing rules**, and **fails over automatically** when an account hits its usage limit.

```
            ┌──────────────────────────────┐
  task ───▶ │  router (your rules.json)    │
            │  tests → codex:work          │
            │  quick Qs → claude/haiku     │
            │  default → claude:personal   │
            └──────────┬───────────────────┘
                       ▼
        ┌──────────────┼──────────────┬─────────────┐
        ▼              ▼              ▼             ▼
   claude:personal claude:work    codex:work   gemini:main
   (Pro)           (Max)          (ChatGPT)    (AI Pro)
        │  limit hit → automatic failover to next in chain
        └──────────────▶ ...
```

## The UI

Claude-panel style, built for a developer environment:

- **Sidebar** — your chat list, grouped by date (Today / Yesterday / Last 7 days / Older). Running chats show a pulsing dot. Nothing is typed here; it's a clean index.
- **Chats open in the editor area** — one tab per conversation, centered column, monospace prompts, markdown + syntax-highlighted code blocks, a routing badge on every reply (`⤳ codex:work /gpt-5.4 [tests-to-codex]`), failover dividers when an account hits its limit mid-task. Two chats side-by-side run concurrently.
- **Accounts tab** — provider cards with status (`● ready` / `◌ limited · resets 18:30`), auth type, usage bars, add/remove.
- **Rules tab** — your routing rules visualized: match conditions as chips, failover chains as pill sequences. Edits to the JSON apply live.

Conversations persist across VS Code restarts, including native CLI session ids, so old chats keep their context.

## How it works (and why it's ToS-friendly)

Consumer AI subscriptions can't be called directly over the API. usrouter therefore never touches provider APIs with subscription credentials — it **orchestrates the official CLIs** (`claude`, `codex`, `gemini`, `copilot`) as subprocesses, each authenticated with its own isolated profile:

| Provider | Multi-account isolation | Auth options |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`) or `CLAUDE_CONFIG_DIR` | subscription token, isolated profile, API key |
| Codex CLI | `CODEX_HOME` per profile | ChatGPT login, API key |
| Gemini CLI | `HOME` override per profile | Google login (paid tiers — see caveats), API key |
| Copilot CLI | `COPILOT_HOME` per profile | GitHub login, fine-grained PAT |

Secrets (tokens, API keys) live in the VS Code secret store. Profile directories live under `~/.usrouter/profiles/`. usrouter also scrubs hijacking env vars (e.g. a stray `ANTHROPIC_API_KEY` silently overrides Claude subscription auth) from every subprocess.

**Adding an account is one authorize click**: the wizard opens a login terminal per account and detects completion automatically — by watching for the auth file (Codex/Gemini), polling `claude auth status`, or capturing the token straight from terminal output (Claude `setup-token`). No copy-pasting.

**Limit detection is first-class**: Claude's stream emits `rate_limit_event` with the exact reset time; Codex/Gemini/Copilot limit messages are fingerprinted in [limits.ts](packages/core/src/adapters/limits.ts). On a limit, the full original prompt is re-sent to the next account in the chain and the account goes on cooldown until its stated reset.

## Requirements

- VS Code 1.95+
- The CLIs for the providers you want to use, installed and on `PATH`:
  - [Claude Code](https://code.claude.com/docs) — `claude`
  - [Codex CLI](https://developers.openai.com/codex) — `codex`
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini`
  - [Copilot CLI](https://github.com/github/copilot-cli) — `copilot` (`npm i -g @github/copilot`)

## Quick start

1. Click the usrouter icon in the activity bar → **Add account** (or `usrouter: Add Account` from the command palette). Each account gets an isolated profile, so two Claude accounts never collide.
2. Click **+ New chat** — the chat opens as an editor tab. Type your task; the routing badge shows which account/model was picked and why.
3. Open the **Rules** tab (or `usrouter: Routing Rules`) and create your rules file:

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "tests-to-codex",
      "match": { "keywords": ["test", "spec"], "globs": ["**/*.test.*"] },
      "target": [
        { "provider": "codex", "account": "work" },
        { "provider": "claude", "account": "personal", "model": "sonnet" }
      ]
    },
    {
      "id": "quick-questions",
      "match": { "keywords": ["what is", "explain"], "maxPromptChars": 400 },
      "target": [{ "provider": "claude", "account": "personal", "model": "haiku" }]
    }
  ],
  "defaultChain": [
    { "provider": "claude", "account": "personal", "model": "sonnet" },
    { "provider": "gemini", "account": "main" }
  ]
}
```

### Routing semantics

- `@provider:account/model` mentions in the prompt (e.g. `@claude:work/opus`) bypass rules entirely.
- Rules are evaluated in order; **first match wins**. Within a rule's `match`, fields are AND-ed and values within a field are OR-ed.
- Failover order: the matched rule's `target` chain, then `defaultChain` entries not yet tried.
- Accounts on cooldown (recently limited) are skipped at routing time.
- `#hashtags` in the prompt become tags for `match.tags` rules.

### Terminal mode

`usrouter: Open Session in Terminal` opens the chosen CLI **interactively** in a VS Code terminal with the right account's environment injected — for long agentic sessions where you want the CLI's own UI.

## Settings

| Setting | Default | Description |
|---|---|---|
| `usrouter.permissionMode` | `safe` | `safe` (read/plan), `edits` (auto-accept edits), `full` (skip approvals) |
| `usrouter.pollUsage` | `false` | Proactively poll quota (Claude 5h/weekly window, Copilot AI credits) |
| `usrouter.cliPath.*` | CLI name | Override binary paths |

## Commands

- `usrouter: Add Account` / `Remove Account` / `Manage Accounts`
- `usrouter: Routing Rules` / `Edit Routing Rules` (raw JSON)
- `usrouter: New Conversation`, `Open Chat`, `Cancel Running Task`
- `usrouter: Open Session in Terminal`
- `usrouter: Simulate Usage Limit (debug)` — test failover without burning quota

## Development

```bash
pnpm install
pnpm build        # core typecheck + extension bundle (esbuild)
pnpm test         # core unit tests (vitest)
```

Open the repo in VS Code and press **F5** to launch the Extension Development Host.

### Architecture

- `packages/core` — editor-agnostic engine: rule matcher/router, orchestrator with failover, quota tracker, per-provider CLI adapters (spawn + stream parsing + limit detection). No `vscode` imports; fully unit-tested.
- `packages/vscode` — the extension: account onboarding with auto-detected logins, secret storage, sidebar chat list, chat/accounts/rules editor tabs (preact), terminal mode.

Limit-message fingerprints live in `packages/core/src/adapters/limits.ts` — when a CLI changes its copy, that's the only file to touch.

## Caveats

- **Gemini free tier**: as of mid-2026 Gemini CLI rejects free individual Google accounts (`IneligibleTierError` pointing to Antigravity). A paid Google AI subscription or a `GEMINI_API_KEY` is required.
- Gemini multi-account uses a `HOME` override (no official config-dir env var yet) — experimental on Windows.
- Copilot CLI's programmatic mode is plain text; tool activity is not itemized.
- Quota polling uses undocumented endpoints and is off by default; passive detection (parsing the CLI's limit message mid-run) is the primary mechanism.

## License

MIT
