import { contextBridge, ipcRenderer } from "electron";
import type { WidgetApi, WidgetState } from "../shared/widgetTypes";

const api: WidgetApi = {
  onStateChanged(listener: (state: WidgetState) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, state: WidgetState) => listener(state);
    ipcRenderer.on("widget:state", wrapped);
    void ipcRenderer.invoke("widget:getState").then((state: WidgetState) => listener(state));

    return () => {
      ipcRenderer.removeListener("widget:state", wrapped);
    };
  },
  onOpenSettings(listener: () => void) {
    const wrapped = () => listener();
    ipcRenderer.on("widget:settings:open", wrapped);

    return () => {
      ipcRenderer.removeListener("widget:settings:open", wrapped);
    };
  },
  onSettingsChanged(listener: (settings: unknown) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, settings: unknown) => listener(settings);
    ipcRenderer.on("widget:settings:changed", wrapped);

    return () => {
      ipcRenderer.removeListener("widget:settings:changed", wrapped);
    };
  },
  async publishSettings(settings: unknown) {
    await ipcRenderer.invoke("widget:settings:changed", settings);
  },
  async reconnect() {
    await ipcRenderer.invoke("widget:reconnect");
  },
  async selectThread(threadId: string) {
    await ipcRenderer.invoke("widget:selectThread", threadId);
  },
  async openMenu() {
    await ipcRenderer.invoke("widget:openMenu");
  },
  async closeSettings() {
    await ipcRenderer.invoke("widget:settings:close");
  },
  async setSettingsOpen(open: boolean) {
    await ipcRenderer.invoke("widget:settings:setOpen", open);
  },
  async setMousePassthrough(ignore: boolean) {
    await ipcRenderer.invoke("widget:mouse:setPassthrough", ignore);
  },
  async setContentSize(size: { width: number; height: number }) {
    await ipcRenderer.invoke("widget:content:setSize", size);
  },
  async beginWindowDrag(point: { screenX: number; screenY: number }) {
    await ipcRenderer.invoke("widget:drag:start", point);
  },
  async moveWindowDrag(point: { screenX: number; screenY: number }) {
    await ipcRenderer.invoke("widget:drag:move", point);
  },
  async endWindowDrag() {
    await ipcRenderer.invoke("widget:drag:end");
  }
};

contextBridge.exposeInMainWorld("codexWidget", api);
