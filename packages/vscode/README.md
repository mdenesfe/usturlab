<img src="https://raw.githubusercontent.com/mdenesfe/usturlab/main/docs/media/hero.png" alt="usturlab" width="100%">

**Route every AI coding task to the best subscription you own.**

usturlab is an open-source VS Code extension for people who juggle multiple AI subscriptions — two Claude accounts, a ChatGPT plan for Codex, a Google AI subscription, GitHub Copilot. You register all of them once; usturlab then routes each task to the right account and model using **your own routing rules**, and **fails over automatically** when an account hits its usage limit.

<img src="https://raw.githubusercontent.com/mdenesfe/usturlab/main/docs/media/routing.png" alt="A prompt enters the router, which matches your rules and picks an account; when that account reports its limit the full prompt is re-sent to the next one in the chain." width="100%">

Subagents get their own lane, so a fan-out reads as a fan-out — and the cost line says `~$0.47` with a tilde, because that is what the run *would* have cost: on a subscription nobody was charged.

<img src="https://raw.githubusercontent.com/mdenesfe/usturlab/main/docs/media/ui-agents.png" alt="A run routed to the personal account: two agents in parallel, each lane showing its tool count, tokens and duration." width="100%">

## The UI

<img src="https://raw.githubusercontent.com/mdenesfe/usturlab/main/docs/media/ui-panel.png" alt="The usturlab panel: chat list on the left, an empty conversation in the editor, and a composer with one chip per registered account." width="100%">

Every account is a chip in the composer. When one reports its limit, its chip dims and the next in your chain picks the task up — the badge on the reply says which account actually ran it.

<img src="https://raw.githubusercontent.com/mdenesfe/usturlab/main/docs/media/ui-failover.png" alt="After the personal account hits its limit its chip is dimmed, the reply is badged work, and the status bar reads claude:work." width="100%">

Analytics separates what you were billed from what you weren't: `Would have cost` is the list price of work your subscriptions covered, and it is never added to money actually charged.

<img src="https://raw.githubusercontent.com/mdenesfe/usturlab/main/docs/media/ui-analytics.png" alt="Analytics: clean-run rate, task count, median duration, and a would-have-cost figure labelled as work the subscription covered." width="100%">

Claude-panel style, built for a developer environment:

- **Sidebar** — your chat list, grouped by date (Today / Yesterday / Last 7 days / Older). Running chats show a pulsing dot. Nothing is typed here; it's a clean index.
- **Chats open in the editor area** — one tab per conversation, centered column, monospace prompts, markdown + syntax-highlighted code blocks, a routing badge on every reply (`⤳ codex:work /gpt-5.4 [tests-to-codex]`), failover dividers when an account hits its limit mid-task. Two chats side-by-side run concurrently.
- **Accounts tab** — provider cards with status (`● ready` / `◌ limited · resets 18:30`), auth type, usage bars, add/remove.
- **Rules tab** — your routing rules visualized: match conditions as chips, failover chains as pill sequences. Edits to the JSON apply live.

Conversations persist across VS Code restarts, including native CLI session ids, so old chats keep their context.

## How it works

Consumer AI subscriptions can't be called directly over the API. usturlab therefore never touches provider APIs with subscription credentials — it **orchestrates the official CLIs** (`claude`, `codex`, `gemini`, `copilot`) as subprocesses, each authenticated with its own isolated profile:

| Provider | Multi-account isolation | Auth options |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`) or `CLAUDE_CONFIG_DIR` | subscription token, isolated profile, API key |
| Codex CLI | `CODEX_HOME` per profile | ChatGPT login, API key |
| Gemini CLI | `HOME` override per profile | Google login (paid tiers — see caveats), API key |
| Copilot CLI | `COPILOT_HOME` per profile | GitHub login, fine-grained PAT |

Secrets (tokens, API keys) live in the VS Code secret store. Profile directories live under `~/.usturlab/profiles/`. usturlab also scrubs hijacking env vars (e.g. a stray `ANTHROPIC_API_KEY` silently overrides Claude subscription auth) from every subprocess.

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

1. Click the usturlab icon in the activity bar → **Add account** (or `usturlab: Add Account` from the command palette). Each account gets an isolated profile, so two Claude accounts never collide.
2. Click **+ New chat** — the chat opens as an editor tab. Type your task; the routing badge shows which account/model was picked and why.
3. Open the **Rules** tab (or `usturlab: Routing Rules`) and create your rules file:

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

`usturlab: Open Session in Terminal` opens the chosen CLI **interactively** in a VS Code terminal with the right account's environment injected — for long agentic sessions where you want the CLI's own UI.

## Settings

| Setting | Default | Description |
|---|---|---|
| `usturlab.permissionMode` | `safe` | `safe` (read/plan), `edits` (auto-accept edits), `full` (skip approvals) |
| `usturlab.pollUsage` | `false` | Proactively poll quota (Claude 5h/weekly window, Copilot AI credits) |
| `usturlab.cliPath.*` | CLI name | Override binary paths |

## Commands

- `usturlab: Add Account` / `Remove Account` / `Manage Accounts`
- `usturlab: Routing Rules` / `Edit Routing Rules` (raw JSON)
- `usturlab: New Conversation`, `Open Chat`, `Cancel Running Task`
- `usturlab: Open Session in Terminal`
- `usturlab: Simulate Usage Limit (debug)` — test failover without burning quota

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

## Your accounts, and each provider's terms

usturlab drives each provider's own official CLI, authenticated with credentials you logged in yourself. It does not share, pool or resell accounts, and it never sends subscription credentials to a provider's API.

What it cannot do is know the terms of *your* plan. Those are set by each provider, differ between plans, and change. Registering several accounts and routing work between them is your decision under whatever agreement you hold with each of them — read those terms and stay inside them. Nothing here is legal advice, and the design described above is not a guarantee about any provider's rules.

One switch is worth choosing deliberately rather than inheriting: **quota polling reads undocumented usage endpoints, and is off by default.** The primary mechanism — reading the limit message the CLI itself prints mid-run — needs no such call, so leaving it off costs you very little.

## License, trademarks and attribution

MIT.

usturlab is an independent project. It is **not affiliated with, endorsed by, or sponsored by** Anthropic, OpenAI, Google, GitHub, Microsoft or OpenRouter. *Claude*, *Codex*, *ChatGPT*, *Gemini*, *Copilot* and their logos are trademarks of their respective owners, used here only to identify the services usturlab connects to.

Provider mark outlines in the UI come from [Simple Icons](https://github.com/simple-icons/simple-icons), released under CC0 1.0.
