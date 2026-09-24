import { Router } from 'express';
import { TelegramUpdate, sendTelegramMessage, downloadAndStoreTelegramPhoto } from '../channels/telegram';
import {
  getOpenConversationsByTelegramChatId,
  getAllConversationsByTelegramChatId,
  countOpenConversationsForCustomer,
  insertHistory,
  updateConversation,
  getHistoryForConversation,
  getScenarioContext,
} from '../db/conversations';
import { draftAgentMessage, CHECKIN_INTERVAL_MINUTES, WithdrawalStatus } from '../ai/drafts';
import { detectAndTranslateToEnglish, translateFromEnglish, SupportedLanguage } from '../ai/translate';
import {
  multipleOpenWithdrawalsClarification,
  askForReferenceIdClarification,
  noRecordFoundNote,
} from '../messages/templates';
import { config } from '../config';
import { ConversationState } from '../types';

export const webhookRouter = Router();

const RESOLUTION_STATUS_MAP: Record<string, WithdrawalStatus> = {
  completed: 'COMPLETED',
  rejected: 'REJECTED',
  failed: 'FAILED',
};

async function findConversationByReferenceId(
  chatId: string,
  messageText: string
): Promise<ConversationState | null> {
  const all = await getAllConversationsByTelegramChatId(chatId);
  const text = messageText.toLowerCase();
  const matches = all.filter((c) => {
    const shortRef = c.payment_id.slice(-8).toLowerCase();
    return text.includes(c.payment_id.toLowerCase()) || text.includes(shortRef);
  });
  return matches.length === 1 ? matches[0] : null;
}

function resolveIntendedConversationByAmount(
  messageText: string,
  openConversations: Awaited<ReturnType<typeof getOpenConversationsByTelegramChatId>>
) {
  const text = messageText.toLowerCase();
  const byAmount = openConversations.filter((c) => c.amount != null && text.includes(String(c.amount)));
  return byAmount.length === 1 ? byAmount[0] : null;
}

function logUnmatchedInbound(chatId: string, messageText: string, reason: string): void {
  console.warn(
    `Unmatched inbound Telegram message. chatId=${chatId} reason=${reason} text=${JSON.stringify(messageText)}`
  );
}

/**
 * Resolves which conversation an inbound message (text or photo) belongs to,
 * using the same reference-first / amount-fallback / ask-if-unclear logic
 * either way. Returns null (having already replied and closed the request)
 * when no conversation could be confidently determined — the caller should
 * stop processing in that case.
 */
async function resolveConversationOrRespond(
  chatId: string,
  textForMatching: string,
  res: { sendStatus: (code: number) => void }
): Promise<ConversationState | null> {
  const referenceMatch = await findConversationByReferenceId(chatId, textForMatching);
  if (referenceMatch) return referenceMatch;

  const openConversations = await getOpenConversationsByTelegramChatId(chatId);

  if (openConversations.length === 1) {
    return openConversations[0];
  }

  if (openConversations.length > 1) {
    const matched = resolveIntendedConversationByAmount(textForMatching, openConversations);
    if (matched) return matched;

    const mostRecent = openConversations[0];
    if (
      config.testTelegramChatId &&
      chatId === config.testTelegramChatId &&
      !config.testUserIds?.includes(mostRecent.customer_id)
    ) {
      console.error(
        `Telegram message from the TEST_TELEGRAM_CHAT_ID matched conversation ${mostRecent.conversation_id} for customer ${mostRecent.customer_id}, who is not in TEST_USER_IDS. Dropping instead of misattributing it.`
      );
      res.sendStatus(200);
      return null;
    }

    const clarification = multipleOpenWithdrawalsClarification(
      openConversations.map((c) => ({ amount: c.amount, currency: c.currency, payment_id: c.payment_id }))
    );
    const localizedClarification = await translateFromEnglish(
      clarification,
      (mostRecent.customer_language ?? 'en') as SupportedLanguage
    );
    await sendTelegramMessage(chatId, localizedClarification);
    const now = new Date().toISOString();
    await insertHistory({
      conversation_id: mostRecent.conversation_id,
      customer_id: mostRecent.customer_id,
      role: 'system',
      message: clarification,
      sent_at: now,
      metadata: { reason: 'multiple_open_withdrawals_clarification' },
    });
    res.sendStatus(200);
    return null;
  }

  // No reference match AND no open conversations.
  const allConversations = await getAllConversationsByTelegramChatId(chatId);

  if (allConversations.length === 0) {
    logUnmatchedInbound(chatId, textForMatching, 'no_conversations_ever');
    await sendTelegramMessage(chatId, noRecordFoundNote());
    res.sendStatus(200);
    return null;
  }

  if (allConversations.length === 1) {
    return allConversations[0];
  }

  logUnmatchedInbound(chatId, textForMatching, 'multiple_past_conversations_no_reference');
  await sendTelegramMessage(chatId, askForReferenceIdClarification());
  res.sendStatus(200);
  return null;
}

// Inbound Telegram webhook: https://core.telegram.org/bots/api#update
webhookRouter.post('/telegram', async (req, res) => {
  try {
    const update = req.body as TelegramUpdate;
    const message = update?.message;

    if (message?.chat?.id === undefined) {
      res.sendStatus(200);
      return;
    }

    const chatId = String(message.chat.id);
    const isPhoto = Boolean(message.photo && message.photo.length > 0);

    if (!message.text && !isPhoto) {
      // Some other update type we don't handle (sticker, voice note, etc).
      res.sendStatus(200);
      return;
    }

    // For matching purposes, a photo's caption (if any) is treated the same
    // way as a text message's body — a customer can attach a reference
    // number as the caption. If there's no caption, matching falls through
    // to the same open-conversation / all-conversation logic as any other
    // ambiguous message.
    const textForMatching = isPhoto ? (message.caption ?? '') : message.text!;

    const convo = await resolveConversationOrRespond(chatId, textForMatching, res);
    if (!convo) return; // already responded inside resolveConversationOrRespond

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

    if (isPhoto) {
      // Largest/best-quality entry is last in Telegram's array of sizes.
      const largestPhoto = message.photo![message.photo!.length - 1];
      let imageUrl: string | null = null;
      try {
        imageUrl = await downloadAndStoreTelegramPhoto(largestPhoto.file_id);
      } catch (err) {
        console.error(`Failed to download/store Telegram photo for chat ${chatId}`, err);
      }

      // A caption is translated to English before storage, exactly like a
      // plain text message — see the else-branch below for why.
      const captionText = message.caption?.trim() || '';
      const captionTranslation = captionText ? await detectAndTranslateToEnglish(captionText) : null;
      if (captionTranslation && captionTranslation.detectedLanguage !== convo.customer_language) {
        await updateConversation(convo.conversation_id, { customer_language: captionTranslation.detectedLanguage });
        convo.customer_language = captionTranslation.detectedLanguage;
      }

      await insertHistory({
        conversation_id: convo.conversation_id,
        customer_id: convo.customer_id,
        role: 'customer',
        // A non-empty placeholder is required — some downstream consumers
        // (e.g. the Lovable dashboard's history mapping) filter out rows
        // with an empty message string.
        message: captionTranslation ? captionTranslation.englishText : '[Photo attachment]',
        sent_at: now,
        metadata: {
          ...(imageUrl ? { image_url: imageUrl } : { image_upload_failed: true }),
          ...(captionText
            ? { original_text: captionText, detected_language: captionTranslation?.detectedLanguage }
            : {}),
        },
      });
    } else {
      // Detect the customer's language and translate their message to
      // English before it ever reaches history or draftAgentMessage — the
      // withdrawal-agent prompt only ever reasons over English text. The
      // original text is preserved in metadata for audit purposes, and the
      // conversation's remembered language is updated so outbound messages
      // (here and from poll.ts's proactive check-ins) know what to reply in.
      const translation = await detectAndTranslateToEnglish(message.text!);
      if (translation.detectedLanguage !== convo.customer_language) {
        await updateConversation(convo.conversation_id, { customer_language: translation.detectedLanguage });
        convo.customer_language = translation.detectedLanguage;
      }

      await insertHistory({
        conversation_id: convo.conversation_id,
        customer_id: convo.customer_id,
        role: 'customer',
        message: translation.englishText,
        sent_at: now,
        metadata: { original_text: message.text, detected_language: translation.detectedLanguage },
      });
    }

    await updateConversation(convo.conversation_id, { last_webhook_flag_at: now });

    const humanOwnsIt = Boolean(convo.taken_over_by) || convo.status === 'human_required';
    if (humanOwnsIt) {
      // Logged above; a human is driving this one, so the AI stays out of it.
      // This applies to photos too — a screenshot sent while a human owns
      // the conversation is simply visible to them, no AI reply drafted.
      res.sendStatus(200);
      return;
    }

    if (isPhoto) {
      // A bare photo (no caption asking a specific question) doesn't need an
      // AI-drafted reply — it's just evidence attached to the conversation
      // for whoever looks at it next (human, or the Wednesday Slack/Pay777
      // verification flow). If there IS a caption, fall through below and
      // let the agent respond to it like any other message.
      if (!message.caption?.trim()) {
        res.sendStatus(200);
        return;
      }
    }

    const [fullHistory, scenario, openCount] = await Promise.all([
      getHistoryForConversation(convo.conversation_id),
      getScenarioContext(convo.conversation_id),
      countOpenConversationsForCustomer(convo.customer_id),
    ]);
    const history = fullHistory.slice(-6);

    const current_status: WithdrawalStatus =
      convo.resolution_outcome && RESOLUTION_STATUS_MAP[convo.resolution_outcome]
        ? RESOLUTION_STATUS_MAP[convo.resolution_outcome]
        : 'PENDING';

    const output = await draftAgentMessage({
      withdrawal_id: convo.payment_id,
      amount: convo.amount,
      currency: convo.currency,
      current_status,
      verified_customer_reason: convo.resolution_reason ?? convo.reason,
      reason_is_customer_safe: convo.reason_is_customer_safe ?? false,
      next_step_instructions: null,
      verified_timeframe: scenario?.eta_text ?? null,
      trigger_type: 'USER_REPLY',
      next_check_in_minutes: current_status === 'PENDING' ? CHECKIN_INTERVAL_MINUTES : null,
      pending_update_count: convo.pending_update_count,
      has_multiple_open_withdrawals: openCount > 1,
      message_history: history.map((h) => ({ role: h.role, message: h.message })),
    });

    if (output.send) {
      // draftAgentMessage always reasons and responds in English; localize
      // to the customer's detected language right before sending. History
      // keeps the English version so future draftAgentMessage calls and any
      // internal review stay in one consistent language.
      const targetLanguage = (convo.customer_language ?? 'en') as SupportedLanguage;
      const localizedMessage = await translateFromEnglish(output.message, targetLanguage);
      await sendTelegramMessage(chatId, localizedMessage);
      const replyAt = new Date().toISOString();
      await insertHistory({
        conversation_id: convo.conversation_id,
        customer_id: convo.customer_id,
        role: 'agent',
        message: output.message,
        sent_at: replyAt,
        metadata: targetLanguage !== 'en' ? { localized_text: localizedMessage, sent_language: targetLanguage } : null,
      });
      await updateConversation(convo.conversation_id, { agent_last_message_at: replyAt });
    }

    if (output.escalate) {
      // Escalation flags the conversation for human attention — it does NOT
      // silence the agent by setting status to 'human_required'. That status
      // is reserved for an actual manual "Take Control" click in the
      // dashboard. If we ever decide escalation SHOULD auto-hand-off to a
      // human (e.g. specifically for legal/regulatory triggers, or after
      // repeated escalations on the same conversation), that logic belongs
      // here — deliberately, not as a side effect of every escalate:true.
      await updateConversation(convo.conversation_id, {
        escalation_flagged: true,
        escalation_reason: output.escalation_reason,
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Error handling Telegram webhook', err);
    // Still 200 so Telegram doesn't retry-storm us over a bug we've already logged.
    res.sendStatus(200);
  }
});