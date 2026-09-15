import express, { Express } from 'express';
import { webhookRouter } from './routes/webhookRoutes';
import { humanRouter } from './routes/humanRoutes';
import { conversationRouter } from './routes/conversationRoutes';
import { getConversationStatusCounts } from './db/conversations';

export function createServer(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/stats', async (_req, res) => {
    try {
      const stats = await getConversationStatusCounts();
      res.json({ ok: true, stats });
    } catch (err) {
      console.error('Error fetching stats', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.use('/webhooks', webhookRouter);
  app.use('/human', humanRouter);
  app.use('/conversations', conversationRouter);

  return app;
}
