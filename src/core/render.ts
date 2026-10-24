import { ITEM_KINDS } from "./format.js";
import { activeItems, findItem, lineage, type Item, type StpState } from "./model.js";
import { relativePath } from "./store.js";

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function itemLine(item: Item): string {
  const status = item.status ? ` [${item.status}]` : "";
  const links = [
    item.closes.length ? `closes ${item.closes.join(", ")}` : "",
    item.targets.length ? `targets ${item.targets.join(", ")}` : "",
    item.gaps.length ? `gaps ${item.gaps.join(", ")}` : "",
    item.supersedes ? `supersedes ${item.supersedes}` : ""
  ].filter(Boolean).join("; ");
  return `  ${item.ref}${status} ${oneLine(item.text)}${links ? `  (${links})` : ""}`;
}

export interface StpSummary {
  id: string;
  title: string;
  file: string;
  stage: string;
  active: boolean;
  entries: number;
  openCount: number;
  uncoveredGaps: number;
  issues: number;
}

export function summarize(root: string, state: StpState, activeId?: string): StpSummary {
  return {
    id: state.id,
    title: state.title,
    file: relativePath(root, state.file),
    stage: state.stage,
    active: state.id === activeId,
    entries: state.entryCount,
    openCount: state.open.length,
    uncoveredGaps: state.uncoveredGaps.length,
    issues: state.issues.length
  };
}

export function formatList(summaries: StpSummary[]): string {
  if (summaries.length === 0) return "No STPs yet. Create one with: aegis-stp new \"<title>\"";
  return summaries
    .map((stp) => `${stp.active ? "*" : " "} ${stp.id}  ${stp.stage.padEnd(9)}  ${stp.title}  (${stp.entries} entries, ${stp.openCount} open${stp.issues ? `, ${stp.issues} issues` : ""})`)
    .join("\n");
}

export function formatStatus(root: string, state: StpState): string {
  const sections: string[] = [`${state.id} · ${state.title}`, `Stage: ${state.stage}`, `File: ${relativePath(root, state.file)}`];
  const groups: [string, Item[]][] = [
    ["Situation", activeItems(state, "finding")],
    ["Target", activeItems(state, "target")],
    ["Milestones", activeItems(state, "milestone")],
    ["Gaps", activeItems(state, "gap")],
    ["Proposal", activeItems(state, "change")],
    ["Decisions", activeItems(state, "decision")],
    ["Notes", activeItems(state, "note")]
  ];
  for (const [label, items] of groups) {
    if (items.length === 0) continue;
    sections.push("", `${label}:`, ...items.map((item) => {
      const line = itemLine(item);
      return item.kind === "gap" && state.uncoveredGaps.includes(item.ref) ? `${line}  ← no change closes this` : line;
    }));
  }
  if (state.issues.length) sections.push("", `Issues (${state.issues.length}):`, ...state.issues.map((issue) => `  ! ${issue}`));
  return sections.join("\n");
}

export interface ResumeCard {
  id: string;
  title: string;
  file: string;
  stage: string;
  stoppedAt?: { utc: string; actor: string; what: string; line: number };
  decided: { ref: string; status?: string; text: string }[];
  next?: { ref?: string; reason: string; text?: string };
  open: { ref?: string; reason: string; text?: string }[];
  uncoveredGaps: string[];
  counts: Record<string, number>;
  issues: string[];
}

export function resumeCard(root: string, state: StpState): ResumeCard {
  const withText = (entry: { ref?: string; reason: string }) => ({ ...entry, text: entry.ref ? findItem(state, entry.ref)?.text : undefined });
  const last = state.lastEntry;
  const counts: Record<string, number> = {};
  for (const kind of Object.keys(ITEM_KINDS)) counts[kind] = activeItems(state, kind as keyof typeof ITEM_KINDS).length;
  return {
    id: state.id,
    title: state.title,
    file: relativePath(root, state.file),
    stage: state.stage,
    stoppedAt: last ? { utc: last.utc, actor: last.actor, what: `${last.kind}${last.ref ? ` ${last.ref}` : ""}: ${oneLine(last.text, 160)}`, line: last.line } : undefined,
    decided: state.decided.map((ref) => {
      const item = findItem(state, ref);
      return { ref, status: item?.status, text: item?.text ?? "" };
    }),
    next: state.open[0] ? withText(state.open[0]) : undefined,
    open: state.open.map(withText),
    uncoveredGaps: state.uncoveredGaps,
    counts,
    issues: state.issues
  };
}

export function formatResume(card: ResumeCard): string {
  const lines = [`${card.id} · ${card.title}`, `Stage: ${card.stage}`];
  if (card.stoppedAt) lines.push(`Stopped at: ${card.stoppedAt.utc} by ${card.stoppedAt.actor}`, `  ${card.stoppedAt.what}`);
  lines.push("", "Decided:");
  lines.push(...(card.decided.length ? card.decided.map((item) => `  ${item.ref}${item.status ? ` [${item.status}]` : ""} ${oneLine(item.text)}`) : ["  nothing yet"]));
  lines.push("", "Next:");
  lines.push(card.next ? `  ${card.next.ref ? `${card.next.ref}: ` : ""}${card.next.reason}${card.next.text ? `\n    ${oneLine(card.next.text)}` : ""}` : "  nothing open");
  if (card.open.length > 1) lines.push("", `Also open (${card.open.length - 1}):`, ...card.open.slice(1).map((item) => `  ${item.ref ? `${item.ref}: ` : ""}${item.reason}`));
  if (card.issues.length) lines.push("", `Issues: ${card.issues.length} (run aegis-stp validate)`);
  return lines.join("\n");
}

export function formatShow(state: StpState, ref: string): string {
  const chain = lineage(state, ref);
  if (chain.length === 0) throw new Error(`No item ${ref.toUpperCase()} in ${state.id}`);
  const lines: string[] = [];
  for (const item of chain) {
    const marker = item.supersededBy ? `superseded by ${item.supersededBy}` : "current";
    lines.push(`${item.ref} · ${ITEM_KINDS[item.kind].label} · ${marker}`, `  ${item.utc} by ${item.actor} (line ${item.line})`);
    if (item.evidence.length) lines.push(`  Evidence: ${item.evidence.join("; ")}`);
    if (item.closes.length) lines.push(`  Closes: ${item.closes.join(", ")}`);
    if (item.targets.length) lines.push(`  Targets: ${item.targets.join(", ")}`);
    if (item.gaps.length) lines.push(`  Gaps: ${item.gaps.join(", ")}`);
    lines.push(...item.text.split(/\r?\n/).map((line) => `  ${line}`));
    for (const event of item.history) lines.push(`  → ${event.status} · ${event.utc} by ${event.actor}${event.role ? ` (${event.role})` : ""}${event.channel ? ` via ${event.channel}` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
