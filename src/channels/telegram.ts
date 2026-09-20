import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { supabase } from '../db/supabase';

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

const ATTACHMENTS_BUCKET = 'chat-attachments';

/**
 * Downloads a photo the customer sent via Telegram (by file_id) and uploads
 * it to Supabase Storage, returning a public URL. We do NOT use Telegram's
 * own file URLs directly (https://api.telegram.org/file/bot<TOKEN>/...) —
 * that embeds the bot token in the URL, which would leak it to anyone with
 * access to the Lovable dashboard where this URL eventually gets rendered.
 * Requires a public Supabase Storage bucket named "chat-attachments" to
 * already exist (created manually in the Supabase dashboard).
 */
export async function downloadAndStoreTelegramPhoto(fileId: string): Promise<string> {
  const fileInfoRes = await fetch(`${apiBase()}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!fileInfoRes.ok) {
    throw new Error(`Telegram getFile failed: ${fileInfoRes.status} ${fileInfoRes.statusText}`);
  }
  const fileInfo = (await fileInfoRes.json()) as { result?: { file_path?: string } };
  const filePath = fileInfo.result?.file_path;
  if (!filePath) {
    throw new Error('Telegram getFile response had no file_path');
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`Telegram file download failed: ${fileRes.status} ${fileRes.statusText}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();

  const extension = filePath.split('.').pop() || 'jpg';
  const storagePath = `${randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, Buffer.from(arrayBuffer), {
      contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    });
  if (uploadError) {
    throw new Error(`Supabase storage upload failed: ${uploadError.message}`);
  }

  const { data } = supabase.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

// Minimal shape of a Telegram webhook update, just the fields we read.
// https://core.telegram.org/bots/api#update
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    // Telegram's caption field — text sent alongside a photo, if the
    // customer added any. Used the same way as `text` for matching which
    // conversation a photo belongs to.
    caption?: string;
    chat: { id: number | string };
    from?: { id: number | string; username?: string; first_name?: string };
    // Present when the customer sends an image. Telegram sends an array of
    // the same photo at multiple resolutions (smallest to largest) — the
    // last entry is the largest/best quality, which is what we download.
    photo?: {
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }[];
  };
}