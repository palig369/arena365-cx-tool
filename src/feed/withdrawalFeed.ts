import { config } from '../config';
import { FeedAlert, FeedResponse, FeedRecentWithdrawal } from './types';

export async function fetchWithdrawalFeed(): Promise<FeedAlert[]> {
  const res = await fetch(config.withdrawalFeedUrl);
  if (!res.ok) {
    throw new Error(`Withdrawal feed request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as FeedResponse;
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];

  if (!config.testUserIds || config.testUserIds.length === 0) {
    return alerts;
  }
  // Testing mode: only act on the configured test users so we don't message real customers.
  return alerts.filter((alert) => config.testUserIds!.includes(alert.userId));
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
// A withdrawal that's no longer in the top-level alerts list has resolved
// somehow. Its final status/remark may still be visible in ANY alert's
// player.recentWithdrawals array (not just its own former alert), because
// that array is a rolling history keyed by user, and the same user might
// still have a different withdrawal currently pending. If nothing matches,
// the entry has fully aged out of the feed's visibility and we genuinely
// don't know the outcome — callers should fall back to a last-known snapshot
// (see conversation_state.last_known_status / last_known_remark) rather than
// treating this null as a final answer.

export type ResolutionCategory = 'completed' | 'rejected' | 'failed' | 'unknown';

export interface ResolvedOutcome {
  category: ResolutionCategory;
  rawStatus: string | null;
  rawRemark: string | null;
}

export function findResolvedOutcome(paymentId: string, allAlerts: FeedAlert[]): ResolvedOutcome | null {
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