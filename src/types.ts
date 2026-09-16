// Mirrors the existing Supabase schema. This service reads/writes these tables
// but does not create or migrate them.

export type ConversationStatus = 'autonomous' | 'monitoring' | 'human_required' | 'resolved';
export type ConversationRole = 'agent' | 'customer' | 'human_agent' | 'system';

export interface ConversationState {
  conversation_id: string;
  customer_id: string;
  payment_id: string;
  status: ConversationStatus;
  reason: string | null;
  category: string | null;
  priority: string | null;
  amount: number | null;
  currency: string | null;
  customer_name: string | null;
  vip: boolean | null;
  telegram_chat_id: string | null;
  taken_over_by: string | null;
  checkin_count: number;
  first_seen_at: string;
  agent_last_message_at: string | null;
  last_webhook_flag_at: string | null;
  last_known_status: string | null;
  last_known_remark: string | null;
  pending_update_count: number;
  reason_is_customer_safe: boolean | null;
  resolution_outcome?: string | null;
  resolution_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ConversationHistoryRow {
  conversation_id: string;
  customer_id: string;
  role: ConversationRole;
  message: string;
  sent_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ScenarioContextRow {
  conversation_id: string;
  customer_id: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  objective: string;
  eta_text: string | null;
}