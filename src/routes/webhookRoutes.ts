import { Router } from 'express';
import { TelegramUpdate, sendTelegramMessage } from '../channels/telegram';
import {
  getOpenConversationByTelegramChatId,
  insertHistory,
  updateConversation,
  getHistoryForConversation,
  getScenarioContext,
} from '../db/conversations';
import { draftReply } from '../ai/drafts';
import { config } from '../config';

export const webhookRouter = Router();

// Inbound Telegram webhook: https://core.telegram.org/bots/api#update
webhookRouter.post('/telegram', async (req, res) => {
  try {
    const update = req.body as TelegramUpdate;
    const message = update?.message;
    if (!message?.text || message.chat?.id === undefined) {
      res.sendStatus(200);
      return;
    }

    const chatId = String(message.chat.id);
    const convo = await getOpenConversationByTelegramChatId(chatId);
    if (!convo) {
      // Nothing to attach this to. Most likely this chat has no open withdrawal
      // conversation (or was never linked). We don't have a fallback table for
      // unmatched inbound messages per the current schema, so just log and drop.
      console.warn(`Telegram message from chat ${chatId} matched no open conversation, dropping.`);
      res.sendStatus(200);
      return;
    }

    // Defense-in-depth: the test chat is only ever supposed to represent a customer
    // in TEST_USER_IDS (that's what the outbound fallback in resolveTelegramChatId
    // enforces when a conversation is created). If this chat id is the test chat but
    // the conversation it matched belongs to a customer_id that isn't a test user,
    // something upstream mislinked it (e.g. a bad /human/link-telegram call) — refuse
    // to route it as that customer's message rather than silently attaching a real
    // customer's conversation to the tester's personal chat.
    if (
      config.testTelegramChatId &&
      chatId === config.testTelegramChatId &&
      !config.testUserIds?.includes(convo.customer_id)
    ) {
      console.error(
        `Telegram message from the TEST_TELEGRAM_CHAT_ID matched conversation ${convo.conversation_id} for customer ${convo.customer_id}, who is not in TEST_USER_IDS. Dropping instead of misattributing it.`
      );
      res.sendStatus(200);
      return;
    }

    const now = new Date().toISOString();
    await insertHistory({
      conversation_id: convo.conversation_id,
      customer_id: convo.customer_id,
      role: 'customer',
      message: message.text,
      sent_at: now,
      metadata: null,
    });
    await updateConversation(convo.conversation_id, { last_webhook_flag_at: now });

    const humanOwnsIt = Boolean(convo.taken_over_by) || convo.status === 'human_required';
    if (humanOwnsIt) {
      // Logged above; a human is driving this one, so the AI stays out of it.
      res.sendStatus(200);
      return;
    }

    const [fullHistory, scenario] = await Promise.all([
      getHistoryForConversation(convo.conversation_id),
      getScenarioContext(convo.conversation_id),
    ]);
    // Only the last few turns matter for replying to the current message —
    // sending the entire history overwhelms a small model with repeated
    // generic check-ins and makes it default to stock phrasing.
    const history = fullHistory.slice(-6);

    const reply = await draftReply(
      {
        customerName: convo.customer_name,
        amount: convo.amount,
        currency: convo.currency,
        etaText: scenario?.eta_text ?? null,
        paymentId: convo.payment_id,
        reasonHint: convo.reason,
      },
      history.map((h) => ({ role: h.role, message: h.message }))
    );

    await sendTelegramMessage(chatId, reply);
    const replyAt = new Date().toISOString();
    await insertHistory({
      conversation_id: convo.conversation_id,
      customer_id: convo.customer_id,
      role: 'agent',
      message: reply,
      sent_at: replyAt,
      metadata: null,
    });
    await updateConversation(convo.conversation_id, { agent_last_message_at: replyAt });

    res.sendStatus(200);
  } catch (err) {
    console.error('Error handling Telegram webhook', err);
    // Still 200 so Telegram doesn't retry-storm us over a bug we've already logged.
    res.sendStatus(200);
  }
});