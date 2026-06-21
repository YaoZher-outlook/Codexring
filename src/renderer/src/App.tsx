import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { LimitBucket, RingState, WidgetState } from "../../shared/widgetTypes";
import { createInitialWidgetState, ringLabel } from "../../main/codex/state";

type Language = "zh" | "en";
type BarContent = "remaining" | "used" | "both";
type RingVisualState = RingState | "limitExceeded" | "limitReset";
type RingTransition = "none" | "jump" | "flash" | "burst" | "hop" | "settle" | "alert" | "reconnect";

interface WidgetSettings {
  language: Language;
  opacity: {
    background: number;
    ring: number;
    bar: number;
  };
  chrome: {
    border: boolean;
  };
  bars: {
    visible: boolean;
    content: BarContent;
  };
  colors: {
    background: string;
    idle: string;
    thinking: string;
    working: string;
    waiting: string;
    danger: string;
    barOk: string;
    barWarn: string;
    barDanger: string;
  };
}

const SETTINGS_KEY = "codexring:settings:v1";
const LEGACY_SETTINGS_KEYS = ["codey:settings:v1", "codex-floating-status-pet:settings:v1"];
const WIDGET_SIZE = { width: 176, height: 72 };
const COMPACT_WIDGET_SIZE = { width: 66, height: 66 };

const defaultSettings: WidgetSettings = {
  language: "zh",
  opacity: {
    background: 88,
    ring: 100,
    bar: 100
  },
  chrome: {
    border: true
  },
  bars: {
    visible: true,
    content: "remaining"
  },
  colors: {
    background: "#11151d",
    idle: "#f5f7fb",
    thinking: "#f5f7fb",
    working: "#62d6ff",
    waiting: "#5ee68c",
    danger: "#ff5f66",
    barOk: "#4fcf7b",
    barWarn: "#f2c84b",
    barDanger: "#ff5f66"
  }
};

const copy = {
  zh: {
    settings: "设置",
    close: "完成",
    language: "语言",
    chinese: "中文",
    english: "English",
    opacity: "透明度",
    background: "背景",
    border: "边框",
    ring: "圆环",
    bars: "血条",
    showBars: "显示血条",
    barContent: "血条内容",
    remaining: "剩余额",
    used: "已用量",
    both: "都显示",
    colors: "颜色",
    idle: "空闲",
    thinking: "Thinking",
    working: "Working",
    waiting: "等待",
    danger: "限额/错误",
    okBar: "健康血条",
    warnBar: "警告血条",
    dangerBar: "危险血条",
    week: "周",
    connected: "已连接 Codex",
    fallback: "读取本地 Codex 会话",
    disconnected: "Codex 未连接",
    connecting: "正在连接 Codex"
  },
  en: {
    settings: "Settings",
    close: "Done",
    language: "Language",
    chinese: "Chinese",
    english: "English",
    opacity: "Opacity",
    background: "Background",
    border: "Border",
    ring: "Ring",
    bars: "Bars",
    showBars: "Show bars",
    barContent: "Bar content",
    remaining: "Remaining",
    used: "Used",
    both: "Both",
    colors: "Colors",
    idle: "Idle",
    thinking: "Thinking",
    working: "Working",
    waiting: "Waiting",
    danger: "Limit/Error",
    okBar: "Healthy bar",
    warnBar: "Warning bar",
    dangerBar: "Danger bar",
    week: "Week",
    connected: "Codex connected",
    fallback: "Using local Codex session",
    disconnected: "Codex disconnected",
    connecting: "Connecting to Codex"
  }
} satisfies Record<Language, Record<string, string>>;

export function App(): JSX.Element {
  const [state, setState] = useState<WidgetState>(() => ({
    ...createInitialWidgetState(),
    connection: {
      status: "disconnected",
      error: "Waiting for Electron preload",
      detail: null,
      lastConnectedAt: null
    },
    ring: "reconnecting"
  }));
  const [settings, setSettings] = useState<WidgetSettings>(() => loadSettings());
  const [isSettingsView] = useState(() => isSettingsRoute());
  const [notice, setNotice] = useState<string | null>(null);
  const [ringTransition, setRingTransition] = useState<RingTransition>("none");
  const [ringTransitionRevision, setRingTransitionRevision] = useState(0);
  const [limitResetPulse, setLimitResetPulse] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const draggingRef = useRef(false);
  const mousePassthroughRef = useRef<boolean | null>(null);
  const remoteSettingsRef = useRef(false);
  const previousLimitsRef = useRef<WidgetState["limits"] | null>(null);
  const previousRingVisualRef = useRef<RingVisualState | null>(null);
  const limitResetTimerRef = useRef<number | undefined>(undefined);
  const ringTransitionTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!window.codexWidget) {
      return;
    }

    const offState = window.codexWidget.onStateChanged(setState);
    return () => {
      offState();
    };
  }, []);

  useEffect(() => {
    saveSettings(settings);
    if (!isSettingsView || !window.codexWidget) {
      return;
    }

    if (remoteSettingsRef.current) {
      remoteSettingsRef.current = false;
      return;
    }

    void window.codexWidget.publishSettings(settings);
  }, [isSettingsView, settings]);

  useEffect(() => {
    if (!window.codexWidget) {
      return;
    }

    return window.codexWidget.onSettingsChanged((next) => {
      const merged = mergeSettings(next as Partial<WidgetSettings>);
      setSettings((current) => {
        if (settingsEqual(current, merged)) {
          return current;
        }

        remoteSettingsRef.current = true;
        return merged;
      });
    });
  }, []);

  useEffect(() => {
    if (isSettingsView || !window.codexWidget) {
      return;
    }

    void window.codexWidget.setContentSize(settings.bars.visible ? WIDGET_SIZE : COMPACT_WIDGET_SIZE);
  }, [isSettingsView, settings.bars.visible]);

  useEffect(() => {
    if (isSettingsView) {
      void window.codexWidget?.setMousePassthrough(false);
      return;
    }

    const setPassthrough = (ignore: boolean) => {
      if (mousePassthroughRef.current === ignore) {
        return;
      }

      mousePassthroughRef.current = ignore;
      void window.codexWidget?.setMousePassthrough(ignore);
    };
    const updatePassthrough = (event: MouseEvent) => {
      if (draggingRef.current) {
        setPassthrough(false);
        return;
      }

      const shell = shellRef.current;
      if (!shell) {
        setPassthrough(true);
        return;
      }

      const interactive = isPointInInteractiveArea(event.clientX, event.clientY, shell, settings, false);
      setPassthrough(!interactive);
    };
    const leaveWindow = () => {
      if (!draggingRef.current) {
        setPassthrough(true);
      }
    };

    setPassthrough(true);
    window.addEventListener("mousemove", updatePassthrough);
    window.addEventListener("mouseleave", leaveWindow);
    window.addEventListener("blur", leaveWindow);

    return () => {
      window.removeEventListener("mousemove", updatePassthrough);
      window.removeEventListener("mouseleave", leaveWindow);
      window.removeEventListener("blur", leaveWindow);
    };
  }, [isSettingsView, settings]);

  useEffect(() => {
    const label = connectionNotice(state, settings.language);
    if (!label) {
      return;
    }

    setNotice(label);
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [state.connection.status, state.connection.error]);

  useEffect(() => {
    const previous = previousLimitsRef.current;
    if (previous && didAnyLimitReset(previous, state.limits)) {
      setLimitResetPulse(true);
      window.clearTimeout(limitResetTimerRef.current);
      limitResetTimerRef.current = window.setTimeout(() => setLimitResetPulse(false), 3200);
    }

    previousLimitsRef.current = state.limits;
  }, [state.limits]);

  useEffect(() => {
    return () => window.clearTimeout(limitResetTimerRef.current);
  }, []);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      if (!draggingRef.current) {
        return;
      }

      void window.codexWidget?.moveWindowDrag({ screenX: event.screenX, screenY: event.screenY });
    };
    const up = () => {
      if (!draggingRef.current) {
        return;
      }

      draggingRef.current = false;
      void window.codexWidget?.endWindowDrag();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const ringVisual = useMemo<RingVisualState>(() => {
    if (limitResetPulse) {
      return "limitReset";
    }

    if (state.limits.fiveHour.reached || state.limits.weekly.reached) {
      return "limitExceeded";
    }

    return state.ring;
  }, [limitResetPulse, state.limits.fiveHour.reached, state.limits.weekly.reached, state.ring]);

  useEffect(() => {
    const previous = previousRingVisualRef.current;
    previousRingVisualRef.current = ringVisual;
    if (previous === null || previous === ringVisual) {
      return;
    }

    window.clearTimeout(ringTransitionTimerRef.current);
    setRingTransition(transitionForRing(ringVisual));
    setRingTransitionRevision((revision) => revision + 1);
    ringTransitionTimerRef.current = window.setTimeout(() => setRingTransition("none"), 720);
  }, [ringVisual]);

  useEffect(() => {
    return () => window.clearTimeout(ringTransitionTimerRef.current);
  }, []);

  const ringTitle = useMemo(() => visualRingLabel(ringVisual, settings.language), [ringVisual, settings.language]);
  const vars = useMemo(() => settingsToCssVars(settings), [settings]);
  const text = copy[settings.language];
  const className = [
    "widget-shell",
    isSettingsView ? "settings-mode" : "",
    !settings.chrome.border ? "borderless" : "",
    !settings.bars.visible && !isSettingsView ? "bars-hidden" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      ref={shellRef}
      className={className}
      data-ring={state.ring}
      data-ring-visual={ringVisual}
      aria-label="Codex status widget"
      style={vars}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!isSettingsView) {
          void window.codexWidget?.openMenu();
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || isInteractiveTarget(event.target)) {
          return;
        }

        draggingRef.current = true;
        mousePassthroughRef.current = false;
        void window.codexWidget?.setMousePassthrough(false);
        event.currentTarget.setPointerCapture(event.pointerId);
        void window.codexWidget?.beginWindowDrag({ screenX: event.screenX, screenY: event.screenY });
      }}
    >
      {isSettingsView ? (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => void window.codexWidget?.closeSettings()} />
      ) : (
        <>
          <section className="ring-zone" aria-label={ringTitle}>
            <StatusRing
              key={`${ringVisual}-${ringTransitionRevision}`}
              ring={ringVisual}
              transition={ringTransition}
              title={ringTitle}
            />
          </section>
          {settings.bars.visible ? (
            <section className="bars-zone" aria-label="Codex usage limits">
              <LimitBar limit={state.limits.fiveHour} settings={settings} />
              <LimitBar limit={state.limits.weekly} settings={settings} />
            </section>
          ) : null}
          {notice ? <div className="notice-toast">{notice}</div> : null}
          <Tooltip state={state} language={settings.language} />
        </>
      )}
      <span className="sr-only">{text.settings}</span>
    </main>
  );
}

function StatusRing({
  ring,
  transition,
  title
}: {
  ring: RingVisualState;
  transition: RingTransition;
  title: string;
}): JSX.Element {
  return (
    <svg
      className={`status-ring status-ring-${ring} status-ring-transition-${transition}`}
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
    >
      <g className="status-ring-surface">
        <circle className="status-ring-main" cx="24" cy="24" r="17" />
        <circle className="status-ring-drop status-ring-drop-a" cx="24" cy="7" r="2.1" />
        <circle className="status-ring-drop status-ring-drop-b" cx="24" cy="7" r="1.45" />
      </g>
    </svg>
  );
}

function LimitBar({ limit, settings }: { limit: LimitBucket; settings: WidgetSettings }): JSX.Element {
  const width = limit.available ? `${barFillPercent(limit, settings.bars.content)}%` : "100%";
  const label = barLabel(limit, settings);
  const name = limit.label === "Week" && settings.language === "zh" ? copy.zh.week : limit.label;

  return (
    <div className={`limit-row tone-${limit.tone}`} aria-label={`${name} limit ${label}`}>
      <span className="limit-label">{name}</span>
      <span className="limit-track">
        <span className="limit-fill" style={{ width }} />
      </span>
      <span className="limit-value">{label}</span>
    </div>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose
}: {
  settings: WidgetSettings;
  onChange: (settings: WidgetSettings) => void;
  onClose: () => void;
}): JSX.Element {
  const text = copy[settings.language];

  return (
    <section className="settings-panel" aria-label={text.settings}>
      <header className="settings-header">
        <strong>{text.settings}</strong>
        <button className="settings-close" type="button" onClick={onClose}>
          {text.close}
        </button>
      </header>

      <div className="settings-grid">
        <label className="settings-field">
          <span>{text.language}</span>
          <select
            value={settings.language}
            onChange={(event) => onChange({ ...settings, language: event.target.value as Language })}
          >
            <option value="zh">{text.chinese}</option>
            <option value="en">{text.english}</option>
          </select>
        </label>

        <fieldset>
          <legend>{text.bars}</legend>
          <label className="settings-field checkbox-field">
            <span>{text.showBars}</span>
            <input
              type="checkbox"
              checked={settings.bars.visible}
              onChange={(event) => onChange({ ...settings, bars: { ...settings.bars, visible: event.target.checked } })}
            />
          </label>
          <label className="settings-field">
            <span>{text.barContent}</span>
            <select
              value={settings.bars.content}
              onChange={(event) =>
                onChange({ ...settings, bars: { ...settings.bars, content: event.target.value as BarContent } })
              }
            >
              <option value="remaining">{text.remaining}</option>
              <option value="used">{text.used}</option>
              <option value="both">{text.both}</option>
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>{text.opacity}</legend>
          <label className="settings-field checkbox-field">
            <span>{text.border}</span>
            <input
              type="checkbox"
              checked={settings.chrome.border}
              onChange={(event) => onChange({ ...settings, chrome: { border: event.target.checked } })}
            />
          </label>
          <RangeField
            label={text.background}
            value={settings.opacity.background}
            min={0}
            onChange={(value) => onChange({ ...settings, opacity: { ...settings.opacity, background: value } })}
          />
          <RangeField
            label={text.ring}
            value={settings.opacity.ring}
            min={20}
            onChange={(value) => onChange({ ...settings, opacity: { ...settings.opacity, ring: value } })}
          />
          <RangeField
            label={text.bars}
            value={settings.opacity.bar}
            min={0}
            onChange={(value) => onChange({ ...settings, opacity: { ...settings.opacity, bar: value } })}
          />
        </fieldset>

        <fieldset className="color-fieldset">
          <legend>{text.colors}</legend>
          <ColorField
            label={text.background}
            value={settings.colors.background}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, background: value } })}
          />
          <ColorField
            label={text.idle}
            value={settings.colors.idle}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, idle: value } })}
          />
          <ColorField
            label={text.thinking}
            value={settings.colors.thinking}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, thinking: value } })}
          />
          <ColorField
            label={text.working}
            value={settings.colors.working}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, working: value } })}
          />
          <ColorField
            label={text.waiting}
            value={settings.colors.waiting}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, waiting: value } })}
          />
          <ColorField
            label={text.danger}
            value={settings.colors.danger}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, danger: value } })}
          />
          <ColorField
            label={text.okBar}
            value={settings.colors.barOk}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, barOk: value } })}
          />
          <ColorField
            label={text.warnBar}
            value={settings.colors.barWarn}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, barWarn: value } })}
          />
          <ColorField
            label={text.dangerBar}
            value={settings.colors.barDanger}
            onChange={(value) => onChange({ ...settings, colors: { ...settings.colors, barDanger: value } })}
          />
        </fieldset>
      </div>
    </section>
  );
}

function RangeField({
  label,
  value,
  min,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="settings-field range-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={100}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}%</output>
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="settings-field color-field">
      <span>{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Tooltip({ state, language }: { state: WidgetState; language: Language }): JSX.Element {
  const title = language === "zh" ? localizeTooltipTitle(state.tooltip.primary) : state.tooltip.primary;

  return (
    <aside className="tooltip" role="tooltip">
      <strong>{title}</strong>
      {state.tooltip.detail.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </aside>
  );
}

function isSettingsRoute(): boolean {
  try {
    return new URL(window.location.href).searchParams.get("view") === "settings";
  } catch {
    return false;
  }
}

function loadSettings(): WidgetSettings {
  try {
    const raw =
      window.localStorage.getItem(SETTINGS_KEY) ??
      LEGACY_SETTINGS_KEYS.map((key) => window.localStorage.getItem(key)).find((value) => value !== null);
    if (!raw) {
      return defaultSettings;
    }

    const settings = mergeSettings(JSON.parse(raw) as Partial<WidgetSettings>);
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  } catch {
    return defaultSettings;
  }
}

function settingsEqual(left: WidgetSettings, right: WidgetSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function saveSettings(settings: WidgetSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures; the widget still works with in-memory settings.
  }
}

function mergeSettings(value: Partial<WidgetSettings>): WidgetSettings {
  const incomingColors: Partial<WidgetSettings["colors"]> = value.colors ?? {};
  const colors = {
    ...defaultSettings.colors,
    ...incomingColors
  };

  if (!incomingColors.working && incomingColors.thinking?.toLowerCase() === "#62d6ff") {
    colors.thinking = defaultSettings.colors.thinking;
  }

  return {
    language: value.language === "en" ? "en" : "zh",
    opacity: {
      background: clampOpacity(value.opacity?.background ?? defaultSettings.opacity.background, 0),
      ring: clampOpacity(value.opacity?.ring ?? defaultSettings.opacity.ring, 20),
      bar: clampOpacity(value.opacity?.bar ?? defaultSettings.opacity.bar, 0)
    },
    chrome: {
      border: value.chrome?.border ?? defaultSettings.chrome.border
    },
    bars: {
      visible: value.bars?.visible ?? defaultSettings.bars.visible,
      content: isBarContent(value.bars?.content) ? value.bars.content : defaultSettings.bars.content
    },
    colors
  };
}

function clampOpacity(value: number, min: number): number {
  return Math.min(Math.max(Math.round(value), min), 100);
}

function settingsToCssVars(settings: WidgetSettings): CSSProperties {
  const text = contrastTextForBackground(settings.colors.background, settings.opacity.background);

  return {
    "--widget-bg-rgb": hexToRgb(settings.colors.background),
    "--bg-alpha": String(settings.opacity.background / 100),
    "--ring-alpha": String(settings.opacity.ring / 100),
    "--bar-alpha": String(settings.opacity.bar / 100),
    "--text-rgb": text.foreground,
    "--text-muted-rgb": text.muted,
    "--text-shadow-rgb": text.shadow,
    "--ring-idle-rgb": hexToRgb(settings.colors.idle),
    "--ring-thinking-rgb": hexToRgb(settings.colors.thinking),
    "--ring-working-rgb": hexToRgb(settings.colors.working),
    "--ring-waiting-rgb": hexToRgb(settings.colors.waiting),
    "--ring-danger-rgb": hexToRgb(settings.colors.danger),
    "--bar-ok-rgb": hexToRgb(settings.colors.barOk),
    "--bar-warn-rgb": hexToRgb(settings.colors.barWarn),
    "--bar-danger-rgb": hexToRgb(settings.colors.barDanger)
  } as CSSProperties;
}

function hexToRgb(hex: string): string {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#ffffff";
  const value = Number.parseInt(normalized.slice(1), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

function contrastTextForBackground(
  hex: string,
  opacity: number
): {
  foreground: string;
  muted: string;
  shadow: string;
} {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : defaultSettings.colors.background;
  const value = Number.parseInt(normalized.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  if (opacity >= 35 && luminance > 0.58) {
    return {
      foreground: "20 24 32",
      muted: "44 52 66",
      shadow: "255 255 255"
    };
  }

  return {
    foreground: "245 247 251",
    muted: "220 227 239",
    shadow: "0 0 0"
  };
}

function transitionForRing(ring: RingVisualState): RingTransition {
  switch (ring) {
    case "creating":
      return "jump";
    case "thinking":
    case "reviewReady":
      return "flash";
    case "working":
    case "limitReset":
      return "burst";
    case "waitingApproval":
      return "hop";
    case "failed":
    case "limitExceeded":
      return "alert";
    case "reconnecting":
      return "reconnect";
    case "idle":
      return "settle";
  }
}

function connectionNotice(state: WidgetState, language: Language): string | null {
  const text = copy[language];
  if (state.connection.status === "fallback") {
    return text.fallback;
  }

  if (state.connection.status === "disconnected") {
    return text.disconnected;
  }

  if (state.connection.status === "connecting") {
    return text.connecting;
  }

  return null;
}

function barFillPercent(limit: LimitBucket, content: BarContent): number {
  if (!limit.available) {
    return 100;
  }

  if (content === "used") {
    return limit.usedPercent ?? 0;
  }

  return limit.remainingPercent ?? 0;
}

function barLabel(limit: LimitBucket, settings: WidgetSettings): string {
  if (!limit.available || limit.remainingPercent === null || limit.usedPercent === null) {
    return "N/A";
  }

  const remaining = Math.round(limit.remainingPercent);
  const used = Math.round(limit.usedPercent);
  if (settings.bars.content === "used") {
    return `${used}%`;
  }

  if (settings.bars.content === "both") {
    return `${remaining}/${used}`;
  }

  return `${remaining}%`;
}

function didAnyLimitReset(previous: WidgetState["limits"], next: WidgetState["limits"]): boolean {
  return didLimitReset(previous.fiveHour, next.fiveHour) || didLimitReset(previous.weekly, next.weekly);
}

function didLimitReset(previous: LimitBucket, next: LimitBucket): boolean {
  if (
    !previous.available ||
    !next.available ||
    previous.remainingPercent === null ||
    next.remainingPercent === null
  ) {
    return false;
  }

  const wasLow = previous.reached || previous.remainingPercent <= 15;
  const recovered = next.remainingPercent >= 60 && next.remainingPercent > previous.remainingPercent + 20;
  return wasLow && recovered;
}

function isBarContent(value: unknown): value is BarContent {
  return value === "remaining" || value === "used" || value === "both";
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("button,input,select,textarea,option,label,.settings-panel,.tooltip"));
}

function isPointInInteractiveArea(
  clientX: number,
  clientY: number,
  shell: HTMLElement,
  settings: WidgetSettings,
  settingsOpen: boolean
): boolean {
  const shellRect = shell.getBoundingClientRect();
  if (settingsOpen) {
    return pointInRect(clientX, clientY, shellRect);
  }

  if (settings.opacity.background > 5 && pointInRoundedRect(clientX, clientY, shellRect, 12)) {
    return true;
  }

  return pointInVisibleContent(clientX, clientY, shell);
}

function pointInVisibleContent(clientX: number, clientY: number, shell: HTMLElement): boolean {
  const elements = shell.querySelectorAll<HTMLElement>(".ring-zone,.bars-zone,.notice-toast");
  for (const element of elements) {
    if (pointInExpandedRect(clientX, clientY, element.getBoundingClientRect(), 5)) {
      return true;
    }
  }

  return false;
}

function pointInExpandedRect(clientX: number, clientY: number, rect: DOMRect, padding: number): boolean {
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  );
}

function pointInRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function pointInRoundedRect(clientX: number, clientY: number, rect: DOMRect, radius: number): boolean {
  if (!pointInRect(clientX, clientY, rect)) {
    return false;
  }

  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const innerX = Math.min(Math.max(x, radius), rect.width - radius);
  const innerY = Math.min(Math.max(y, radius), rect.height - radius);
  const dx = x - innerX;
  const dy = y - innerY;
  return dx * dx + dy * dy <= radius * radius;
}

function visualRingLabel(ring: RingVisualState, language: Language): string {
  if (language === "en") {
    return ring === "limitExceeded" ? "Limit exceeded" : ring === "limitReset" ? "Limit reset" : ringLabel(ring);
  }

  switch (ring) {
    case "creating":
      return "创建中";
    case "thinking":
      return "思考中";
    case "working":
      return "工作中";
    case "waitingApproval":
      return "等待回复";
    case "reviewReady":
      return "等待查看";
    case "limitExceeded":
      return "超出限额";
    case "limitReset":
      return "限额已重置";
    case "failed":
      return "需要处理";
    case "idle":
      return "空闲";
    case "reconnecting":
      return "正在重连";
  }
}

function localizeTooltipTitle(title: string): string {
  return title
    .replace("Creating", "创建中")
    .replace("Thinking", "思考中")
    .replace("Working", "工作中")
    .replace("Waiting for approval", "等待回复")
    .replace("Ready to review", "等待查看")
    .replace("Needs attention", "需要处理")
    .replace("Idle", "空闲")
    .replace("Reconnecting", "正在重连");
}
