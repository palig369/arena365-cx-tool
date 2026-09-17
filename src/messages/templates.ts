// Fixed copy for INTERNAL-ONLY log entries (role: 'system', never sent to the
// customer). Every customer-facing message is AI-drafted through aiClient.complete
// (see src/ai/drafts.ts) so it goes through the same honesty-rule reasoning step
// every time; these are just audit-trail notes, not something anyone reads as
// support copy, so a fixed string is fine here.

export function escalationInternalNote(ageMinutes: number): string {
  return `Escalated directly to human review. Withdrawal was already ${Math.round(
    ageMinutes
  )} min old when first detected.`;
}

export function twoCheckinsEscalationNote(): string {
  return 'Escalated to human review after two check-ins with no resolution.';
}

export function resolvedWhileTakenOverNote(paymentId: string): string {
  return `Payment ${paymentId} is no longer showing as pending in the feed. Marking resolved. Customer was not auto-messaged because a human agent has taken control; let them know directly.`;
}

/**
 * Sent when a customer with multiple open withdrawals sends an ambiguous
 * reply (no reference or amount that clearly matches just one of them).
 * This is a plain templated message, not an AI-drafted one, because its
 * only job is to ask which withdrawal they mean — there's no state or
 * reasoning involved.
 */
export function multipleOpenWithdrawalsClarification(
  conversations: { amount: number | null; currency: string | null; payment_id: string }[]
): string {
  const lines = conversations.map((c, i) => {
    const amountText = c.amount && c.currency ? `${c.amount} ${c.currency.toUpperCase()}` : 'a withdrawal';
    return `${i + 1}. ${amountText} (reference ${c.payment_id})`;
  });
  return [
    "You currently have more than one pending withdrawal, so I want to make sure I answer about the right one:",
    ...lines,
    'Could you let me know which one you mean, either by number or by quoting the reference?',
  ].join('\n');
}