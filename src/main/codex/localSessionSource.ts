import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { RateLimitsResult } from "./types";
import type { RingState, ThreadSummary } from "../../shared/widgetTypes";

const SESSION_RESCAN_MS = 1_000;
const SESSION_HEAD_BYTES = 128_000;
const SESSION_TAIL_BYTES = 4_000_000;

export interface LocalSessionSnapshot {
  thread: ThreadSummary;
  rateLimits: RateLimitsResult | null;
  rateLimitsUpdatedAtMs: number | null;
  ring: RingState;
  active: boolean;
  updatedAtMs: number;
  activityUpdatedAtMs: number;
  activityKind: string | null;
}

interface SessionMeta {
  id?: string;
  cwd?: string;
  originator?: string;
  source?: string;
}

export function readLatestLocalSessionSnapshot(codexHome = join(homedir(), ".codex")): LocalSessionSnapshot | null {
  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) {
    return null;
  }

  const latest = findLatestJsonl(sessionsDir);
  if (!latest) {
    return null;
  }

  return readSessionSnapshot(latest);
}

export function createLocalSessionSnapshotReader(
  codexHome = join(homedir(), ".codex")
): () => LocalSessionSnapshot | null {
  const sessionsDir = join(codexHome, "sessions");
  let latest: SessionFile | null = null;
  let cachedSnapshot: LocalSessionSnapshot | null = null;
  let cachedPath: string | null = null;
  let nextRescanAt = 0;

  return () => {
    if (!existsSync(sessionsDir)) {
      return null;
    }

    const now = Date.now();
    if (!latest || now >= nextRescanAt) {
      const candidate = findLatestJsonl(sessionsDir);
      nextRescanAt = now + SESSION_RESCAN_MS;
      if (candidate) {
        latest = candidate;
      }
    }

    if (!latest) {
      return null;
    }

    try {
      const stat = statSync(latest.fullPath);
      if (cachedSnapshot && cachedPath === latest.fullPath && stat.mtimeMs === cachedSnapshot.updatedAtMs) {
        return cachedSnapshot;
      }
      latest = { fullPath: latest.fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      latest = null;
      cachedSnapshot = null;
      cachedPath = null;
      return null;
    }

    cachedSnapshot = readSessionSnapshot(latest);
    cachedPath = latest.fullPath;
    return cachedSnapshot;
  };
}

interface SessionFile {
  fullPath: string;
  mtimeMs: number;
  size: number;
}

function readSessionSnapshot(latest: SessionFile): LocalSessionSnapshot {
  const text = readTail(latest.fullPath, latest.size, SESSION_TAIL_BYTES);
  const head = readHead(latest.fullPath, latest.size, SESSION_HEAD_BYTES);
  const meta = readSessionMeta(head);
  const rateLimitSnapshot = readLatestRateLimits(text);
  const activity = readLatestActivity(text);
  const threadId = meta?.id ?? threadIdFromFilename(latest.fullPath);
  const cwdName = meta?.cwd ? basename(meta.cwd) : null;

  return {
    thread: {
      id: threadId,
      title: cwdName ? `Local: ${cwdName}` : "Local Codex session",
      preview: [meta?.originator, meta?.source].filter(Boolean).join(" / "),
      statusType: "localSession",
      updatedAt: latest.mtimeMs
    },
    rateLimits: rateLimitSnapshot?.result ?? null,
    rateLimitsUpdatedAtMs: rateLimitSnapshot?.updatedAtMs ?? null,
    ring: activity?.ring ?? "idle",
    active: activity?.active ?? false,
    updatedAtMs: latest.mtimeMs,
    activityUpdatedAtMs: activity?.updatedAtMs ?? latest.mtimeMs,
    activityKind: activity?.kind ?? null
  };
}

function findLatestJsonl(root: string): SessionFile | null {
  const queue = [root];
  let latest: SessionFile | null = null;

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      try {
        const stat = statSync(fullPath);
        const mtimeMs = stat.mtimeMs;
        if (!latest || mtimeMs > latest.mtimeMs) {
          latest = { fullPath, mtimeMs, size: stat.size };
        }
      } catch {
        // Ignore files that are being rotated or temporarily locked.
      }
    }
  }

  return latest;
}

function readHead(fullPath: string, size: number, maxBytes: number): string {
  return readRange(fullPath, 0, Math.min(size, maxBytes));
}

function readTail(fullPath: string, size: number, maxBytes: number): string {
  const start = Math.max(0, size - maxBytes);
  const text = readRange(fullPath, start, size - start);
  if (start === 0) {
    return text;
  }

  const firstNewline = text.indexOf("\n");
  return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
}

function readRange(fullPath: string, start: number, length: number): string {
  if (length <= 0) {
    return "";
  }

  let fd: number | null = null;
  try {
    fd = openSync(fullPath, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function readSessionMeta(text: string): SessionMeta | null {
  for (const line of text.split(/\r?\n/)) {
    const value = parseJsonLine(line);
    if (value?.type === "session_meta" && isRecord(value.payload)) {
      return value.payload as SessionMeta;
    }
  }

  return null;
}

function readLatestRateLimits(text: string): { result: RateLimitsResult; updatedAtMs: number } | null {
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const value = parseJsonLine(line);
    if (
      value?.type === "event_msg" &&
      isRecord(value.payload) &&
      value.payload.type === "token_count" &&
      isRecord(value.payload.rate_limits)
    ) {
      const updatedAtMs = timestampOf(value) ?? Date.now();
      return {
        result: {
          rateLimits: value.payload.rate_limits as RateLimitsResult["rateLimits"],
          rate_limits: value.payload.rate_limits as RateLimitsResult["rate_limits"]
        },
        updatedAtMs
      };
    }
  }

  return null;
}

interface LocalActivity {
  updatedAtMs: number;
  kind: string;
  ring: RingState;
  active: boolean;
}

function readLatestActivity(text: string): LocalActivity | null {
  const lines = text.split(/\r?\n/);
  let activity: LocalActivity | null = null;

  for (const line of lines) {
    const value = parseJsonLine(line);
    if (!value) {
      continue;
    }

    const timestamp = timestampOf(value);
    if (timestamp === null) {
      continue;
    }

    if (value.type === "response_item" && isRecord(value.payload)) {
      if (activity?.ring === "reviewReady" && !activity.active) {
        continue;
      }
      const next = classifyResponseItem(value.payload);
      if (next) {
        activity = { ...next, updatedAtMs: timestamp };
      }
      continue;
    }

    if (value.type === "event_msg" && isRecord(value.payload)) {
      if (activity?.ring === "reviewReady" && !activity.active && !isTurnStartEvent(value.payload)) {
        continue;
      }
      const next = classifyEventMessage(value.payload);
      if (next) {
        activity = { ...next, updatedAtMs: timestamp };
      }
    }
  }

  return activity;
}

function isTurnStartEvent(payload: Record<string, unknown>): boolean {
  const type = normalize(String(payload.type ?? ""));
  return type === "taskstarted" || type === "turnstarted" || type === "usermessage";
}

function classifyResponseItem(payload: Record<string, unknown>): Omit<LocalActivity, "updatedAtMs"> | null {
  const rawType = String(payload.type ?? "");
  const type = normalize(rawType);
  const toolName = normalize(String(payload.name ?? payload.tool ?? ""));
  const kind = `response_item:${rawType}`;

  if (type === "reasoning" || type === "message" || type.includes("agentmessage")) {
    return { kind, ring: "thinking", active: true };
  }

  if (type.includes("output")) {
    return { kind, ring: "thinking", active: true };
  }

  if (type.includes("call")) {
    const waitingForUser = toolName.includes("requestuserinput") || toolName.includes("approval");
    return { kind, ring: waitingForUser ? "waitingApproval" : "working", active: true };
  }

  if (type.includes("imagegeneration") || type.includes("filechange")) {
    return { kind, ring: "working", active: true };
  }

  return null;
}

function classifyEventMessage(payload: Record<string, unknown>): Omit<LocalActivity, "updatedAtMs"> | null {
  const rawType = String(payload.type ?? "");
  const type = normalize(rawType);
  const kind = `event_msg:${rawType}`;

  if (!type || type === "tokencount") {
    return null;
  }

  if (type === "taskstarted" || type === "turnstarted" || type === "usermessage") {
    return { kind, ring: "creating", active: true };
  }

  if (type === "taskcomplete" || type === "turncomplete") {
    return { kind, ring: "reviewReady", active: false };
  }

  if (type.includes("failed") || type.includes("error")) {
    return { kind, ring: "failed", active: false };
  }

  if (type.includes("cancel") || type.includes("interrupt") || type.includes("abort")) {
    return { kind, ring: "idle", active: false };
  }

  if (type.includes("approval") || type.includes("userinput")) {
    return { kind, ring: "waitingApproval", active: true };
  }

  if (type.includes("contextcompact")) {
    return { kind, ring: "creating", active: true };
  }

  if (type.includes("begin") || type.includes("started")) {
    return { kind, ring: "working", active: true };
  }

  if (type.includes("end") || type.includes("completed") || type.includes("agentmessage")) {
    return { kind, ring: "thinking", active: true };
  }

  return null;
}

function timestampOf(value: Record<string, unknown>): number | null {
  if (typeof value.timestamp !== "string") {
    return null;
  }

  const timestamp = Date.parse(value.timestamp);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function threadIdFromFilename(fullPath: string): string {
  return basename(fullPath, ".jsonl").replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
