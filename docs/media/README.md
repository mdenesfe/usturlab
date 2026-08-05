# README artwork

**Screenshots** (`ui-*.png`) are captured from the real extension. To reshoot, run VS Code
with a throwaway profile so nothing personal is in frame:

```
code --user-data-dir /tmp/uslab --extensions-dir /tmp/uslab/ext \
     --extensionDevelopmentPath packages/vscode <a demo workspace>
```

Point `usturlab.cliPath.claude` at a script that runs
`packages/core/test/fixtures/fake-claude-cli.mjs` with `FAKE_CLAUDE_STREAM` set to one of the
recorded `.ndjson` fixtures. The panel then renders a stream a real `claude` actually produced,
so the screenshots cost no quota and contain no private data. `usturlab: Simulate Usage Limit`
produces the failover shot. Crop the macOS title bar before committing — it carries the
`[Extension Development Host]` label.

**Diagrams** (`hero`, `routing`) are hand-authored SVG; the `.svg` is the source, the `.png` is
what both READMEs reference. The Marketplace rejects SVG outright and requires HTTPS sources,
which is why `packages/vscode/README.md` uses absolute `raw.githubusercontent.com` URLs and
PNG only.
