import {
  ARCHITECT_STATUSES,
  HUMAN_CHANNELS,
  ITEM_KINDS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  isItemKind,
  isStage,
  isStatus,
  splitEvidence,
  splitList,
  type Channel,
  type Entry,
  type ItemKind,
  type ParsedStp,
  type Stage,
  type Status
} from "./format.js";

export interface StatusEvent {
  status: Status;
  actor: string;
  utc: string;
  channel?: string;
  role?: string;
  text: string;
  line: number;
}

export interface Item {
  ref: string;
  kind: ItemKind;
  text: string;
  actor: string;
  utc: string;
  line: number;
  hash?: string;
  status?: Status;
  evidence: string[];
  closes: string[];
  targets: string[];
  gaps: string[];
  supersedes?: string;
  supersededBy?: string;
  distilled?: string;
  history: StatusEvent[];
}

export interface OpenItem {
  ref?: string;
  reason: string;
}

export interface StpState {
  file: string;
  id: string;
  title: string;
  created: string;
  createdBy: string;
  stage: Stage;
  stageHistory: { stage: Stage; actor: string; utc: string; line: number }[];
  items: Item[];
  entryCount: number;
  lastEntry?: { heading: string; utc: string; actor: string; kind: string; ref?: string; text: string; line: number; hash?: string };
  lastHash?: string;
  uncoveredGaps: string[];
  decided: string[];
  open: OpenItem[];
  issues: string[];
}

export function activeItems(state: StpState, kind?: ItemKind): Item[] {
  return state.items.filter((item) => !item.supersededBy && (!kind || item.kind === kind));
}

export function findItem(state: StpState, ref: string): Item | undefined {
  return state.items.find((item) => item.ref === ref.toUpperCase());
}

/** The chain of revisions an item belongs to, oldest first. */
export function lineage(state: StpState, ref: string): Item[] {
  let item = findItem(state, ref);
  if (!item) return [];
  while (item.supersedes) {
    const earlier = findItem(state, item.supersedes);
    if (!earlier) break;
    item = earlier;
  }
  const chain: Item[] = [item];
  while (item.supersededBy) {
    const later = findItem(state, item.supersededBy);
    if (!later) break;
    chain.push(later);
    item = later;
  }
  return chain;
}

function isLiveChange(item: Item): boolean {
  return item.kind === "change" && !item.supersededBy && item.status !== "Declined" && item.status !== "Revised";
}

export function buildState(parsed: ParsedStp): StpState {
  const issues: string[] = [...parsed.headerIssues];
  const items: Item[] = [];
  const byRef = new Map<string, Item>();
  const stageHistory: StpState["stageHistory"] = [];
  let stage: Stage = "Situation";

  const where = (entry: Entry) => `line ${entry.line} (${entry.heading.slice(4)})`;
  const checkRefs = (entry: Entry, refs: string[], kind: ItemKind, field: string) => {
    for (const ref of refs) {
      const target = byRef.get(ref.toUpperCase());
      if (!target) issues.push(`${where(entry)}: ${field} cites ${ref}, which does not exist earlier in the log`);
      else if (target.kind !== kind) issues.push(`${where(entry)}: ${field} cites ${ref}, which is a ${target.kind}, not a ${kind}`);
    }
  };

  for (const entry of parsed.entries) {
    if (!entry.utc || !entry.actor || !entry.kind) {
      issues.push(`${where(entry)}: heading must be "### <utc> | <actor> | <kind> [ref]"`);
      continue;
    }
    if (entry.fields.Kind && entry.fields.Kind.toLowerCase() !== entry.kind) {
      issues.push(`${where(entry)}: Kind field "${entry.fields.Kind}" does not match heading kind "${entry.kind}"`);
    }
    if (entry.fields.Channel && !["cli", "extension", "mcp"].includes(entry.fields.Channel)) {
      issues.push(`${where(entry)}: unknown Channel "${entry.fields.Channel}"`);
    }

    if (entry.kind === "stage") {
      const value = entry.fields.Stage ?? "";
      if (!isStage(value)) {
        issues.push(`${where(entry)}: stage entry has invalid Stage "${value}"`);
        continue;
      }
      stage = value;
      stageHistory.push({ stage: value, actor: entry.actor, utc: entry.utc, line: entry.line });
      continue;
    }

    if (entry.kind === "status") {
      const ref = entry.fields.Item?.toUpperCase() ?? "";
      const value = entry.fields.Status ?? "";
      const target = byRef.get(ref);
      if (!target) {
        issues.push(`${where(entry)}: status entry names Item "${ref}", which does not exist`);
        continue;
      }
      if (target.kind !== "change") {
        issues.push(`${where(entry)}: status entries apply only to proposed changes; ${ref} is a ${target.kind}`);
        continue;
      }
      if (!isStatus(value)) {
        issues.push(`${where(entry)}: invalid Status "${value}"`);
        continue;
      }
      const current = target.status ?? "Drafted";
      if (target.supersededBy) {
        issues.push(`${where(entry)}: ${ref} was superseded by ${target.supersededBy}; move the newer entry instead`);
        continue;
      }
      if (!TRANSITIONS[current].includes(value)) {
        issues.push(`${where(entry)}: ${ref} cannot move from ${current} to ${value}`);
        continue;
      }
      if (ARCHITECT_STATUSES.includes(value)) {
        if (!HUMAN_CHANNELS.includes(entry.fields.Channel as Channel)) {
          issues.push(`${where(entry)}: ${value} must be recorded through the CLI or extension, not "${entry.fields.Channel ?? "unknown"}"`);
          continue;
        }
        if (entry.fields.Role?.toLowerCase() !== "architect") {
          issues.push(`${where(entry)}: ${value} must be recorded by a named Architect (Role: architect)`);
          continue;
        }
      }
      target.status = value;
      target.history.push({ status: value, actor: entry.actor, utc: entry.utc, channel: entry.fields.Channel, role: entry.fields.Role, text: entry.text, line: entry.line });
      continue;
    }

    if (!isItemKind(entry.kind)) {
      issues.push(`${where(entry)}: unknown kind "${entry.kind}"`);
      continue;
    }
    const spec = ITEM_KINDS[entry.kind];
    const ref = entry.ref ?? "";
    if (!new RegExp(`^${spec.prefix}\\d+$`).test(ref)) {
      issues.push(`${where(entry)}: ${entry.kind} needs a reference like ${spec.prefix}1, got "${ref}"`);
      continue;
    }
    if (byRef.has(ref)) {
      issues.push(`${where(entry)}: reference ${ref} is already used`);
      continue;
    }
    if (!entry.text) issues.push(`${where(entry)}: ${ref} has no text`);

    const item: Item = {
      ref,
      kind: entry.kind,
      text: entry.text,
      actor: entry.actor,
      utc: entry.utc,
      line: entry.line,
      hash: entry.hash,
      evidence: splitEvidence(entry.fields.Evidence),
      closes: splitList(entry.fields.Closes).map((value) => value.toUpperCase()),
      targets: splitList(entry.fields.Targets).map((value) => value.toUpperCase()),
      gaps: splitList(entry.fields.Gaps).map((value) => value.toUpperCase()),
      supersedes: entry.fields.Supersedes?.toUpperCase(),
      distilled: entry.fields.Distilled,
      history: []
    };

    if (item.kind === "finding" && item.evidence.length === 0) {
      issues.push(`${where(entry)}: Situation finding ${ref} needs Evidence (a file and line, commit:, URL, totem:, or "assumption")`);
    }
    if (item.kind === "change") {
      const declared = entry.fields.Status ?? "Drafted";
      if (declared !== "Drafted") issues.push(`${where(entry)}: a new change starts as Drafted, not "${declared}"`);
      item.status = "Drafted";
      item.history.push({ status: "Drafted", actor: entry.actor, utc: entry.utc, channel: entry.fields.Channel, text: "", line: entry.line });
      if (item.closes.length === 0) issues.push(`${where(entry)}: change ${ref} should name the gaps it closes (Closes: G1, ...)`);
      checkRefs(entry, item.closes, "gap", "Closes");
    }
    if (item.kind === "gap") checkRefs(entry, item.targets, "target", "Targets");
    if (item.kind === "milestone") {
      if (item.targets.length === 0 && item.gaps.length === 0) issues.push(`${where(entry)}: milestone ${ref} should select Target items or gaps`);
      checkRefs(entry, item.targets, "target", "Targets");
      checkRefs(entry, item.gaps, "gap", "Gaps");
    }

    if (item.supersedes) {
      const earlier = byRef.get(item.supersedes);
      if (!earlier) issues.push(`${where(entry)}: Supersedes ${item.supersedes}, which does not exist`);
      else if (earlier.kind !== item.kind) issues.push(`${where(entry)}: ${ref} (${item.kind}) cannot supersede ${earlier.ref} (${earlier.kind})`);
      else if (earlier.supersededBy) issues.push(`${where(entry)}: ${earlier.ref} was already superseded by ${earlier.supersededBy}`);
      else if (earlier.kind === "change" && earlier.status && TERMINAL_STATUSES.includes(earlier.status)) {
        issues.push(`${where(entry)}: ${earlier.ref} is ${earlier.status} and can no longer be revised`);
      } else {
        earlier.supersededBy = ref;
        if (earlier.kind === "change") {
          earlier.status = "Revised";
          earlier.history.push({ status: "Revised", actor: entry.actor, utc: entry.utc, channel: entry.fields.Channel, text: `Superseded by ${ref}`, line: entry.line });
        }
      }
    }

    items.push(item);
    byRef.set(ref, item);
  }

  const state: StpState = {
    file: parsed.file,
    id: parsed.id,
    title: parsed.title,
    created: parsed.created,
    createdBy: parsed.createdBy,
    stage,
    stageHistory,
    items,
    entryCount: parsed.entries.length,
    uncoveredGaps: [],
    decided: [],
    open: [],
    issues
  };

  const last = parsed.entries.at(-1);
  if (last) {
    state.lastEntry = { heading: last.heading, utc: last.utc, actor: last.actor, kind: last.kind, ref: last.ref ?? last.fields.Item, text: last.text, line: last.line, hash: last.hash };
    state.lastHash = last.hash;
  }

  const liveChanges = items.filter(isLiveChange);
  state.uncoveredGaps = activeItems(state, "gap")
    .filter((gap) => !liveChanges.some((change) => change.closes.includes(gap.ref)))
    .map((gap) => gap.ref);
  state.decided = [
    ...activeItems(state, "decision").map((item) => item.ref),
    ...liveChanges.filter((change) => change.status === "Approved" || change.status === "Executing" || change.status === "Verified").map((change) => change.ref)
  ];
  state.open = computeOpen(state, liveChanges);
  return state;
}

function computeOpen(state: StpState, liveChanges: Item[]): OpenItem[] {
  const open: OpenItem[] = [];
  if (activeItems(state, "finding").length === 0) open.push({ reason: "Record the first Situation finding, with evidence" });
  if (activeItems(state, "target").length === 0) open.push({ reason: "Record the Target: the whole ideal, before any milestone" });
  if (activeItems(state, "target").length > 0 && activeItems(state, "gap").length === 0) open.push({ reason: "Name the gaps between Situation and Target" });
  for (const change of liveChanges.filter((item) => item.status === "Presented")) open.push({ ref: change.ref, reason: "Presented; awaiting the Architect's decision" });
  for (const gap of state.uncoveredGaps) open.push({ ref: gap, reason: "No proposed change closes this gap" });
  for (const change of liveChanges.filter((item) => item.status === "Drafted")) open.push({ ref: change.ref, reason: "Drafted; not yet presented" });
  for (const change of liveChanges.filter((item) => item.status === "Approved")) open.push({ ref: change.ref, reason: "Approved; execution not started" });
  for (const change of liveChanges.filter((item) => item.status === "Executing")) open.push({ ref: change.ref, reason: "Executing; awaiting verification" });
  return open;
}
