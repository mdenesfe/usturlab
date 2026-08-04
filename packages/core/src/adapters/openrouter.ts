import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { buildChildEnv } from '../accounts/env.js';
import { isTransientFailure } from './limits.js';
import type { AdapterEvent, ResolvedAccount, Usage } from '../types.js';

/**
 * Open-weight models over OpenRouter's HTTP API — the only provider here that
 * is not a CLI, and the only one that costs the user nothing.
 *
 * It exists for one job: the second opinion. A review needs a model from a
 * different lab reading a diff, which is a single stateless request — no tools,
 * no sandbox, no session. That is precisely what a free tier can carry, and
 * precisely what makes this provider useless as an author (see
 * `REVIEW_ONLY_PROVIDERS`).
 *
 * Two facts about free tiers shape the code below. The free model list rotates
 * without notice, so a pinned model id will eventually 404 — `run` walks a
 * chain instead of trusting one. And free capacity runs out both per-model
 * (busy hour) and per-account (daily cap), both reported as 429 — so a 429 is
 * worth retrying on another model before it is believed as a real limit.
 */

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Ordered by usefulness as a reviewer: reasoning first, then a coder model with
 * a large window, then a generalist as the last resort. Ids ending in `:free`
 * are the zero-cost variants; everything else on OpenRouter bills the account.
 */
export const OPENROUTER_FREE_MODELS = [
  { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (free)' },
  { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder (free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)' },
];

/** A model that is gone or unroutable right now — try the next one instead. */
function isModelUnavailable(status: number, body: string): boolean {
  return status === 404 || /no (?:endpoints|allowed providers) found|not a valid model/i.test(body);
}

interface StreamChoice {
  delta?: { content?: string | null };
}

interface StreamChunk {
  choices?: StreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = 'openrouter' as const;
  readonly displayName = 'OpenRouter (free models)';
  /** Stateless HTTP; the caller supplies whatever history matters. */
  readonly supportsNativeResume = false;
  readonly models = OPENROUTER_FREE_MODELS;

  // Wrapped rather than passed as a bare reference so the global keeps its own
  // receiver when it is called as a method of this adapter.
  constructor(private fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildChildEnv(account, base);
  }

  async *run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const key = account.secret?.trim();
    if (!key) {
      yield {
        type: 'error',
        message: 'no OpenRouter API key stored for this account — re-add it to save one',
        retryable: false,
      };
      return;
    }

    // A requested model is tried first, then the rest of the free chain.
    const chain = req.model
      ? [req.model, ...this.models.map((m) => m.id).filter((id) => id !== req.model)]
      : this.models.map((m) => m.id);

    for (let i = 0; i < chain.length; i++) {
      if (signal.aborted) return;
      const model = chain[i]!;
      const isLast = i === chain.length - 1;

      let response: Response;
      try {
        response = await this.open(model, key, req, signal);
      } catch (e) {
        if (signal.aborted) return;
        const message = (e as Error).message;
        yield { type: 'error', message, retryable: isTransientFailure(message) };
        return;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = errorMessage(body) ?? `${response.status} ${response.statusText}`;

        // Both "this model is gone" and "this model is busy" are worth trying
        // the next free model for; only the last one is believed.
        if (!isLast && (isModelUnavailable(response.status, body) || response.status === 429)) {
          continue;
        }
        yield response.status === 429
          ? // OpenRouter's free allowance is a daily count; the tracker parks
            // the account until it rolls over rather than retrying all day.
            { type: 'limit', scope: 'daily', raw: detail }
          : { type: 'error', message: `OpenRouter: ${detail}`, retryable: response.status >= 500 };
        return;
      }

      yield* this.stream(response, signal);
      return;
    }
  }

  private open(
    model: string,
    key: string,
    req: RunRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    const brief = req.systemBrief?.trim();
    if (brief) messages.push({ role: 'system', content: brief });
    messages.push({ role: 'user', content: req.prompt });

    return this.fetchImpl(API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Attribution headers OpenRouter uses for its app leaderboard.
        'HTTP-Referer': 'https://github.com/bulsana/usturlab',
        'X-Title': 'usturlab',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        usage: { include: true },
      }),
    });
  }

  /** Server-sent events → text deltas, then one result carrying the whole answer. */
  private async *stream(response: Response, signal: AbortSignal): AsyncGenerator<AdapterEvent> {
    const body = response.body;
    if (!body) {
      yield { type: 'error', message: 'OpenRouter returned an empty stream', retryable: true };
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: Usage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          // Keep-alive comments (": OPENROUTER PROCESSING") arrive between events.
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            continue;
          }
          if (chunk.error?.message) {
            yield { type: 'error', message: `OpenRouter: ${chunk.error.message}`, retryable: false };
            return;
          }
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
          }
          // Reasoning models also stream a `reasoning` field; the answer is
          // what the caller asked for, so only `content` is collected.
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            yield { type: 'text-delta', text: delta };
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      const message = (e as Error).message;
      // A dropped stream that already produced an answer is still an answer.
      if (!text.trim()) {
        yield { type: 'error', message, retryable: isTransientFailure(message) };
        return;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }

    if (signal.aborted) return;
    yield { type: 'result', text, usage, costUsd: 0 };
  }

  interactiveCommand(): { command: string[]; env: NodeJS.ProcessEnv } {
    // Nothing to attach a terminal to — this provider is an HTTP call, and the
    // host filters it out of the interactive picker for that reason.
    throw new Error('OpenRouter has no interactive CLI — it is used for reviews only');
  }

  loginFlow(): LoginFlow {
    // Unreachable: the account wizard offers OpenRouter only as an API key,
    // which never reaches a login flow.
    throw new Error(
      'OpenRouter is connected with an API key from openrouter.ai/keys — there is no login flow',
    );
  }
}

/** OpenRouter reports failures as `{ error: { message } }`; fall back to raw text. */
function errorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return body.trim() ? body.trim().slice(0, 300) : undefined;
}
