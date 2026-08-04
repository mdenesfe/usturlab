# Changelog

## 0.8.0 — 2026-08-04

### Parallel agents, drawn as parallel

When a model splits work across subagents, that is the most interesting thing happening in the panel — and it was the one thing usturlab did not show. Claude's stream marks every subagent message with `parent_tool_use_id`, and the old code either dropped it or, worse, folded a subagent's tool calls into the main thread's timeline where they read as the parent's own work.

Subagents now get **lanes**: one per agent, all visible at once, each with its own live state.

- **Concurrency is the layout.** Agents whose lifetimes overlap share one block under a single trunk, one branch each. Nothing about a stack of collapsed rows says "at the same time", so the lanes never collapse into a summary while they run.
- **Each lane shows its own work** — the tool calls it made, what it is doing right now (`Running Search for b.txt`), its tool count and token spend, and what it reported back when it finished.
- **Duration bars survive the run.** Once a fan-out is done, every lane keeps a bar proportional to the slowest one, so the shape of the work stays readable — which reviewer took 38s and which took 5s.
- **A failed agent says so** (`✕`), and one that never reported back before the run ended reads as stopped rather than spinning forever.

**Asynchronous agents were the hard part.** Claude usually launches agents in the background: the parent's `tool_result` comes back immediately with `async_launched`, and the agent reports for real much later — often after the turn that spawned it has already finished and answered. Reading that acknowledgement as an ending closed each lane instantly, which also meant no two lanes ever overlapped and the fan-out stopped looking parallel at all. Only a genuinely terminal status ends a lane now, and a lane is found by agent id rather than by which message it belongs to, so a late report still lands where it belongs.

Both stream shapes are pinned as fixtures recorded from a real `claude` 2.1.216 and replayed in `packages/core/test/claudeAgents.test.ts` — the parsing is tested against output the CLI actually produced, not against a guess at its schema.

### The run, where it cannot scroll away

- **A work bar above the composer** while a task runs: elapsed time, and what is happening right now — `thinking`, `writing`, the file being edited, how many agents are working, or `waiting for you` when a permission question is blocking the model.
- **Live tool activity opens itself.** A running tool group used to sit collapsed behind "3 steps"; it now expands while the work is live and closes when it is done. Click it and it is yours — the panel stops steering it.

### A run that ends, ends

Three places let a turn stream for ever, because only a `result` ever marked one finished:

| | before | now |
|---|---|---|
| you press Stop | cursor blinks for good, no sign you stopped it | turn closes with `⊘ stopped by you` |
| every account fails | the bubble sits there thinking under the error | turn closes; the error says why |
| failover mid-answer | the abandoned attempt keeps a live cursor | that attempt closes, the banner explains |

None of this was cosmetic: the state was written to the stored conversation, so reopening an old chat replayed the same lie — and a subagent in that turn looked like it was still working, months later.

### Getting out of a hole

- **Copy** on every code block and every answer. It was the most common thing anyone does here and there was no way to do it but drag a selection across a moving stream.
- **Retry** on the failure that just happened, sending your last message again. It routes fresh, so the account that just hit its limit is on cooldown and gets skipped.
- **Jump to latest** once you have scrolled up, and it says `new activity` when something arrived while you were reading. Scrolling away used to strand you.

### Reachable without a mouse or a screen

- The transcript is a `log`; the work bar is a `status`, so state changes are announced without reading every streamed token aloud.
- The chat list is keyboard-navigable (it was a plain `div`), icon-only buttons have labels, and everything that said something in colour alone — account readiness, a running chat, an agent's state — now says it in words too.

### A second opinion that costs nothing

The second opinion was the best idea in this extension and the one most likely to be switched off, because it was billed to the user twice: once to do the work, once to check it. That is why it only ever ran on hard tasks, and only when a second subscription had headroom to spare — a review you cannot afford is a review that does not happen.

**OpenRouter** connects as a fifth provider, reaching free open-weight models (DeepSeek R1, Qwen3 Coder, Llama 3.3 70B) over plain HTTP. It is added with an API key from `openrouter.ai/keys` and no subscription. With one connected, reviews run there — and the headroom gate disappears, because there is no longer anything to ration. Your subscriptions keep every point of quota for the work that needs tools.

**It can only ever review.** A free model over HTTP has no tools, no sandbox and no session: enough to read a diff and argue with it, nowhere near enough to write code. So the provider is marked review-only and is held out of the authoring path in every place a target is chosen — the default chain, the automatic router's scoring, plan execution, `@` mentions, and the account pills. An account you cannot give work to never appears as somewhere to send work.

**Free tiers are treated as the moving target they are.** The free model list rotates without notice, so a retired model id (404) falls through to the next model in the chain rather than failing the review. Free capacity also runs out two ways — a busy model and a spent daily allowance, both reported as `429` — so a 429 is retried on another model before it is believed, and only then parks the account until the allowance rolls over at 00:00 UTC. A drained reviewer is recorded as such, so the next task picks a different one instead of paying for the round trip again.

### The router stops overcharging you

Four things the routing loop was getting wrong, all of them quietly.

**A thread's weight now comes back down.** The heaviest turn a conversation ever had used to pin every later turn to the heavy tier — one hard question on turn 3 meant a typo fix on turn 40 still ran on the most expensive model in the account, and the stickiness bonus kept it there. Only the last two turns count now, and they lift a turn by at most one rank. A bare confirmation still inherits the weight of the turn it answers, which was the case this was built for in the first place.

**Turkish prompts are actually weighed.** The kind patterns spoke some Turkish; the complexity scoring — the part that picks the model — spoke none. "auth modülünü tüm kod tabanında yeni API'ye taşı, sonra da testleri güncelle" scored as a simple edit and went to a light model. Three things had to be right to fix it: `\b` is ASCII-only, so a pattern anchored with it can never match a word starting with "ö"; the language is agglutinative, so a closing boundary matches the bare noun and nothing a sentence does with it; and a final "k" softens under a suffix, so "güvenlik" has to be spelled short enough to still find "güvenliğini". Stacked confirmations ("evet yap", "tamam devam et") read as one continuation now, too.

**Measured speed counts on light work.** The median duration of each provider's clean runs was being computed in two places and used in none. On light-tier work — where the tier was chosen precisely because capability is not the deciding factor — a measurably faster account now gets a real bonus. Nothing changes for heavy work, and an account with no history neither gains nor loses.

**A cheap model's failures stay off the expensive one's record.** Capability was measured per provider, so a run of scrappy work on Haiku dragged down the score that decides whether Opus gets the hard task, and vice versa. Runs now record their weight class and evidence is keyed by it, with older untiered runs still counted at lower confidence.

### A retired model no longer costs you an account

Model ids are pinned by version in the tier table, and providers retire them on their own schedule. That error matched nothing — not a limit, not a transient failure — so it failed straight over to the next account, which was then asked for the same dead model. The CLI's rejection of a model is now recognized as its own kind of failure: the account drops to the CLI's own default once and finishes the job, emitting `model-downgraded` (an event that had a handler in the panel and no producer anywhere). A run that downgraded is not filed under a weight class, because we no longer know which one it ran on.

### Rules can say never

A rule could only say where work should go. Barring one provider from one kind of work meant enumerating everyone else — and it still did not work, because the default chain is appended behind every rule.

Rules take an `exclude` now: `{ "match": { "keywords": ["güvenlik"] }, "exclude": [{ "provider": "gemini" }] }`. It applies to the whole chain, failover tail included, and a rule that only excludes does not have to name a target to be heard — every matching rule contributes its bans, not just the one that won the routing. An explicit `@mention` still overrides it, because overriding your own rule on purpose is allowed. The visual editor shows exclusions and preserves them; authoring them is a rules-file edit for now.

### Fixed

- `ANTHROPIC_BASE_URL` is now scrubbed from routed Claude runs alongside the credentials. It carries no secret of its own, which is exactly why it was missed — but it decides which server the credential is sent to, so a stray one in the user's shell silently rerouted every routed run through a third-party proxy.
- A mid-run correction was being filed under the thread's *complexity* where its task kind belongs, so the learning loop clustered corrections by the wrong key.

### Also

- Narrow panels stop overlapping: below 640px a lane's label and its state take one line each instead of stacking badges on top of text.
- The live indicators respect `prefers-reduced-motion`.
- A provider with no official brand mark renders an initial in its colour instead of a blank space in the account strip.

## 0.7.0 — 2026-08-01

### A tasks panel, fed by whatever the model actually keeps

Every CLI keeps a task list and every one of them describes it differently. They now all land in one live checklist in the transcript — updated in place, never stacked — with a progress bar and the step being worked on.

| | source |
|---|---|
| Claude | its `TodoWrite` tool call |
| Codex | `turn/plan/updated` |
| Gemini · Copilot | the ACP `plan` session update |

### It stops and asks — on every provider

Claude Code's defining behaviour was the one thing usturlab threw away: Codex and the ACP agents were already *sending* approval requests, and the old code answered all of them blindly. Now, with **Ask** selected in the composer (or `usturlab.askPermission`), the question reaches you.

- The request appears **in the transcript** as a card with the command or diff and Allow / Always / Deny — not a toast that scrolls away, because the model is genuinely blocked until you answer. If the tab is not focused you also get a notification you can answer from.
- **Always is per action, not blanket**: allowing `git status` allows `git`, never `rm`. A blanket allow is what Full mode is for.
- **Reads are never interrupted.** Plan mode still refuses rather than asking.
- A run that ends with a question outstanding releases the CLI instead of leaving its stdin blocked forever.

**Claude needed a bridge.** It cannot ask over stream-json — `--permission-mode manual` silently degrades to `default` and the tool just runs (verified). Its real hook is `--permission-prompt-tool`, so the extension now ships a small MCP server that Claude spawns and that asks usturlab over a loopback socket with a per-session token. If the extension is unreachable it denies: a permission prompt that fails open is worse than none.

### Switching modes

The composer's permission dropdown gains **Ask** alongside Plan / Edit / Full, and switching applies immediately to every open surface. `usturlab: Toggle Ask Before Acting` does the same from the palette. Ask is a separate switch rather than a fourth level — it decides *who answers*, while the mode still bounds *what can be asked for*.

### Verified live

`pnpm -C packages/core test:live`. Each provider was asked to write a file into the home directory — which every sandbox genuinely refuses — and denied:

| | asked | obeyed the denial |
|---|---|---|
| Claude (MCP bridge) | ✅ | ✅ file not written |
| Codex (`on-request`) | ✅ | ✅ file not written |
| Copilot (ACP) | ✅ | ✅ file not written |

Worth knowing: Codex only asks when its sandbox would otherwise block. `echo` inside the workspace — and even in the temp dir, which `workspace-write` permits — runs without a question. That is the right behaviour, not a gap.

### Fixed

- The permission gate announced one answered question **twice** to the UI; `close()` and `ask()` were both reporting it.
- `edits` mode would have started denying commands, which would have stopped agents running the project's own tests. The line between `edits` and `full` is drawn by each CLI's sandbox flags, where it can actually be enforced — so the gate no longer re-litigates it.

- 200 offline tests, 13 live

## 0.6.1 — 2026-08-01

Until now the router only improved **who** ran your task. Nothing improved **how well** they ran it. This release is that half: context, constraints, and someone checking the work.

### The model now knows what you know

`activeFile` was being captured and used only for rule matching — the model never saw it. Now a task brief carries what you would have told a colleague looking over your shoulder:

- the file you have open, your **selection with its line range**, the language, other open files
- the branch, uncommitted files, and the diff stat when it is small enough to be worth sending
- the project's convention files — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md` — normalized so every provider gets them, deduplicated when they are copies of each other
- what this conversation already touched, and what last went wrong

Nothing is sent twice: Claude already loads `CLAUDE.md` and Codex `AGENTS.md`, so their briefs omit those and carry only what they cannot know. The brief has a character budget and drops whole sections rather than truncating mid-sentence.

### Every CLI gets the instructions it is missing

There was no system-prompt mechanism anywhere in the codebase. Now each provider gets standing instructions through **its own real channel** — Claude `--append-system-prompt`, Codex `thread/start developerInstructions` (which adds to its base prompt rather than replacing it), and for Gemini/Copilot, which have no ACP system slot, prepended to the session's first prompt and restated only when it changes.

The content is compensation, not a generic preamble: what does *this* CLI not do that Claude does. Claude's list is the shortest — that is the point.

### The work gets checked

After a run changes files, the project's **own** typecheck/test script runs and, on failure, the model gets one chance to fix it with the real output in hand.

- Commands are never invented — only what `package.json` or a `Makefile` declares
- Nothing runs in Plan mode
- A typo fix gets a typecheck; a refactor gets the suite
- A timed-out check is not a verdict
- The repair prompt says to fix the cause, not to weaken the check

### A different model looks for what the checks cannot see

For hard work, a **different provider** reviews the diff adversarially and is told that finding nothing is a valid answer (`LGTM`). Its critique appears as a collapsible block, and the author gets to answer it — including pushing back where the reviewer is wrong. A different provider is preferred over a different account of the same one, and it is skipped entirely when no reviewer has the headroom.

### Plan with the expensive model, execute with the cheap one

Auto-plan produced a plan and stopped. Now the plan is parsed, and if it is specific enough to follow — a step list that names real files — you are offered to carry it out on a cheaper account one tier down. Prose and vague lists are refused rather than handed off. The executor is told to stop and say which step is wrong rather than improvise a different solution.

### It learns what to tell them, not just where to send them

Every message you type into a running task is a correction. Those words used to be discarded; now they are collected, and when the same correction recurs it is **offered** (never silently applied) as a standing rule that enters every provider's brief.

Brief lines also have to earn their place: runs record which lines they carried, and a line whose clean-run rate is measurably worse than runs without it is dropped automatically.

### New settings

`usturlab.sendWorkspaceContext`, `usturlab.standingInstructions`, `usturlab.verifyChanges` (all on), `usturlab.secondOpinion` (`never` / `hard` / `always`, default `hard`).

### Verified against the real CLIs

`pnpm -C packages/core test:live` runs the intelligence layer against real logged-in accounts. The channel test and the comprehension test are kept separate on purpose — a model that skips a trailing-format instruction is not the same failure as a brief that never arrived.

| | standing brief reaches it | describes the editor state |
|---|---|---|
| Claude (`--append-system-prompt`) | ✅ | ✅ |
| Codex (`developerInstructions`) | ✅ | ✅ |
| Copilot (ACP first prompt) | ✅ | ✅ |
| Gemini | blocked¹ | blocked¹ |

¹ `This client is no longer supported for Gemini Code Assist for individuals` — Google now requires a paid plan or an API key. Correctly classified as permanent, so it fails over instead of retrying.

Also verified live: check discovery finds this repo's real commands (`pnpm run typecheck | test | build`) and nothing else; a Codex review of deliberately broken code caught both planted defects (`NaN` on empty input, mutating the caller's array) while returning `LGTM` for correct code without inventing problems; and a real Claude plan parsed as executable with concrete file paths.

- 183 offline tests, 11 live

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
