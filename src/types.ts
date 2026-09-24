export type ConversationRole = 'agent' | 'customer' | 'system';

export type ConversationStatus =
  | 'autonomous'
  | 'monitoring'
  | 'human_required'
  | 'resolved';

export interface ConversationState {
  conversation_id: string;
  customer_id: string;
  payment_id: string;
  status: string;
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
  first_seen_at: string | null;
  agent_last_message_at: string | null;
  last_webhook_flag_at: string | null;
  last_known_status: string | null;
  last_known_remark: string | null;
  pending_update_count: number;
  reason_is_customer_safe: boolean | null;
  resolution_outcome?: string | null;
  resolution_reason?: string | null;
  escalation_flagged?: boolean | null;
  escalation_reason?: string | null;
  customer_language?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ConversationHistoryRow {
  id?: string;
  conversation_id: string;
  role: ConversationRole;
  message: string;
  sent_at: string;
  metadata?: Record<string, unknown> | null;
}

export interface ScenarioContextRow {
  id?: string;
  conversation_id: string;
  scenario_key: string;
  context: Record<string, unknown> | null;
  created_at?: string;
}