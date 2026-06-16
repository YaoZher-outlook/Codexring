import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import { join } from "node:path";
import { CodexAppServerController } from "./codex/appServerClient";
import { getInitialBounds, keepWindowInsideScreen, persistWindowState } from "./windowState";

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let dragState:
  | {
      window: BrowserWindow;
      startX: number;
      startY: number;
      windowX: number;
      windowY: number;
    }
  | null = null;
let topMostTimer: ReturnType<typeof setInterval> | null = null;
const mousePassthroughByWindow = new Map<number, boolean>();
const controller = new CodexAppServerController();

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const WIDGET_SIZE = { width: 176, height: 72 };
const COMPACT_WIDGET_SIZE = { width: 66, height: 66 };
const SETTINGS_SIZE = { width: 380, height: 344 };

function createWindow(): BrowserWindow {
  const bounds = getInitialBounds();
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setMenuBarVisibility(false);
  startTopMostEnforcer(window);

  window.on("moved", () => persistWindowState(window));
  window.on("ready-to-show", () => {
    window.showInactive();
    keepWindowInsideScreen(window);
    enforceTopMost(window);
    setWindowMousePassthrough(window, true);
  });
  window.on("show", () => enforceTopMost(window));
  window.on("blur", () => enforceTopMost(window));
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    mousePassthroughByWindow.delete(window.id);
    stopTopMostEnforcer(window);
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

function createSettingsWindow(): BrowserWindow {
  const bounds = getSettingsBounds();
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.setAlwaysOnTop(true);
  window.setMenuBarVisibility(false);

  window.on("ready-to-show", () => {
    window.show();
    window.moveTop();
  });
  window.on("closed", () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
    mousePassthroughByWindow.delete(window.id);
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set("view", "settings");
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      query: { view: "settings" }
    });
  }

  return window;
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    "data:image/svg+xml;utf8," +
      encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="8" fill="#101319"/>
          <circle cx="16" cy="16" r="9" fill="none" stroke="#59d18c" stroke-width="4"/>
          <circle cx="16" cy="16" r="3" fill="#f2c84b"/>
        </svg>
      `)
  );
  tray = new Tray(icon);
  tray.setToolTip("Codey");
  tray.setContextMenu(buildMenu());
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Settings",
      click: () => openSettings()
    },
    {
      label: "Reconnect",
      click: () => {
        void controller.reconnect();
      }
    },
    {
      label: "Keep inside screen",
      click: () => {
        if (mainWindow) {
          keepWindowInsideScreen(mainWindow);
        }
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => quitApp()
    }
  ]);
}

function popupMenu(window: BrowserWindow): void {
  setWindowMousePassthrough(window, false);
  buildMenu().popup({ window });
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  createTray();

  controller.on("state", (state) => {
    sendStateToWindow(state);
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(`${state.tooltip.primary}\n${state.tooltip.detail.join("\n")}`);
    }
  });
  controller.on("diagnostic", (message) => {
    console.warn(`[codex-widget] ${String(message).trim()}`);
  });
  void controller.start();

  ipcMain.handle("widget:getState", () => controller.getState());
  ipcMain.handle("widget:reconnect", async () => {
    await controller.reconnect();
  });
  ipcMain.handle("widget:selectThread", async (_event, threadId: string) => {
    await controller.selectThread(threadId);
  });
  ipcMain.handle("widget:openMenu", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      popupMenu(mainWindow);
    }
  });
  ipcMain.handle("widget:settings:changed", (event, settings: unknown) => {
    broadcastSettings(settings, event.sender);
  });
  ipcMain.handle("widget:settings:close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && window === settingsWindow && !window.isDestroyed()) {
      window.close();
    } else if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });
  ipcMain.handle("widget:settings:setOpen", (_event, open: boolean) => {
    if (open) {
      openSettings();
    } else if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });
  ipcMain.handle("widget:mouse:setPassthrough", (event, ignore: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      return;
    }

    setWindowMousePassthrough(window, ignore);
  });
  ipcMain.handle("widget:content:setSize", (event, size: { width: number; height: number }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || window !== mainWindow) {
      return;
    }

    setContentSize(window, size);
  });
  ipcMain.handle("widget:drag:start", (event, point: { screenX: number; screenY: number }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      return;
    }

    setWindowMousePassthrough(window, false);
    const [windowX, windowY] = window.getPosition();
    dragState = {
      window,
      startX: point.screenX,
      startY: point.screenY,
      windowX,
      windowY
    };
  });
  ipcMain.handle("widget:drag:move", (_event, point: { screenX: number; screenY: number }) => {
    if (!dragState || dragState.window.isDestroyed()) {
      return;
    }

    const x = Math.round(dragState.windowX + point.screenX - dragState.startX);
    const y = Math.round(dragState.windowY + point.screenY - dragState.startY);
    dragState.window.setPosition(x, y);
  });
  ipcMain.handle("widget:drag:end", () => {
    if (dragState && !dragState.window.isDestroyed()) {
      if (dragState.window === mainWindow) {
        persistWindowState(dragState.window);
      }
    }
    dragState = null;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopTopMostEnforcer();
  controller.dispose();
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
});

app.on("window-all-closed", () => {
  // Keep the tray process alive until the user chooses Quit.
});

function sendStateToWindow(state: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("widget:state", state);
}

function broadcastSettings(settings: unknown, source?: Electron.WebContents): void {
  for (const window of [mainWindow, settingsWindow]) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents === source) {
      continue;
    }

    window.webContents.send("widget:settings:changed", settings);
  }
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.moveTop();
    return;
  }

  settingsWindow = createSettingsWindow();
}

function setContentSize(window: BrowserWindow, size: { width: number; height: number }): void {
  const target = normalizeWidgetContentSize(size);
  const { width, height } = target;
  const [currentWidth, currentHeight] = window.getSize();

  if (Math.abs(currentWidth - width) < 1 && Math.abs(currentHeight - height) < 1) {
    return;
  }

  window.setSize(width, height, false);
  keepWindowInsideScreen(window);
  enforceTopMost(window);
}

function normalizeWidgetContentSize(size: { width: number; height: number }): { width: number; height: number } {
  if (size.width <= 100 || size.height <= 68) {
    return COMPACT_WIDGET_SIZE;
  }

  return WIDGET_SIZE;
}

function quitApp(): void {
  stopTopMostEnforcer();
  controller.dispose();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
  app.quit();
}

function startTopMostEnforcer(window: BrowserWindow): void {
  stopTopMostEnforcer();
  enforceTopMost(window);
  topMostTimer = setInterval(() => enforceTopMost(window), 1800);
}

function stopTopMostEnforcer(window?: BrowserWindow): void {
  if (!topMostTimer) {
    return;
  }

  if (window && mainWindow && window !== mainWindow) {
    return;
  }

  clearInterval(topMostTimer);
  topMostTimer = null;
}

function enforceTopMost(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  try {
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.moveTop();
  } catch {
    // Some fullscreen/native surfaces can reject topmost changes; the next tick can try again.
  }
}

function setWindowMousePassthrough(window: BrowserWindow, ignore: boolean): void {
  if (window.isDestroyed() || mousePassthroughByWindow.get(window.id) === ignore) {
    return;
  }

  mousePassthroughByWindow.set(window.id, ignore);
  if (ignore) {
    window.setIgnoreMouseEvents(true, { forward: true });
  } else {
    window.setIgnoreMouseEvents(false);
  }
}

function getSettingsBounds(): Electron.Rectangle {
  const mainBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const display = screen.getDisplayMatching(mainBounds ?? screen.getPrimaryDisplay().workArea);
  const workArea = display.workArea;
  const preferred = {
    x: mainBounds ? mainBounds.x : workArea.x + workArea.width - SETTINGS_SIZE.width - 28,
    y: mainBounds ? mainBounds.y + mainBounds.height + 8 : workArea.y + 144,
    width: SETTINGS_SIZE.width,
    height: SETTINGS_SIZE.height
  };

  return {
    ...preferred,
    x: clampDimension(preferred.x, workArea.x, workArea.x + workArea.width - preferred.width),
    y: clampDimension(preferred.y, workArea.y, workArea.y + workArea.height - preferred.height)
  };
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.ceil(value), min), max);
}
