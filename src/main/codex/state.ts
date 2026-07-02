import type {
  LimitBucket,
  LimitSource,
  LimitSyncStatus,
  LimitTone,
  RingState,
  ThreadSummary,
  WidgetState
} from "../../shared/widgetTypes";
import type {
  CodexRateLimitBucket,
  CodexRateLimitWindow,
  CodexStatus,
  CodexThread,
  RateLimitsResult
} from "./types";

const FIVE_HOURS_MINS = 300;
const WEEK_MINS = 10_080;

export function createInitialWidgetState(): WidgetState {
  return withTooltip({
    revision: 0,
    connection: {
      status: "connecting",
      error: null,
      detail: null,
      lastConnectedAt: null
    },
    thread: emptyThread(),
    ring: "reconnecting",
    limits: {
      fiveHour: unavailableLimit("5h", FIVE_HOURS_MINS),
      weekly: unavailableLimit("Week", WEEK_MINS),
      lastUpdatedAt: null,
      refreshStartedAt: null,
      status: "unknown",
      source: null,
      error: null
    },
    tooltip: {
      primary: "",
      detail: []
    }
  });
}

export function emptyThread(): ThreadSummary {
  return {
    id: null,
    title: "No thread",
    preview: "",
    statusType: null,
    updatedAt: null
  };
}

export function toThreadSummary(thread: CodexThread | null | undefined): ThreadSummary {
  if (!thread) {
    return emptyThread();
  }

  return {
    id: thread.id,
    title: thread.name?.trim() || thread.preview?.trim() || shortId(thread.id),
    preview: thread.preview?.trim() ?? "",
    statusType: thread.status?.type ?? null,
    updatedAt: thread.updatedAt ?? thread.createdAt ?? null
  };
}

export function mapStatusToRing(
  connectionStatus: WidgetState["connection"]["status"],
  status: CodexStatus | null | undefined,
  fallback: RingState = "idle"
): RingState {
  if (connectionStatus === "disconnected" || connectionStatus === "connecting") {
    return "reconnecting";
  }

  if (!status) {
    return fallback;
  }

  const type = normalizeStatusText(status.type);
  const flags = (status.activeFlags ?? []).map(normalizeStatusText);

  if (type.includes("error") || type.includes("failed")) {
    return "failed";
  }

  if (
    flags.some(
      (flag) => flag.includes("waitingonapproval") || flag.includes("waitingonuserinput") || flag.includes("approval")
    )
  ) {
    return "waitingApproval";
  }

  if (type.includes("interrupted") || type.includes("cancel")) {
    return "idle";
  }

  if (hasCreatingStatusText(type) || flags.some(hasCreatingStatusText)) {
    return "creating";
  }

  if (hasThinkingStatusText(type) || flags.some(hasThinkingStatusText)) {
    return "thinking";
  }

  if (hasWorkingStatusText(type) || flags.some(hasWorkingStatusText)) {
    return "working";
  }

  if (type === "active") {
    return fallback;
  }

  return "idle";
}

export function hasActiveStatusText(value: string): boolean {
  return hasCreatingStatusText(value) || hasThinkingStatusText(value) || hasWorkingStatusText(value);
}

export function hasCreatingStatusText(value: string): boolean {
  const text = normalizeStatusText(value);
  return ["creating", "initializing", "starting", "preparing", "spawning", "loading"].some((word) =>
    text.includes(word)
  );
}

export function hasThinkingStatusText(value: string): boolean {
  const text = normalizeStatusText(value);
  return ["thinking", "reasoning", "streaming", "responding", "generating", "assistantresponse"].some((word) =>
    text.includes(word)
  );
}

export function hasWorkingStatusText(value: string): boolean {
  const text = normalizeStatusText(value);
  return [
    "running",
    "working",
    "busy",
    "inprogress",
    "progress",
    "processing",
    "executing",
    "execute",
    "tool",
    "command",
    "shell",
    "patch",
    "compact"
  ].some((word) => text.includes(word));
}

export function normalizeStatusText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function applyRateLimits(
  state: WidgetState,
  result: RateLimitsResult | null | undefined,
  updatedAt = new Date().toISOString(),
  source: LimitSource = state.limits.source ?? "appServer"
): WidgetState {
  const fiveHour = toLimitBucket("5h", FIVE_HOURS_MINS, findRateLimitWindow(result, FIVE_HOURS_MINS));
  const weekly = toLimitBucket("Week", WEEK_MINS, findRateLimitWindow(result, WEEK_MINS));
  const status: LimitSyncStatus = fiveHour.available || weekly.available ? "ready" : "unknown";

  return withTooltip({
    ...state,
    limits: {
      fiveHour,
      weekly,
      lastUpdatedAt: updatedAt,
      refreshStartedAt: null,
      status,
      source,
      error: null
    }
  });
}

export function markRateLimitsRefreshing(
  state: WidgetState,
  source: LimitSource = state.limits.source ?? "appServer",
  refreshStartedAt = new Date().toISOString()
): WidgetState {
  return withTooltip({
    ...state,
    limits: {
      ...state.limits,
      refreshStartedAt,
      status: "refreshing",
      source,
      error: null
    }
  });
}

export function markRateLimitsProblem(
  state: WidgetState,
  error: string,
  source: LimitSource | null = state.limits.source
): WidgetState {
  const hasCachedData = state.limits.fiveHour.available || state.limits.weekly.available;

  return withTooltip({
    ...state,
    limits: {
      ...state.limits,
      refreshStartedAt: null,
      status: hasCachedData ? "stale" : "error",
      source,
      error
    }
  });
}

export function findRateLimitWindow(
  result: RateLimitsResult | null | undefined,
  windowDurationMins: number
): CodexRateLimitWindow | null {
  if (!result) {
    return null;
  }

  const buckets: CodexRateLimitBucket[] = [
    ...Object.values(result.rateLimitsByLimitId ?? {}),
    ...Object.values(result.rate_limits_by_limit_id ?? {}),
    ...(result.rateLimits ? [result.rateLimits] : []),
    ...(result.rate_limits ? [result.rate_limits] : [])
  ];

  const matches: CodexRateLimitWindow[] = [];
  for (const bucket of buckets) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (getWindowDurationMins(window) === windowDurationMins) {
        if (window) {
          matches.push(window);
        }
      }
    }
  }

  return chooseRateLimitWindow(matches);
}

export function toLimitBucket(
  label: LimitBucket["label"],
  targetWindowMins: number,
  raw: CodexRateLimitWindow | null
): LimitBucket {
  const rawUsedPercent = getUsedPercent(raw);
  const rawRemainingPercent = getRemainingPercent(raw);
  if (!raw || (typeof rawUsedPercent !== "number" && typeof rawRemainingPercent !== "number")) {
    return unavailableLimit(label, targetWindowMins);
  }

  const resetsAt = getResetsAt(raw);
  const resetElapsed = hasResetElapsed(resetsAt);
  const remainingPercent = resetElapsed
    ? 100
    : clamp(rawRemainingPercent ?? 100 - (rawUsedPercent ?? 0), 0, 100);
  const usedPercent =
    resetElapsed || typeof rawRemainingPercent === "number"
      ? clamp(100 - remainingPercent, 0, 100)
      : clamp(rawUsedPercent ?? 100 - remainingPercent, 0, 100);
  return {
    label,
    available: true,
    usedPercent,
    remainingPercent,
    windowDurationMins: getWindowDurationMins(raw) ?? targetWindowMins,
    resetsAt: resetElapsed ? null : resetsAt,
    tone: toneForRemaining(remainingPercent),
    reached: remainingPercent <= 0
  };
}

export function unavailableLimit(label: LimitBucket["label"], windowDurationMins: number): LimitBucket {
  return {
    label,
    available: false,
    usedPercent: null,
    remainingPercent: null,
    windowDurationMins,
    resetsAt: null,
    tone: "muted",
    reached: false
  };
}

export function toneForRemaining(remainingPercent: number): LimitTone {
  if (remainingPercent <= 15) {
    return "danger";
  }

  if (remainingPercent <= 40) {
    return "warn";
  }

  return "ok";
}

export function withTooltip(state: WidgetState): WidgetState {
  const threadLine = state.thread.id ? state.thread.title : "No Codex thread selected";
  const connectionLine =
    state.connection.status === "connected"
      ? "Connected to Codex app-server"
      : state.connection.status === "fallback"
        ? "Using local Codex session fallback"
      : state.connection.error ?? "Connecting to Codex app-server";
  const detailLine = state.connection.detail ? `Detail: ${state.connection.detail}` : null;

  return {
    ...state,
    tooltip: {
      primary: `${ringLabel(state.ring)} - ${threadLine}`,
      detail: [
        connectionLine,
        ...(detailLine ? [detailLine] : []),
        formatLimitSyncTooltip(state),
        formatLimitTooltip(state.limits.fiveHour),
        formatLimitTooltip(state.limits.weekly)
      ]
    }
  };
}

function getUsedPercent(raw: CodexRateLimitWindow | null): number | undefined {
  return raw?.usedPercent ?? raw?.used_percent ?? raw?.percentUsed ?? raw?.percent_used;
}

function getRemainingPercent(raw: CodexRateLimitWindow | null): number | undefined {
  return raw?.remainingPercent ?? raw?.remaining_percent ?? raw?.percentRemaining ?? raw?.percent_remaining;
}

function getWindowDurationMins(raw: CodexRateLimitWindow | null | undefined): number | undefined {
  return raw?.windowDurationMins ?? raw?.window_minutes;
}

function getResetsAt(raw: CodexRateLimitWindow): number | null {
  const value = raw.resetsAt ?? raw.resets_at;
  if (typeof value !== "number") {
    return null;
  }

  return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
}

function chooseRateLimitWindow(windows: CodexRateLimitWindow[]): CodexRateLimitWindow | null {
  if (windows.length === 0) {
    return null;
  }

  return [...windows].sort((left, right) => rateLimitWindowScore(right) - rateLimitWindowScore(left))[0];
}

function rateLimitWindowScore(window: CodexRateLimitWindow): number {
  const resetsAt = getResetsAt(window);
  const remainingPercent = getRemainingPercent(window) ?? 100 - (getUsedPercent(window) ?? 100);
  const freshness = hasResetElapsed(resetsAt) ? 10_000 : resetsAt ? 20_000 : 15_000;
  return freshness + clamp(remainingPercent, 0, 100);
}

function hasResetElapsed(resetsAt: number | null): boolean {
  if (!resetsAt) {
    return false;
  }

  const elapsedMs = Date.now() - resetsAt * 1000;
  return elapsedMs >= 0;
}

export function ringLabel(ring: RingState): string {
  switch (ring) {
    case "creating":
      return "Creating";
    case "thinking":
      return "Thinking";
    case "working":
      return "Working";
    case "waitingApproval":
      return "Waiting for approval";
    case "reviewReady":
      return "Ready to review";
    case "failed":
      return "Needs attention";
    case "idle":
      return "Idle";
    case "reconnecting":
      return "Reconnecting";
  }
}

function formatLimitTooltip(limit: LimitBucket): string {
  if (!limit.available || limit.remainingPercent === null) {
    return `${limit.label}: N/A`;
  }

  const reset = limit.resetsAt ? `, resets ${formatResetTime(limit.resetsAt)}` : "";
  return `${limit.label}: ${Math.round(limit.remainingPercent)}% remaining${reset}`;
}

function formatLimitSyncTooltip(state: WidgetState): string {
  const source = formatLimitSource(state.limits.source);
  switch (state.limits.status) {
    case "refreshing":
      return `Quota: syncing${source ? ` from ${source}` : ""}`;
    case "ready":
      return state.limits.lastUpdatedAt
        ? `Quota: updated ${formatUpdateTime(state.limits.lastUpdatedAt)}${source ? ` from ${source}` : ""}`
        : `Quota: ready${source ? ` from ${source}` : ""}`;
    case "stale":
      return `Quota: showing cached data${state.limits.error ? ` (${state.limits.error})` : ""}`;
    case "error":
      return `Quota: unavailable${state.limits.error ? ` (${state.limits.error})` : ""}`;
    case "unknown":
      return "Quota: waiting for usage data";
  }
}

function formatLimitSource(source: LimitSource | null): string | null {
  switch (source) {
    case "appServer":
      return "Codex app-server";
    case "localSession":
      return "local session";
    case null:
      return null;
  }
}

function formatUpdateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }

  return date.toLocaleTimeString();
}

function formatResetTime(resetsAt: number): string {
  const resetDate = new Date(resetsAt * 1000);
  if (Number.isNaN(resetDate.getTime())) {
    return "unknown";
  }

  return resetDate.toLocaleString();
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}...` : id;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
