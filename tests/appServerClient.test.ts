import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerController,
  type CodexProcess
} from "../src/main/codex/appServerClient";

class FakeCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  private buffer = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.handleInput(chunk));
  }

  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleInput(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.respond(JSON.parse(line));
      }
    }
  }

  private respond(message: { id?: number; method: string }): void {
    if (message.id === undefined) {
      return;
    }

    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const resultByMethod: Record<string, unknown> = {
      initialize: { userAgent: "fake", platformFamily: "windows", platformOs: "win32" },
      "thread/loaded/list": { data: [] },
      "thread/list": {
        data: [
          {
            id: "thr_recent",
            name: "Recent work",
            preview: "Fix the UI",
            updatedAt: 10,
            status: { type: "notLoaded" }
          }
        ],
        nextCursor: null
      },
      "thread/resume": {
        thread: {
          id: "thr_recent",
          name: "Recent work",
          updatedAt: 10,
          status: { type: "idle" }
        }
      },
      "account/rateLimits/read": {
        rateLimitsByLimitId: {
          codex_5h: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: futureReset }
          },
          codex_week: {
            primary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: futureReset }
          }
        }
      }
    };

    this.stdout.write(`${JSON.stringify({ id: message.id, result: resultByMethod[message.method] ?? {} })}\n`);
  }
}

describe("CodexAppServerController", () => {
  it("hydrates the recent thread and updates ring state from notifications", async () => {
    const fake = new FakeCodexProcess();
    const controller = new CodexAppServerController({
      findCodexBin: () => "codex",
      spawnProcess: () => fake,
      readLocalSessionSnapshot: () => null,
      rateLimitPollMs: 60_000
    });

    await controller.start();
    expect(controller.getState()).toMatchObject({
      connection: { status: "connected" },
      thread: { id: "thr_recent", title: "Recent work" },
      limits: {
        fiveHour: { remainingPercent: 75 },
        weekly: { remainingPercent: 50 }
      }
    });

    fake.notify("thread/started", {
      thread: {
        id: "thr_recent",
        name: "Recent work",
        updatedAt: 11,
        status: { type: "creating" }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().ring).toBe("creating");

    fake.notify("thread/status/changed", {
      threadId: "thr_recent",
      status: { type: "active", activeFlags: ["waitingOnApproval"] }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().ring).toBe("waitingApproval");

    fake.notify("turn/updated", {
      threadId: "thr_recent",
      status: "thinking"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().ring).toBe("thinking");

    fake.notify("turn/completed", {
      threadId: "thr_recent",
      status: "completed"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().ring).toBe("reviewReady");

    fake.notify("thread/status/changed", {
      threadId: "thr_recent",
      status: { type: "idle" }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().ring).toBe("reviewReady");

    fake.notify("turn/started", {
      threadId: "thr_recent"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().ring).toBe("thinking");
    controller.dispose();
  });

  it("uses recent local session writes as an activity signal when app-server status is idle", async () => {
    const fake = new FakeCodexProcess();
    let updatedAtMs = Date.now();
    const controller = new CodexAppServerController({
      findCodexBin: () => "codex",
      spawnProcess: () => fake,
      readLocalSessionSnapshot: () => ({
        thread: {
          id: "local_current",
          title: "Local: codey",
          preview: "codex desktop",
          statusType: "localFallback",
          updatedAt: updatedAtMs
        },
        rateLimits: null,
        updatedAtMs,
        activityUpdatedAtMs: updatedAtMs,
        activityKind: "response_item:reasoning"
      }),
      rateLimitPollMs: 60_000,
      localActivityPollMs: 5,
      localActivityFreshMs: 20
    });

    await controller.start();
    expect(controller.getState()).toMatchObject({
      ring: "thinking",
      thread: { id: "local_current", statusType: "localActivity" }
    });

    updatedAtMs = Date.now() - 120_000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.getState().ring).toBe("idle");
    controller.dispose();
  });
});
