#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command, Option } from "commander";
import { CHANNELS, ITEM_KINDS, STAGES, type Channel, type ItemKind } from "./core/format.js";
import { addItem, distill, newStp, setStage, setStatus, supersede, useStp, type WriteOptions, type WriteResult } from "./core/ops.js";
import { formatList, formatResume, formatShow, formatStatus, resumeCard, summarize } from "./core/render.js";
import { listStpFiles, loadState, readConfig, relativePath, resolveStp, validateFile, writeConfig } from "./core/store.js";
import { lineage } from "./core/model.js";

interface GlobalOptions {
  stp?: string;
  actor?: string;
  json?: boolean;
  totem?: boolean;
  channel?: string;
}

const root = process.cwd();
const collect = (value: string, previous: string[] = []) => [...previous, value];
const list = (value: string, previous: string[] = []) => [...previous, ...value.split(/[,;]/).map((part) => part.trim()).filter(Boolean)];

function writeOptions(options: GlobalOptions): WriteOptions {
  const channel = options.channel ?? "cli";
  if (!(CHANNELS as readonly string[]).includes(channel)) throw new Error(`Unknown channel "${channel}"`);
  return { root, stp: options.stp, actor: options.actor, channel: channel as Channel, totem: options.totem };
}

function report(options: GlobalOptions, result: WriteResult, message: string): void {
  if (options.json) {
    console.log(JSON.stringify({ ...result, file: relativePath(root, result.file) }, null, 2));
    return;
  }
  console.log(message);
  if (result.totem) console.log(result.totem.detail);
}

const program = new Command();
program
  .name("aegis-stp")
  .description("Situation, Target, Proposal: append-only, evidence-grounded reviews that live in the repo.")
  .version("0.1.0")
  .option("--stp <id>", "STP to act on (id, number, or slug); defaults to the active STP")
  .option("--actor <name>", "who is writing; defaults to AEGIS_STP_ACTOR, git user.name, or the OS user")
  .option("--json", "print machine-readable output")
  .option("--no-totem", "do not post a pointer to the Totem lane for this write")
  .addOption(new Option("--channel <channel>", "writer channel").choices([...CHANNELS]).hideHelp());

program.command("new").description("Open a new STP and make it active.").argument("<title...>")
  .action(async (title: string[], _options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const result = await newStp({ ...writeOptions(options), title: title.join(" ") });
    report(options, result, `Opened ${result.id}: ${relativePath(root, result.file)}`);
  });

program.command("list").description("List the STPs in this repo.")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    const { active } = await readConfig(root);
    const summaries = await Promise.all((await listStpFiles(root)).map(async (file) => summarize(root, await loadState(file), active)));
    console.log(options.json ? JSON.stringify(summaries, null, 2) : formatList(summaries));
  });

program.command("use").description("Make an STP the active one.").argument("<stp>")
  .action(async (stp: string) => console.log(`Active STP: ${await useStp(root, stp)}`));

function addCommand(name: string, kind: ItemKind, description: string): void {
  const command = program.command(name).description(description)
    .requiredOption("-m, --message <text>", "the entry text")
    .option("-e, --evidence <citation>", "evidence: path:line[-line], commit:<sha>, URL, totem:<path>, or assumption (repeatable)", collect)
    .option("--closes <gaps>", "gaps this change closes, e.g. G1,G4", list)
    .option("--targets <items>", "Target items this gap or milestone refers to, e.g. T1,T3", list)
    .option("--gaps <gaps>", "gaps a milestone selects", list);
  command.action(async (local: { message: string; evidence?: string[]; closes?: string[]; targets?: string[]; gaps?: string[] }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const result = await addItem({ ...writeOptions(options), kind, text: local.message, evidence: local.evidence, closes: local.closes, targets: local.targets, gaps: local.gaps });
    report(options, result, `Added ${result.ref} to ${result.id}`);
  });
}

addCommand("finding", "finding", "Add a Situation finding with evidence.");
addCommand("target", "target", "Add a Target item (part of the whole ideal).");
addCommand("milestone", "milestone", "Add a milestone that selects Target items or gaps.");
addCommand("gap", "gap", "Name a gap between Situation and Target.");
addCommand("propose", "change", "Draft a proposed change that closes gaps.");
addCommand("decision", "decision", "Record a settled decision.");
addCommand("note", "note", "Add a note.");

program.command("add").description(`Add an entry of any kind: ${Object.keys(ITEM_KINDS).join(", ")}.`)
  .argument("<kind>")
  .requiredOption("-m, --message <text>", "the entry text")
  .option("-e, --evidence <citation>", "evidence citation (repeatable)", collect)
  .option("--closes <gaps>", "gaps closed", list)
  .option("--targets <items>", "Target items", list)
  .option("--gaps <gaps>", "gaps selected", list)
  .action(async (kind: string, local: { message: string; evidence?: string[]; closes?: string[]; targets?: string[]; gaps?: string[] }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const normalized = kind.toLowerCase() === "proposal" ? "change" : kind.toLowerCase();
    if (!(normalized in ITEM_KINDS)) throw new Error(`Unknown kind "${kind}". Kinds: ${Object.keys(ITEM_KINDS).join(", ")}`);
    const result = await addItem({ ...writeOptions(options), kind: normalized as ItemKind, text: local.message, evidence: local.evidence, closes: local.closes, targets: local.targets, gaps: local.gaps });
    report(options, result, `Added ${result.ref} to ${result.id}`);
  });

program.command("supersede").description("Append a revision that supersedes an earlier entry; the earlier one stays in the record.")
  .argument("<ref>")
  .requiredOption("-m, --message <text>", "the revised text")
  .option("-e, --evidence <citation>", "replacement evidence (repeatable); inherits when omitted", collect)
  .option("--closes <gaps>", "replacement gaps closed", list)
  .option("--targets <items>", "replacement Target items", list)
  .option("--gaps <gaps>", "replacement gaps", list)
  .action(async (ref: string, local: { message: string; evidence?: string[]; closes?: string[]; targets?: string[]; gaps?: string[] }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const result = await supersede({ ...writeOptions(options), ref, text: local.message, evidence: local.evidence, closes: local.closes, targets: local.targets, gaps: local.gaps });
    report(options, result, `${result.ref} supersedes ${ref.toUpperCase()} in ${result.id}`);
  });

program.command("stage").description(`Move the STP to a stage: ${STAGES.join(", ")}.`).argument("<stage>").option("-m, --message <text>", "why")
  .action(async (stage: string, local: { message?: string }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const result = await setStage({ ...writeOptions(options), stage, text: local.message });
    report(options, result, `${result.id} stage: ${stage}`);
  });

function statusCommand(name: string, status: string, description: string, architect: boolean): void {
  const command = program.command(name).description(description).argument("<ref>").option("-m, --message <text>", "note for the record");
  if (architect) command.requiredOption("--as <architect>", "the named human Architect recording this");
  command.action(async (ref: string, local: { message?: string; as?: string }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const result = await setStatus({ ...writeOptions({ ...options, actor: local.as ?? options.actor }), ref, status, text: local.message });
    report(options, result, `${ref.toUpperCase()} → ${status}`);
  });
}

statusCommand("present", "Presented", "Present a drafted change to the Architect. Presenting is not approval.", false);
statusCommand("approve", "Approved", "Record the Architect's approval to execute a presented change.", true);
statusCommand("execute", "Executing", "Mark an approved change as executing.", false);
statusCommand("verify", "Verified", "Record the Architect's verification of an executed change.", true);
statusCommand("decline", "Declined", "Decline a change.", false);

program.command("status").description("Show the computed state of the STP.")
  .action(async (_options, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const state = await loadState(await resolveStp(root, options.stp));
    console.log(options.json ? JSON.stringify({ ...state, file: relativePath(root, state.file) }, null, 2) : formatStatus(root, state));
  });

program.command("resume").description("Show the return point: where you stopped, what is decided, and the next open item.")
  .action(async (_options, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const card = resumeCard(root, await loadState(await resolveStp(root, options.stp)));
    console.log(options.json ? JSON.stringify(card, null, 2) : formatResume(card));
  });

program.command("show").description("Show one item with its full lineage and status history.").argument("<ref>")
  .action(async (ref: string, _options, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const state = await loadState(await resolveStp(root, options.stp));
    console.log(options.json ? JSON.stringify(lineage(state, ref), null, 2) : formatShow(state, ref));
  });

program.command("read").description("Print the raw STP file.")
  .action(async (_options, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    process.stdout.write(await readFile(await resolveStp(root, options.stp), "utf8"));
  });

program.command("validate").description("Recompute the hash chain and check every entry's fields and links.").option("--all", "validate every STP in the repo")
  .action(async (local: { all?: boolean }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const files = local.all ? await listStpFiles(root) : [await resolveStp(root, options.stp)];
    const results = await Promise.all(files.map(async (file) => ({ file: relativePath(root, file), errors: await validateFile(file) })));
    const ok = results.every((result) => result.errors.length === 0);
    if (options.json) console.log(JSON.stringify({ ok, results }, null, 2));
    else for (const result of results) console.log(result.errors.length ? `✗ ${result.file}\n${result.errors.map((error) => `  ${error}`).join("\n")}` : `✓ ${result.file}`);
    if (!ok) process.exitCode = 1;
  });

program.command("distill").description("Summarize a settled item into a Folder Totem, with a link back to the STP.")
  .argument("<ref>").requiredOption("--folder <folder>", "repo-relative folder whose TOTEM.md receives the summary").option("-m, --message <text>", "summary text; defaults to the item's text")
  .action(async (ref: string, local: { folder: string; message?: string }, cmd: Command) => {
    const options = cmd.optsWithGlobals<GlobalOptions>();
    const result = await distill({ ...writeOptions(options), ref, folder: local.folder, text: local.message });
    report(options, result, `Distilled ${ref.toUpperCase()} into ${local.folder}; back-link ${result.ref}`);
  });

program.command("config").description("Show or change STP settings for this repo.").option("--post-to-totem <on|off>", "post pointers into the Totem aegis-stp lane")
  .action(async (local: { postToTotem?: string }) => {
    const config = await readConfig(root);
    if (local.postToTotem) {
      config.postToTotem = !["off", "false", "no", "0"].includes(local.postToTotem.toLowerCase());
      await writeConfig(root, config);
    }
    console.log(JSON.stringify({ postToTotem: config.postToTotem !== false, active: config.active ?? null }, null, 2));
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`aegis-stp: ${(error as Error).message}`);
  process.exitCode = 1;
}
