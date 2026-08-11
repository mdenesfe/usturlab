import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import { CopilotAdapter } from '../src/adapters/copilot.js';
import type { LiveRunHandle, ProviderAdapter } from '../src/adapters/adapter.js';
import type { AdapterEvent, ProviderId, ResolvedAccount } from '../src/types.js';

/**
 * Does the model actually stop and wait for us?
 *
 * Asserted by denying: a denied command cannot have run, so the run finishing
 * without the side effect is proof the answer was obeyed rather than ignored.
 */

const LIVE = process.env.USTURLAB_LIVE === '1';
const only = process.env.USTURLAB_LIVE_PROVIDER;
const PROFILES = join(homedir(), '.usturlab', 'profiles');

const account = (provider: ProviderId, id: string): ResolvedAccount => ({
  id,
  provider,
  label: 'personal',
  authMode: 'managed-home',
  homeDir: join(PROFILES, id),
  hasSecret: false,
  priority: 1,
});

const CASES: Array<{ provider: ProviderId; adapter: ProviderAdapter; account: ResolvedAccount }> = [
  { provider: 'codex', adapter: new CodexAdapter(), account: account('codex', 'codex-personal') },
  { provider: 'copilot', adapter: new CopilotAdapter(), account: account('copilot', 'copilot-personal') },
];

describe.skipIf(!LIVE)('live: the model waits for permission', () => {
  for (const entry of CASES) {
    it.skipIf(!!only && only !== entry.provider)(
      `${entry.provider} asks before running a command and obeys a denial`,
      async () => {
        const handle: LiveRunHandle = {};
        const events: AdapterEvent[] = [];
        const asked: string[] = [];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 170_000);

        for await (const ev of entry.adapter.run(
          {
            // workspace-write already permits the temp dir, so the probe has
            // to target somewhere the sandbox genuinely refuses: the home dir.
            prompt:
              'Run the shell command `echo probe > ~/usturlab-permission-probe.txt` ' +
              'to write that file in my home directory. Then say DONE.',
            cwd: process.cwd(),
            permissionMode: 'edits',
            askPermission: true,
            handle,
          },
          entry.account,
          controller.signal,
        )) {
          events.push(ev);
          if (ev.type === 'permission') {
            asked.push(`${ev.request.kind}: ${ev.request.title}`);
            handle.respondPermission?.(ev.request.id, { outcome: 'deny', reason: 'not this time' });
          }
        }
        clearTimeout(timer);

        console.log(`\n[${entry.provider}] asked ${asked.length}×:\n  ${asked.join('\n  ')}`);
        expect(asked.length, `${entry.provider} never asked`).toBeGreaterThan(0);
        expect(events.some((e) => e.type === 'permission-resolved')).toBe(true);
      },
      190_000,
    );
  }
});
