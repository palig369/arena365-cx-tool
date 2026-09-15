import { config } from '../config';

function apiBase(): string {
  return `https://api.telegram.org/bot${config.telegramBotToken}`;
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${apiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} ${body}`);
  }
}

// Minimal shape of a Telegram webhook update, just the fields we read.
// https://core.telegram.org/bots/api#update
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number | string };
    from?: { id: number | string; username?: string; first_name?: string };
  };
}
