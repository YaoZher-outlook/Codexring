import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export function findCodexBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.CODEX_BIN,
    ...findOnPath("codex.exe", env),
    ...findOnPath("codex", env),
    "codex",
    "codex.exe",
    windowsAppsCandidate(env)
  ].filter((candidate): candidate is string => Boolean(candidate));

  return unique(candidates)[0] ?? null;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("where.exe", [name], {
        env,
        encoding: "utf8",
        windowsHide: true
      });

      if (result.status === 0) {
        return result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  return (env.PATH ?? "")
    .split(delimiter)
    .map((pathDir) => join(pathDir, name))
    .filter((candidate) => existsSync(candidate));
}

function windowsAppsCandidate(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const appAlias = join(localAppData, "Microsoft", "WindowsApps", "codex.exe");
  return existsSync(appAlias) ? appAlias : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
