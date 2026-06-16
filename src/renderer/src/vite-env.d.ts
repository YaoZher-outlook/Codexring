/// <reference types="vite/client" />

import type { WidgetApi } from "../../shared/widgetTypes";

declare global {
  interface Window {
    codexWidget?: WidgetApi;
  }
}
