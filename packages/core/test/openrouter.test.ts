import { describe, expect, it } from 'vitest';
import { OpenRouterAdapter, OPENROUTER_FREE_MODELS } from '../src/adapters/openrouter.js';
import { pickReviewer } from '../src/review/secondOpinion.js';
import { pickExecutor } from '../src/review/planExecute.js';
import { builtinDefaultChain } from '../src/rules/defaults.js';
import { autoRoute } from '../src/router/autoRoute.js';
import { classifyTask } from '../src/router/classify.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import { isReviewOnly } from '../src/types.js';
import type { AccountProfile, AdapterEvent, ResolvedAccount, Target, TaskRequest } from '../src/types.js';
import type { RunRequest } from '../src/adapters/adapter.js';

const account: ResolvedAccount = {
  id: 'openrouter-free',
  provider: 'openrouter',
  label: 'free',
  authMode: 'api-key',
  hasSecret: true,
  priority: 9,
  secret: 'sk-or-test',
};

const request: RunRequest = {
  prompt: 'find what is wrong with this diff',
  cwd: '/tmp',
  permissionMode: 'safe',
};

/** A streaming chat-completions response, in OpenRouter's SSE shape. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // The keep-alive comment is real traffic and must be ignored, not parsed.
      controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function delta(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

async function collect(
  adapter: OpenRouterAdapter,
  req: RunRequest = request,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.run(req, account, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

/** Records the model asked for on each call, and replies with a queued response. */
function fakeFetch(responses: Array<() => Response>): {
  fetch: typeof fetch;
  models: string[];
  bodies: Array<Record<string, unknown>>;
} {
  const models: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    bodies.push(body);
    models.push(body.model as string);
    const next = responses[call++] ?? responses[responses.length - 1]!;
    return next();
  }) as unknown as typeof fetch;
  return { fetch: impl, models, bodies };
}

describe('OpenRouter adapter', () => {
  it('streams deltas and closes with the whole answer', async () => {
    const { fetch } = fakeFetch([
      () =>
        sseResponse([
          delta('The diff '),
          delta('drops the null check.'),
          JSON.stringify({ usage: { prompt_tokens: 900, completion_tokens: 40 } }),
        ]),
    ]);
    const events = await collect(new OpenRouterAdapter(fetch));

    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)).toEqual([
      'The diff ',
      'drops the null check.',
    ]);
    const result = events.at(-1) as Extract<AdapterEvent, { type: 'result' }>;
    expect(result.type).toBe('result');
    expect(result.text).toBe('The diff drops the null check.');
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    // The whole point of this provider: the review is free.
    expect(result.costUsd).toBe(0);
  });

  it('walks to the next free model when one has been retired', async () => {
    const gone = () =>
      new Response(JSON.stringify({ error: { message: 'No endpoints found for this model' } }), {
        status: 404,
      });
    const { fetch, models } = fakeFetch([gone, () => sseResponse([delta('LGTM')])]);
    const events = await collect(new OpenRouterAdapter(fetch));

    expect(models).toEqual([OPENROUTER_FREE_MODELS[0]!.id, OPENROUTER_FREE_MODELS[1]!.id]);
    expect((events.at(-1) as { text: string }).text).toBe('LGTM');
  });

  it('treats a busy free model as a reason to try another one', async () => {
    const busy = () => new Response(JSON.stringify({ error: { message: 'Rate limited' } }), { status: 429 });
    const { fetch, models } = fakeFetch([busy, () => sseResponse([delta('ok')])]);
    const events = await collect(new OpenRouterAdapter(fetch));

    expect(models).toHaveLength(2);
    expect(events.at(-1)!.type).toBe('result');
  });

  it('reports a limit only once every free model is exhausted', async () => {
    const busy = () => new Response(JSON.stringify({ error: { message: 'daily limit' } }), { status: 429 });
    const { fetch, models } = fakeFetch([busy, busy, busy]);
    const events = await collect(new OpenRouterAdapter(fetch));

    expect(models).toHaveLength(OPENROUTER_FREE_MODELS.length);
    const limit = events.at(-1) as Extract<AdapterEvent, { type: 'limit' }>;
    expect(limit.type).toBe('limit');
    // Free allowance is a daily count, so the tracker parks it until it rolls over.
    expect(limit.scope).toBe('daily');
  });

  it('tries an explicitly requested model before the defaults', async () => {
    const { fetch, models } = fakeFetch([() => sseResponse([delta('ok')])]);
    await collect(new OpenRouterAdapter(fetch), { ...request, model: 'z-ai/glm-4.6:free' });
    expect(models[0]).toBe('z-ai/glm-4.6:free');
  });

  it('sends the standing brief as a system message', async () => {
    const { fetch, bodies } = fakeFetch([() => sseResponse([delta('ok')])]);
    await collect(new OpenRouterAdapter(fetch), { ...request, systemBrief: 'be adversarial' });
    expect(bodies[0]!.messages).toEqual([
      { role: 'system', content: 'be adversarial' },
      { role: 'user', content: request.prompt },
    ]);
  });

  it('says so plainly when no key was saved', async () => {
    const { fetch } = fakeFetch([() => sseResponse([delta('ok')])]);
    const events: AdapterEvent[] = [];
    for await (const event of new OpenRouterAdapter(fetch).run(
      request,
      { ...account, secret: undefined },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect((events[0] as { message: string }).message).toMatch(/no OpenRouter API key/i);
  });

  it('has no interactive session to open a terminal on', () => {
    expect(() => new OpenRouterAdapter().interactiveCommand()).toThrow(/no interactive CLI/i);
  });
});

describe('a free reviewer never becomes the author', () => {
  const accounts: AccountProfile[] = [
    { id: 'claude-personal', provider: 'claude', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 1 },
    { id: 'openrouter-free', provider: 'openrouter', label: 'free', authMode: 'api-key', hasSecret: true, priority: 2 },
  ];
  const task: TaskRequest = {
    conversationId: 'c1',
    prompt: 'refactor the auth module and update every caller',
    cwd: '/tmp',
    permissionMode: 'edits',
  };

  it('is left out of the default chain', () => {
    expect(builtinDefaultChain(accounts).map((t) => t.provider)).toEqual(['claude']);
  });

  it('is never scored as a candidate, however much headroom it reports', () => {
    const auto = autoRoute(classifyTask(task), accounts, new QuotaTracker());
    expect(auto.chain.every((t) => !isReviewOnly(t.provider))).toBe(true);
    expect(auto.chain).toHaveLength(1);
  });

  it('is never handed a plan to carry out', () => {
    const planner: Target = { provider: 'claude', account: 'personal' };
    const candidates: Target[] = [{ provider: 'openrouter', account: 'free' }];
    expect(pickExecutor(planner, candidates, { 'openrouter:free': 100 })).toBeUndefined();
  });
});

describe('a free reviewer is preferred for the second opinion', () => {
  const author: Target = { provider: 'claude', account: 'personal' };
  const hard = { kind: 'edit', complexity: 'hard', writesCode: true, signals: [] } as never;
  const candidates: Target[] = [
    { provider: 'claude', account: 'personal' },
    { provider: 'codex', account: 'personal' },
    { provider: 'openrouter', account: 'free' },
  ];

  it('spends nothing when a free model can do the reviewing', () => {
    const choice = pickReviewer({
      author,
      candidates,
      classification: hard,
      headroom: { 'claude:personal': 80, 'codex:personal': 80, 'openrouter:free': 75 },
    });
    expect(choice?.target.provider).toBe('openrouter');
    expect(choice?.reason).toMatch(/none of your quota/i);
  });

  it('reviews even when every subscription is nearly empty', () => {
    // The headroom gate exists because a review costs quota. A free one does not.
    const choice = pickReviewer({
      author,
      candidates,
      classification: hard,
      headroom: { 'claude:personal': 5, 'codex:personal': 3, 'openrouter:free': 0 },
    });
    expect(choice?.target.provider).toBe('openrouter');
  });

  it('still respects the policy switch the user set', () => {
    expect(
      pickReviewer({
        author,
        candidates,
        classification: hard,
        headroom: { 'openrouter:free': 75 },
        policy: 'never',
      }),
    ).toBeUndefined();
  });
});
