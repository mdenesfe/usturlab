# What this changes

<!-- What it does, and why. Link the issue if there is one. -->

## How it was verified

<!--
Not "tests pass" — what you actually ran and what it printed.
`pnpm build && pnpm test` is the baseline; say if you also ran it against a real CLI.
-->

- [ ] `pnpm build` — both packages typecheck
- [ ] `pnpm test` — unit tests pass
- [ ] Tried it in the Extension Development Host (F5), if it touches the UI
- [ ] `pnpm -C packages/core test:live`, if it touches adapters or briefs

## Checklist

- [ ] `packages/core` still has **zero `vscode` imports**
- [ ] A CLI's verbatim output that this depends on is pinned in a test (limit messages belong in `packages/core/test/limits.test.ts`)
- [ ] CHANGELOG.md updated, if a user would notice the change
- [ ] No credential, token or account name in the diff, tests or fixtures
