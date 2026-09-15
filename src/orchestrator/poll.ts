import { randomUUID } from 'node:crypto';
import { resolveTelegramChatId } from '../config';
import { ConversationState, ConversationRole } from '../types';
import {
  fetchWithdrawalFeed,
  findMatchingWithdrawal,
  findResolvedOutcome,
  classifyOutcome,
  getEtaText,
} from '../feed/withdrawalFeed';
import { FeedAlert } from '../feed/types';
import {
  getOpenConversations,
  getKnownPaymentIds,
  getMostRecentTelegramChatIdForCustomer,
  createConversation,
  updateConversation,
  insertHistory,
  insertScenarioContext,
  getScenarioContext,
} from '../db/conversations';
import { sendTelegramMessage } from '../channels/telegram';
import { draftFirstMessage, draftCheckin, draftResolution, WithdrawalContext } from '../ai/drafts';
import { resolvedWhileTakenOverNote } from '../messages/templates';

const CHECKIN_INTERVAL_MINUTES = 10;

function toWithdrawalContext(convo: ConversationState, etaText: string | null): WithdrawalContext {
  return {
    customerName: convo.customer_name,
    amount: convo.amount,
    currency: convo.currency,
    etaText,
    paymentId: convo.payment_id,
  };
}

// Falls back to a last-known snapshot (captured while the withdrawal was
// still visible in the feed) when the withdrawal has fully aged out of the
// feed's visibility and findResolvedOutcome can no longer find it anywhere.
function resolveOutcome(
  liveOutcome: ReturnType<typeof findResolvedOutcome>,
  lastKnownStatus: string | null,
  lastKnownRemark: string | null
): ReturnType<typeof findResolvedOutcome> {
  if (liveOutcome) return liveOutcome;
  if (!lastKnownStatus) return null;
  return {
    category: classifyOutcome(lastKnownStatus, lastKnownRemark),
    rawStatus: lastKnownStatus,
    rawRemark: lastKnownRemark,
  };
}

async function logAndMaybeSend(params: {
  conversation: ConversationState;
  role: ConversationRole;
  message: string;
  sendToCustomer: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { conversation, role, message, sendToCustomer, metadata } = params;

  if (sendToCustomer) {
    const chatId = resolveTelegramChatId(conversation.customer_id, conversation.telegram_chat_id);
    if (chatId) {
      await sendTelegramMessage(String(chatId), message);
    }
  }

  await insertHistory({
    conversation_id: conversation.conversation_id,
    customer_id: conversation.customer_id,
    role,
    message,
    sent_at: new Date().toISOString(),
    metadata: metadata ?? null,
  });
}

async function handleNewWithdrawal(alert: FeedAlert, now: Date, allAlerts: FeedAlert[]): Promise<void> {
  const matched = findMatchingWithdrawal(alert);
  const etaText = getEtaText(alert);
  const existingChatId = await getMostRecentTelegramChatIdForCustomer(alert.userId);
  const telegramChatId = resolveTelegramChatId(alert.userId, existingChatId);

  const conversation: ConversationState = {
    conversation_id: randomUUID(),
    customer_id: alert.userId,
    payment_id: alert.paymentId,
    status: 'autonomous',
    reason: matched?.remark ?? null,
    category: 'withdrawal_delay',
    priority: null,
    amount: Number(alert.amount) || matched?.amount || null,
    currency: alert.currency ?? null,
    customer_name: alert.player?.identity?.username ?? null,
    vip: null,
    telegram_chat_id: telegramChatId,
    taken_over_by: null,
    checkin_count: 0,
    first_seen_at: alert.createdAt,
    agent_last_message_at: null,
    last_webhook_flag_at: null,
    last_known_status: matched?.status ?? null,
    last_known_remark: matched?.remark ?? null,
  };

  await createConversation(conversation);
  await insertScenarioContext({
    conversation_id: conversation.conversation_id,
    customer_id: conversation.customer_id,
    event_type: 'withdrawal_delay',
    event_payload: alert as unknown as Record<string, unknown>,
    objective:
      'Reassure the customer about a delayed withdrawal without asserting an unverified root cause, and keep them updated until it resolves.',
    eta_text: etaText,
  });

  // The feed lists this payment_id for the first time, but it may already be
  // resolved by the moment we see it (e.g. rejected within the same poll
  // window it first appeared, or a slow first sighting). Sending "still
  // pending" for something already decided would be dishonest — check the
  // feed's own live status before assuming it's actually pending.
  if (alert.status !== 'pending') {
    const outcome = resolveOutcome(
      findResolvedOutcome(alert.paymentId, allAlerts),
      conversation.last_known_status,
      conversation.last_known_remark
    );
    const message = await draftResolution(
      toWithdrawalContext(conversation, etaText),
      outcome ? { category: outcome.category } : null
    );
    await logAndMaybeSend({ conversation, role: 'agent', message, sendToCustomer: true });
    await updateConversation(conversation.conversation_id, {
      status: 'resolved',
      resolution_outcome: outcome?.category ?? 'unknown',
      resolution_reason: outcome?.rawRemark ?? null,
    });
    return;
  }

  const message = await draftFirstMessage(toWithdrawalContext(conversation, etaText));

  await logAndMaybeSend({ conversation, role: 'agent', message, sendToCustomer: true });
  await updateConversation(conversation.conversation_id, { agent_last_message_at: now.toISOString() });
}

async function handleResolved(convo: ConversationState, allAlerts: FeedAlert[]): Promise<void> {
  const humanOwnsIt = Boolean(convo.taken_over_by);
  const outcome = resolveOutcome(
    findResolvedOutcome(convo.payment_id, allAlerts),
    convo.last_known_status,
    convo.last_known_remark
  );

  if (humanOwnsIt) {
    await logAndMaybeSend({
      conversation: convo,
      role: 'system',
      message: resolvedWhileTakenOverNote(convo.payment_id),
      sendToCustomer: false,
    });
    await updateConversation(convo.conversation_id, {
      status: 'resolved',
      resolution_outcome: outcome?.category ?? 'unknown',
      resolution_reason: outcome?.rawRemark ?? null,
    });
    return;
  }

  const scenario = await getScenarioContext(convo.conversation_id);
  const message = await draftResolution(
    toWithdrawalContext(convo, scenario?.eta_text ?? null),
    outcome ? { category: outcome.category } : null
  );

  await logAndMaybeSend({ conversation: convo, role: 'agent', message, sendToCustomer: true });
  await updateConversation(convo.conversation_id, {
    status: 'resolved',
    resolution_outcome: outcome?.category ?? 'unknown',
    resolution_reason: outcome?.rawRemark ?? null,
  });
}

async function maybeCheckin(convo: ConversationState, now: Date): Promise<void> {
  if (convo.taken_over_by) return;
  if (convo.status !== 'autonomous' && convo.status !== 'monitoring') return;
  if (!convo.agent_last_message_at) return;

  const minutesSinceLastMessage =
    (now.getTime() - new Date(convo.agent_last_message_at).getTime()) / 60000;
  if (minutesSinceLastMessage < CHECKIN_INTERVAL_MINUTES) return;

  const nextCheckinNumber = convo.checkin_count === 0 ? 1 : 2;
  const scenario = await getScenarioContext(convo.conversation_id);
  const message = await draftCheckin(toWithdrawalContext(convo, scenario?.eta_text ?? null), nextCheckinNumber);

  await logAndMaybeSend({ conversation: convo, role: 'agent', message, sendToCustomer: true });
  await updateConversation(convo.conversation_id, {
    checkin_count: convo.checkin_count + 1,
    status: 'monitoring',
    agent_last_message_at: now.toISOString(),
  });
}

export async function runPollCycle(): Promise<void> {
  const now = new Date();
  const alerts = await fetchWithdrawalFeed();
  const feedByPaymentId = new Map(alerts.map((a) => [a.paymentId, a]));

  const openConversations = await getOpenConversations();

  for (const convo of openConversations) {
    try {
      const feedAlert = feedByPaymentId.get(convo.payment_id);

      // While the withdrawal is still visible anywhere in the feed, snapshot
      // its live status/remark so that if it later disappears entirely (no
      // trace in anyone's player.recentWithdrawals), handleResolved still has
      // a last-known outcome to fall back on instead of defaulting to
      // "unknown".
      if (feedAlert) {
        const matched = findMatchingWithdrawal(feedAlert);
        if (matched) {
          await updateConversation(convo.conversation_id, {
            last_known_status: matched.status ?? null,
            last_known_remark: matched.remark ?? null,
          });
          convo.last_known_status = matched.status ?? null;
          convo.last_known_remark = matched.remark ?? null;
        }
      }

      const stillPending = feedAlert ? feedAlert.status === 'pending' : false;

      if (!stillPending) {
        await handleResolved(convo, alerts);
      } else {
        await maybeCheckin(convo, now);
      }
    } catch (err) {
      console.error(`Poll cycle: failed processing conversation ${convo.conversation_id}`, err);
    }
  }

  const paymentIds = alerts.map((a) => a.paymentId);
  const knownPaymentIds = await getKnownPaymentIds(paymentIds);
  const newAlerts = alerts.filter((a) => !knownPaymentIds.has(a.paymentId));

  for (const alert of newAlerts) {
    try {
      await handleNewWithdrawal(alert, now, alerts);
    } catch (err) {
      console.error(`Poll cycle: failed onboarding new withdrawal ${alert.paymentId}`, err);
    }
  }
}