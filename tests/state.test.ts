import { describe, expect, it } from "vitest";
import {
  createInitialWidgetState,
  findRateLimitWindow,
  mapStatusToRing,
  toLimitBucket
} from "../src/main/codex/state";

describe("Codex widget state helpers", () => {
  it("maps active waiting-on-approval status to the approval ring", () => {
    expect(
      mapStatusToRing("connected", {
        type: "active",
        activeFlags: ["waitingOnApproval"]
      })
    ).toBe("waitingApproval");
  });

  it("prefers disconnected over any thread status", () => {
    expect(mapStatusToRing("disconnected", { type: "working" })).toBe("reconnecting");
  });

  it("maps working/thinking status names to distinct rings", () => {
    expect(mapStatusToRing("connected", { type: "creating" })).toBe("creating");
    expect(mapStatusToRing("connected", { type: "working" })).toBe("working");
    expect(mapStatusToRing("connected", { type: "thinking" })).toBe("thinking");
    expect(mapStatusToRing("connected", { type: "in_progress" })).toBe("working");
    expect(mapStatusToRing("connected", { type: "idle", activeFlags: ["streamingResponse"] })).toBe("thinking");
  });

  it("does not treat a generic active thread marker as thinking", () => {
    expect(mapStatusToRing("connected", { type: "active" })).toBe("idle");
    expect(mapStatusToRing("connected", { type: "active" }, "working")).toBe("working");
  });

  it("maps waiting-on-user-input to the waiting ring", () => {
    expect(
      mapStatusToRing("connected", {
        type: "active",
        activeFlags: ["waitingOnUserInput"]
      })
    ).toBe("waitingApproval");
  });

  it("selects 5h and weekly rate limit windows by duration", () => {
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const result = {
      rateLimitsByLimitId: {
        codex_fast: {
          limitId: "codex_fast",
          primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: futureReset }
        },
        codex_week: {
          limitId: "codex_week",
          primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: futureReset }
        }
      }
    };

    expect(findRateLimitWindow(result, 300)?.usedPercent).toBe(60);
    expect(findRateLimitWindow(result, 10080)?.usedPercent).toBe(10);
  });

  it("accepts local session snake_case rate limit fields", () => {
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const result = {
      rate_limits: {
        primary: { used_percent: 11, window_minutes: 300, resets_at: futureReset },
        secondary: { used_percent: 44, window_minutes: 10080, resets_at: futureReset }
      }
    };

    expect(findRateLimitWindow(result, 300)?.used_percent).toBe(11);
    expect(findRateLimitWindow(result, 10080)?.used_percent).toBe(44);
    expect(toLimitBucket("5h", 300, findRateLimitWindow(result, 300))).toMatchObject({
      available: true,
      remainingPercent: 89,
      tone: "ok"
    });
  });

  it("turns used percentage into remaining blood-bar percentage and tone", () => {
    expect(toLimitBucket("5h", 300, { usedPercent: 64, windowDurationMins: 300 })).toMatchObject({
      available: true,
      usedPercent: 64,
      remainingPercent: 36,
      tone: "warn"
    });

    expect(toLimitBucket("Week", 10080, null)).toMatchObject({
      available: false,
      tone: "muted",
      remainingPercent: null
    });
  });

  it("prefers explicit remaining percentage fields when app-server provides them", () => {
    expect(
      toLimitBucket("5h", 300, {
        usedPercent: 29,
        remainingPercent: 99,
        windowDurationMins: 300
      })
    ).toMatchObject({
      available: true,
      usedPercent: 1,
      remainingPercent: 99,
      tone: "ok"
    });

    expect(
      toLimitBucket("Week", 10080, {
        percent_used: 74,
        percent_remaining: 26,
        window_minutes: 10080
      })
    ).toMatchObject({
      available: true,
      usedPercent: 74,
      remainingPercent: 26,
      tone: "warn"
    });
  });

  it("treats an expired window as reset while app-server catches up", () => {
    const bucket = toLimitBucket("5h", 300, {
      usedPercent: 29,
      windowDurationMins: 300,
      resetsAt: Math.floor(Date.now() / 1000) - 2
    });

    expect(bucket).toMatchObject({
      available: true,
      usedPercent: 0,
      remainingPercent: 100,
      tone: "ok",
      reached: false
    });
  });

  it("starts disconnected until the app-server handshake succeeds", () => {
    expect(createInitialWidgetState()).toMatchObject({
      ring: "reconnecting",
      connection: { status: "connecting" }
    });
  });
});
