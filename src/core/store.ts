import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join, relative } from "node:path";
import { validateChainedEntries } from "../fs/append.js";
import { parseStp, sanitizeActor, slugify, stpTemplate, type ParsedStp } from "./format.js";
import { buildState, type StpState } from "./model.js";

export interface StpConfig {
  active?: string;
  postToTotem?: boolean;
}

export function stpDir(root: string): string {
  return join(root, ".aegis", "stp");
}

function configPath(root: string): string {
  return join(stpDir(root), "config.json");
}

export async function readConfig(root: string): Promise<StpConfig> {
  try {
    return JSON.parse(await readFile(configPath(root), "utf8")) as StpConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(root: string, config: StpConfig): Promise<void> {
  await mkdir(stpDir(root), { recursive: true });
  await writeFile(configPath(root), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const stpFilePattern = /^STP-\d{3,}-.+\.md$/;

export async function listStpFiles(root: string): Promise<string[]> {
  if (!existsSync(stpDir(root))) return [];
  return (await readdir(stpDir(root)))
    .filter((name) => stpFilePattern.test(name))
    .sort()
    .map((name) => join(stpDir(root), name));
}

export function relativePath(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/");
}

export async function loadParsed(file: string): Promise<{ content: string; parsed: ParsedStp }> {
  const content = await readFile(file, "utf8");
  return { content, parsed: parseStp(content, file) };
}

export async function loadState(file: string): Promise<StpState> {
  return buildState((await loadParsed(file)).parsed);
}

export async function validateFile(file: string): Promise<string[]> {
  const { content, parsed } = await loadParsed(file);
  return [...validateChainedEntries(content), ...buildState(parsed).issues];
}

/** Resolves an STP by id (STP-001 or 1), slug, or file name; falls back to the active STP. */
export async function resolveStp(root: string, ref?: string): Promise<string> {
  if (ref && ref.endsWith(".md") && existsSync(ref)) return ref;
  const files = await listStpFiles(root);
  if (files.length === 0) throw new Error(`No STPs in ${stpDir(root)}. Create one with: aegis-stp new "<title>"`);
  const wanted = ref ?? (await readConfig(root)).active;
  if (!wanted) {
    if (files.length === 1) return files[0];
    throw new Error("Several STPs exist and none is active. Pass --stp <id> or run: aegis-stp use <id>");
  }
  const needle = wanted.trim().toLowerCase();
  const numeric = /^\d+$/.test(needle) ? `stp-${needle.padStart(3, "0")}-` : null;
  const match = files.find((file) => {
    const name = basename(file).toLowerCase();
    return name === needle || name === `${needle}.md` || name.startsWith(`${needle}-`) || (numeric && name.startsWith(numeric)) || name.slice(8, -3) === needle;
  });
  if (!match) throw new Error(`No STP matches "${wanted}"`);
  return match;
}

export async function createStpFile(root: string, title: string, actor: string): Promise<{ file: string; id: string }> {
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (!cleanTitle) throw new Error("An STP needs a title");
  await mkdir(stpDir(root), { recursive: true });
  const numbers = (await listStpFiles(root)).map((file) => Number(basename(file).slice(4, basename(file).indexOf("-", 4))));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const id = `STP-${String(next).padStart(3, "0")}`;
  const file = join(stpDir(root), `${id}-${slugify(cleanTitle)}.md`);
  await writeFile(file, stpTemplate(id, cleanTitle, new Date().toISOString(), actor), { flag: "wx" });
  return { file, id };
}

/** Default actor: AEGIS_STP_ACTOR, then git user.name, then the OS user. */
export function defaultActor(root: string): string {
  if (process.env.AEGIS_STP_ACTOR) return sanitizeActor(process.env.AEGIS_STP_ACTOR);
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return sanitizeActor(name.split(/\s+/)[0]);
  } catch {
    // Not a git repo or git is missing.
  }
  return sanitizeActor(userInfo().username || "architect");
}
