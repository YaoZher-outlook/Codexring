import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rendererPort = readRendererPort();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts")
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    server: {
      port: rendererPort,
      strictPort: true
    },
    preview: {
      port: rendererPort,
      strictPort: true
    },
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared")
      }
    }
  }
});

function readRendererPort(): number {
  const value = Number(process.env.CODEXRING_RENDERER_PORT ?? 28473);
  if (!Number.isInteger(value) || value < 20_000 || value > 39_999) {
    return 28473;
  }

  return value;
}
