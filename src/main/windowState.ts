import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";

interface StoredWindowState {
  x: number;
  y: number;
}

const WIDTH = 176;
const HEIGHT = 72;

export function getInitialBounds(): Electron.Rectangle {
  const saved = readSavedState();
  if (saved && isInsideDisplay(saved.x, saved.y)) {
    return { x: saved.x, y: saved.y, width: WIDTH, height: HEIGHT };
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + workArea.width - WIDTH - 28,
    y: workArea.y + 64,
    width: WIDTH,
    height: HEIGHT
  };
}

export function persistWindowState(window: BrowserWindow): void {
  const [x, y] = window.getPosition();
  writeFileSync(statePath(), JSON.stringify({ x, y }, null, 2));
}

export function keepWindowInsideScreen(window: BrowserWindow): void {
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - bounds.width);
  const y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - bounds.height);
  window.setBounds({ ...bounds, x, y });
  persistWindowState(window);
}

function readSavedState(): StoredWindowState | null {
  const path = statePath();
  if (!existsSync(path)) {
    return null;
  }

  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as StoredWindowState;
    return typeof value.x === "number" && typeof value.y === "number" ? value : null;
  } catch {
    return null;
  }
}

function isInsideDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
  });
}

function statePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
