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

export function askForReferenceIdClarification(): string {
  return [
    "I want to make sure I look into the right withdrawal for you — could you share the reference number from your withdrawal request?",
    "It's the code we send in our messages about it, usually a short string of letters and numbers.",
  ].join(' ');
}

export function noRecordFoundNote(): string {
  return [
    "I don't have a record of a withdrawal matching this on my end.",
    "I've flagged this for a member of the team to look into directly — if you have a reference number handy, feel free to share it and I can take another look.",
  ].join(' ');
}