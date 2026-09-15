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
