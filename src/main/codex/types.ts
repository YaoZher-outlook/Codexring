export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  id: number | string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcIncoming =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface CodexStatus {
  type: string;
  activeFlags?: string[];
  error?: string | null;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  preview?: string | null;
  status?: CodexStatus;
  createdAt?: number;
  updatedAt?: number;
  ephemeral?: boolean;
}

export interface ThreadListResult {
  data?: CodexThread[];
  nextCursor?: string | null;
}

export interface ThreadLoadedListResult {
  data?: string[];
}

export interface ThreadReadResult {
  thread?: CodexThread;
}

export interface ThreadResumeResult {
  thread?: CodexThread;
}

export interface CodexRateLimitWindow {
  usedPercent?: number;
  used_percent?: number;
  percentUsed?: number;
  percent_used?: number;
  remainingPercent?: number;
  remaining_percent?: number;
  percentRemaining?: number;
  percent_remaining?: number;
  windowDurationMins?: number;
  window_minutes?: number;
  resetsAt?: number;
  resets_at?: number;
  credits?: unknown;
}

export interface CodexRateLimitBucket {
  limitId?: string;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface RateLimitsResult {
  rateLimits?: CodexRateLimitBucket | null;
  rate_limits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket>;
  rate_limits_by_limit_id?: Record<string, CodexRateLimitBucket>;
}

export interface ThreadStatusChangedParams {
  threadId?: string;
  status?: CodexStatus;
}

export interface ThreadEventParams {
  threadId?: string;
  thread?: CodexThread;
  turn?: {
    id?: string;
    threadId?: string;
    status?: string;
    error?: unknown;
  };
  item?: {
    id?: string;
    threadId?: string;
    type?: string;
  };
  status?: string;
  error?: unknown;
}
