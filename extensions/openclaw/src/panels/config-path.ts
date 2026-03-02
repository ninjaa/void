import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

let customPath: string | undefined;
const DEFAULT_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

function expandHome(targetPath: string | undefined) {
  if (!targetPath) return targetPath;
  if (targetPath.startsWith("~")) {
    return path.join(os.homedir(), targetPath.slice(1));
  }
  return targetPath;
}

function normalizePath(targetPath: string | undefined) {
  if (!targetPath) return targetPath;
  const expanded = expandHome(targetPath);
  if (process.platform === "win32" && expanded) {
    return expanded.replace(/\\/g, "/");
  }
  return expanded;
}

export function overrideConfigPath(p: string | undefined) {
  customPath = p ? normalizePath(p) : undefined;
}

export function resolveConfigPath() {
  if (customPath) return customPath;
  const fromSettings = vscode.workspace.getConfiguration("openclaw").get<string>("configPath");
  if (fromSettings) {
    customPath = normalizePath(fromSettings);
    if (customPath) {
      return customPath;
    }
  }
  return DEFAULT_PATH;
}

export function getDefaultConfigPath() {
  return DEFAULT_PATH;
}
