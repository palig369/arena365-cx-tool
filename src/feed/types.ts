// Shape of WITHDRAWAL_FEED_URL's response, based on a real sample payload.
// If the feed's shape changes, this is the file to update.

export interface FeedRecentWithdrawal {
  _id: string;
  amount: number;
  method: string | null;
  remark: string | null;
  status: string;
  userId: string;
  country: string | null;
  gateway: string | null;
  currency: string;
  dateTime: string;
  reference: string | null;
  paymentMethod: string | null; // e.g. "crypto", "bank", "upi", "ewallet"
  approvalStatus: string | null;
  providerStatus: string | null;
  payoutLastError: string | null;
  pendingApproval: boolean | null;
  providerMessage: string | null;
  payoutRetryCount: number | null;
  providerResponse: unknown;
  payoutRetryStatus: string | null;
}

export interface FeedPlayerIdentity {
  _id: string;
  phone: string | null;
  username: string | null;
  createdAt: string | null;
  is_blocked: boolean | null;
  countryCode: string | null;
}

export interface FeedPlayer {
  identity: FeedPlayerIdentity;
  activeBonuses: unknown[];
  recentDeposits: unknown[];
  recentWithdrawals: FeedRecentWithdrawal[];
}

export interface FeedAlert {
  paymentId: string;
  userId: string;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string | null;
  flaggedAt: string;
  statusChangedAt: string | null;
  player: FeedPlayer;
}

export interface FeedResponse {
  alerts: FeedAlert[];
}