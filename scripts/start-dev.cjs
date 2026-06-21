const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const exeName = isWindows ? "electron.exe" : "electron";
const electronPackageDir = path.join(projectRoot, "node_modules", "electron");
const localElectronDist = path.join(electronPackageDir, "dist");
const localElectronExe = path.join(localElectronDist, exeName);
const checkOnly = process.argv.includes("--check");
const PORT_MIN = 20_000;
const PORT_MAX = 39_999;
const DEFAULT_PORT = 28_473;

async function main() {
  const env = { ...process.env };
  const electronDist = ensureElectronDist(env);
  const rendererPort = await chooseRendererPort(env);
  env.CODEXRING_RENDERER_PORT = String(rendererPort);

  if (electronDist) {
    const electronExe = path.join(electronDist, exeName);
    env.ELECTRON_OVERRIDE_DIST_PATH = electronDist;
    env.ELECTRON_EXEC_PATH = electronExe;
    console.log(`Using Electron runtime: ${electronExe}`);
  }
  console.log(`Using renderer dev port: ${rendererPort}`);

  if (checkOnly) {
    return;
  }

  const electronViteBin = path.join(
    projectRoot,
    "node_modules",
    ".bin",
    isWindows ? "electron-vite.cmd" : "electron-vite"
  );
  const child = spawn(electronViteBin, ["dev"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    shell: isWindows
  });

  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

async function chooseRendererPort(env) {
  const preferred = Number(env.CODEXRING_RENDERER_PORT || DEFAULT_PORT);
  const start = Number.isInteger(preferred) && preferred >= PORT_MIN && preferred <= PORT_MAX ? preferred : DEFAULT_PORT;

  for (let port = start; port <= PORT_MAX; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }

  for (let port = PORT_MIN; port < start; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error(`No free port found in ${PORT_MIN}-${PORT_MAX}.`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function ensureElectronDist(env) {
  if (fs.existsSync(localElectronExe)) {
    return localElectronDist;
  }

  const override = env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override && fs.existsSync(path.join(override, exeName))) {
    return override;
  }

  const discovered = findNearbyElectronDist();
  if (discovered) {
    return discovered;
  }

  if (checkOnly) {
    throw new Error("Electron runtime is missing and no nearby fallback was found.");
  }

  console.log("Electron runtime is missing. Attempting to install Electron binary...");
  const result = spawnSync(process.execPath, [path.join(electronPackageDir, "install.js")], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    timeout: 180_000
  });

  if (result.status === 0 && fs.existsSync(localElectronExe)) {
    return localElectronDist;
  }

  throw new Error(
    [
      "Electron runtime is still missing.",
      "Try running this manually from the project folder:",
      "  node node_modules\\electron\\install.js",
      "Or set ELECTRON_OVERRIDE_DIST_PATH to a folder that contains electron.exe."
    ].join("\n")
  );
}

function findNearbyElectronDist() {
  const searchRoot = path.dirname(projectRoot);
  const maxDepth = 5;
  const queue = [{ dir: searchRoot, depth: 0 }];
  const seen = new Set();

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    const normalized = path.normalize(dir).toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const candidate = path.join(dir, "node_modules", "electron", "dist", exeName);
    if (fs.existsSync(candidate)) {
      return path.dirname(candidate);
    }

    if (depth >= maxDepth) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
