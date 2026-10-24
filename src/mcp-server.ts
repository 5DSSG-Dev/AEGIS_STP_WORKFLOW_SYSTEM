#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addItem, setStatus, supersede } from "./core/ops.js";
import { formatList, formatResume, formatShow, formatStatus, resumeCard, summarize } from "./core/render.js";
import { listStpFiles, loadState, readConfig, relativePath, resolveStp, validateFile } from "./core/store.js";

const root = resolve(process.env.AEGIS_REPO_ROOT ?? process.cwd());
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const server = new McpServer({ name: "aegis-stp", version: "0.1.0" });

// Agents write through the same records humans use, on the "mcp" channel. Approval and
// verification are not offered here: a Proposal is not approval, and the record rejects
// Approved or Verified from the mcp channel even if written another way.
const base = {
  stp: z.string().optional().describe("STP id, number, or slug; defaults to the active STP"),
  actor: z.string().describe("the agent's name, e.g. claude or codex")
};
const write = (stp: string | undefined, actor: string) => ({ root, stp, actor, channel: "mcp" as const });

server.tool("stp_list", "List the STPs in the repository and which one is active.", {}, async () => {
  const { active } = await readConfig(root);
  return text(formatList(await Promise.all((await listStpFiles(root)).map(async (file) => summarize(root, await loadState(file), active)))));
});

server.tool("stp_resume", "Read the return point of an STP: stage, where work stopped, what is decided, and the next open item. Call this first.", { stp: base.stp }, async ({ stp }) =>
  text(formatResume(resumeCard(root, await loadState(await resolveStp(root, stp))))));

server.tool("stp_status", "Read the full computed state of an STP: Situation, Target, gaps, proposals, and issues.", { stp: base.stp }, async ({ stp }) =>
  text(formatStatus(root, await loadState(await resolveStp(root, stp)))));

server.tool("stp_show", "Show one item (S1, T1, G1, P1, ...) with its lineage and status history.", { stp: base.stp, ref: z.string() }, async ({ stp, ref }) =>
  text(formatShow(await loadState(await resolveStp(root, stp)), ref)));

server.tool("stp_read", "Read the raw append-only STP file.", { stp: base.stp }, async ({ stp }) =>
  text(await readFile(await resolveStp(root, stp), "utf8")));

server.tool("stp_add_finding", "Contribute a Situation finding. Evidence is required: path:line[-line], commit:<sha>, a URL, totem:<path>, or \"assumption\".", {
  ...base,
  text: z.string(),
  evidence: z.array(z.string()).min(1)
}, async ({ stp, actor, text: body, evidence }) => {
  const result = await addItem({ ...write(stp, actor), kind: "finding", text: body, evidence });
  return text(`Added ${result.ref} to ${result.id} (${relativePath(root, result.file)})`);
});

server.tool("stp_add_gap", "Name a gap between Situation and Target, citing the Target items it concerns.", {
  ...base,
  text: z.string(),
  targets: z.array(z.string()).optional()
}, async ({ stp, actor, text: body, targets }) => {
  const result = await addItem({ ...write(stp, actor), kind: "gap", text: body, targets });
  return text(`Added ${result.ref} to ${result.id}`);
});

server.tool("stp_draft_change", "Draft a proposed change that closes one or more gaps. It starts as Drafted; drafting is not approval.", {
  ...base,
  text: z.string(),
  closes: z.array(z.string()).min(1)
}, async ({ stp, actor, text: body, closes }) => {
  const result = await addItem({ ...write(stp, actor), kind: "change", text: body, closes });
  return text(`Drafted ${result.ref} in ${result.id}`);
});

server.tool("stp_add_note", "Add a note to an STP.", { ...base, text: z.string() }, async ({ stp, actor, text: body }) => {
  const result = await addItem({ ...write(stp, actor), kind: "note", text: body });
  return text(`Added ${result.ref} to ${result.id}`);
});

server.tool("stp_supersede", "Revise an earlier entry by appending a successor; the earlier entry stays in the record.", {
  ...base,
  ref: z.string(),
  text: z.string(),
  evidence: z.array(z.string()).optional(),
  closes: z.array(z.string()).optional()
}, async ({ stp, actor, ref, text: body, evidence, closes }) => {
  const result = await supersede({ ...write(stp, actor), ref, text: body, evidence, closes });
  return text(`${result.ref} supersedes ${ref.toUpperCase()} in ${result.id}`);
});

server.tool("stp_present", "Present a drafted change to the Architect for a decision. Presenting is not approval; only the Architect can approve.", {
  ...base,
  ref: z.string(),
  note: z.string().optional()
}, async ({ stp, actor, ref, note }) => {
  const result = await setStatus({ ...write(stp, actor), ref, status: "Presented", text: note });
  return text(`${ref.toUpperCase()} presented in ${result.id}; awaiting the Architect`);
});

server.tool("stp_validate", "Recompute the hash chain and check fields and links for every STP.", {}, async () => {
  const results = await Promise.all((await listStpFiles(root)).map(async (file) => ({ file: relativePath(root, file), errors: await validateFile(file) })));
  return text(results.map((result) => result.errors.length ? `✗ ${result.file}\n${result.errors.map((error) => `  ${error}`).join("\n")}` : `✓ ${result.file}`).join("\n") || "No STPs");
});

await server.connect(new StdioServerTransport());
