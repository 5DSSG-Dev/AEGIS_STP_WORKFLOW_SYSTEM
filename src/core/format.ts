export const STAGES = ["Situation", "Target", "Gap", "Proposal", "Execution", "Complete"] as const;
export type Stage = (typeof STAGES)[number];

/** Kinds that create a referenceable item. The prefix numbers them: S1, T1, G1, P1, ... */
export const ITEM_KINDS = {
  finding: { prefix: "S", stage: "Situation", label: "Situation finding" },
  target: { prefix: "T", stage: "Target", label: "Target item" },
  milestone: { prefix: "M", stage: "Target", label: "Milestone" },
  gap: { prefix: "G", stage: "Gap", label: "Gap" },
  change: { prefix: "P", stage: "Proposal", label: "Proposed change" },
  decision: { prefix: "D", stage: "Proposal", label: "Decision" },
  note: { prefix: "N", stage: null, label: "Note" }
} as const;
export type ItemKind = keyof typeof ITEM_KINDS;

/** Kinds that record an event rather than an item. */
export const EVENT_KINDS = ["stage", "status"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type EntryKind = ItemKind | EventKind;

export const STATUSES = ["Drafted", "Presented", "Approved", "Executing", "Verified", "Revised", "Declined"] as const;
export type Status = (typeof STATUSES)[number];

/** Allowed status moves. Revised is reached only by superseding a change. */
export const TRANSITIONS: Record<Status, Status[]> = {
  Drafted: ["Presented", "Declined"],
  Presented: ["Approved", "Declined"],
  Approved: ["Executing", "Declined"],
  Executing: ["Verified"],
  Verified: [],
  Revised: [],
  Declined: []
};
export const TERMINAL_STATUSES: Status[] = ["Verified", "Revised", "Declined"];

/** Proposal is not approval: these moves need a named human Architect through the CLI or extension. */
export const ARCHITECT_STATUSES: Status[] = ["Approved", "Verified"];
export const CHANNELS = ["cli", "extension", "mcp"] as const;
export type Channel = (typeof CHANNELS)[number];
export const HUMAN_CHANNELS: Channel[] = ["cli", "extension"];

export const FIELD_ORDER = ["Stage", "Kind", "Item", "Status", "Evidence", "Closes", "Targets", "Gaps", "Supersedes", "Distilled", "Role", "Channel"] as const;
export type FieldName = (typeof FIELD_ORDER)[number];
const FIELD_SET = new Set<string>(FIELD_ORDER);

export interface Entry {
  index: number;
  line: number;
  heading: string;
  utc: string;
  actor: string;
  kind: string;
  ref?: string;
  prev?: string;
  hash?: string;
  fields: Partial<Record<FieldName, string>>;
  text: string;
}

export interface ParsedStp {
  file: string;
  id: string;
  title: string;
  created: string;
  createdBy: string;
  entries: Entry[];
  headerIssues: string[];
}

export function isItemKind(kind: string): kind is ItemKind {
  return Object.prototype.hasOwnProperty.call(ITEM_KINDS, kind);
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function canonicalStage(value: string): Stage {
  const match = STAGES.find((stage) => stage.toLowerCase() === value.trim().toLowerCase());
  if (!match) throw new Error(`Unknown stage "${value}". Stages: ${STAGES.join(", ")}`);
  return match;
}

export function canonicalStatus(value: string): Status {
  const match = STATUSES.find((status) => status.toLowerCase() === value.trim().toLowerCase());
  if (!match) throw new Error(`Unknown status "${value}". Statuses: ${STATUSES.join(", ")}`);
  return match;
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
}

/** Evidence is a semicolon-separated list; commas can appear inside a citation. */
export function splitEvidence(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(";").map((part) => part.trim()).filter(Boolean);
}

export type EvidenceType = "file" | "commit" | "url" | "totem" | "assumption" | "other";

export function evidenceType(citation: string): EvidenceType {
  if (/^assumption\b/i.test(citation)) return "assumption";
  if (/^https?:\/\//i.test(citation)) return "url";
  if (/^commit:/i.test(citation)) return "commit";
  if (/^totem:/i.test(citation)) return "totem";
  if (!/\s/.test(citation) && (/[\\/]/.test(citation) || /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(citation))) return "file";
  return "other";
}

/** Parses an evidence file citation such as `src/ui/Shell.tsx:42-88`. */
export function parseFileCitation(citation: string): { path: string; start?: number; end?: number } | null {
  const match = citation.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
  if (!match || evidenceType(citation) !== "file") return null;
  const start = match[2] ? Number(match[2]) : undefined;
  const end = match[3] ? Number(match[3]) : start;
  return { path: match[1], start, end };
}

export function formatField(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Body layout: field lines, a blank line, then free text. The blank line keeps text that looks like a field from being read as one. */
export function composeBody(fields: Partial<Record<FieldName, string>>, text: string): string {
  const lines: string[] = [];
  for (const name of FIELD_ORDER) {
    const value = fields[name];
    if (value !== undefined && value !== "") lines.push(`${name}: ${formatField(value)}`);
  }
  const trimmed = text.trim();
  return trimmed ? `${lines.join("\n")}\n\n${trimmed}` : lines.join("\n");
}

const headingPattern = /^### (.+)$/gm;
const fieldPattern = /^([A-Z][A-Za-z-]*):\s?(.*)$/;

export function parseStp(content: string, file: string): ParsedStp {
  const logIndex = content.indexOf("## Append Log");
  const header = logIndex >= 0 ? content.slice(0, logIndex) : content;
  const headerField = (name: string) => header.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const headerIssues: string[] = [];
  if (logIndex < 0) headerIssues.push("missing \"## Append Log\" section");
  const id = headerField("Id");
  const title = headerField("Title");
  if (!id) headerIssues.push("header is missing an Id line");
  if (!title) headerIssues.push("header is missing a Title line");

  const starts = [...content.matchAll(headingPattern)].map((match) => ({ index: match.index ?? 0, heading: match[0] }));
  const entries: Entry[] = starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? content.length;
    const lines = content.slice(start.index, end).split(/\r?\n/);
    const parts = start.heading.slice(4).split(" | ").map((part) => part.trim());
    const [kind = "", ref] = (parts[2] ?? "").split(/\s+/);
    const prev = lines[1]?.match(/^Chain-Prev:\s+(.+)$/i)?.[1]?.trim();
    const hash = lines[2]?.match(/^Chain-Hash:\s+([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    let cursor = prev || hash ? 3 : 1;
    const fields: Partial<Record<FieldName, string>> = {};
    for (; cursor < lines.length; cursor += 1) {
      const fieldMatch = lines[cursor].match(fieldPattern);
      if (!fieldMatch || !FIELD_SET.has(fieldMatch[1])) break;
      fields[fieldMatch[1] as FieldName] = fieldMatch[2].trim();
    }
    const text = lines.slice(cursor).join("\n").trim();
    return {
      index: position,
      line: content.slice(0, start.index).split("\n").length,
      heading: start.heading,
      utc: parts[0] ?? "",
      actor: parts[1] ?? "",
      kind: kind.toLowerCase(),
      ref: ref?.toUpperCase(),
      prev,
      hash,
      fields,
      text
    };
  });

  return {
    file,
    id,
    title,
    created: headerField("Created"),
    createdBy: headerField("Created-By"),
    entries,
    headerIssues
  };
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "stp";
}

export function sanitizeActor(actor: string): string {
  const normalized = actor.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Actor name is empty after sanitizing: "${actor}"`);
  return normalized;
}

export function stpTemplate(id: string, title: string, created: string, createdBy: string): string {
  return `# ${id} · ${title}

Id: ${id}
Title: ${title}
Created: ${created}
Created-By: ${createdBy}

Situation, Target, Proposal. Situation records what is true, with evidence. Target records the whole ideal; milestones select from it and never overwrite it. Gaps name the distance between them. Proposal records changes that close gaps.

## Operating Rules

- Append-only. Revisions supersede earlier entries; nothing is rewritten or erased.
- Write through \`aegis-stp\` (CLI, VS Code extension, or MCP) so the hash chain stays valid.
- A Proposal is not approval. Only a named human Architect records Approved or Verified, through the CLI or extension.

## Append Log
`;
}
