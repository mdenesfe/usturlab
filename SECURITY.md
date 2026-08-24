# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: go to the repository's **Security** tab → **Report a vulnerability**. That opens a private advisory visible only to you and the maintainers.

Expect an acknowledgement within a few days. If a report is confirmed, the fix ships in the next release and the advisory is published with credit, unless you would rather stay anonymous.

## Supported versions

Only the latest released version is supported. Fixes land on `main` and go out in the next Marketplace release; there are no long-term support branches.

## What is in scope

usturlab handles login credentials for several providers and spawns CLIs on your machine, so the interesting surface is roughly:

- **Secret handling** — tokens and API keys are kept in the VS Code secret store (`packages/vscode/src/`). Anything that writes one to disk, a log, the transcript, or the webview is a vulnerability.
- **Account isolation** — each account gets its own profile directory under `~/.usturlab/profiles/`. Anything that lets one account's run read or reuse another's credentials is a vulnerability.
- **Environment scrubbing** — `packages/core/src/accounts/env.ts` removes hijacking variables (a stray `ANTHROPIC_API_KEY` silently overrides Claude subscription auth) from every subprocess. A gap here means a run silently authenticates as something you did not choose.
- **Subprocess construction** — every provider adapter in `packages/core/src/adapters/` spawns a CLI. Argument or environment injection reachable from a prompt, a rules file, or a workspace file is a vulnerability.
- **Rules and command files** — `.usturlab/rules.json`, `commands.json` and `mcp.json` are read from the open workspace. Opening an untrusted repository should never be enough to execute something you did not ask for — a workspace `commands.json` is inert until you enable it, keyed by the file's content, and is ignored entirely in an untrusted workspace.
- **Webview** — the panel renders model output as markdown. Script execution or extension-host access from rendered content is a vulnerability.

## What is not in scope

- Vulnerabilities in the provider CLIs themselves (`claude`, `codex`, `gemini`, `copilot`) — report those to their vendors.
- Vulnerabilities in VS Code, Node.js, or third-party dependencies — report upstream; tell us too if usturlab's usage makes one materially worse.
- The fact that a model can be prompted into writing bad code. usturlab routes and reviews; it does not sandbox what a CLI does with the permissions you granted it.
- Anything requiring an attacker who already has your user account on your machine, or write access to `~/.usturlab/`.
