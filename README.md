# Codey

A tiny Windows-first Electron widget for watching Codex work at a glance.

The widget is transparent, borderless, always on top, and small enough to sit near the edge of the screen. The left ring shows the current Codex thread state, while the two right bars show remaining 5h and weekly quota when Codex app-server provides those buckets.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

You can also double-click `start-codex-pet.cmd` from this folder. It uses `npm.cmd`, keeps npm cache inside the project, installs dependencies if they are missing, and then starts the widget.

To create a desktop shortcut, double-click `create-desktop-shortcut.cmd`.

The dev launcher runs through `scripts/start-dev.cjs`. If this project's Electron binary is missing, it first looks for a nearby installed `electron.exe` and sets `ELECTRON_EXEC_PATH` automatically. This fixes the common `Electron uninstall` startup error caused by an interrupted Electron binary download.

The renderer dev server automatically picks a free port in `20000-39999`, starting from `28473`. You can override the starting port with `CODEX_WIDGET_PORT`.

If `codex app-server` cannot be spawned, the widget falls back to reading the latest local Codex session JSONL under `%USERPROFILE%\.codex\sessions`. That fallback can show the latest local session and 5h/weekly quota when those values are present in Codex's token-count events.

If Codex is not found automatically, point the app to your Codex executable:

```powershell
$env:CODEX_BIN = ".\codex.exe"
npm.cmd run dev
```

## Scripts

- `npm.cmd run dev` starts the Electron/Vite dev app.
- `npm.cmd run build` type-checks and builds main, preload, and renderer bundles into `out/`.
- `npm.cmd run test` runs unit, integration, and renderer tests.
- `npm.cmd run schemas:codex` optionally generates official Codex app-server TypeScript schemas when your installed Codex supports it.

## Behavior

- The app connects to `codex app-server` over stdio JSONL RPC.
- It selects the newest loaded Codex thread, or the most recently updated thread if nothing is loaded.
- It listens for status, turn, item, token usage, and rate-limit events.
- Limit bars use remaining quota semantics: full means healthy, empty means exhausted.
- Missing 5h or weekly buckets render as `N/A` instead of being estimated.
- Right-click anywhere on the widget and choose `Settings` to change language, background/ring/bar opacity, status colors, whether limit bars are shown, and whether bars display remaining usage, used usage, or both.
