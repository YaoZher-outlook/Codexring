export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "fallback";

export type RingState =
  | "idle"
  | "reconnecting"
  | "creating"
  | "thinking"
  | "working"
  | "waitingApproval"
  | "reviewReady"
  | "failed";

export type LimitTone = "ok" | "warn" | "danger" | "muted";
export type LimitSyncStatus = "unknown" | "refreshing" | "ready" | "stale" | "error";
export type LimitSource = "appServer" | "localSession";

export interface ConnectionInfo {
  status: ConnectionStatus;
  error: string | null;
  detail: string | null;
  lastConnectedAt: string | null;
}

export interface ThreadSummary {
  id: string | null;
  title: string;
  preview: string;
  statusType: string | null;
  updatedAt: number | null;
}

export interface LimitBucket {
  label: "5h" | "Week";
  available: boolean;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  tone: LimitTone;
  reached: boolean;
}

export interface WidgetTooltip {
  primary: string;
  detail: string[];
}

export interface WidgetState {
  revision: number;
  connection: ConnectionInfo;
  thread: ThreadSummary;
  ring: RingState;
  limits: {
    fiveHour: LimitBucket;
    weekly: LimitBucket;
    lastUpdatedAt: string | null;
    refreshStartedAt: string | null;
    status: LimitSyncStatus;
    source: LimitSource | null;
    error: string | null;
  };
  tooltip: WidgetTooltip;
}

export interface WidgetApi {
  onStateChanged(listener: (state: WidgetState) => void): () => void;
  onOpenSettings(listener: () => void): () => void;
  onSettingsChanged(listener: (settings: unknown) => void): () => void;
  publishSettings(settings: unknown): Promise<void>;
  reconnect(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  openMenu(): Promise<void>;
  closeSettings(): Promise<void>;
  setSettingsOpen(open: boolean): Promise<void>;
  setMousePassthrough(ignore: boolean): Promise<void>;
  setContentSize(size: { width: number; height: number }): Promise<void>;
  beginWindowDrag(point: { screenX: number; screenY: number }): Promise<void>;
  moveWindowDrag(point: { screenX: number; screenY: number }): Promise<void>;
  endWindowDrag(): Promise<void>;
}
