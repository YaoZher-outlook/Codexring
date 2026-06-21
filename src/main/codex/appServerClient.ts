import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { JsonlRpcClient } from "./jsonlRpc";
import { findCodexBin } from "./codexBin";
import { createLocalSessionSnapshotReader, type LocalSessionSnapshot } from "./localSessionSource";
import {
  applyRateLimits,
  createInitialWidgetState,
  emptyThread,
  hasCreatingStatusText,
  hasThinkingStatusText,
  hasWorkingStatusText,
  mapStatusToRing,
  normalizeStatusText,
  toThreadSummary,
  withTooltip
} from "./state";
import type {
  RateLimitsResult,
  ThreadEventParams,
  ThreadListResult,
  ThreadLoadedListResult,
  ThreadReadResult,
  ThreadResumeResult,
  ThreadStatusChangedParams
} from "./types";
import type { RingState, WidgetState } from "../../shared/widgetTypes";

const DEFAULT_LOCAL_ACTIVITY_POLL_MS = 150;
const DEFAULT_RATE_LIMIT_POLL_MS = 5_000;
const RATE_LIMIT_RESET_REFRESH_DELAY_MS = 1_500;
const RATE_LIMIT_ACTIVITY_REFRESH_DELAY_MS = 250;

export interface CodexProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface CodexControllerOptions {
  findCodexBin?: () => string | null;
  spawnProcess?: (bin: string, args: string[]) => CodexProcess;
  readLocalSessionSnapshot?: () => LocalSessionSnapshot | null;
  rateLimitPollMs?: number;
  localActivityPollMs?: number;
}

export class CodexAppServerController extends EventEmitter {
  private rpc: JsonlRpcClient | null = null;
  private process: CodexProcess | null = null;
  private state: WidgetState = createInitialWidgetState();
  private selectedThreadId: string | null = null;
  private rateLimitTimer: NodeJS.Timeout | null = null;
  private rateLimitResetTimer: NodeJS.Timeout | null = null;
  private rateLimitActivityTimer: NodeJS.Timeout | null = null;
  private rateLimitRefreshPromise: Promise<void> | null = null;
  private localFallbackTimer: NodeJS.Timeout | null = null;
  private readonly localSessionSnapshotReader: () => LocalSessionSnapshot | null;
  private lastLocalSnapshotRevision: string | null = null;
  private localRateLimitsActive = false;

  constructor(private readonly options: CodexControllerOptions = {}) {
    super();
    this.localSessionSnapshotReader = options.readLocalSessionSnapshot ?? createLocalSessionSnapshotReader();
  }

  getState(): WidgetState {
    return this.state;
  }

  async start(): Promise<void> {
    await this.reconnect();
  }

  async reconnect(): Promise<void> {
    this.stopProcess();
    this.stopLocalFallbackPolling();
    this.lastLocalSnapshotRevision = null;
    this.localRateLimitsActive = false;
    this.setState({
      ...this.state,
      connection: {
        status: "connecting",
        error: null,
        detail: null,
        lastConnectedAt: this.state.connection.lastConnectedAt
      },
      ring: "reconnecting"
    });

    const bin = (this.options.findCodexBin ?? findCodexBin)();
    if (!bin) {
      this.setDisconnected("Could not find Codex app-server. Set CODEX_BIN to a runnable codex.exe.");
      return;
    }

    try {
      const child = (this.options.spawnProcess ?? spawnCodexAppServer)(bin, ["app-server"]);
      this.process = child;
      const rpc = new JsonlRpcClient(child.stdout, child.stdin);
      this.rpc = rpc;

      child.stderr.on("data", (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        this.emit("diagnostic", text);
        this.setConnectionDetail(text);
      });

      child.on("exit", (code) => {
        this.setDisconnected(`Codex app-server exited${code === null ? "" : ` (${code})`}`);
      });
      child.on("error", (error) => this.setDisconnected(error.message));

      rpc.on("notification", (message) => this.handleNotification(message.method, message.params));
      rpc.on("serverRequest", (message) => {
        rpc.respondError(message.id, -32601, `${message.method} is not supported by this widget`);
      });
      rpc.on("close", (error) => {
        if (this.rpc === rpc) {
          this.setDisconnected(error?.message ?? "Codex app-server disconnected");
        }
      });

      await rpc.request("initialize", {
        clientInfo: {
          name: "codexring",
          title: "Codexring",
          version: "0.1.0"
        }
      });
      rpc.notify("initialized", {});

      this.setState({
        ...this.state,
        connection: {
          status: "connected",
          error: null,
          detail: null,
          lastConnectedAt: new Date().toISOString()
        },
        ring: "idle"
      });

      const hasLocalSnapshot = this.startLocalActivityPolling();
      await Promise.all([
        hasLocalSnapshot ? Promise.resolve() : this.hydrateThread(),
        this.refreshRateLimits()
      ]);
      this.startRateLimitPolling();
    } catch (error) {
      this.setDisconnected(error instanceof Error ? error.message : String(error));
    }
  }

  async selectThread(threadId: string): Promise<void> {
    this.selectedThreadId = threadId;
    await this.resumeThread(threadId);
  }

  async refreshRateLimits(): Promise<void> {
    if (this.localRateLimitsActive) {
      return;
    }

    if (this.rateLimitRefreshPromise) {
      return this.rateLimitRefreshPromise;
    }

    const rpc = this.rpc;
    if (!rpc) {
      return;
    }

    const refresh = (async () => {
      try {
        const result = await rpc.request<RateLimitsResult>("account/rateLimits/read", undefined, 10_000);
        if (this.rpc === rpc && !this.localRateLimitsActive) {
          this.applyRateLimitState(result);
        }
      } catch (error) {
        if (this.rpc === rpc) {
          this.emit("diagnostic", `rate limits unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();

    this.rateLimitRefreshPromise = refresh;
    await refresh.finally(() => {
      if (this.rateLimitRefreshPromise === refresh) {
        this.rateLimitRefreshPromise = null;
      }
    });
  }

  dispose(): void {
    this.stopProcess();
    this.stopLocalFallbackPolling();
  }

  private async hydrateThread(): Promise<void> {
    if (!this.rpc) {
      return;
    }

    const loadedIds = await this.readLoadedThreadIds();
    if (loadedIds.length > 0) {
      const loadedThreads = await Promise.all(loadedIds.map((id) => this.readThread(id)));
      const selected = newestThread(loadedThreads.filter(isThread));
      if (selected) {
        await this.resumeThread(selected.id);
        return;
      }
    }

    const recent = await this.readRecentThread();
    if (recent) {
      await this.resumeThread(recent.id);
      return;
    }

    this.setState({
      ...this.state,
      thread: emptyThread(),
      ring: mapStatusToRing(this.state.connection.status, null)
    });
  }

  private async readLoadedThreadIds(): Promise<string[]> {
    if (!this.rpc) {
      return [];
    }

    try {
      const result = await this.rpc.request<ThreadLoadedListResult>("thread/loaded/list", undefined, 10_000);
      return result.data ?? [];
    } catch (error) {
      this.emit("diagnostic", `loaded thread list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async readThread(threadId: string): Promise<ThreadReadResult["thread"] | null> {
    if (!this.rpc) {
      return null;
    }

    try {
      const result = await this.rpc.request<ThreadReadResult>(
        "thread/read",
        { threadId, includeTurns: false },
        10_000
      );
      return result.thread ?? null;
    } catch {
      return null;
    }
  }

  private async readRecentThread(): Promise<NonNullable<ThreadListResult["data"]>[number] | null> {
    if (!this.rpc) {
      return null;
    }

    try {
      const result = await this.requestThreadList({
        cursor: null,
        limit: 1,
        sortKey: "updated_at",
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown"
        ]
      });
      return result.data?.[0] ?? null;
    } catch (error) {
      this.emit("diagnostic", `thread list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async requestThreadList(params: Record<string, unknown>): Promise<ThreadListResult> {
    if (!this.rpc) {
      return {};
    }

    try {
      return await this.rpc.request<ThreadListResult>("thread/list", params, 10_000);
    } catch (error) {
      this.emit(
        "diagnostic",
        `thread list with sourceKinds unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
      const { sourceKinds: _sourceKinds, ...fallbackParams } = params;
      return await this.rpc.request<ThreadListResult>("thread/list", fallbackParams, 10_000);
    }
  }

  private async resumeThread(threadId: string): Promise<void> {
    if (!this.rpc) {
      return;
    }

    try {
      const result = await this.rpc.request<ThreadResumeResult>("thread/resume", { threadId }, 20_000);
      const thread = result.thread ?? (await this.readThread(threadId));
      this.selectedThreadId = thread?.id ?? threadId;
      this.setState({
        ...this.state,
        thread: toThreadSummary(thread ?? { id: threadId }),
        ring: mapStatusToRing(this.state.connection.status, thread?.status)
      });
    } catch (error) {
      this.setState({
        ...this.state,
        thread: {
          ...this.state.thread,
          id: threadId,
          title: this.state.thread.title === "No thread" ? threadId : this.state.thread.title
        },
        ring: "failed",
        connection: {
          ...this.state.connection,
          error: error instanceof Error ? error.message : String(error),
          detail: this.state.connection.detail
        }
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "account/rateLimits/updated") {
      if (!this.localRateLimitsActive) {
        this.applyRateLimitState(params as RateLimitsResult);
        void this.refreshRateLimits();
      }
      return;
    }

    if (method === "thread/status/changed") {
      this.handleThreadStatusChanged(params as ThreadStatusChangedParams);
      return;
    }

    if (method === "thread/started" || method === "thread/name/updated") {
      const event = params as ThreadEventParams;
      if (event.thread) {
        this.selectedThreadId = event.thread.id;
        const ring =
          method === "thread/started" ? mapStatusToRing(this.state.connection.status, event.thread.status, "creating") : mapStatusToRing(this.state.connection.status, event.thread.status);
        this.setState({
          ...this.state,
          thread: toThreadSummary(event.thread),
          ring
        });
      }
      return;
    }

    if (method === "thread/closed") {
      const threadId = getThreadId(params as ThreadEventParams);
      if (threadId && threadId === this.selectedThreadId) {
        this.setState({
          ...this.state,
          ring: "idle",
          thread: {
            ...this.state.thread,
            statusType: "notLoaded"
          }
        });
      }
      return;
    }

    if (method.startsWith("turn/") || method.startsWith("item/")) {
      this.handleActivityNotification(method, params as ThreadEventParams);
      if (method === "turn/completed") {
        this.scheduleActivityRateLimitRefresh();
      }
    }
  }

  private handleThreadStatusChanged(params: ThreadStatusChangedParams): void {
    if (params.threadId && this.selectedThreadId && params.threadId !== this.selectedThreadId) {
      return;
    }

    this.selectedThreadId = params.threadId ?? this.selectedThreadId;
    this.setState({
      ...this.state,
      thread: {
        ...this.state.thread,
        id: params.threadId ?? this.state.thread.id,
        statusType: params.status?.type ?? this.state.thread.statusType
      },
      ring: preserveReviewReady(this.state.ring, mapStatusToRing(this.state.connection.status, params.status, this.state.ring))
    });
  }

  private handleActivityNotification(method: string, params: ThreadEventParams): void {
    const threadId = getThreadId(params);
    if (threadId && this.selectedThreadId && threadId !== this.selectedThreadId) {
      return;
    }

    const ring = ringFromActivity(method, params, this.state.ring);
    this.setState({
      ...this.state,
      ring,
      thread: {
        ...this.state.thread,
        id: threadId ?? this.state.thread.id
      }
    });
  }

  private startRateLimitPolling(): void {
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
    }

    this.rateLimitTimer = setInterval(() => {
      void this.refreshRateLimits();
    }, this.options.rateLimitPollMs ?? DEFAULT_RATE_LIMIT_POLL_MS);
  }

  private stopProcess(): void {
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
    this.clearRateLimitResetTimer();
    this.clearActivityRateLimitRefresh();

    this.rpc?.destroy();
    this.rpc = null;
    this.rateLimitRefreshPromise = null;
    const process = this.process;
    this.process = null;
    if (process) {
      process.removeAllListeners("exit");
      process.removeAllListeners("error");
      process.kill();
    }
  }

  private setDisconnected(error: string): void {
    this.stopProcess();
    this.setState({
      ...this.state,
      connection: {
        status: "disconnected",
        error: compactError(error),
        detail: error,
        lastConnectedAt: this.state.connection.lastConnectedAt
      },
      ring: "reconnecting"
    });
    this.refreshLocalFallback(error);
    this.startLocalFallbackPolling(error);
  }

  private refreshLocalFallback(reason: string): void {
    const snapshot = this.readLocalSessionSnapshot();
    if (!snapshot) {
      return;
    }

    const revision = localSnapshotRevision(snapshot);
    if (this.state.connection.status === "fallback" && revision === this.lastLocalSnapshotRevision) {
      return;
    }

    let next: WidgetState = {
      ...this.state,
      connection: {
        status: "fallback",
        error: "Using local Codex session",
        detail: compactError(reason),
        lastConnectedAt: this.state.connection.lastConnectedAt
      },
      thread: snapshot.thread,
      ring: snapshot.ring
    };
    this.localRateLimitsActive = Boolean(snapshot.rateLimits);
    if (snapshot.rateLimits) {
      next = applyRateLimits(next, snapshot.rateLimits, localRateLimitUpdatedAt(snapshot));
    }
    this.selectedThreadId = snapshot.thread.id;
    this.lastLocalSnapshotRevision = revision;
    this.setState(next);
  }

  private refreshLocalActivitySignal(): boolean {
    if (this.state.connection.status !== "connected") {
      return false;
    }

    const snapshot = this.readLocalSessionSnapshot();
    if (!snapshot) {
      return false;
    }

    const revision = localSnapshotRevision(snapshot);
    if (revision === this.lastLocalSnapshotRevision) {
      return true;
    }

    let next: WidgetState = {
      ...this.state,
      thread: snapshot.thread,
      ring: snapshot.ring
    };
    this.localRateLimitsActive = Boolean(snapshot.rateLimits);
    if (snapshot.rateLimits) {
      next = applyRateLimits(next, snapshot.rateLimits, localRateLimitUpdatedAt(snapshot));
    }

    this.selectedThreadId = snapshot.thread.id;
    this.lastLocalSnapshotRevision = revision;
    this.setState(next);
    return true;
  }

  private startLocalFallbackPolling(reason: string): void {
    if (this.localFallbackTimer) {
      clearInterval(this.localFallbackTimer);
    }

    this.localFallbackTimer = setInterval(() => {
      this.refreshLocalFallback(reason);
    }, this.options.localActivityPollMs ?? DEFAULT_LOCAL_ACTIVITY_POLL_MS);
  }

  private startLocalActivityPolling(): boolean {
    if (this.localFallbackTimer) {
      clearInterval(this.localFallbackTimer);
    }

    const hasSnapshot = this.refreshLocalActivitySignal();
    this.localFallbackTimer = setInterval(() => {
      this.refreshLocalActivitySignal();
    }, this.options.localActivityPollMs ?? DEFAULT_LOCAL_ACTIVITY_POLL_MS);
    return hasSnapshot;
  }

  private stopLocalFallbackPolling(): void {
    if (this.localFallbackTimer) {
      clearInterval(this.localFallbackTimer);
      this.localFallbackTimer = null;
    }
  }

  private setConnectionDetail(detail: string): void {
    const normalized = detail.trim();
    if (!normalized) {
      return;
    }

    this.setState({
      ...this.state,
      connection: {
        ...this.state.connection,
        detail: compactError(normalized)
      }
    });
  }

  private setState(next: WidgetState): void {
    this.state = withTooltip({
      ...next,
      revision: this.state.revision + 1
    });
    this.emit("state", this.state);
  }

  private applyRateLimitState(result: RateLimitsResult): void {
    const next = applyRateLimits(this.state, result);
    this.setState(next);
    this.scheduleRateLimitResetRefresh(next);
  }

  private scheduleRateLimitResetRefresh(state: WidgetState): void {
    this.clearRateLimitResetTimer();

    const nextResetAt = nextRateLimitResetAtMs(state);
    if (!nextResetAt) {
      return;
    }

    const delay = Math.max(1_000, nextResetAt - Date.now() + RATE_LIMIT_RESET_REFRESH_DELAY_MS);
    this.rateLimitResetTimer = setTimeout(() => {
      this.rateLimitResetTimer = null;
      void this.refreshRateLimits();
    }, delay);
  }

  private clearRateLimitResetTimer(): void {
    if (this.rateLimitResetTimer) {
      clearTimeout(this.rateLimitResetTimer);
      this.rateLimitResetTimer = null;
    }
  }

  private scheduleActivityRateLimitRefresh(): void {
    this.clearActivityRateLimitRefresh();
    this.rateLimitActivityTimer = setTimeout(() => {
      this.rateLimitActivityTimer = null;
      void this.refreshRateLimits();
    }, RATE_LIMIT_ACTIVITY_REFRESH_DELAY_MS);
  }

  private clearActivityRateLimitRefresh(): void {
    if (this.rateLimitActivityTimer) {
      clearTimeout(this.rateLimitActivityTimer);
      this.rateLimitActivityTimer = null;
    }
  }

  private readLocalSessionSnapshot(): LocalSessionSnapshot | null {
    return this.localSessionSnapshotReader();
  }
}

function spawnCodexAppServer(bin: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

function newestThread(threads: NonNullable<ThreadReadResult["thread"]>[]): NonNullable<ThreadReadResult["thread"]> | null {
  if (threads.length === 0) {
    return null;
  }

  return [...threads].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];
}

function isThread(thread: ThreadReadResult["thread"] | null | undefined): thread is NonNullable<ThreadReadResult["thread"]> {
  return Boolean(thread);
}

function getThreadId(params: ThreadEventParams): string | null {
  return params.threadId ?? params.thread?.id ?? params.turn?.threadId ?? params.item?.threadId ?? null;
}

function nextRateLimitResetAtMs(state: WidgetState): number | null {
  const now = Date.now();
  const resetTimes = [state.limits.fiveHour.resetsAt, state.limits.weekly.resetsAt]
    .filter((value): value is number => typeof value === "number" && value * 1000 > now)
    .map((value) => value * 1000);

  if (resetTimes.length === 0) {
    return null;
  }

  return Math.min(...resetTimes);
}

function preserveReviewReady(current: RingState, next: RingState): RingState {
  return current === "reviewReady" && next === "idle" ? "reviewReady" : next;
}

function ringFromActivity(method: string, params: ThreadEventParams, current: RingState): RingState {
  const methodText = normalizeStatusText(method);
  const statusText = normalizeStatusText(String(params.turn?.status ?? params.status ?? ""));
  const itemType = normalizeStatusText(params.item?.type ?? "");

  if (method === "thread/started" || methodText.includes("creating") || methodText.includes("created")) {
    return "creating";
  }

  if (method === "turn/started") {
    return "thinking";
  }

  if (
    method === "turn/completed" ||
    methodText.includes("completed") ||
    methodText.includes("finished") ||
    methodText.includes("ended")
  ) {
    if (params.turn?.error || params.error || statusText.includes("failed") || statusText.includes("error")) {
      return "failed";
    }

    if (statusText.includes("interrupted") || statusText.includes("cancel")) {
      return "idle";
    }

    return "reviewReady";
  }

  if (
    params.turn?.error ||
    params.error ||
    statusText.includes("failed") ||
    statusText.includes("error") ||
    methodText.includes("failed")
  ) {
    return "failed";
  }

  if (statusText.includes("interrupted") || statusText.includes("cancel") || methodText.includes("cancel")) {
    return "idle";
  }

  if (itemType && hasCreatingStatusText(itemType)) {
    return "creating";
  }

  if (itemType && hasWorkingStatusText(itemType)) {
    return "working";
  }

  if (itemType && hasThinkingStatusText(itemType)) {
    return "thinking";
  }

  if (method === "item/started") {
    return "working";
  }

  if (hasCreatingStatusText(statusText)) {
    return "creating";
  }

  if (hasWorkingStatusText(statusText)) {
    return "working";
  }

  if (hasThinkingStatusText(statusText)) {
    return "thinking";
  }

  if (method.startsWith("turn/") && (methodText.includes("started") || methodText.includes("created"))) {
    return methodText.includes("created") ? "creating" : "thinking";
  }

  if (method.startsWith("item/") && (methodText.includes("started") || methodText.includes("created"))) {
    return methodText.includes("created") ? "creating" : "working";
  }

  return current;
}

function compactError(error: string): string {
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function localSnapshotRevision(snapshot: LocalSessionSnapshot): string {
  return [
    snapshot.thread.id ?? "",
    snapshot.updatedAtMs,
    snapshot.activityUpdatedAtMs,
    snapshot.rateLimitsUpdatedAtMs ?? "",
    snapshot.ring
  ].join(":");
}

function localRateLimitUpdatedAt(snapshot: LocalSessionSnapshot): string {
  const timestamp = snapshot.rateLimitsUpdatedAtMs ?? snapshot.updatedAtMs;
  return new Date(timestamp).toISOString();
}
