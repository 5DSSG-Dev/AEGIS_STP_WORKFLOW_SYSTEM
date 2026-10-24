import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addItem, newStp, setStage, setStatus, supersede } from "../src/core/ops.js";
import { loadState, resolveStp, validateFile } from "../src/core/store.js";
import { evidenceType, parseStp } from "../src/core/format.js";
import { lineage } from "../src/core/model.js";
import { resumeCard } from "../src/core/render.js";

let root: string;
const opts = (actor = "tracey") => ({ root, actor, totem: false });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stp-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function seeded() {
  const { file } = await newStp({ ...opts(), title: "UI Flow and Design" });
  await addItem({ ...opts(), kind: "finding", text: "Panels compete for focus.", evidence: ["src/ui/Shell.tsx:42-88"] });
  await addItem({ ...opts(), kind: "target", text: "Focus is always clear." });
  await addItem({ ...opts(), kind: "gap", text: "No focus owner.", targets: ["T1"] });
  await addItem({ ...opts(), kind: "gap", text: "No onboarding.", targets: ["T1"] });
  return file;
}

describe("record format", () => {
  it("creates an STP, numbers items per kind, and validates", async () => {
    const file = await seeded();
    const state = await loadState(file);
    expect(state.id).toBe("STP-001");
    expect(state.items.map((item) => item.ref)).toEqual(["S1", "T1", "G1", "G2"]);
    expect(await validateFile(file)).toEqual([]);
    expect(await resolveStp(root, "1")).toBe(file);
    expect(await resolveStp(root, "ui-flow-and-design")).toBe(file);
  });

  it("detects tampering through the hash chain", async () => {
    const file = await seeded();
    writeFileSync(file, readFileSync(file, "utf8").replace("Panels compete for focus.", "Panels are fine."));
    expect((await validateFile(file)).some((error) => error.includes("hash mismatch"))).toBe(true);
  });

  it("refuses a finding without evidence and a change without gaps", async () => {
    await seeded();
    await expect(addItem({ ...opts(), kind: "finding", text: "Unsupported." })).rejects.toThrow(/needs Evidence/);
    await expect(addItem({ ...opts(), kind: "change", text: "Do things." })).rejects.toThrow(/should name the gaps/);
    await expect(addItem({ ...opts(), kind: "change", text: "Do things.", closes: ["G9"] })).rejects.toThrow(/does not exist/);
  });

  it("keeps free text that looks like a field out of the fields", async () => {
    const file = await seeded();
    await addItem({ ...opts(), kind: "note", text: "Status: this is prose, not a field." });
    const note = (await loadState(file)).items.find((item) => item.ref === "N1");
    expect(note?.text).toBe("Status: this is prose, not a field.");
    expect(await validateFile(file)).toEqual([]);
  });

  it("classifies evidence", () => {
    expect(evidenceType("src/ui/Shell.tsx:42-88")).toBe("file");
    expect(evidenceType("commit:a8d0fb9")).toBe("commit");
    expect(evidenceType("https://github.com/x/y")).toBe("url");
    expect(evidenceType("totem:src/TOTEM.md")).toBe("totem");
    expect(evidenceType("assumption: users skim")).toBe("assumption");
  });
});

describe("gaps and proposals", () => {
  it("shows uncovered gaps until a change closes them", async () => {
    const file = await seeded();
    expect((await loadState(file)).uncoveredGaps).toEqual(["G1", "G2"]);
    await addItem({ ...opts("verus"), kind: "change", text: "Collapse the left panel.", closes: ["G1"] });
    const state = await loadState(file);
    expect(state.uncoveredGaps).toEqual(["G2"]);
    expect(state.items.find((item) => item.ref === "P1")?.status).toBe("Drafted");
  });

  it("walks the lifecycle and refuses skipped steps", async () => {
    const file = await seeded();
    await addItem({ ...opts("verus"), kind: "change", text: "Collapse the left panel.", closes: ["G1"] });
    await expect(setStatus({ ...opts(), ref: "P1", status: "Approved" })).rejects.toThrow(/cannot move from Drafted to Approved/);
    await setStatus({ ...opts("verus"), ref: "P1", status: "Presented" });
    await setStatus({ ...opts(), ref: "P1", status: "Approved" });
    await setStatus({ ...opts(), ref: "P1", status: "Executing" });
    await setStatus({ ...opts(), ref: "P1", status: "Verified" });
    const item = (await loadState(file)).items.find((entry) => entry.ref === "P1");
    expect(item?.history.map((event) => event.status)).toEqual(["Drafted", "Presented", "Approved", "Executing", "Verified"]);
    expect(item?.history[2].role).toBe("architect");
    expect(await validateFile(file)).toEqual([]);
  });

  it("does not let an agent channel approve", async () => {
    const file = await seeded();
    await addItem({ ...opts("verus"), kind: "change", text: "Collapse.", closes: ["G1"], channel: "mcp" });
    await setStatus({ ...opts("verus"), ref: "P1", status: "Presented", channel: "mcp" });
    await expect(setStatus({ ...opts("verus"), ref: "P1", status: "Approved", channel: "mcp" })).rejects.toThrow(/human Architect/);
    await expect(setStatus({ root, totem: false, ref: "P1", status: "Approved" })).rejects.toThrow(/must name the Architect/);

    // A hand-written approval on the mcp channel is rejected by validation too.
    const content = readFileSync(file, "utf8");
    writeFileSync(file, `${content}\n### 2026-10-24T00:00:00.000Z | verus | status\nStage: Proposal\nKind: status\nItem: P1\nStatus: Approved\nRole: architect\nChannel: mcp\n\nForged.\n`);
    expect((await validateFile(file)).some((error) => error.includes("must be recorded through the CLI or extension"))).toBe(true);
  });

  it("supersedes without erasing, and marks a revised change", async () => {
    const file = await seeded();
    await addItem({ ...opts("verus"), kind: "change", text: "Collapse.", closes: ["G1"] });
    await setStatus({ ...opts("verus"), ref: "P1", status: "Presented" });
    const result = await supersede({ ...opts("verus"), ref: "P1", text: "Collapse, and open from the Luminary prompt." });
    expect(result.ref).toBe("P2");
    const state = await loadState(file);
    const p1 = state.items.find((item) => item.ref === "P1");
    const p2 = state.items.find((item) => item.ref === "P2");
    expect(p1?.status).toBe("Revised");
    expect(p1?.supersededBy).toBe("P2");
    expect(p2?.status).toBe("Drafted");
    expect(p2?.closes).toEqual(["G1"]);
    expect(lineage(state, "P2").map((item) => item.ref)).toEqual(["P1", "P2"]);
    await expect(supersede({ ...opts(), ref: "P1", text: "again" })).rejects.toThrow(/already superseded/);
    expect(readFileSync(file, "utf8")).toContain("Collapse.");
  });

  it("milestones select from the Target without changing it", async () => {
    const file = await seeded();
    await addItem({ ...opts(), kind: "milestone", text: "Hackathon slice.", targets: ["T1"], gaps: ["G1"] });
    const state = await loadState(file);
    expect(state.items.find((item) => item.ref === "T1")?.supersededBy).toBeUndefined();
    await expect(addItem({ ...opts(), kind: "milestone", text: "Empty." })).rejects.toThrow(/should select/);
  });
});

describe("orientation", () => {
  it("tracks stage and builds a resume card with the next open item", async () => {
    const file = await seeded();
    await addItem({ ...opts("verus"), kind: "change", text: "Collapse.", closes: ["G1"] });
    await setStatus({ ...opts("verus"), ref: "P1", status: "Presented" });
    await setStage({ ...opts(), stage: "proposal" });
    const card = resumeCard(root, await loadState(file));
    expect(card.stage).toBe("Proposal");
    expect(card.next).toMatchObject({ ref: "P1", reason: "Presented; awaiting the Architect's decision" });
    expect(card.open.map((item) => item.ref)).toEqual(["P1", "G2"]);
    expect(card.stoppedAt?.what).toMatch(/^stage/);
  });

  it("guides an empty STP toward its first finding", async () => {
    const { file } = await newStp({ ...opts(), title: "Empty" });
    expect(resumeCard(root, await loadState(file)).next?.reason).toMatch(/first Situation finding/);
  });
});

describe("cli", () => {
  const cli = join(process.cwd(), "dist", "src", "cli.js");
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, "--no-totem"], { cwd: root, encoding: "utf8" });

  it("runs the core flow and emits JSON for adapters", () => {
    run("new", "CLI", "Flow", "--actor", "tracey");
    run("finding", "-m", "It works.", "-e", "assumption");
    run("target", "-m", "Ideal.");
    run("gap", "-m", "Missing.", "--targets", "T1");
    run("propose", "-m", "Fix.", "--closes", "G1");
    const status = JSON.parse(run("status", "--json"));
    expect(status.items.map((item: { ref: string }) => item.ref)).toEqual(["S1", "T1", "G1", "P1"]);
    const list = JSON.parse(run("list", "--json"));
    expect(list[0]).toMatchObject({ id: "STP-001", active: true });
    expect(run("validate")).toContain("✓");
    expect(() => run("approve", "P1")).toThrow();
  });

  it("parses the design doc's illustrative entry shape", () => {
    const parsed = parseStp(`# x\n\nId: STP-009\nTitle: Sketch\n\n## Append Log\n\n### 2026-10-21 | tracey | finding S3\nStage: Situation\nKind: finding\nEvidence: src/ui/Shell.tsx:42-88; screenshot docs/ui/nav.png\nThe left panel and the 3D canvas compete for focus on first load.\n`, "x.md");
    expect(parsed.entries[0]).toMatchObject({ kind: "finding", ref: "S3", text: "The left panel and the 3D canvas compete for focus on first load." });
    expect(parsed.entries[0].fields.Evidence).toContain("Shell.tsx");
  });
});
