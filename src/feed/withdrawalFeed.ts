import { config } from '../config';
import { FeedAlert, FeedResponse, FeedRecentWithdrawal } from './types';

export async function fetchWithdrawalFeed(): Promise<FeedAlert[]> {
  const res = await fetch(config.withdrawalFeedUrl);
  if (!res.ok) {
    throw new Error(`Withdrawal feed request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as FeedResponse;
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];

  // Every pending withdrawal is processed (detected, drafted, logged) regardless
  // of who it belongs to, so we can observe the whole flow for every customer.
  // Actual delivery is still gated separately in resolveTelegramChatId/
  // logAndMaybeSend: only TEST_USER_IDS get a real Telegram send today, since
  // Telegram is a test-only channel. Real customers get everything processed
  // and logged to conversation history, just not delivered anywhere yet
  // (no live channel exists for them until the V3 integration lands).
  return alerts;
}

/**
 * The top-level alert doesn't repeat every field (payment rail, internal remark).
 * Those live on the matching entry in player.recentWithdrawals.
 */
export function findMatchingWithdrawal(alert: FeedAlert): FeedRecentWithdrawal | null {
  return alert.player?.recentWithdrawals?.find((w) => w._id === alert.paymentId) ?? null;
}

// A "Held for manual approval" remark means the withdrawal is waiting on a
// normal back-office review, not that anything is stuck or broken. New
// withdrawals like this should never be treated as "already old" and escalated
// straight to a human just because of age, and ongoing check-ins for these
// should continue indefinitely rather than escalating after two rounds.
export function isManualApprovalHold(remark: string | null | undefined): boolean {
  return (remark ?? '').toLowerCase().startsWith('held for manual approval');
}

// Detects the specific "approved internally, submitted to the payment
// provider" remark. This means the withdrawal is genuinely moving forward,
// but is NOT complete yet — the provider still has to confirm it before an
// admin marks it Completed. Never expose the provider's name to the customer.
const APPROVED_SUBMITTED_PATTERN = /approved.*submitted/i;

export function isApprovedSubmittedRemark(remark: string | null | undefined): boolean {
  return APPROVED_SUBMITTED_PATTERN.test((remark ?? '').trim());
}

// --- Customer-safe reason detection ----------------------------------------
// Most rejection/failure remarks are internal shorthand (system names, queue
// states, codes) and must never reach the customer as-is — those stay
// reason_is_customer_safe: false, and the agent gives a generic "team will
// follow up" message instead. A small, explicit allowlist of patterns here
// are reasons that are genuinely customer-actionable and safe to relay
// plainly (e.g. "wrong wallet address" tells the customer exactly what to
// fix). Start narrow: only add a new pattern here once you've confirmed the
// exact wording that reason appears as in the feed / back office, so we never
// accidentally mark something unsafe as safe.
const CUSTOMER_SAFE_REASON_PATTERNS = [
  /wrong wallet/i,
  /account mismatch/i,
  /wrong ifsc/i,
  /payslip/i,
  /wagering/i,
  /not verified/i,
  /daily limit/i,
  /unplayed amount/i,
];

export function isCustomerSafeReason(remark: string | null | undefined): boolean {
  const text = (remark ?? '').trim();
  if (!text) return false;
  return CUSTOMER_SAFE_REASON_PATTERNS.some((pattern) => pattern.test(text));
}

export function getWithdrawalAgeMinutes(alert: FeedAlert, now: Date = new Date()): number {
  const created = new Date(alert.createdAt).getTime();
  return (now.getTime() - created) / 60000;
}

// --- Currency / payment-rail classification -------------------------------
// This is the one spot to adjust if the feed's currency or paymentMethod
// vocabulary changes. Fiat/bank rails get a concrete ETA; crypto, UPI and
// e-wallet rails don't, because those settlement times vary too much to
// honestly promise a window.

const FIAT_ETA_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP']);
const NON_ETA_PAYMENT_METHODS = new Set(['crypto', 'upi', 'e-wallet', 'ewallet', 'wallet']);

export function getEtaText(alert: FeedAlert): string | null {
  const matched = findMatchingWithdrawal(alert);
  const paymentMethod = matched?.paymentMethod?.toLowerCase().trim();
  const currency = alert.currency?.toUpperCase().trim();

  if (paymentMethod && NON_ETA_PAYMENT_METHODS.has(paymentMethod)) {
    return null;
  }
  if (currency && FIAT_ETA_CURRENCIES.has(currency)) {
    return '1-2 business days';
  }
  // Unknown or crypto-looking currency codes (e.g. usdttrc20, btc, eth): don't
  // promise a timeframe we can't back up.
  return null;
}

// --- Resolution outcome lookup ---------------------------------------------
// A withdrawal that's no longer pending has resolved somehow. The feed
// carries this in TWO places that can disagree: the alert's own top-level
// `status` field (authoritative, updates promptly), and the nested
// player.recentWithdrawals[] entry for the same paymentId (a secondary copy
// that has been observed to lag behind and still say "pending" well after
// the top-level status has already changed). Always trust the top-level
// status on an alert whose paymentId matches, over any nested copy. Only
// fall back to searching other alerts' nested arrays (for a withdrawal that
// has fully disappeared from the top-level list) as a last resort, and even
// then prefer another alert's own top-level status if that nested search
// happens to land on its own alert.

export type ResolutionCategory = 'completed' | 'rejected' | 'failed' | 'unknown';

export interface ResolvedOutcome {
  category: ResolutionCategory;
  rawStatus: string | null;
  rawRemark: string | null;
}

export function findResolvedOutcome(paymentId: string, allAlerts: FeedAlert[]): ResolvedOutcome | null {
  // Pass 1: does any alert's own top-level paymentId/status match, and is
  // that status non-pending? This is the authoritative, current answer -
  // check it before ever consulting a nested recentWithdrawals copy.
  //
  // The top-level alert carries its own `reason` field, confirmed live via
  // curl on 2026-09-24, which updates promptly alongside `status`. The
  // nested recentWithdrawals[] remark can stay stale/frozen on the original
  // placeholder for hours after resolution (confirmed on payment_id
  // 6ab4b5880ec99d159c97150f: rejected with reason "wrong wallet id" at the
  // top level, while the nested copy still showed the pre-rejection
  // placeholder). Always prefer ownAlert.reason; fall back to the nested
  // remark only if the top-level reason is missing.
  const ownAlert = allAlerts.find((a) => a.paymentId === paymentId);
  if (ownAlert && ownAlert.status && ownAlert.status !== 'pending') {
    const match = ownAlert.player?.recentWithdrawals?.find((w) => w._id === paymentId);
    const resolvedRemark = ownAlert.reason ?? match?.remark ?? null;
    return {
      category: classifyOutcome(ownAlert.status, resolvedRemark),
      rawStatus: ownAlert.status,
      rawRemark: resolvedRemark,
    };
  }

  // Pass 2: the withdrawal's own alert has vanished from the top-level list
  // entirely (fully aged out). Search every alert's nested
  // recentWithdrawals array as a last resort - this is a rolling history
  // keyed by user, and the same user might still have a different
  // withdrawal currently pending.
  for (const alert of allAlerts) {
    const match = alert.player?.recentWithdrawals?.find((w) => w._id === paymentId);
    if (match) {
      return {
        category: classifyOutcome(match.status, match.remark),
        rawStatus: match.status ?? null,
        rawRemark: match.remark ?? null,
      };
    }
  }

  return null;
}

export function classifyOutcome(status: string | null | undefined, remark: string | null | undefined): ResolutionCategory {
  const s = (status ?? '').toLowerCase();
  const r = (remark ?? '').toLowerCase();

  if (s === 'completed') return 'completed';

  if (s === 'rejected') {
    if (r.includes('hero rejected the approved payout') || r.includes('invalid') || r.includes('not valid')) {
      return 'failed';
    }
    return 'rejected';
  }

  if (s === 'failed') return 'failed';

  return 'unknown';
}