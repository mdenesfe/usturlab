# usturlab

**Route every AI coding task to the best subscription you own — and make every model behave like the best one.**

usturlab is an open-source VS Code extension for people who juggle multiple AI subscriptions — two Claude accounts, a ChatGPT plan for Codex, a Google AI subscription, GitHub Copilot. You register all of them once; usturlab then routes each task to the right account and model using **your own routing rules**, and **fails over automatically** when an account hits its usage limit.

It does not stop at picking who runs the task. Every provider is given the context it would otherwise lack, held to the same standing instructions through its own system-prompt channel, and — for hard work — checked by a *different* model before you rely on the answer.

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

## Making every model smarter

A model's output quality is a function of the context it gets, the constraints it is held to, and whether anyone checks its work. Routing alone touches none of those.

**It knows what you know.** Each run carries a task brief: the file you have open with your selection and its line range, the branch and uncommitted changes, and the project's convention files — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md` — normalized so every provider gets them. Nothing is sent twice: Claude already loads `CLAUDE.md` and Codex `AGENTS.md`, so their briefs carry only what they cannot know.

**Every request gets the framing it is missing.** Before a run starts, the brief adds only what your prompt did not already cover: the exact check that will be run against it afterwards (`pnpm run typecheck && pnpm run test` — this repo's own, never invented), reproducing a failure before fixing it when a bug report has no output in it, naming files before editing them when nothing anchors the work, and staying inside the scope you asked for on heavy changes. Never more than three lines, never a rewrite of what you typed — instructions that get ignored are worse than instructions never sent.

**Every CLI gets the instructions it is missing**, through its own real channel — Claude `--append-system-prompt`, Codex `developerInstructions`, and for the ACP agents, which have no system slot, the session's first prompt, restated only when it changes. The content is compensation for what each CLI does not do by default, so Claude's list is the shortest.

**The work gets checked.** After a run changes files, the project's *own* typecheck/test script runs and, on failure, the model gets one repair round with the real output. Commands are never invented — only what `package.json` or a `Makefile` declares — and nothing runs in Plan mode.

**A different model looks for what the checks cannot see.** On hard work a different provider reviews the diff adversarially, told that finding nothing (`LGTM`) is a valid answer. Different labs have different blind spots; that is the whole reason to own several subscriptions. Connect a free [OpenRouter](#how-it-works-and-why-its-tos-friendly) account and the review runs on an open-weight model instead, so checking the work costs no quota at all.

**It says when a chat has turned against itself.** Two corrections, or checks left red twice, and the thread is now feeding the model its own failed attempts every turn. usturlab says so once and suggests a fresh chat — length alone is never the trigger, only evidence of circling.

**It learns.** Auto routing calibrates each account from your own clean-run rate — runs you did not have to steer, retry, or escalate — keyed by weight class so a scrappy run on the cheap model is not held against the expensive one, and on light work a measurably faster account wins. It estimates how much of a quota window a task will burn before choosing. Corrections you type mid-run are collected, and a recurring one is *offered* (never silently applied) as a standing rule every provider inherits.

## The UI

Claude-panel style, built for a developer environment:

- **Sidebar** — your chat list, grouped by date (Today / Yesterday / Last 7 days / Older). Running chats show a pulsing dot. Nothing is typed here; it's a clean index.
- **Chats open in the editor area** — one tab per conversation, centered column, monospace prompts, markdown + syntax-highlighted code blocks, a routing badge on every reply (`⤳ codex:work /gpt-5.4 [tests-to-codex]`), failover dividers when an account hits its limit mid-task. Two chats side-by-side run concurrently.
- **Parallel agents get lanes.** When a model splits the work across subagents, each one is its own lane — its tool calls, what it is doing right now, its token spend, and what it reported back. Agents whose lifetimes overlap share one block under a single trunk, so concurrency is visible as concurrency; when they finish, each lane keeps a duration bar proportional to the slowest, so you can see which part of the work was expensive.
- **The run never scrolls away.** A bar above the composer holds the elapsed time and the current activity — `thinking`, the file being edited, how many agents are working, or `waiting for you` when the model is blocked on a permission question. Live tool activity expands itself while it happens and collapses when it's done. Scroll up to read and a **jump to latest** appears, telling you whether anything happened while you were away.
- **A run that ends, ends.** Stop it and the turn closes with `⊘ stopped by you`; when every account fails, the error closes it and offers **Retry**. Copy sits on every code block and every answer.
- **Usable without a mouse.** The chat list is keyboard-navigable, the transcript is a `log` and the work bar a `status` — so state is announced without reading every streamed token aloud — and nothing conveys state by colour alone.
- **Accounts tab** — provider cards with status (`● ready` / `◌ limited · resets 18:30`), auth type, usage bars, add/remove.
- **Rules tab** — your routing rules visualized: match conditions as chips, failover chains as pill sequences. Edits to the JSON apply live.

Conversations persist across VS Code restarts, including native CLI session ids, so old chats keep their context.

## How it works (and why it's ToS-friendly)

Consumer AI subscriptions can't be called directly over the API. usturlab therefore never touches provider APIs with subscription credentials — it **orchestrates the official CLIs** (`claude`, `codex`, `gemini`, `copilot`) as subprocesses, each authenticated with its own isolated profile:

| Provider | Multi-account isolation | Auth options |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`) or `CLAUDE_CONFIG_DIR` | subscription token, isolated profile, API key |
| Codex CLI | `CODEX_HOME` per profile | ChatGPT login, API key |
| Gemini CLI | `HOME` override per profile | Google login (paid tiers — see caveats), API key |
| Copilot CLI | `COPILOT_HOME` per profile | GitHub login, fine-grained PAT |
| OpenRouter | none needed (stateless HTTP) | free API key — **reviews only**, see below |

The one exception to "no APIs" is **OpenRouter**, which is not a subscription: it reaches free open-weight models (DeepSeek R1, Qwen3 Coder, Llama 3.3 70B) over plain HTTP so the [second opinion](#making-every-model-smarter) can run without spending a second subscription. Because a model reached this way has no tools, no sandbox and no session, it is marked **review-only** — held out of the default chain, the router's scoring, plan execution and `@` mentions. It can check work; it can never be given work.

Secrets (tokens, API keys) live in the VS Code secret store. Profile directories live under `~/.usturlab/profiles/`. usturlab also scrubs hijacking env vars (e.g. a stray `ANTHROPIC_API_KEY` silently overrides Claude subscription auth) from every subprocess.

**Adding an account is one authorize click**: the wizard opens a login terminal per account and detects completion automatically — by watching for the auth file (Codex/Gemini), polling `claude auth status`, or capturing the token straight from terminal output (Claude `setup-token`). No copy-pasting.

**Limit detection is first-class**: Claude's stream emits `rate_limit_event` with the exact reset time; Codex/Gemini/Copilot limit messages are fingerprinted in `packages/core/src/adapters/limits.ts`. On a limit, the full original prompt is re-sent to the next account in the chain and the account goes on cooldown until its stated reset.

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
- A rule may carry `exclude` instead of (or alongside) `target` — `{ "exclude": [{ "provider": "gemini" }] }` bars it from the whole chain, `defaultChain` included. Every matching rule's exclusions apply, not just the first match's; an explicit `@mention` overrides them.
- Accounts on cooldown (recently limited) are skipped at routing time.
- `#hashtags` in the prompt become tags for `match.tags` rules.

### Terminal mode

`usturlab: Open Session in Terminal` opens the chosen CLI **interactively** in a VS Code terminal with the right account's environment injected — for long agentic sessions where you want the CLI's own UI.

## Settings

| Setting | Default | Description |
|---|---|---|
| `usturlab.permissionMode` | `safe` | `safe` (read/plan), `edits` (auto-accept edits), `full` (skip approvals) |
| `usturlab.routingMode` | `auto` | `auto` reads the task and picks the model; `manual` follows your chain exactly. Your rules win in both |
| `usturlab.sendWorkspaceContext` | `true` | Send the open file, selection, git state and convention files |
| `usturlab.frameTasks` | `true` | Add the framing a request is missing — the check to run, reproduce first, name files, stay in scope |
| `usturlab.standingInstructions` | `true` | Give each provider the instructions it needs to behave like the best one |
| `usturlab.verifyChanges` | `true` | Run the project's own checks after a change, and let the model fix a failure once |
| `usturlab.secondOpinion` | `hard` | Have a different provider review the work: `never` / `hard` / `always` |
| `usturlab.autoPlanHeavyEdits` | `true` | Plan heavy code-writing work before it edits |
| `usturlab.pollUsage` | `false` | Proactively poll quota (Claude 5h/weekly window, Copilot AI credits) |
| `usturlab.cliPath.*` | CLI name | Override binary paths |

## Commands

- `usturlab: Add Account` / `Remove Account` / `Manage Accounts`
- `usturlab: Routing Rules` / `Edit Routing Rules` (raw JSON)
- `usturlab: New Conversation`, `Open Chat`, `Cancel Running Task`
- `usturlab: Open Session in Terminal`
- `usturlab: Analytics` — what the router learned: clean-run rate and confidence per account, median burn per run, performance per kind of work
- `usturlab: Simulate Usage Limit (debug)` — test failover without burning quota

## Development

```bash
pnpm install
pnpm build        # core typecheck + extension bundle (esbuild)
pnpm test         # unit tests (vitest) — no accounts needed

pnpm -C packages/core test:live   # against your real logged-in CLIs
```

`test:live` proves the parts that only reality can: that the standing brief reaches each provider through its own channel, that the workspace brief is understood, that check discovery finds a repo's real commands and nothing else, and that a second model catches a planted defect while waving through correct code.

Open the repo in VS Code and press **F5** to launch the Extension Development Host.

### Architecture

- `packages/core` — editor-agnostic engine: rule matcher/router, auto-routing with measured capability and burn estimation, orchestrator with failover and handover, task/provider briefs, verification and review prompts, per-provider CLI adapters (spawn + stream parsing + limit detection). No `vscode` imports; fully unit-tested.
- `packages/vscode` — the extension: account onboarding with auto-detected logins, secret storage, sidebar chat list, chat/accounts/rules editor tabs (preact), terminal mode.

Limit-message fingerprints live in `packages/core/src/adapters/limits.ts` — when a CLI changes its copy, that's the only file to touch.

## Caveats

- **Gemini free tier**: as of mid-2026 Gemini CLI rejects free individual Google accounts (`IneligibleTierError` pointing to Antigravity). A paid Google AI subscription or a `GEMINI_API_KEY` is required.
- Gemini multi-account uses a `HOME` override (no official config-dir env var yet) — experimental on Windows.
- Copilot CLI's programmatic mode is plain text; tool activity is not itemized.
- Quota polling uses undocumented endpoints and is off by default; passive detection (parsing the CLI's limit message mid-run) is the primary mechanism.

## License

MIT
