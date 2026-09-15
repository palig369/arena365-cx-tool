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
