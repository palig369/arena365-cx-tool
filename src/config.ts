import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in your .env file (see .env.example).`
    );
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

export const config = {
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceKey: requireEnv('SUPABASE_SERVICE_KEY'),
  // Anthropic is the sole AI brain for all customer messaging (replaced Groq/OpenRouter).
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
  telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  withdrawalFeedUrl: requireEnv('WITHDRAWAL_FEED_URL'),

  // Optional testing/staging helpers.
  // TEST_USER_IDS: if set, the poller only acts on withdrawals whose userId is in this
  // comma-separated list. Leave blank in production so all customers are handled.
  testUserIds: optionalEnv('TEST_USER_IDS')
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  // TEST_TELEGRAM_CHAT_ID: fallback Telegram chat used ONLY for customers listed in
  // TEST_USER_IDS when their conversation has no telegram_chat_id linked yet, so you
  // can see your own test messages land somewhere. Never used for real customers.
  testTelegramChatId: optionalEnv('TEST_TELEGRAM_CHAT_ID'),

  port: Number(optionalEnv('PORT') ?? '3000'),
  pollIntervalSeconds: Number(optionalEnv('POLL_INTERVAL_SECONDS') ?? '30'),
} as const;

/**
 * Where to send an outbound message for this conversation, or null to skip sending.
 *
 * IMPORTANT: TEST_TELEGRAM_CHAT_ID is only ever used as a fallback for customers
 * explicitly listed in TEST_USER_IDS. A real customer with no telegram_chat_id
 * linked yet is a customer we have no channel for, not a test case — we must not
 * redirect their messages into the tester's personal chat. The check is "is this
 * customer_id a test user", never "is telegram_chat_id empty".
 *
 * SAFETY NET: even if a conversation row already has TEST_TELEGRAM_CHAT_ID stored
 * as its telegram_chat_id (e.g. from old/bad data created before this gating
 * existed, or any future bug that mislinks it), we refuse to use it unless the
 * customer is currently a listed test user. A non-test customer should never be
 * able to end up wired to the tester's personal chat, no matter how that value
 * got onto their row.
 */
export function resolveTelegramChatId(customerId: string, telegramChatId: string | null): string | null {
  const isTestUser = Boolean(config.testUserIds?.includes(customerId));

  if (telegramChatId) {
    if (telegramChatId === config.testTelegramChatId && !isTestUser) {
      return null;
    }
    return telegramChatId;
  }

  if (config.testTelegramChatId && isTestUser) {
    return config.testTelegramChatId;
  }
  return null;
}