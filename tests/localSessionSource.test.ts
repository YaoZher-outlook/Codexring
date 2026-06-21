import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLatestLocalSessionSnapshot } from "../src/main/codex/localSessionSource";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local Codex session snapshots", () => {
  it("reconstructs the turn lifecycle from semantic session events", () => {
    const fixture = createSessionFixture();

    fixture.append("event_msg", { type: "task_started" }, "2026-06-18T01:00:00.000Z");
    expect(readLatestLocalSessionSnapshot(fixture.codexHome)).toMatchObject({
      ring: "creating",
      active: true,
      activityKind: "event_msg:task_started"
    });

    fixture.append("response_item", { type: "reasoning" }, "2026-06-18T01:00:01.000Z");
    expect(readLatestLocalSessionSnapshot(fixture.codexHome)?.ring).toBe("thinking");

    fixture.append(
      "response_item",
      { type: "function_call", name: "shell_command" },
      "2026-06-18T01:00:02.000Z"
    );
    expect(readLatestLocalSessionSnapshot(fixture.codexHome)?.ring).toBe("working");

    fixture.append("response_item", { type: "function_call_output" }, "2026-06-18T01:00:03.000Z");
    expect(readLatestLocalSessionSnapshot(fixture.codexHome)?.ring).toBe("thinking");

    fixture.append("event_msg", { type: "task_complete" }, "2026-06-18T01:00:04.000Z");
    fixture.append("event_msg", { type: "item_completed" }, "2026-06-18T01:00:05.000Z");
    expect(readLatestLocalSessionSnapshot(fixture.codexHome)).toMatchObject({
      ring: "reviewReady",
      active: false,
      activityKind: "event_msg:task_complete"
    });
  });

  it("reads waiting-for-input and the latest quota snapshot", () => {
    const fixture = createSessionFixture();
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;

    fixture.append("event_msg", { type: "task_started" }, "2026-06-18T01:00:00.000Z");
    fixture.append(
      "response_item",
      { type: "function_call", name: "request_user_input" },
      "2026-06-18T01:00:01.000Z"
    );
    fixture.append(
      "event_msg",
      {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 26, window_minutes: 300, resets_at: resetsAt },
          secondary: { used_percent: 4, window_minutes: 10080, resets_at: resetsAt }
        }
      },
      "2026-06-18T01:00:02.000Z"
    );

    const snapshot = readLatestLocalSessionSnapshot(fixture.codexHome);
    expect(snapshot).toMatchObject({
      ring: "waitingApproval",
      active: true,
      rateLimitsUpdatedAtMs: Date.parse("2026-06-18T01:00:02.000Z"),
      rateLimits: {
        rate_limits: {
          primary: { used_percent: 26 },
          secondary: { used_percent: 4 }
        }
      }
    });
  });
});

function createSessionFixture(): {
  codexHome: string;
  append(type: string, payload: Record<string, unknown>, timestamp: string): void;
} {
  const codexHome = mkdtempSync(join(tmpdir(), "codey-session-"));
  tempDirs.push(codexHome);
  const sessionDir = join(codexHome, "sessions", "2026", "06", "18");
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "rollout-2026-06-18T01-00-00-thread_test.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      timestamp: "2026-06-18T01:00:00.000Z",
      type: "session_meta",
      payload: { id: "thread_test", cwd: "E:\\Projects\\App\\codey", originator: "codex" }
    })}\n`,
    "utf8"
  );

  return {
    codexHome,
    append(type, payload, timestamp) {
      appendFileSync(sessionFile, `${JSON.stringify({ timestamp, type, payload })}\n`, "utf8");
    }
  };
}
