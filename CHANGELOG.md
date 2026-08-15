# Changelog

## 0.10.1 — 2026-08-15

### Where the other agents already are

Claude Code and Codex each sit in two places at once: an icon on the left, and one in the strip at the top right. usturlab only ever had the left. It now has both — the same session list, docked in the secondary side bar, so a conversation can stand beside the file it is about instead of across the window from it. The editor toolbar carries the mark too; clicking it opens your last conversation in its tab.

Both lists are the same lists. Open a chat from either and it is the same conversation, in the same place it always opens.

On VS Code older than 1.106 — which cannot take a view container in the secondary side bar at all — nothing moves and nothing is duplicated: the activity bar entry stays the only one.

### One live indicator, not three

A running task said `thinking` in the transcript where the answer was about to appear, and said it again in a pinned bar above the composer, which also held the clock. Two words for one fact, in two places, neither of them where you were looking.

There is one now, in the header of the reply being written, beside the account that is writing it: what the run is doing — `thinking`, `writing`, `working`, `2 agents`, or `waiting for you` when it is blocked on a permission question — and how long it has been going. The bar above the composer is gone; the `Esc stops` hint it carried is in the composer's own placeholder while a task runs.

### "Ask" was never a fourth permission level

The menu listed Plan, Edit, Full and Ask as one choice, but the code has always
treated asking as a switch sitting on top of the level — it decides who answers,
while the level still bounds what can be asked. Listing them together meant
turning asking on hid which level was actually in effect, `Edit + ask` could not
be expressed at all, and `Full + ask` was offered even though `Full` skips
approvals by definition and ignores it.

There are three levels now and a separate toggle under them. The button says
what you changed away from the default — `Edit · ask`, `Full · manual` — and the
toggle says plainly when it does nothing: on Full there is nothing to stop at.
The three hints also stop paraphrasing each other; they name the sandbox, which
is what actually separates Edit from Full.

### Fixed

- **Notifications said "usturlab — AI Subscription Router".** VS Code labels a notification with the extension's display name, so every finished-run toast carried the tagline. The extension is called usturlab; the description still says what it does, where a description belongs.

## 0.10.0 — 2026-08-14

### The conversation is one thread, so it is drawn as one

A run used to arrive as a stack of tiles: the prompt in a bubble on the right, the answer in a tinted box, tool activity in a bordered panel, the checklist in another, the permission question in a third. Five containers for one piece of work, each with its own frame, fill and radius, none of them saying anything the position on the page did not already say.

There is a single hairline rail down the transcript now, and every event is a dot on it. Your message, the answer, what the router did, what needs your decision — one column, in order. The dot carries the state that used to need a box: hollow for something that happened, filled for someone speaking, in the account's own colour so a run that failed over reads as two providers at a glance, a lit centre while something is still moving, and a pulse while the model is blocked on you.

### The work is not the point; the answer is

Everything the model did to produce an answer — files read, commands run, subagents dispatched — is one dim line underneath it: `3 steps · 2 agents`. Click it and the whole record is there, unchanged. While the run is live that line names what is happening right now instead of counting, and the work bar above the composer carries the rest, so nothing is hidden while you are waiting on it. The model's own checklist follows the same rule: `tasks 2/4` and the item it is on, with the list one click away.

The answer itself is no longer interrupted by any of it. Tool calls used to be spliced between paragraphs of the reply; the prose now runs continuously and the record sits below it.

The numbers beside a line — which model, how long, what it would have cost, how many tokens a lane spent — hold their space and fade in when you look at the row they belong to. They stay in the DOM throughout, so a screen reader still reads them and a keyboard user still reaches them, and on a touch screen they simply show.

### A composer with nothing in it but your task

The composer carried a chip per account, wrapping onto a second line as soon as you registered a fourth, restating quota the Accounts tab already shows. They are gone: routing is the router's job, `@claude:work` still overrides it with completion as you type, and quota lives where quota is managed.

What is left is the text you are writing, a `+`, one word — `Plan` — and Send. That word opens a menu holding both switches that used to be two dropdowns: what the model may do (plan, edit, full, ask) and how it is routed (auto, manual), each with the sentence saying what choosing it actually does. Auto is the default and says nothing; pick manual and the button says so.

### One design, on every screen

Accounts, rules and analytics were rebuilt in the same language rather than three dialects of it. Cards became lists separated by hairlines, tables lost their frames, and the coloured edge on an analytics row went away because the flag on the right already said `error` or `failover`. Selection is a resting surface instead of a slab of theme blue.

Underneath, the values that were being invented per rule are now a small fixed set: four radii and nothing in between, one hairline, two raised planes, two shadows, one motion duration. Colour is reserved for state and for the four provider brands — the same four values had been written six different ways. Glass is used only where a surface genuinely floats over moving content, and menus are opaque, because a menu with words readable through it is a worse menu.

Everything is theme-aware in both directions, focus rings are part of the design rather than whatever the platform left behind, and the reduced-motion path keeps the blocked-on-you dot legible without animating it.

### Added

- **A design harness** (`pnpm -C packages/vscode preview`) renders the real webview bundle against sample host messages in a browser: every screen, both themes, no VS Code window, no account, no CLI. It is excluded from the published extension.

### Removed

- The routing badge component and its styles, which nothing had rendered for several releases. The reply's own header says which account and model ran it; the rule that picked them is in its tooltip.

## 0.9.0 — 2026-08-12

### One place to write a rule

The rules builder was a second screen showing the same file, so it drifted from the tab beside it. There is one screen now: the ordered list on the left *is* the order the router tries them in, and the pane on the right is the rule that row stands for. Reordering is two buttons instead of an argument with the JSON. The default chain is a row in that same list rather than a special case somewhere else, and the failover chain has a real editor. The JSON file is still the source of truth, still one button away, and edits made there still show up here immediately.

Analytics was rebuilt on the same lines, and the CSS underneath both lost about a third of its weight.

### A broken rules file no longer costs you your rules

A rules file that does not parse is replaced in memory by an empty one, because that is what routing has to fall back to. The Rules tab then showed *empty* and kept its editors live — so saving anything wrote that empty file over the rules still sitting on disk. A misplaced comma cost you the lot.

Now the pane says what actually happened: the list reads empty because routing fell back, your rules are still in the file, and everything that writes is off until it parses. `RulesManager` refuses the write independently, so nothing reaching it by another path can do it either.

### Fixed

- **Saving a rule failed on Windows.** The parent directory was derived with `lastIndexOf('/')`, which finds nothing in a path built out of backslashes. It uses `dirname` now, like the MCP writer next to it always did. CI runs on Windows from this release so the next one of these is caught rather than reported.
- **`~/.usturlab/rules.json` now applies live.** The watcher only covered the workspace copy, so "edits to the JSON apply live" was false for anyone whose rules live in their home directory — and for the legacy `.usrouter` paths, which are still read. All four locations are watched.
- **The default chain pane no longer holds a stale draft** when the chain is changed in the JSON underneath it. The rule pane already reloaded on an external edit; this one didn't.
- **The rules template pointed `$schema` at a repository that does not exist**, so editor validation silently did nothing for every file created from it.
- **Two raw NUL bytes in `RulesView.tsx`** made git treat the file as binary — no diff, no blame, no merge — and made grep skip it entirely. They were sentinel prefixes that only needed escaping.
- **Adding a Gemini account no longer offers the free tier**, which the CLI itself refuses (`IneligibleTierError`). It says Pro or Ultra, which is what works.
- The rules and commands templates create their parent directory before writing, instead of assuming `.usturlab/` is already there.

### Documentation

The marketplace README had stopped describing the extension: no mention of the brief, the framing, the standing instructions, verification or the second opinion; three of sixteen settings; four missing commands; a disclaimer naming OpenRouter that appeared nowhere else in the page; and a relative source link that resolved to nothing. It is back in step with the repository README. Both now lead the Claude row with the isolated-profile login the wizard actually recommends, rather than the `setup-token` that cannot read usage.

## 0.8.2 — 2026-08-05

### The numbers were wrong

Both figures in the analytics tab were plausible and wrong. Verified against real CLI output, not assumed:

**Tokens were off by four orders of magnitude.** Claude's `usage.input_tokens` counts only what was neither served from cache nor written to it. A real turn reported `input_tokens: 2` while reading 18,726 tokens from cache and writing 6,088 more into it — usturlab stored the 2. Adapters now normalize to what the model actually read, with the cached share kept separately:

| | before | after |
|---|---|---|
| Claude | `input_tokens` alone | `+ cache_creation + cache_read` |
| Codex | `output_tokens` alone | `+ reasoning_output_tokens` (billed as output) |

Codex's input side needed no change — it already counts the cache and breaks out the cached part. The analytics row now reads `24.8k→4` instead of `2→4`, and hovering shows how much of it came from cache.

### Dollars that were never charged

`total_cost_usd` is the API list price of the tokens, and Claude Code reports it whether or not anyone was billed. On a subscription — which is the entire point of this extension — the run cost nothing. Three identical trivial prompts reported `$0.070939`, `$0.070420` and `$0.012668`; the last was 5.6× cheaper only because the cache was warm.

The figure is worth keeping — it is exactly *what the subscription saved you* — so it is labelled rather than hidden:

- A cost from an API-key account reads `$0.07`. From a subscription account it reads `~$0.07`, and the tooltip says nothing was charged.
- The analytics summary splits **Billed** (money) from **Would have cost** (list price of the free runs). They are never added together, because the sum is neither number.
- A provider that reports no cost at all — Codex, Gemini and Copilot report none — now shows `—` instead of `$0.00`. "Not reported" is not "free".
- Sub-cent runs show three decimals instead of rounding to `$0.00`.

Runs recorded before this release have no billing flag and are counted as unbilled, which is right for subscription accounts and wrong for API-key ones; there is no way to recover it retroactively.

## 0.8.1 — 2026-08-05

### The check comes before the run, not after

usturlab already ran this project's own typecheck and tests after a change and handed back the failure. That closed the loop one round trip too late: the model had already declared victory, and every repair round is a turn the user paid for.

Now the same commands are named **in the brief, before the work starts** — `pnpm run typecheck && pnpm run test`, discovered from `package.json` or a `Makefile`, never invented — with the instruction to run them and keep working until they pass, and to show what they printed instead of asserting success. The list is the same one verification would run, so a model that passes its own check passes ours. It is told even when `verifyChanges` is off, which is exactly when it matters most.

### Framing, only where the request is missing it

The brief now leads with **how to approach this one** — never more than three lines, and only ones that answer a gap actually present in what you typed:

| when | what it adds |
|---|---|
| always, on work that writes code | the check above, or — if the repo declares none — say how you verified it |
| a bug report with no output pasted in it | reproduce the failure first, then fix the cause |
| "make it faster" with nothing to measure | name the property you are improving and how you'd know it improved |
| nothing names a file, and no editor file is open | find the place and say which files you'll change before changing them |
| a refactor or a multi-step job | follow the pattern already here, and name where you took it from |
| hard or multi-step work | do what was asked; list other problems instead of fixing them |

Your prompt is never rewritten — the framing sits beside it and can be read separately. A typo fix gets the check and nothing else. Plan mode gets none of it: there is nothing to verify yet. `usturlab.frameTasks` turns it off.

### A chat that has turned against itself now says so

Two corrections, or checks left red twice, and the thread is feeding the model its own failed attempts on every turn. usturlab says this once and suggests starting fresh with what you learned. Length alone is never the trigger — a long thread deep in one problem is where accumulated context earns its place; only evidence of circling counts.

### Sharper standing instructions

- **Every provider** is now told not to buy a green check: no silencing a failing check, swallowing an error, widening a type, or weakening a test. If the real fix is out of scope, say so.
- **Codex** gets three lines for its documented defaults — batch reads in parallel instead of walking the tree one file per turn, deliver working code rather than a proposal, and look for an existing helper before writing a parallel one.
- **The repair prompt** now says outright that editing, deleting or skipping a test — or stubbing what it exercises — is not a fix, because a check bought that way hides the bug it existed to catch.

Every line still carries an id and stays subject to the A/B loop that drops one when the evidence says it hurts. The framing lines deliberately sit outside that loop: they appear only when their gap does, so "with" and "without" would be different populations of task and the comparison would measure difficulty, not the line.

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
