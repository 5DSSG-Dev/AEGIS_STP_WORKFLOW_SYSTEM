import { basename } from "node:path";
import { appendChained } from "../fs/append.js";
import {
  ARCHITECT_STATUSES,
  HUMAN_CHANNELS,
  ITEM_KINDS,
  canonicalStage,
  canonicalStatus,
  composeBody,
  parseStp,
  sanitizeActor,
  type Channel,
  type FieldName,
  type ItemKind,
  type Stage,
  type Status
} from "./format.js";
import { buildState, findItem, type StpState } from "./model.js";
import { createStpFile, defaultActor, loadState, readConfig, relativePath, resolveStp, writeConfig } from "./store.js";
import { appendFolderTotem, postLaneMessage, type TotemResult } from "./totem.js";

export interface WriteOptions {
  root: string;
  stp?: string;
  actor?: string;
  channel?: Channel;
  /** false skips the Totem pointer for this write. */
  totem?: boolean;
}

export interface WriteResult {
  file: string;
  id: string;
  heading: string;
  hash: string;
  ref?: string;
  totem?: TotemResult;
}

function actorFor(options: WriteOptions): string {
  return options.actor ? sanitizeActor(options.actor) : defaultActor(options.root);
}

/**
 * Appends an entry only if it adds no new validation issue. The check runs on the
 * file as it is inside the write lock, by parsing the log with the candidate appended.
 */
async function appendChecked(
  file: string,
  build: (state: StpState) => { kind: string; ref?: string; fields: Partial<Record<FieldName, string>>; text: string; actor: string }
): Promise<{ heading: string; hash: string; ref?: string }> {
  let ref: string | undefined;
  const result = await appendChained(file, (existing) => {
    const before = buildState(parseStp(existing, file));
    const candidate = build(before);
    ref = candidate.ref;
    const heading = `### ${new Date().toISOString()} | ${candidate.actor} | ${candidate.kind}${candidate.ref ? ` ${candidate.ref}` : ""}`;
    const body = composeBody(candidate.fields, candidate.text);
    const after = buildState(parseStp(`${existing}\n${heading}\n${body}\n`, file));
    const known = new Set(before.issues);
    const added = after.issues.filter((issue) => !known.has(issue));
    if (added.length) throw new Error(added.map((issue) => issue.replace(/^line \d+ \([^)]*\): /, "")).join("\n"));
    return { heading, body };
  });
  return { ...result, ref };
}

function nextRef(state: StpState, kind: ItemKind): string {
  const prefix = ITEM_KINDS[kind].prefix;
  const used = state.items.filter((item) => item.ref.startsWith(prefix)).map((item) => Number(item.ref.slice(prefix.length)));
  return `${prefix}${(used.length ? Math.max(...used) : 0) + 1}`;
}

async function shouldPost(options: WriteOptions): Promise<boolean> {
  if (options.totem === false) return false;
  return (await readConfig(options.root)).postToTotem !== false;
}

function pointerMessage(state: StpState, root: string, event: string, hash: string): string {
  return [
    `STP pointer: ${state.id} "${state.title}"`,
    `Event: ${event}`,
    `Stage: ${state.stage}`,
    `File: ${relativePath(root, state.file)}`,
    `STP-Entry-Hash: ${hash}`
  ].join("\n");
}

async function maybePost(options: WriteOptions, file: string, event: string, hash: string): Promise<TotemResult | undefined> {
  if (!(await shouldPost(options))) return undefined;
  const state = await loadState(file);
  return postLaneMessage(options.root, pointerMessage(state, options.root, event, hash));
}

export async function newStp(options: WriteOptions & { title: string }): Promise<WriteResult> {
  const actor = actorFor(options);
  const { file, id } = await createStpFile(options.root, options.title, actor);
  const result = await appendChecked(file, () => ({
    kind: "stage",
    actor,
    fields: { Stage: "Situation", Kind: "stage", Channel: options.channel ?? "cli" },
    text: `Opened ${id}. Stage: Situation.`
  }));
  const config = await readConfig(options.root);
  await writeConfig(options.root, { ...config, active: id });
  const totem = await maybePost(options, file, "created", result.hash);
  return { file, id, ...result, totem };
}

export async function useStp(root: string, stp: string): Promise<string> {
  const file = await resolveStp(root, stp);
  const id = basename(file).slice(0, basename(file).indexOf("-", 4));
  const config = await readConfig(root);
  await writeConfig(root, { ...config, active: id });
  return id;
}

export interface AddItemOptions extends WriteOptions {
  kind: ItemKind;
  text: string;
  evidence?: string[];
  closes?: string[];
  targets?: string[];
  gaps?: string[];
  supersedes?: string;
}

export async function addItem(options: AddItemOptions): Promise<WriteResult> {
  const file = await resolveStp(options.root, options.stp);
  const actor = actorFor(options);
  const spec = ITEM_KINDS[options.kind];
  if (!spec) throw new Error(`Unknown kind "${options.kind}". Kinds: ${Object.keys(ITEM_KINDS).join(", ")}`);
  const result = await appendChecked(file, (state) => {
    const fields: Partial<Record<FieldName, string>> = {
      Stage: spec.stage ?? state.stage,
      Kind: options.kind,
      Channel: options.channel ?? "cli"
    };
    if (options.evidence?.length) fields.Evidence = options.evidence.join("; ");
    if (options.closes?.length) fields.Closes = options.closes.map((ref) => ref.toUpperCase()).join(", ");
    if (options.targets?.length) fields.Targets = options.targets.map((ref) => ref.toUpperCase()).join(", ");
    if (options.gaps?.length) fields.Gaps = options.gaps.map((ref) => ref.toUpperCase()).join(", ");
    if (options.kind === "change") fields.Status = "Drafted";
    if (options.supersedes) fields.Supersedes = options.supersedes.toUpperCase();
    return { kind: options.kind, ref: nextRef(state, options.kind), actor, fields, text: options.text };
  });
  return { file, id: (await loadState(file)).id, ...result };
}

/** Appends a revision that supersedes `ref`, inheriting its links unless new ones are given. */
export async function supersede(options: WriteOptions & { ref: string; text: string; evidence?: string[]; closes?: string[]; targets?: string[]; gaps?: string[] }): Promise<WriteResult> {
  const file = await resolveStp(options.root, options.stp);
  const earlier = findItem(await loadState(file), options.ref);
  if (!earlier) throw new Error(`No item ${options.ref.toUpperCase()} in this STP`);
  return addItem({
    ...options,
    stp: file,
    kind: earlier.kind,
    text: options.text,
    evidence: options.evidence?.length ? options.evidence : earlier.evidence,
    closes: options.closes?.length ? options.closes : earlier.closes,
    targets: options.targets?.length ? options.targets : earlier.targets,
    gaps: options.gaps?.length ? options.gaps : earlier.gaps,
    supersedes: earlier.ref
  });
}

export async function setStage(options: WriteOptions & { stage: string; text?: string }): Promise<WriteResult> {
  const file = await resolveStp(options.root, options.stp);
  const actor = actorFor(options);
  const stage: Stage = canonicalStage(options.stage);
  const result = await appendChecked(file, (state) => {
    if (state.stage === stage) throw new Error(`Already at stage ${stage}`);
    return { kind: "stage", actor, fields: { Stage: stage, Kind: "stage", Channel: options.channel ?? "cli" }, text: options.text ?? `Stage: ${state.stage} → ${stage}.` };
  });
  const totem = await maybePost(options, file, `stage → ${stage}`, result.hash);
  return { file, id: (await loadState(file)).id, ...result, totem };
}

export async function setStatus(options: WriteOptions & { ref: string; status: string; text?: string; architect?: boolean }): Promise<WriteResult> {
  const file = await resolveStp(options.root, options.stp);
  const actor = actorFor(options);
  const status: Status = canonicalStatus(options.status);
  const channel = options.channel ?? "cli";
  if (status === "Revised") throw new Error("A change becomes Revised by superseding it: aegis-stp supersede <ref> -m \"...\"");
  if (status === "Drafted") throw new Error("Drafted is the starting status; propose a new change or supersede instead");
  if (ARCHITECT_STATUSES.includes(status)) {
    if (!HUMAN_CHANNELS.includes(channel)) throw new Error(`${status} can be recorded only by a human Architect through the CLI or VS Code extension`);
    if (!options.actor) throw new Error(`${status} must name the Architect (--as <name>)`);
  }
  const ref = options.ref.toUpperCase();
  const result = await appendChecked(file, () => {
    const fields: Partial<Record<FieldName, string>> = { Stage: "Proposal", Kind: "status", Item: ref, Status: status, Channel: channel };
    if (ARCHITECT_STATUSES.includes(status) || options.architect) fields.Role = "architect";
    return { kind: "status", actor, fields, text: options.text ?? `${ref} → ${status}.` };
  });
  const totem = status === "Approved" || status === "Verified" ? await maybePost(options, file, `${ref} ${status} by ${actor}`, result.hash) : undefined;
  return { file, id: (await loadState(file)).id, ...result, ref, totem };
}

/** Summarizes a settled item into a Folder Totem and records the back-link in the STP. */
export async function distill(options: WriteOptions & { ref: string; folder: string; text?: string }): Promise<WriteResult & { totemOutput: string }> {
  const file = await resolveStp(options.root, options.stp);
  const state = await loadState(file);
  const item = findItem(state, options.ref);
  if (!item) throw new Error(`No item ${options.ref.toUpperCase()} in this STP`);
  if (item.supersededBy) throw new Error(`${item.ref} was superseded by ${item.supersededBy}; distill the current entry`);
  if (item.kind === "change" && item.status !== "Approved" && item.status !== "Executing" && item.status !== "Verified") {
    throw new Error(`${item.ref} is ${item.status}; distill a change once it is approved or verified`);
  }
  const summary = options.text?.trim() || item.text;
  const message = [
    `Distilled from ${state.id} ${item.ref} (${item.kind}${item.status ? `, ${item.status}` : ""}): ${summary}`,
    `Source: ${relativePath(options.root, file)}#${item.ref}`,
    `STP-Entry-Hash: ${item.hash ?? "unknown"}`
  ].join("\n");
  const totemOutput = await appendFolderTotem(options.root, options.folder, item.kind === "change" ? "decision" : item.kind, message);
  const folder = options.folder.replace(/\\/g, "/").replace(/\/$/, "");
  const result = await addItem({ ...options, stp: file, kind: "note", text: `Distilled ${item.ref} into the Folder Totem at ${folder}/TOTEM.md.` });
  return { ...result, totemOutput };
}
