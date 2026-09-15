import { Router } from 'express';
import { getConversationById, insertHistory, updateConversation } from '../db/conversations';
import { sendTelegramMessage } from '../channels/telegram';
import { resolveTelegramChatId } from '../config';

export const humanRouter = Router();

// Take Control: a human agent sends a message directly, no AI involved.
humanRouter.post('/take-control', async (req, res) => {
  try {
    const { conversation_id, agent_id, message } = req.body as {
      conversation_id?: string;
      agent_id?: string;
      message?: string;
    };
    if (!conversation_id || !agent_id || !message) {
      res.status(400).json({ error: 'conversation_id, agent_id and message are required' });
      return;
    }

    const convo = await getConversationById(conversation_id);
    if (!convo) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }

    const chatId = resolveTelegramChatId(convo.customer_id, convo.telegram_chat_id);
    if (chatId) {
      await sendTelegramMessage(String(chatId), message);
    }

    const now = new Date().toISOString();
    await insertHistory({
      conversation_id,
      customer_id: convo.customer_id,
      role: 'human_agent',
      message,
      sent_at: now,
      metadata: { agent_id },
    });
    await updateConversation(conversation_id, { taken_over_by: agent_id, agent_last_message_at: now });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in take-control', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Release Control: clears taken_over_by, optionally marks resolved too.
humanRouter.post('/release-control', async (req, res) => {
  try {
    const { conversation_id, mark_resolved } = req.body as {
      conversation_id?: string;
      mark_resolved?: boolean;
    };
    if (!conversation_id) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const convo = await getConversationById(conversation_id);
    if (!convo) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }

    await updateConversation(conversation_id, {
      taken_over_by: null,
      ...(mark_resolved ? { status: 'resolved' as const } : {}),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in release-control', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// NOTE: not part of the original spec. Nothing in the withdrawal feed carries a
// Telegram chat id, so a new conversation only gets one by copying it forward
// from an earlier conversation for the same customer_id. The very first time a
// customer messages the bot, that link has to be established somehow — this
// endpoint is a minimal manual way to do it (e.g. from an admin panel) until a
// real linking flow exists. Safe to delete if you handle linking another way.
humanRouter.post('/link-telegram', async (req, res) => {
  try {
    const { conversation_id, telegram_chat_id } = req.body as {
      conversation_id?: string;
      telegram_chat_id?: string;
    };
    if (!conversation_id || !telegram_chat_id) {
      res.status(400).json({ error: 'conversation_id and telegram_chat_id are required' });
      return;
    }

    const convo = await getConversationById(conversation_id);
    if (!convo) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }

    await updateConversation(conversation_id, { telegram_chat_id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in link-telegram', err);
    res.status(500).json({ error: 'internal error' });
  }
});
