import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const STP_LANE = "aegis-stp";

export interface TotemResult {
  posted: boolean;
  detail: string;
}

/** Totem is in use when the repo has its config and Root Totem. */
export function totemInstalledInRepo(root: string): boolean {
  return existsSync(join(root, ".aegis", "config.json")) && existsSync(join(root, "ROOT_TOTEM.md"));
}

/**
 * Finds a runnable Totem CLI as [command, ...prefixArgs]. Always runs a JS entry through
 * node when one can be found, so no shell is needed to pass multi-line messages.
 */
export function findTotemCli(): string[] | null {
  const override = process.env.AEGIS_TOTEM_CLI;
  if (override) return override.endsWith(".js") ? [process.execPath, override] : [override];

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const hasShim = ["aegis-totem", "aegis-totem.cmd", "aegis-totem.ps1"].some((name) => existsSync(join(dir, name)));
    if (!hasShim) continue;
    for (const candidate of [
      join(dir, "node_modules", "aegis-totem", "dist", "src", "cli.js"),
      join(dirname(dir), "lib", "node_modules", "aegis-totem", "dist", "src", "cli.js")
    ]) {
      if (existsSync(candidate)) return [process.execPath, candidate];
    }
    if (process.platform !== "win32") return [join(dir, "aegis-totem")];
  }

  // The Totem VS Code extension bundles its CLI.
  for (const base of [join(homedir(), ".vscode", "extensions"), join(homedir(), ".cursor", "extensions"), join(homedir(), ".vscode-oss", "extensions")]) {
    if (!existsSync(base)) continue;
    const found = readdirSync(base)
      .filter((name) => name.toLowerCase().startsWith("thelight1122.aegis-totem-vscode-"))
      .sort()
      .reverse()
      .map((name) => join(base, name, "cli-dist", "src", "cli.js"))
      .find((path) => existsSync(path));
    if (found) return [process.execPath, found];
  }
  return null;
}

function runTotem(cli: string[], root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli[0], [...cli.slice(1), ...args], { cwd: root, timeout: 20000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function ensureLane(cli: string[], root: string): Promise<void> {
  if (existsSync(join(root, ".aegis", "lanes", `${STP_LANE}.md`))) return;
  await runTotem(cli, root, ["lane", "create", STP_LANE]);
}

/** Posts a pointer into the repo's aegis-stp lane. Never throws: Totem is optional. */
export async function postLaneMessage(root: string, message: string): Promise<TotemResult> {
  if (!totemInstalledInRepo(root)) return { posted: false, detail: "Totem is not set up in this repo; nothing posted" };
  const cli = findTotemCli();
  if (!cli) return { posted: false, detail: "Totem is set up here but the aegis-totem CLI was not found; nothing posted" };
  try {
    await ensureLane(cli, root);
    await runTotem(cli, root, ["lane", "message", STP_LANE, "-m", message]);
    return { posted: true, detail: `Posted to Totem lane .aegis/lanes/${STP_LANE}.md` };
  } catch (error) {
    return { posted: false, detail: `Totem post failed: ${(error as Error).message}` };
  }
}

/** Appends a distilled decision to a Folder Totem through Totem's own CLI. */
export async function appendFolderTotem(root: string, folder: string, kind: string, message: string): Promise<string> {
  if (!totemInstalledInRepo(root)) throw new Error("Totem is not set up in this repo (needs .aegis/config.json and ROOT_TOTEM.md)");
  const cli = findTotemCli();
  if (!cli) throw new Error("The aegis-totem CLI was not found. Install it, or set AEGIS_TOTEM_CLI to its cli.js");
  await ensureLane(cli, root);
  return runTotem(cli, root, ["totem", "append", folder, "--actor", STP_LANE, "--kind", kind, "-m", message]);
}
