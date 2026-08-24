/*
 * A run that exercises every kind of transcript entry — answer, tool group,
 * parallel subagents, task list, permission, notice, failover, review, error —
 * plus accounts, rules and analytics. Sample data only: nothing here is read
 * by the extension, and no CLI is involved.
 */
const post = (msg) => window.dispatchEvent(new MessageEvent('message', { data: msg }));

const accounts = [
  { id: 'work', provider: 'claude', label: 'work', authMode: 'subscription', available: true,
    identity: 'you@work.example', models: [{ id: 'opus', label: 'Opus 5' }, { id: 'sonnet', label: 'Sonnet 5' }],
    usage: [{ label: 'session', utilizationPct: 42, resetAt: Date.now() + 3600e3 }, { label: 'week', utilizationPct: 71 }] },
  { id: 'personal', provider: 'claude', label: 'personal', authMode: 'subscription', available: true,
    identity: 'you@personal.example', models: [{ id: 'opus', label: 'Opus 5' }], usage: [{ label: 'session', utilizationPct: 12 }] },
  { id: 'main', provider: 'codex', label: 'main', authMode: 'chatgpt', available: true,
    identity: 'you@work.example', models: [{ id: 'gpt', label: 'gpt-5.6' }], usage: [{ label: 'week', utilizationPct: 88 }] },
  { id: 'g', provider: 'gemini', label: 'g-paid', authMode: 'oauth', available: false, resetAt: Date.now() + 7200e3,
    models: [{ id: 'pro', label: 'Gemini 3 Pro' }], usage: [{ label: 'day', utilizationPct: 100 }] },
];

setTimeout(() => {
  post({ kind: 'accounts', accounts });
  if (new URLSearchParams(location.search).has('empty')) return;
  post({ kind: 'modes', permissionMode: new URLSearchParams(location.search).get('mode2') || 'safe', routingMode: 'auto', askPermission: false });
  post({ kind: 'conversations', activeId: 'a', list: [
    { id: 'a', title: 'Timeline redesign for the chat panel', updatedAt: Date.now() - 6e5 },
    { id: 'b', title: 'Quota failover keeps picking the wrong account', updatedAt: Date.now() - 9e7 },
    { id: 'c', title: 'Rules: tag matching for #tests', updatedAt: Date.now() - 2.4e8 },
  ] });

  const M = 'm1';
  post({ kind: 'userEcho', text: 'Chat arayüzünü timeline gibi yap — kutu yok, çizgi ve nokta olsun. #ui' });
  post({ kind: 'routing', messageId: M, target: { provider: 'claude', account: 'work', model: 'opus' }, ruleId: 'ui-work', reason: 'tag #ui' });
  post({ kind: 'delta', messageId: M, text: 'Panelin tamamını tek bir zaman çizelgesi olarak yeniden kurdum. Kutular kalktı, her olay rayın üzerinde bir nokta.\n\n' });
  post({ kind: 'tasks', messageId: M, items: [
    { text: 'Design tokens: hairline, glass, radius', status: 'done' },
    { text: 'Transcript → timeline rail', status: 'done' },
    { text: 'Accounts + rules + analytics pass', status: 'active' },
    { text: 'Screenshot review', status: 'pending' },
  ] });
  post({ kind: 'toolUse', messageId: M, name: 'Read', detail: 'media/webview.css', path: 'packages/vscode/media/webview.css', action: 'read' });
  post({ kind: 'toolUse', messageId: M, name: 'Edit', detail: 'webview.css · timeline rail', path: 'packages/vscode/media/webview.css', action: 'edit',
    preview: '-  gap: 14px;\n-  padding: 16px 0;\n+  padding: 22px 0 8px;\n+}\n+\n+.tl {\n+  position: relative;' });
  post({ kind: 'toolUse', messageId: M, name: 'Bash', detail: 'pnpm -C packages/vscode build', action: 'run', preview: '[usturlab] build complete' });
  post({ kind: 'delta', messageId: M, text: 'Ray hep aynı yerde duruyor; canlı olan tek olayın noktası içi dolu.\n' });
  post({ kind: 'agentStart', messageId: M, id: 'a1', label: 'accounts screen', agentKind: 'Explore', prompt: 'Flatten the account cards' });
  post({ kind: 'agentStart', messageId: M, id: 'a2', label: 'analytics screen', agentKind: 'Explore' });
  post({ kind: 'agentProgress', messageId: M, id: 'a1', activity: 'reading AccountsView.tsx', toolUses: 4, tokens: 8200 });
  post({ kind: 'agentEnd', messageId: M, id: 'a2', status: 'completed', summary: 'Tables lose their frames; rows keep hairlines.', toolUses: 7, tokens: 15400, durationMs: 24000 });
  post({ kind: 'permission', messageId: M, request: { id: 'p1', kind: 'command', title: 'git commit -m "timeline UI"', detail: '4 files changed, 312 insertions(+), 96 deletions(-)' },
    target: { provider: 'claude', account: 'work' } });
  post({ kind: 'attachments', paths: [
    'packages/vscode/media/webview.css',
    'packages/vscode/webview/components/Transcript.tsx',
    'docs/media/README.md',
  ] });
  post({ kind: 'busy', running: true });
}, 60);

// Rules + analytics fixtures, so every screen can be reviewed from one harness.
setTimeout(() => {
  post({ kind: 'rules', path: '.usturlab/rules.json', exists: true, customCommands: [], rules: {
    version: 1,
    rules: [
      { id: 'ui-work', description: 'Anything touching the panel goes to the big model',
        match: { tags: ['ui'], globs: ['packages/vscode/**'] },
        target: [{ provider: 'claude', account: 'work', model: 'opus' }, { provider: 'codex', account: 'main' }] },
      { id: 'tests', description: 'Cheap and fast for test churn',
        match: { tags: ['tests'], keywords: ['vitest'] },
        target: [{ provider: 'codex', account: 'main' }] },
      { id: 'no-secrets', description: 'Security work never leaves Claude',
        match: { keywords: ['token', 'credential'] }, target: [], exclude: [{ provider: 'gemini' }] },
    ],
    defaultChain: [{ provider: 'claude', account: 'personal', model: 'opus' }, { provider: 'codex', account: 'main' }],
  } });

  const now = Date.now();
  const metrics = [];
  const shapes = [
    ['claude', 'work', 'opus', 'success', 12400, 0.42, 3.1],
    ['claude', 'work', 'sonnet', 'success', 4300, 0.08, 0.9],
    ['claude', 'personal', 'opus', 'failover', 9100, 0.31, 2.4],
    ['codex', 'main', 'gpt-5.6', 'success', 7700, 0.19, 1.6],
    ['codex', 'main', 'gpt-5.6', 'error', 900, 0.01, 0.2],
    ['gemini', 'g-paid', 'pro', 'success', 5200, 0.12, 1.1],
  ];
  for (let i = 0; i < 14; i++) {
    const s = shapes[i % shapes.length];
    metrics.push({
      id: 'm' + i, timestamp: now - i * 42e5, conversationId: 'a',
      provider: s[0], account: s[1], model: s[2], status: s[3], kind: i % 3 ? 'edit' : 'explain',
      inputTokens: s[4], outputTokens: Math.round(s[4] / 4), costUsd: s[5], metered: s[0] === 'gemini',
      durationMs: s[6] * 1000, burnPct: s[6], ruleId: i % 2 ? 'ui-work' : undefined,
      verified: i % 5 === 0 ? 'passed' : undefined, steered: i % 7 === 0,
    });
  }
  post({ kind: 'analytics', metrics, accounts });
}, 90);

// A second run: the events that are not an answer — notice, failover, review, error.
setTimeout(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('short') || q.has('empty')) return;
  const M2 = 'm2';
  post({ kind: 'notice', text: 'context compacted · 42k tokens carried over' });
  post({ kind: 'userEcho', text: 'Şimdi de analytics ekranını aynı dile getir.' });
  post({ kind: 'routing', messageId: M2, target: { provider: 'codex', account: 'main', model: 'gpt-5.6' }, reason: 'default chain' });
  post({ kind: 'delta', messageId: M2, text: 'Tablolardan çerçeveleri kaldırdım:\n\n```css\n.metric-rows { display: flex; flex-direction: column; }\n```\n\nSatırlar artık yalnızca saç teli çizgiyle ayrılıyor.' });
  post({ kind: 'failover', messageId: M2, from: { provider: 'codex', account: 'main' }, to: { provider: 'claude', account: 'personal' }, reason: 'weekly limit reached' });
  post({ kind: 'done', messageId: M2, costUsd: 0.18, metered: false, durationMs: 21400 });
  post({ kind: 'review', messageId: M2, by: 'gemini:g-paid', text: 'Sticky başlıklardaki cam efekti, `--surface` şeffafken açık temada kontrastı düşürebilir.' });
  post({ kind: 'error', messageId: M2, message: 'codex: stream closed before the answer finished (transient)' });
  post({ kind: 'busy', running: false });
}, 120);

// `?click=<selector>` opens a menu or popup for a screenshot without a mouse.
setTimeout(() => {
  const sel = new URLSearchParams(location.search).get('click');
  if (sel) document.querySelector(sel)?.click();
}, 300);
