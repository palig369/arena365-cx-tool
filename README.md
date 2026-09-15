# Palig CX Tool

TypeScript/Node backend for the CX support agent, replacing the n8n prototype.
Polls a withdrawal-delay feed, drafts and sends customer messages over
Telegram, and escalates to a human when needed.

## Stack

- TypeScript + Node.js + Express
- Supabase (temporary DB; schema already exists, this service only reads/writes it)
- OpenRouter (`anthropic/claude-sonnet-4.6`) for AI drafting — see "Swapping the AI provider" below
- Telegram Bot API (temporary customer channel)

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with real values (see below), then:
npm run dev
```

Required env vars (the app refuses to start if any are missing — see
`src/config.ts`):

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — service-role key, this runs server-side only
- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `WITHDRAWAL_FEED_URL`

Optional:

- `TEST_USER_IDS` — comma-separated `userId`s. When set, the poller only acts
  on these customers. Leave blank in production.
- `TEST_TELEGRAM_CHAT_ID` — fallback chat id used when a conversation has no
  `telegram_chat_id` linked yet, so outbound messages have somewhere to land
  while testing.
- `PORT` (default `3000`), `POLL_INTERVAL_MINUTES` (default `2`)

## Wiring up the Telegram webhook

Customer replies arrive as an inbound webhook at `POST /webhooks/telegram`.
Once the server is reachable on a public HTTPS URL, register it with Telegram:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://your-domain/webhooks/telegram"
```

## Project layout

```
src/
  config.ts              env loading + validation
  types.ts               DB row types (conversation_state, conversation_history, scenario_context)
  db/
    supabase.ts           Supabase client
    conversations.ts      all DB reads/writes
  ai/
    client.ts              AIClient interface + OpenRouter implementation (swap point, see below)
    drafts.ts               honesty rules + prompt building for every customer-facing message
                             (first message, check-ins, resolution, replies)
  channels/
    telegram.ts            sendMessage + inbound update type
  feed/
    types.ts                withdrawal feed response shape
    withdrawalFeed.ts        fetch + currency/payment-rail ETA classification
  messages/
    templates.ts            fixed copy for INTERNAL-ONLY audit notes (never sent to the customer)
  orchestrator/
    poll.ts                  the 2-minute poll cycle: new withdrawals, check-ins, resolution detection
  routes/
    webhookRoutes.ts          inbound customer replies
    humanRoutes.ts             take-control / release-control / link-telegram
  server.ts, index.ts
```

## Swapping the AI provider

`src/ai/client.ts` defines an `AIClient` interface with one method,
`complete(messages, opts)`. Every other file calls that interface, never
OpenRouter directly. To move to the direct Anthropic API later: rewrite the
class in that one file to use `@anthropic-ai/sdk` with the same method
signature, and repoint the `aiClient` export. No other file changes.

## Core flow (as implemented)

1. **Poll** `WITHDRAWAL_FEED_URL` every `POLL_INTERVAL_MINUTES` (`src/orchestrator/poll.ts`).
2. **New withdrawal** (a `paymentId` never seen in `conversation_state` before):
   creates `conversation_state` + `scenario_context`, and:
   - if the withdrawal is already >10 min old (by `createdAt`) when first
     detected, skips straight to `human_required` — no first message is sent,
     an internal `system` note is logged instead.
   - otherwise, AI drafts a first message (1-2 sentences, <35 words, honest
     about not knowing the cause, ETA only for fiat currencies), sends it via
     Telegram if a `telegram_chat_id` is linked, and logs it either way.
3. **Check-in loop** (status `autonomous`/`monitoring`, not taken over): if
   10+ min since `agent_last_message_at` and the payment is still pending,
   AI drafts and sends check-in #1 (under 25 words, flips status to
   `monitoring`), then check-in #2 ten minutes later, then escalates to
   `human_required` (no more automatic messages) ten minutes after that if
   still unresolved.
4. **Resolution detection**: every poll, any open conversation (`status !=
   resolved`) whose `payment_id` has dropped out of the feed gets an
   AI-drafted, honest "no longer showing as pending, confirming the outcome"
   message (never claiming success) and is marked `resolved`. If a human has
   taken control, this is logged internally instead of auto-messaging the
   customer (see note below).
5. **Inbound replies** (`POST /webhooks/telegram`): always logged. AI only
   replies if `taken_over_by` is null **and** status isn't `human_required`;
   otherwise the message is logged and left for the human.
6. **Take Control** (`POST /human/take-control`): logs a `human_agent`
   message, sends it directly via Telegram (no AI), sets `taken_over_by`.
7. **Release Control** (`POST /human/release-control`): clears
   `taken_over_by`, and marks `resolved` too if `mark_resolved: true` is
   passed. Note: if status was `human_required` and `mark_resolved` isn't
   passed, it stays `human_required` after release (per the gate in point 5,
   that keeps the AI out until someone deliberately changes status) —
   intentional, not a bug.

## Assumptions and open items (flagged, not silently guessed)

- **Feed shape**: parsed from a real sample payload you provided
  (`{ alerts: [{ paymentId, userId, amount, currency, createdAt, player: {
  identity, recentWithdrawals } }] }`). See `src/feed/types.ts`.
- **Currency → ETA classification** (`src/feed/withdrawalFeed.ts`,
  `getEtaText`): fiat currencies `INR/USD/EUR/GBP` get "1-2 business days";
  everything else (crypto tickers, or a matching `recentWithdrawals` entry
  with `paymentMethod` of `crypto`/`upi`/`e-wallet`/`wallet`) gets no
  timeframe. This is the one function to edit if the real vocabulary differs.
- **Telegram linking gap**: nothing in the feed carries a `telegram_chat_id`.
  New conversations only get one by copying it from an earlier conversation
  for the same `customer_id`. The very first link for a customer has to be
  established some other way — I added a minimal `POST
  /human/link-telegram` endpoint for this (not in the original spec, easy to
  remove if you handle linking differently, e.g. a `/start` deep link).
- **Unmatched inbound Telegram messages**: if a chat id matches no open
  conversation, the message is logged to the server console and dropped —
  the current schema has no fallback table to persist it against.
- **Resolution message vs. an active human takeover**: chose not to
  auto-message the customer when `taken_over_by` is set, even if the payment
  disappears from the feed — logs an internal note for the human instead, so
  automation doesn't talk over a human mid-conversation. Flag if you'd rather
  it always messages the customer.
- **Every customer-facing message is AI-drafted** through `aiClient.complete`
  (`src/ai/drafts.ts`: `draftFirstMessage`, `draftCheckin`, `draftResolution`,
  `draftReply`), each with its own system prompt carrying the honesty rules,
  the ETA rule, and its length constraint (35 words for the first message, 25
  for check-ins, 1-2 short sentences for resolution and replies).
  `src/messages/templates.ts` now only holds fixed copy for internal `system`-role
  audit notes (escalation, taken-over-resolution) that are never sent to the
  customer — those don't need a model call since no one reads them as support
  copy.
