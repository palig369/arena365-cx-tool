import { aiClient, ChatMessage } from './client';
import { ConversationRole } from '../types';

export const CHECKIN_INTERVAL_MINUTES = 10;

export const HONESTY_RULES = `
Honesty rules, follow these exactly:
- Never assert a root cause that hasn't been confirmed. Say the withdrawal is pending and being looked into. Do not blame a specific system, team, or reason unless it has been explicitly confirmed to you.
- Do not promise a resolution time you don't actually know.
- No em dashes. No flowery language.
- Never narrate your own honesty (do not say things like "I won't lie to you" or "to be honest"). Just say the plain thing.
- Write like a real support agent typing quickly: short, plain sentences. No corporate tone, no exclamation points.
- Always give the customer a concrete next update time, never a vague open-ended line like "we'll be in touch if something happens." A customer should never be left wondering when they'll hear from you next.
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
  reasonHint?: string | null;
}

function etaInstruction(etaText: string | null): string {
  return etaText
    ? `You may mention that this typically takes ${etaText}, but don't sound certain it applies to this specific case.`
    : `Do not give a specific timeframe for how long the withdrawal itself will take. This payment method doesn't have a reliable ETA to quote.`;
}

function nextUpdateInstruction(): string {
  return `Tell them you'll update them again in ${CHECKIN_INTERVAL_MINUTES} minutes. That promise is about your next check-in, not the withdrawal itself.`;
}

function reasonInstruction(reasonHint: string | null | undefined): string {
  return reasonHint
    ? `Internal note on why this is pending: "${reasonHint}". Never repeat this verbatim or name any internal system, team, or specific flag from it. If it's genuinely useful, translate it into a safe, generic customer-facing category (e.g. "manual review", "provider delay", "risk check") without naming what triggered it.`
    : 'You do not have a specific reason on file for this delay. If asked why, be honest that no cause has been confirmed yet rather than guessing.';
}

export async function draftFirstMessage(
  ctx: WithdrawalContext,
  opts: { alreadyDelayed?: boolean } = {}
): Promise<string> {
  const system = [
    'You are a customer support agent messaging a customer about a delayed withdrawal for the first time.',
    HONESTY_RULES,
    'The message must be 1 to 2 sentences, under 35 words total.',
    'Tell them you know about the pending withdrawal and are looking into it.',
    nextUpdateInstruction(),
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
  ].filter(Boolean).join('\n');

  return aiClient.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 120 }
  );
}

export async function draftCheckin(ctx: WithdrawalContext, checkinNumber: number): Promise<string> {
  const system = [
    'You are a customer support agent sending a check-in about a withdrawal that is still pending.',
    HONESTY_RULES,
    'The message must be under 25 words, ideally one short sentence.',
    'Tell them it is still pending and being looked into.',
    nextUpdateInstruction(),
    etaInstruction(ctx.etaText),
    "Don't use the customer's name. Don't sign off with a name.",
  ].join('\n');

  const user = [
    'Draft a short check-in message about this still-pending withdrawal.',
    `Amount: ${ctx.amount ?? 'unknown'} ${ctx.currency ?? ''}`.trim(),
    `Payment reference: ${ctx.paymentId}`,
  ].filter(Boolean).join('\n');

  return aiClient.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 80 }
  );
}

export interface ResolutionOutcome {
  category: 'completed' | 'rejected' | 'failed' | 'unknown';
}

export async function draftResolution(
  ctx: WithdrawalContext,
  outcome?: ResolutionOutcome | null
): Promise<string> {
  const category = outcome?.category ?? 'unknown';

  const outcomeInstruction =
    category === 'completed'
      ? 'The withdrawal has been approved and completed. State this plainly and positively, like good news, the way you would tell a customer their bank transfer just went through. Do not hedge or sound uncertain.'
      : category === 'rejected'
        ? 'The withdrawal was reviewed and rejected. State this plainly and directly, following a routine account review, without naming any internal system, team, or specific flag. Do not speculate further than that. Invite them to contact support if they want more detail on why, since you understand this is frustrating news.'
        : category === 'failed'
          ? 'The withdrawal could not be completed due to a technical issue on the payout side (for example, an invalid withdrawal address). State this plainly and invite them to check or update their withdrawal details before trying again, or contact support.'
          : `You do not know for certain the money has landed, only that it is no longer pending on your end. Frame the message as confirming the outcome, never as announcing success. If you still cannot confirm, tell them you'll update them again in ${CHECKIN_INTERVAL_MINUTES} minutes.`;

  const system = [
    'You are a customer support agent messaging a customer whose withdrawal is no longer showing as pending in the system.',
    HONESTY_RULES,
    outcomeInstruction,
    'The message must be 1 to 2 short sentences.',
    "Don't use the customer's name. Don't sign off with a name.",
  ].join('\n');

  const user = [
    category === 'unknown'
      ? 'Draft a message telling the customer their withdrawal is no longer showing as pending, and that you are confirming the outcome.'
      : `Draft a message telling the customer the outcome of their withdrawal (${category}).`,
    `Amount: ${ctx.amount ?? 'unknown'} ${ctx.currency ?? ''}`.trim(),
    `Payment reference: ${ctx.paymentId}`,
  ].filter(Boolean).join('\n');

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
    `You are a tier 1 customer support agent replying to a customer about their delayed withdrawal (payment reference ${ctx.paymentId}).`,
    HONESTY_RULES,
    SCOPE_RULE,
    'The customer just sent a new message. You must read exactly what they asked and answer that specific question. Do not reuse a stock phrase from an earlier message in this chat if the new message asks something different.',
    reasonInstruction(ctx.reasonHint),
    'Common withdrawal questions you should recognize and answer directly, not interchangeably:',
    '- "Why is it delayed / why is it pending?" -> explain the reason category if you have one (see above), otherwise say no cause is confirmed yet.',
    `- "When will it be approved / accepted / processed?" -> you cannot promise an exact time, but say it is actively being reviewed and give them the next check-in time (${CHECKIN_INTERVAL_MINUTES} minutes), do not just repeat "checking why it is pending."`,
    '- "Is my money safe / did I lose it?" -> reassure them plainly that the funds are safe and accounted for, this is a processing delay, not a loss.',
    '- "Can I cancel it?" -> tell them you will note the request and someone will follow up, since you cannot cancel it directly here.',
    '- "Did you get my message?" -> confirm yes, and restate where things currently stand.',
    '- "How long does this usually take?" -> use the ETA guidance below, do not invent a number if none applies.',
    'Keep the reply short, a sentence or two, like a real agent typing in a chat.',
    etaInstruction(ctx.etaText),
  ].join('\n');

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