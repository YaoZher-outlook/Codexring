import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { RateLimitsResult } from "./types";
import type { ThreadSummary } from "../../shared/widgetTypes";

export interface LocalSessionSnapshot {
  thread: ThreadSummary;
  rateLimits: RateLimitsResult | null;
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

  const text = readTail(latest.fullPath, 2_000_000);
  const head = readHead(latest.fullPath, 200_000);
  const meta = readSessionMeta(head);
  const rateLimits = readLatestRateLimits(text);
  const activity = readLatestActivity(text);
  const threadId = meta?.id ?? threadIdFromFilename(latest.fullPath);
  const cwdName = meta?.cwd ? basename(meta.cwd) : null;

  return {
    thread: {
      id: threadId,
      title: cwdName ? `Local: ${cwdName}` : "Local Codex session",
      preview: [meta?.originator, meta?.source].filter(Boolean).join(" / "),
      statusType: "localFallback",
      updatedAt: latest.mtimeMs
    },
    rateLimits,
    updatedAtMs: latest.mtimeMs,
    activityUpdatedAtMs: activity?.updatedAtMs ?? latest.mtimeMs,
    activityKind: activity?.kind ?? null
  };
}

function findLatestJsonl(root: string): { fullPath: string; mtimeMs: number } | null {
  const queue = [root];
  let latest: { fullPath: string; mtimeMs: number } | null = null;

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
        const mtimeMs = statSync(fullPath).mtimeMs;
        if (!latest || mtimeMs > latest.mtimeMs) {
          latest = { fullPath, mtimeMs };
        }
      } catch {
        // Ignore files that are being rotated or temporarily locked.
      }
    }
  }

  return latest;
}

function readHead(fullPath: string, maxBytes: number): string {
  try {
    const buffer = readFileSync(fullPath);
    return buffer.subarray(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

function readTail(fullPath: string, maxBytes: number): string {
  try {
    const buffer = readFileSync(fullPath);
    return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
  } catch {
    return "";
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

function readLatestRateLimits(text: string): RateLimitsResult | null {
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const value = parseJsonLine(line);
    if (
      value?.type === "event_msg" &&
      isRecord(value.payload) &&
      value.payload.type === "token_count" &&
      isRecord(value.payload.rate_limits)
    ) {
      return {
        rateLimits: value.payload.rate_limits as RateLimitsResult["rateLimits"],
        rate_limits: value.payload.rate_limits as RateLimitsResult["rate_limits"]
      };
    }
  }

  return null;
}

function readLatestActivity(text: string): { updatedAtMs: number; kind: string } | null {
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const value = parseJsonLine(line);
    if (!value) {
      continue;
    }

    const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
    if (Number.isNaN(timestamp)) {
      continue;
    }

    if (value.type === "response_item" && isRecord(value.payload)) {
      const kind = [value.type, value.payload.type].filter(Boolean).join(":");
      return { updatedAtMs: timestamp, kind };
    }

    if (value.type === "event_msg" && isRecord(value.payload)) {
      const payloadType = String(value.payload.type ?? "");
      if (payloadType !== "token_count") {
        return { updatedAtMs: timestamp, kind: `${value.type}:${payloadType}` };
      }
    }
  }

  return null;
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
