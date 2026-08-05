# Contributing to usturlab

Thanks for helping! A few pointers:

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security problem? Don't open an issue — see [SECURITY.md](SECURITY.md).

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Press **F5** in VS Code to launch the Extension Development Host.

## Where things live

- `packages/core` — all routing/failover/parsing logic. **Zero `vscode` imports** — keep it that way so it stays unit-testable and reusable outside VS Code.
- `packages/core/src/adapters/limits.ts` — every provider's limit-message fingerprints. If a CLI changed its quota-error copy, fix it here and add the verbatim string to `packages/core/test/limits.test.ts`.
- `packages/vscode` — extension host + preact webview.

## Adding a provider

1. Implement `ProviderAdapter` in `packages/core/src/adapters/<name>.ts` (spawn the CLI, parse its output into `AdapterEvent`s, detect limit messages).
2. Add env scrubbing/injection to `packages/core/src/accounts/env.ts`.
3. Register it in `packages/vscode/src/extension.ts` and add auth options to `packages/vscode/src/onboarding/addAccount.ts`.
4. Add limit fixtures to the tests.

## Rules

- Tests must pass (`pnpm test`) and both packages must typecheck (`pnpm build`).
- Real captured CLI output beats guessed formats — when you touch parsing, paste the actual lines into the tests.
- Never log or persist secrets; they belong in the VS Code secret store only.
- Scrub captured output before committing it: tokens, account names, absolute paths and anything else from your machine. Fixtures are public.
- Provider names and logos identify the services and nothing more — keep it that way, and don't imply endorsement by any of them.
