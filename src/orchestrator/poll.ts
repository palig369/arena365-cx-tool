import { randomUUID } from 'node:crypto';
import { resolveTelegramChatId } from '../config';
import { ConversationState, ConversationRole } from '../types';
import {
  fetchWithdrawalFeed,
  findMatchingWithdrawal,
  getWithdrawalAgeMinutes,
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
import {
  escalationInternalNote,
  twoCheckinsEscalationNote,
  resolvedWhileTakenOverNote,
} from '../messages/templates';

const CHECKIN_INTERVAL_MINUTES = 10;
const ALREADY_OLD_THRESHOLD_MINUTES = 10;

function toWithdrawalContext(convo: ConversationState, etaText: string | null): WithdrawalContext {
  return {
    customerName: convo.customer_name,
    amount: convo.amount,
    currency: convo.currency,
    etaText,
    paymentId: convo.payment_id,
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

async function handleNewWithdrawal(alert: FeedAlert, now: Date): Promise<void> {
  const matched = findMatchingWithdrawal(alert);
  const ageMinutes = getWithdrawalAgeMinutes(alert, now);
  const etaText = getEtaText(alert);
  const existingChatId = await getMostRecentTelegramChatIdForCustomer(alert.userId);
  // Resolve (and persist below) the test fallback here too, not just at send time.
  // The DB column is the source of truth inbound replies are matched against, so if
  // we only applied the fallback when sending, a test customer's row would keep
  // telegram_chat_id = null and their replies would never match anything.
  // resolveTelegramChatId only ever substitutes TEST_TELEGRAM_CHAT_ID when alert.userId
  // is in TEST_USER_IDS, so this column never ends up holding the test chat id for a
  // real customer.
  const telegramChatId = resolveTelegramChatId(alert.userId, existingChatId);
  const isAlreadyOld = ageMinutes > ALREADY_OLD_THRESHOLD_MINUTES;

  const conversation: ConversationState = {
    conversation_id: randomUUID(),
    customer_id: alert.userId,
    payment_id: alert.paymentId,
    status: isAlreadyOld ? 'human_required' : 'autonomous',
    // Internal only: never surfaced to the customer as a confirmed cause.
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

  if (isAlreadyOld) {
    // Already stale by the time we saw it: log why we're escalating straight to a
    // human, then still send the customer an honest holding message. It must not
    // pretend this just started, only that it's taking longer than it should and
    // is being looked into (see draftFirstMessage's alreadyDelayed prompt branch).
    await logAndMaybeSend({
      conversation,
      role: 'system',
      message: escalationInternalNote(ageMinutes),
      sendToCustomer: false,
    });

    const staleMessage = await draftFirstMessage(toWithdrawalContext(conversation, etaText), {
      alreadyDelayed: true,
    });
    await logAndMaybeSend({ conversation, role: 'agent', message: staleMessage, sendToCustomer: true });
    await updateConversation(conversation.conversation_id, { agent_last_message_at: now.toISOString() });
    return;
  }

  const message = await draftFirstMessage(toWithdrawalContext(conversation, etaText));

  await logAndMaybeSend({ conversation, role: 'agent', message, sendToCustomer: true });
  await updateConversation(conversation.conversation_id, { agent_last_message_at: now.toISOString() });
}

async function handleResolved(convo: ConversationState): Promise<void> {
  const humanOwnsIt = Boolean(convo.taken_over_by);

  if (humanOwnsIt) {
    // Don't auto-message a customer whose conversation a human is actively driving;
    // log it internally and let the human relay it.
    await logAndMaybeSend({
      conversation: convo,
      role: 'system',
      message: resolvedWhileTakenOverNote(convo.payment_id),
      sendToCustomer: false,
    });
    await updateConversation(convo.conversation_id, { status: 'resolved' });
    return;
  }

  const scenario = await getScenarioContext(convo.conversation_id);
  const message = await draftResolution(toWithdrawalContext(convo, scenario?.eta_text ?? null));

  await logAndMaybeSend({ conversation: convo, role: 'agent', message, sendToCustomer: true });
  await updateConversation(convo.conversation_id, { status: 'resolved' });
}

async function maybeCheckin(convo: ConversationState, now: Date): Promise<void> {
  if (convo.taken_over_by) return; // human owns this, no automatic check-ins
  if (convo.status !== 'autonomous' && convo.status !== 'monitoring') return;
  if (!convo.agent_last_message_at) return; // nothing sent yet, nothing to check in about

  const minutesSinceLastMessage =
    (now.getTime() - new Date(convo.agent_last_message_at).getTime()) / 60000;
  if (minutesSinceLastMessage < CHECKIN_INTERVAL_MINUTES) return;

  if (convo.checkin_count === 0 || convo.checkin_count === 1) {
    const checkinNumber = convo.checkin_count === 0 ? 1 : 2;
    const scenario = await getScenarioContext(convo.conversation_id);
    const message = await draftCheckin(toWithdrawalContext(convo, scenario?.eta_text ?? null), checkinNumber);

    await logAndMaybeSend({ conversation: convo, role: 'agent', message, sendToCustomer: true });
    await updateConversation(convo.conversation_id, {
      checkin_count: checkinNumber,
      status: 'monitoring',
      agent_last_message_at: now.toISOString(),
    });
    return;
  }

  // checkin_count >= 2 and still unresolved another interval after check-in #2: escalate, no more messages.
  await logAndMaybeSend({
    conversation: convo,
    role: 'system',
    message: twoCheckinsEscalationNote(),
    sendToCustomer: false,
  });
  await updateConversation(convo.conversation_id, { status: 'human_required' });
}

export async function runPollCycle(): Promise<void> {
  const now = new Date();
  const alerts = await fetchWithdrawalFeed();
  const feedByPaymentId = new Map(alerts.map((a) => [a.paymentId, a]));

  const openConversations = await getOpenConversations();

  // Resolution detection + check-in loop over everything currently open.
  for (const convo of openConversations) {
    try {
      if (!feedByPaymentId.has(convo.payment_id)) {
        await handleResolved(convo);
      } else {
        await maybeCheckin(convo, now);
      }
    } catch (err) {
      console.error(`Poll cycle: failed processing conversation ${convo.conversation_id}`, err);
    }
  }

  // New withdrawal detection, checked against ALL known payment_ids (not just open ones)
  // so a payment_id is never double-onboarded.
  const paymentIds = alerts.map((a) => a.paymentId);
  const knownPaymentIds = await getKnownPaymentIds(paymentIds);
  const newAlerts = alerts.filter((a) => !knownPaymentIds.has(a.paymentId));

  for (const alert of newAlerts) {
    try {
      await handleNewWithdrawal(alert, now);
    } catch (err) {
      console.error(`Poll cycle: failed onboarding new withdrawal ${alert.paymentId}`, err);
    }
  }
}
