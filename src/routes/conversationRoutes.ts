import { Router } from 'express';
import { getConversations, getConversationById, getHistoryForConversation } from '../db/conversations';
import { ConversationStatus } from '../types';

export const conversationRouter = Router();

const VALID_STATUSES: ConversationStatus[] = ['autonomous', 'monitoring', 'human_required', 'resolved'];

// List conversations, most recent activity first. Optional filters: ?status=, ?category=
conversationRouter.get('/', async (req, res) => {
  try {
    const { status, category } = req.query as { status?: string; category?: string };
    if (status && !VALID_STATUSES.includes(status as ConversationStatus)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return;
    }

    const conversations = await getConversations({
      status: status as ConversationStatus | undefined,
      category,
    });
    res.json({ ok: true, conversations });
  } catch (err) {
    console.error('Error listing conversations', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Single conversation's full state.
conversationRouter.get('/:id', async (req, res) => {
  try {
    const conversation = await getConversationById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }
    res.json({ ok: true, conversation });
  } catch (err) {
    console.error('Error fetching conversation', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Full message history for a conversation, oldest to newest.
conversationRouter.get('/:id/history', async (req, res) => {
  try {
    const conversation = await getConversationById(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }
    const history = await getHistoryForConversation(req.params.id);
    res.json({ ok: true, history });
  } catch (err) {
    console.error('Error fetching conversation history', err);
    res.status(500).json({ error: 'internal error' });
  }
});
