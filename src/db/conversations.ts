import { supabase } from './supabase';
import { ConversationState, ConversationHistoryRow, ScenarioContextRow, ConversationStatus } from '../types';

const ALL_STATUSES: ConversationStatus[] = ['autonomous', 'monitoring', 'human_required', 'resolved'];

export async function getOpenConversations(): Promise<ConversationState[]> {
  const { data, error } = await supabase.from('conversation_state').select('*').neq('status', 'resolved');
  if (error) throw new Error(`Supabase error (getOpenConversations): ${error.message}`);
  return (data ?? []) as ConversationState[];
}

/** Which of these payment_ids already have a conversation_state row (any status). */
export async function getKnownPaymentIds(paymentIds: string[]): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('conversation_state')
    .select('payment_id')
    .in('payment_id', paymentIds);
  if (error) throw new Error(`Supabase error (getKnownPaymentIds): ${error.message}`);
  return new Set((data ?? []).map((r: { payment_id: string }) => r.payment_id));
}

/**
 * The feed doesn't carry a Telegram chat id, so when a customer has an earlier
 * (any status) conversation with one linked, carry it forward onto the new one.
 */
export async function getMostRecentTelegramChatIdForCustomer(customerId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('telegram_chat_id')
    .eq('customer_id', customerId)
    .not('telegram_chat_id', 'is', null)
    .order('first_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase error (getMostRecentTelegramChatIdForCustomer): ${error.message}`);
  return data?.telegram_chat_id ?? null;
}

/** Most recent open (non-resolved) conversation linked to this Telegram chat. */
export async function getOpenConversationByTelegramChatId(chatId: string): Promise<ConversationState | null> {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .neq('status', 'resolved')
    .order('first_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase error (getOpenConversationByTelegramChatId): ${error.message}`);
  return (data as ConversationState) ?? null;
}

/** All conversations, optionally filtered, ordered by most recent activity first. */
export async function getConversations(filters: {
  status?: ConversationStatus;
  category?: string;
} = {}): Promise<ConversationState[]> {
  let query = supabase.from('conversation_state').select('*');
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.category) query = query.eq('category', filters.category);

  // updated_at is bumped on every write to the row (status changes, new
  // messages, checkin_count, taken_over_by, ...), so it's the one column that
  // always reflects the most recent activity — unlike first_seen_at (set once)
  // or agent_last_message_at / last_webhook_flag_at (each only tracks one
  // direction of message and can be null).
  query = query.order('updated_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(`Supabase error (getConversations): ${error.message}`);
  return (data ?? []) as ConversationState[];
}

/** Counts of conversations per status, for the traffic-light dashboard. */
export async function getConversationStatusCounts(): Promise<Record<ConversationStatus, number>> {
  const entries = await Promise.all(
    ALL_STATUSES.map(async (status) => {
      const { count, error } = await supabase
        .from('conversation_state')
        .select('*', { count: 'exact', head: true })
        .eq('status', status);
      if (error) throw new Error(`Supabase error (getConversationStatusCounts:${status}): ${error.message}`);
      return [status, count ?? 0] as const;
    })
  );
  return Object.fromEntries(entries) as Record<ConversationStatus, number>;
}

export async function getConversationById(conversationId: string): Promise<ConversationState | null> {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    // conversation_id is a uuid column — Postgres rejects a non-UUID string
    // with 22P02 instead of just matching zero rows. Callers (including the
    // GET /conversations/:id routes) treat a null return as "not found", so
    // a malformed id should look the same as a missing one, not a 500.
    if (error.code === '22P02') return null;
    throw new Error(`Supabase error (getConversationById): ${error.message}`);
  }
  return (data as ConversationState) ?? null;
}

export async function createConversation(row: ConversationState): Promise<ConversationState> {
  const { data, error } = await supabase.from('conversation_state').insert(row).select().single();
  if (error) throw new Error(`Supabase error (createConversation): ${error.message}`);
  return data as ConversationState;
}

export async function updateConversation(
  conversationId: string,
  patch: Partial<ConversationState>
): Promise<void> {
  const { error } = await supabase.from('conversation_state').update(patch).eq('conversation_id', conversationId);
  if (error) throw new Error(`Supabase error (updateConversation): ${error.message}`);
}

export async function insertHistory(row: ConversationHistoryRow): Promise<void> {
  const { error } = await supabase.from('conversation_history').insert(row);
  if (error) throw new Error(`Supabase error (insertHistory): ${error.message}`);
}

export async function insertScenarioContext(row: ScenarioContextRow): Promise<void> {
  const { error } = await supabase.from('scenario_context').insert(row);
  if (error) throw new Error(`Supabase error (insertScenarioContext): ${error.message}`);
}

export async function getHistoryForConversation(conversationId: string): Promise<ConversationHistoryRow[]> {
  const { data, error } = await supabase
    .from('conversation_history')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });
  if (error) throw new Error(`Supabase error (getHistoryForConversation): ${error.message}`);
  return (data ?? []) as ConversationHistoryRow[];
}

export async function getScenarioContext(conversationId: string): Promise<ScenarioContextRow | null> {
  const { data, error } = await supabase
    .from('scenario_context')
    .select('*')
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) throw new Error(`Supabase error (getScenarioContext): ${error.message}`);
  return (data as ScenarioContextRow) ?? null;
}
