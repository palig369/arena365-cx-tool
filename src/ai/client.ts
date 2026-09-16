import { config } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIClient {
  complete(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

// llama-3.1-8b-instant is retired / unavailable on this account's Groq catalog
// (confirmed via GET /openai/v1/models); openai/gpt-oss-20b is the closest
// free-tier, fast, instruction-tuned equivalent.
const GROQ_MODEL = 'openai/gpt-oss-20b';

/**
 * Groq-backed implementation. Every other file in this project talks to
 * the `AIClient` interface only, never to Groq directly.
 *
 * We moved here from OpenRouter because OpenRouter blocks all requests
 * (even free models) once the account balance goes negative. Groq's free
 * tier has no such restriction.
 *
 * To switch to calling Anthropic directly later: replace this class's body
 * with one built on @anthropic-ai/sdk (same `complete` signature), point the
 * `aiClient` export at it, and nothing else in the codebase needs to change.
 *
 * NOTE: openai/gpt-oss-20b is a reasoning model — it spends part of max_tokens
 * on a hidden "reasoning" pass before writing the visible content. Callers in
 * this app use small budgets (80-150 tokens) for short customer-facing drafts,
 * so reasoning_effort is pinned to "low" to keep that budget mostly available
 * for content; without it, reasoning alone can consume the whole budget and
 * come back as an empty completion.
 *
 * NOTE: gpt-oss-20b occasionally emits a spontaneous tool-call-shaped response
 * even though we never pass any `tools` — Groq then rejects the request with
 * a 400 "Tool choice is none, but model called a tool" error, since there is
 * nothing to call. response_format: { type: 'json_object' } forces the model
 * to return plain JSON as regular content instead, which suppresses this
 * behaviour. As a second line of defence, a single automatic retry is applied
 * below for both this error and a truncated/empty completion, so one flaky
 * response doesn't silently drop an entire caller-side operation (e.g. a
 * poll-cycle check-in).
 */
class GroqClient implements AIClient {
  private async request(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.4,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq request failed: ${res.status} ${res.statusText} ${body}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Groq returned an empty completion.');
    }
    return content.trim();
  }

  async complete(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number } = {}
  ): Promise<string> {
    try {
      return await this.request(messages, opts);
    } catch (err) {
      console.log(`GroqClient.complete: first attempt failed (${(err as Error).message}). Retrying once.`);
      return await this.request(messages, opts);
    }
  }
}

export const aiClient: AIClient = new GroqClient();