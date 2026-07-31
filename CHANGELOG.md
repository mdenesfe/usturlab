# Changelog

## 0.5.1 — 2026-08-01

- The assistant's answer takes the **full column width** — only your own message stays a right-aligned bubble. Errors span the full width too
- The tool timeline is quieter: the decorative gear is gone, and the collapsed row now reads `▸ 7 steps · Read ×4 · Edit ×2` on the left with the files it touched right-aligned
- Every step sits on **one grid** — glyph, tool name and path share the same columns down the whole list, so nothing is ragged. The disclosure arrow has its own reserved column, and an expanded preview starts exactly under the path column
- Path chips lost their code-block background; a step is now plain aligned monospace

## 0.5.0 — 2026-08-01

### The timeline says which file, and what changed — on every provider

Tool activity used to be a bare list of names. Claude sent no arguments at all, so `Read` meant nothing; Codex and the ACP agents sent one loose field each.

- **One shared describer** turns any provider's raw tool arguments into the same view, so Claude, Codex, Gemini and Copilot all read identically
- **Collapsed** — the group row now previews the files it touched: `7 steps · Read ×4 · Edit ×2 — autoRoute.ts · learning.ts +2`
- **Expanded** — every step shows what it did and where: `◇ Read src/router/autoRoute.ts:105-160`, `✎ Edit src/a.ts`, `❯ Bash pnpm test`, `⌕ Grep "retryable" in packages`
- **Steps with content expand again** into the content itself: an edit shows a colored before/after diff, a write shows the first lines it wrote, a multi-line command shows the whole script, a sub-agent shows its prompt. Long content is truncated with a line count rather than flooding the panel
- Per-provider mapping is real, not guessed: Codex's `fileChange` lists every path it touched, ACP's `content` diff is used verbatim when the agent supplies one, ACP kinds (`read`/`edit`/`execute`/`search`/`fetch`/`delete`/`move`) each get their own action, and unknown or MCP tools still fall back to a readable line instead of vanishing

- 138 core tests

## 0.4.1 — 2026-08-01

### A dropped connection no longer costs you a provider

`API Error: Connection closed mid-response` used to fail straight over to another account, which then answered "where were we?" because it got none of the context.

- **Transient failures are retried on the same account** — dropped streams, socket resets, overloaded upstreams, 502/503/504, timeouts. Two retries with 1s/4s backoff, and the native session is resumed so the model keeps everything it knows. Only after that does the chain move on. Previously nothing in the codebase ever marked an error retryable, so the retry path was dead code
- **Interrupted work is handed over, not thrown away.** Whatever the cut-off attempt already produced is passed to whoever picks the task up, with instructions to continue from it rather than restart — and explicitly not to ask where to resume. When the same session is resumed the text isn't re-sent, only the nudge
- **The failed account is now recorded.** A failover used to record only the account that cleaned up afterwards, so the one that failed was invisible to the learning loop
- **Infrastructure doesn't count against capability.** A run marked transient is excluded from the clean-rate sample — a network blip shouldn't lower whichever provider happened to be running
- The transcript says `connection dropped — retrying on claude:personal (attempt 2)` instead of a bare `retry #2` chip

- 123 core tests

## 0.4.0 — 2026-08-01

### Auto routing now learns from what actually happened

Until now the router judged providers from a hand-written capability table. It still starts there, but that table is only a prior — every run is measured and the score moves with the evidence.

- **Clean-run rate is the signal.** A run counts as clean when it finished without you interrupting it, without you re-asking, and without the router having to escalate. Three friction signals are recorded: `steered` (you injected a message mid-run), `retried` (you re-asked the same thing right after the answer), `escalated` (the work turned out heavier than classified)
- **Confidence-weighted calibration.** Kind-specific evidence leads (from 3 runs), the provider's overall record backs it up at half weight, and confidence grows with sample size — one bad streak can't disqualify a provider, but a consistent one moves it

### It now knows what a run costs, not just what's left

Knowing an account is "40% free" is useless without knowing whether the job costs 2% or 30% of that window.

- **Estimated burn** per candidate: measured median from comparable past runs when there are ≥3, otherwise a tier prior scaled by kind (agentic work multiplies by 2.5)
- **Affordability penalty** pushes down an account that this particular run would empty, so the router stops walking accounts off a cliff
- Actual burn is measured after each run from the movement in the account's tightest usage window

### Conversations hold together

- **Stickiness:** a thread stays on the account it started on, and the bonus grows with thread length — moving a long conversation loses the native session and everything the model already knows. A draining account still loses it
- **Thread weight:** a bare "yes, go ahead" / "evet yap" inherits the conversation's heaviest turn instead of dropping to a light model
- **Mid-thread escalation:** when the work suddenly gets harder the router moves up a tier and says so in the transcript
- **Auto plan** (`usturlab.autoPlanHeavyEdits`, on by default): heavy code-writing work switches that turn to Plan so you see the approach before it edits. A permission mode you set yourself is never overridden

### Analytics tab

`usturlab: Analytics` shows what the router learned — clean-rate and confidence per account, median burn per run, performance per kind of work with the best account for each, and a per-run timeline with friction flags. It follows runs live and can be cleared.

- 112 core tests

## 0.3.2 — 2026-08-01

- Composer controls tidied into two compact dropdowns — routing (Auto / Manual) and permissions (Plan / Edit / Full) — instead of a row of chips
- New **+** button attaches files: pick any files, they appear as removable chips above the input and travel with the message as paths every CLI can open

## 0.3.1 — 2026-08-01

### Gemini is now actually usable without a Google subscription
- API-key Gemini accounts get their **own isolated profile** and the profile is seeded with the matching auth type (`gemini-api-key`). Before this, a key-based account fell back to the machine's OAuth profile — which Google now rejects for free individual accounts — so it could never run
- Every account type gets a profile directory, keeping providers isolated regardless of how you signed in

### The ACP path is verified without needing a live account
- A fake ACP agent fixture speaks the real protocol, so the Gemini/Copilot path is covered end to end offline: session open, streamed text, tool calls with detail, permission requests answered per permission mode, mid-run injection producing a separate turn, cancellation noise filtered out, native resume with fallback, quota failures mapped to limit events, and a missing CLI reported instead of hanging
- 97 tests total

## 0.3.0 — 2026-08-01

### Every provider now runs a live session
- **Copilot** and **Gemini** move to the **Agent Client Protocol** (`--acp`) — the same session transport both CLIs expose for editors. Sessions stay open, so tool calls stream into the timeline, permission requests are answered by your permission mode, sessions resume natively, and **a message sent mid-run reaches the agent live**
- Injection semantics are modelled per provider instead of assumed: Claude and ACP agents answer an injected message as its **own reply block**; Codex `turn/steer` folds it **into the running block** and the UI says "delivered to the running task"
- Verified against the real CLIs: Copilot answers the injected message in a second turn, Codex inlines it, both with the original session context intact

### Result
| | Claude | Codex | Gemini | Copilot |
|---|---|---|---|---|
| mid-run messages | live | live | live¹ | live |
| native session resume | ✅ | ✅ | ✅ | ✅ |
| streamed tool timeline | ✅ | ✅ | ✅ | ✅ |

¹ Gemini's ACP handshake works, but Google now rejects free individual accounts (`IneligibleTierError`); a paid Google AI plan or an API key is required to run it.

## 0.2.0 — 2026-08-01

### Codex gets a live session (GPT is now steerable like Claude)
- Codex runs over its **app-server JSON-RPC protocol** instead of one-shot `exec`: the thread stays open, so a message sent while a task runs is delivered with `turn/steer` and the model reacts immediately — verified end to end against the real CLI
- Tool activity (shell, edits, MCP, web search, sub-agents) streams into the timeline; threads resume natively and fall back to a fresh thread when a resume id is stale

### Auto mode: understand the task, then choose the model
- usturlab now classifies every request before routing it — kind (question / explain / edit / debug / test / review / refactor / docs / agentic) and weight (trivial → hard) from transparent signals shown in the routing badge
- The model tier follows the weight (light / standard / heavy per provider) and the account is chosen with **usage in mind**: nearly-exhausted accounts are kept in reserve for easy work, while hard work still goes to the most capable account — solving your task well outweighs saving quota
- Your rules and `@mentions` always win over automatic choice, in every mode

### Modes in the composer
- **Auto / Manual** routing toggle and **Plan / Edit / Full** permission modes are one click away under the input, apply per message and persist as settings — and they work on **every provider**, not just Claude

### Tested
- 88 automated tests: classification, tier selection, quota-aware scoring, cooldown safety, mode precedence, plus the existing engine/UI suites

## 0.1.2 — 2026-08-01

### Chat
- Tool activity renders as an expandable timeline in the order it happened: a collapsed row summarizes the group (`36 steps · Bash ×30 · Read ×5`) with a spinning gear and the live step while running; expanding lists every call with its detail
- Text and tool groups interleave as ordered segments, so long agentic answers read like a transcript instead of a wall

### Stability
- Verified Claude's live mid-run injection against the real CLI end to end (two turns, one session)
- Host slash actions (`/accounts`, `/clear`, …) execute immediately instead of being injected into or queued behind a running task
- Conversations flush to storage on window close — the last turn can no longer be lost inside the debounce window
- Test suite grown to 78: env isolation/scrubbing per provider, Claude usage parsing (both shapes + failures), Codex offline usage reader, MCP sync for all four config formats (idempotent, preserves unrelated keys), custom command parsing/precedence, transcript timeline + compaction invariants, and a VS Code regression test that closes and reopens every tab twice

## 0.1.1 — 2026-08-01

- Closed Accounts/Rules/chat tabs reopen reliably: a stale panel handle no longer swallows the click; webview handler errors now land in the output channel instead of dying silently
- Release workflow gets `contents: write` so tagged releases actually publish; marketplace publish stays optional until `VSCE_PAT` is set

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
