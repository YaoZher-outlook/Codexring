import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App";
import type { WidgetApi, WidgetState } from "../src/shared/widgetTypes";

describe("App", () => {
  it("renders stable limit bars from preload state", async () => {
    const state: WidgetState = {
      connection: { status: "connected", error: null, detail: null, lastConnectedAt: "now" },
      thread: {
        id: "thr_1",
        title: "UI work",
        preview: "UI work",
        statusType: "working",
        updatedAt: 1
      },
      ring: "working",
      limits: {
        fiveHour: {
          label: "5h",
          available: true,
          usedPercent: 25,
          remainingPercent: 75,
          windowDurationMins: 300,
          resetsAt: null,
          tone: "ok",
          reached: false
        },
        weekly: {
          label: "Week",
          available: false,
          usedPercent: null,
          remainingPercent: null,
          windowDurationMins: 10080,
          resetsAt: null,
          tone: "muted",
          reached: false
        },
        lastUpdatedAt: "now"
      },
      tooltip: {
        primary: "Working - UI work",
        detail: ["Connected to Codex app-server", "5h: 75% remaining", "Week: N/A"]
      }
    };

    window.codexWidget = {
      onStateChanged(listener: (next: WidgetState) => void) {
        listener(state);
        return () => undefined;
      },
      onOpenSettings() {
        return () => undefined;
      },
      onSettingsChanged() {
        return () => undefined;
      },
      publishSettings: async () => undefined,
      reconnect: async () => undefined,
      selectThread: async () => undefined,
      openMenu: async () => undefined,
      closeSettings: async () => undefined,
      setSettingsOpen: async () => undefined,
      setMousePassthrough: async () => undefined,
      setContentSize: async () => undefined,
      beginWindowDrag: async () => undefined,
      moveWindowDrag: async () => undefined,
      endWindowDrag: async () => undefined
    } satisfies WidgetApi;

    render(<App />);

    expect(await screen.findByLabelText("Codex status widget")).toHaveAttribute("data-ring", "working");
    expect(screen.getByLabelText("5h limit 75%")).toBeInTheDocument();
    expect(screen.getByLabelText("周 limit N/A")).toBeInTheDocument();
  });
});
