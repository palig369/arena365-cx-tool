import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIClient {
  complete(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
  /**
   * Forces the model to return a structured object matching inputSchema
   * (a JSON Schema object), instead of relying on the model to voluntarily
   * produce valid JSON as plain text. Implemented via Anthropic's tool-use
   * with a forced tool_choice, which guarantees a parseable object back.
   */
  completeStructured<T = unknown>(
    messages: ChatMessage[],
    toolName: string,
    inputSchema: Record<string, unknown>,
    opts?: { maxTokens?: number; temperature?: number }
  ): Promise<T>;
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Anthropic-backed implementation. Every other file in this project talks to
 * the `AIClient` interface only, never to the Anthropic SDK directly.
 *
 * Anthropic's API takes the system prompt as a separate top-level `system`
 * param, not as a message in the messages array — so any `role: 'system'`
 * entries in the incoming ChatMessage[] are extracted and joined into that
 * param, and only user/assistant turns are passed as `messages`.
 */
class AnthropicClient implements AIClient {
  private splitMessages(messages: ChatMessage[]) {
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const conversationMessages = messages
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    return { systemText, conversationMessages };
  }

  private async request(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    const { systemText, conversationMessages } = this.splitMessages(messages);

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 400,
      temperature: opts.temperature ?? 0.4,
      system: systemText || undefined,
      messages: conversationMessages,
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const content = textBlock && 'text' in textBlock ? textBlock.text : undefined;

    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Anthropic returned an empty completion.');
    }
    return content.trim();
  }

  private async requestStructured<T>(
    messages: ChatMessage[],
    toolName: string,
    inputSchema: Record<string, unknown>,
    opts: { maxTokens?: number; temperature?: number }
  ): Promise<T> {
    const { systemText, conversationMessages } = this.splitMessages(messages);

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 400,
      temperature: opts.temperature ?? 0.4,
      system: systemText || undefined,
      messages: conversationMessages,
      tools: [
        {
          name: toolName,
          description: `Call this with the ${toolName} response. This is the only way to respond.`,
          input_schema: inputSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: toolName },
    });

    const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      throw new Error('Anthropic did not return a tool_use block for the forced tool call.');
    }
    return toolUseBlock.input as T;
  }

  async complete(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number } = {}
  ): Promise<string> {
    try {
      return await this.request(messages, opts);
    } catch (err) {
      console.log(`AnthropicClient.complete: first attempt failed (${(err as Error).message}). Retrying once.`);
      return await this.request(messages, opts);
    }
  }

  async completeStructured<T = unknown>(
    messages: ChatMessage[],
    toolName: string,
    inputSchema: Record<string, unknown>,
    opts: { maxTokens?: number; temperature?: number } = {}
  ): Promise<T> {
    try {
      return await this.requestStructured<T>(messages, toolName, inputSchema, opts);
    } catch (err) {
      console.log(
        `AnthropicClient.completeStructured: first attempt failed (${(err as Error).message}). Retrying once.`
      );
      return await this.requestStructured<T>(messages, toolName, inputSchema, opts);
    }
  }
}

export const aiClient: AIClient = new AnthropicClient();