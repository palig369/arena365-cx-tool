import { aiClient, ChatMessage } from './client';
import { ConversationRole } from '../types';

// Baked into every system prompt below. Keep these in sync if the honesty
// requirements ever change; don't loosen them per-call.
export const HONESTY_RULES = `
Honesty rules, follow these exactly:
- Never assert a root cause that hasn't been confirmed. Say the withdrawal is pending and being looked into. Do not blame a specific system, team, or reason unless it has been explicitly confirmed to you.
- Do not promise a resolution time you don't actually know.
- No em dashes. No flowery language.
- Never narrate your own honesty (do not say things like "I won't lie to you" or "to be honest"). Just say the plain thing.
- Write like a real support agent typing quickly: short, plain sentences. No corporate tone, no exclamation points.
`.trim();

export const SCOPE_RULE = `
Stay strictly scoped to this one withdrawal issue. If the customer asks about anything unrelated, politely say this chat is for this specific withdrawal and to reach out through the normal channel for anything else.
`.trim();

export interface WithdrawalContext {
  customerName: string | null;
  amount: number | null;
  currency: string | null;
  etaText: string | null;
  paymentId: string;
}

function etaInstruction(etaText: string | null): string {
  return etaText
    ? `You may mention that this typically takes ${etaText}, but don't sound certain it applies to this specific case.`
    : `Do not give a specific timeframe. This payment method doesn't have a reliable ETA to quote.`;
}

export async function draftFirstMessage(
  ctx: WithdrawalContext,
  opts: { alreadyDelayed?: boolean } = {}
): Promise<string> {
  const system = [
    'You are a customer support agent messaging a customer about a delayed withdrawal for the first time.',
    HONESTY_RULES,
    'The message must be 1 to 2 sentences, under 35 words total.',
    ...(opts.alreadyDelayed
      ? [
          "This withdrawal has already been pending for a while by the time you're reaching out. Don't say you just noticed it or imply it's fresh. Acknowledge it's taking longer than it should and that it's being looked into closely, without giving a reason.",
        ]
      : []),
    etaInstruction(ctx.etaText),
    "Don't use the customer's name more than once, if at all. Don't sign off with a name.",
  ].join('\n');

  const user = [
    'Draft the first outreach message about this withdrawal.',
    `Amount: ${ctx.amount ?? 'unknown'} ${ctx.currency ?? ''}`.trim(),
    `Payment reference: ${ctx.paymentId}`,
  ].join('\n');

  return aiClient.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 120 }
  );
}

export async function draftCheckin(ctx: WithdrawalContext, checkinNumber: 1 | 2): Promise<string> {
  const system = [
    'You are a customer support agent sending a brief check-in about a withdrawal that is still pending.',
    HONESTY_RULES,
    'The message must be under 25 words, ideally one short sentence.',
    checkinNumber === 1
      ? 'This is the first check-in since the initial message. There is no new information yet, you are just letting them know it is still being looked at.'
      : 'This is a second check-in. Still no resolution and no new information. You can note it is getting closer attention, without promising a timeline or outcome.',
    etaInstruction(ctx.etaText),
    "Don't use the customer's name. Don't sign off with a name.",
  ].join('\n');

  const user = [
    'Draft a short check-in message about this still-pending withdrawal.',
    `Amount: ${ctx.amount ?? 'unknown'} ${ctx.currency ?? ''}`.trim(),
    `Payment reference: ${ctx.paymentId}`,
  ].join('\n');

  return aiClient.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 80 }
  );
}

export async function draftResolution(ctx: WithdrawalContext): Promise<string> {
  const system = [
    'You are a customer support agent messaging a customer whose withdrawal is no longer showing as pending in the system.',
    HONESTY_RULES,
    'You do not know for certain the money has landed, only that it is no longer pending on your end. Frame the message as confirming the outcome, never as announcing success.',
    'The message must be 1 to 2 short sentences.',
    "Don't use the customer's name. Don't sign off with a name.",
  ].join('\n');

  const user = [
    'Draft a message telling the customer their withdrawal is no longer showing as pending, and that you are confirming the outcome.',
    `Amount: ${ctx.amount ?? 'unknown'} ${ctx.currency ?? ''}`.trim(),
    `Payment reference: ${ctx.paymentId}`,
  ].join('\n');

  return aiClient.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 100 }
  );
}

export interface HistoryMessage {
  role: ConversationRole;
  message: string;
}

export async function draftReply(ctx: WithdrawalContext, history: HistoryMessage[]): Promise<string> {
  const system = [
    `You are a customer support agent replying to a customer about their delayed withdrawal (payment reference ${ctx.paymentId}).`,
    HONESTY_RULES,
    SCOPE_RULE,
    'Keep the reply short, a sentence or two, like a real agent typing in a chat.',
    etaInstruction(ctx.etaText),
  ].join('\n');

  // The AI only ever sees this as a two-sided conversation: customer messages
  // are "user" turns, everything the customer has seen from us (agent
  // check-ins, human agent messages, this AI) are "assistant" turns. Internal
  // system notes are never shown to the customer, so they're excluded here.
  const historyAsChat: ChatMessage[] = history
    .filter((h) => h.role !== 'system')
    .map((h) => ({
      role: h.role === 'customer' ? 'user' : 'assistant',
      content: h.message,
    }));

  return aiClient.complete(
    [{ role: 'system', content: system }, ...historyAsChat],
    { maxTokens: 150 }
  );
}
