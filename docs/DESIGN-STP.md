# AEGIS STP Workflow System: design STP

Oct 20, 2026 · @Tracey Prutch

This doc applies STP to the STP extension itself. It is a design draft for discussion, and nothing here is approved to build. The ideas you raised with Codex are treated as inputs to test against the Target, not as settled requirements.

What I need from you is reactions, mainly to the decisions in the Proposal and the open questions at the end. The Vibe Architect IDE UI Flow trial has not started and waits for your go-ahead.

## Situation

You lose your place during long engineering work: decisions get buried in chat, and resuming after an interruption means reconstructing the discussion. STP already works for you as a method. What is missing is a tool that holds its structure in the editor.

### The AEGIS Totem precedent

I studied [5DSSG-Dev/AEGIS\_MULTI\_AGENT\_TOTEM\_SYSTEM](https://github.com/5DSSG-Dev/AEGIS_MULTI_AGENT_TOTEM_SYSTEM) at commit a8d0fb9 (2026-10-18), starting from its `ROOT_TOTEM.md`. CLI 0.1.2 and extension 0.1.3 are released.

| Aspect | What Totem does | Evidence |
| --- | --- | --- |
| Architecture | One canonical TypeScript CLI; the VS Code extension and MCP server are thin adapters that call it | `src/cli.ts`, `vscode-extension/extension.js`, `src/mcp-server.ts` |
| Storage | Human-readable Markdown in the repo plus `.aegis/config.json`; no service, no account, no telemetry | `ROOT_TOTEM.md`, `.aegis/` |
| Integrity law | Append-only. Corrections and supersessions are appended, never rewritten | Root Totem operating rules |
| Tamper evidence | Each append carries `Chain-Prev` and `Chain-Hash` (SHA-256); `validate` recomputes the chain; lock directory serializes concurrent writers | `src/fs/append.ts` |
| VS Code surface | Activity-bar tree (Root, Folder Totems, Lanes), visible action rows, input-box prompts for appends, read-only webview panels (Doctor, List, Analytics, Live Test) | `vscode-extension/package.json` (12 commands, 1 view) |
| Agent surface | MCP stdio tools that read, append, and validate the same files | `docs/mcp-clients.md` |
| Packaging | VSIX bundles the CLI so it works before npm publication; Cursor and Open VSX use the same VSIX | `scripts/package-vscode.mjs` |
| Quality gates | Separate QA scripts per surface, plus a release preflight; readiness is kept separate from publication | `npm run alpha:check` |

The Totem's own lesson, "publication readiness is not the same as publication", is the same rule you want for STP: a Proposal is not approval to execute.

### Constraints

- STP should follow Totem's laws: local-first, free, human-readable, append-only.
- The extension writes through a CLI, so agents and humans share one source of truth.
- The Meta Hackathon runs October 26 to November 4, 2026, which sets the near-term clock for the first trial.

### Shortfalls in Totem relevant to STP

- Entries are free text. Totem has no structured fields for evidence, stage, or links between entries. Its own Root Totem lists structured evidence fields (`--file`, `--verify`, `--next`) as open follow-up.
- The VS Code adapter is mostly prompts and read-only panels. There is no editing surface for structured content.
- The extension reads only the first workspace folder.

### Unknowns

- Where STP records should live: in the repo under review, or in a central place.
- Whether several STPs run at once (one per review area), and how they relate.
- Which repo is the Vibe Architect IDE.
- Resolved 2026-10-20: the Vibe Architect IDE is VS Code based, so STP can run inside it.

## Target

At any moment you can glance at VS Code and know which STP you are in, which stage it is at, what has been established, and what is still open. This is the ideal; a smaller first milestone does not change it.

1. **Always oriented.** The active STP and its stage are visible without opening anything, for example in the status bar.
2. **Three distinct spaces.** Situation, Target, and Proposal each have their own place, so an observation never gets mistaken for a wish or a plan.
3. **Grounded Situation.** Each Situation finding can cite its evidence: a file and line, a commit, a URL, a Totem entry, or a note that it is an assumption.
4. **A protected ideal.** The Target is recorded whole. A delivery milestone is a scoped slice that points back to the Target and never overwrites it.
5. **Visible gaps.** Each gap between Situation and Target is named. Every proposed change shows which gaps it closes, and gaps with no proposed change stand out.
6. **Proposal is not approval.** A Proposal can be drafted, presented, and revised without anything happening. Approval to execute is a separate, attributed act by you as Architect.
7. **A return point.** On reopening, a resume card shows where you stopped, what was decided, and the next open item.
8. **Lineage.** Revisions supersede earlier entries without erasing them, so you can see how an assessment or decision changed.
9. **Totem integration.** STP structures the live investigation; when a decision settles, its understanding is distilled into the relevant Totem with a link back.
10. **Shared with agents.** An AI agent can read the active STP and contribute Situation evidence or draft Proposals through the same records you use.
11. **Same laws as Totem.** Local, free, human-readable, append-only, and tamper-evident.

## Gap

Totem already supplies the integrity law, packaging, and agent channel; the gaps are almost all about structure and visibility. Numbers in the Target column refer to the Target list above.

| Gap | Target | What exists today |
| --- | --- | --- |
| G1 No STP record format with stages, evidence, gaps, and links | 2, 3, 5 | Totem entries are free text |
| G2 No visible stage or active-STP indicator | 1 | Nothing |
| G3 No way to cite evidence on a finding | 3 | Free-text mentions only |
| G4 No separation of ideal Target from milestone scope | 4 | Nothing |
| G5 No gap-to-change traceability | 5 | Nothing |
| G6 No proposal lifecycle or approval record | 6 | Totem has release gates, but only as a convention |
| G7 No resume card or return point | 7 | Totem has status and analytics, which are counts, not orientation |
| G8 No supersession links between entries | 8 | Supersessions are appended as prose |
| G9 No STP-to-Totem distill or back-link | 9 | Nothing |
| G10 No agent tools for STP | 10 | Totem MCP pattern exists and can be copied |

## Proposal

I recommend a separate STP CLI and extension built on Totem's architecture, storing each STP as an append-only Markdown file with structured entry fields. Six decisions shape it; my recommendation is marked in each.

### D1 Packaging (closes G1, G10)

| Option | Gain | Cost |
| --- | --- | --- |
| **A. Separate `aegis-stp` CLI and extension that reuses Totem's append core (recommended)** | Clear identity; STP can ship and change on its own clock; Totem stays focused | Two extensions to install; shared code must be extracted or depended on |
| B. A module inside the Totem extension | One install; integration is trivial | Grows Totem's scope; STP's richer UI would dominate a deliberately thin tool |
| C. Extension only, no CLI | Fastest first build | Breaks the precedent; agents and terminals lose the shared source of truth |

**Decided 2026-10-20 by Tracey:** Option A, its own extension. The repo will be owned by `5DSSG-Dev`, alongside Totem. Reason: it leaves the developer a choice (Axiom 6) to install STP, Totem or both, rather than both or none.

### D2 Record format (closes G1, G3, G5, G8)

| Option | Gain | Cost |
| --- | --- | --- |
| **A. One Markdown file per STP; each entry has a heading plus short fields such as `Stage:`, `Kind:`, `Evidence:`, `Closes:`, `Supersedes:` (recommended)** | Readable in any editor; reuses `appendChained` and `validate`; same feel as Totems | Field parsing must be strict, and validated |
| B. JSONL event log as the source, Markdown generated as a view | Easiest to query and link | Not human-first; breaks the Totem precedent |
| C. Free-text Markdown sections, Totem style | Zero new format | Links, stages, and states cannot be computed, so G5 to G7 stay open |

Current state (stage, open gaps, latest Proposal status) is computed from the log as a view, as Totem does for status and analytics.

A sketch of two entries in that format, for illustration only:

```markdown
### 2026-10-21 | tracey | situation-finding S3
Stage: Situation
Kind: finding
Evidence: src/ui/Shell.tsx:42-88; screenshot docs/ui/nav.png
The left panel and the 3D canvas compete for focus on first load.

### 2026-10-21 | verus | proposal-change P2
Stage: Proposal
Kind: change
Closes: G1, G4
Status: Drafted
Collapse the left panel by default and open it from the Luminary prompt.
```

### D3 Location (closes G1)

Recommended: `.aegis/stp/<id>-<slug>.md` inside the repo under review, with one STP per review area. For the Vibe Architect IDE that means one file per area, starting with UI Flow and Design. The alternative, a central STP repo, keeps reviews together across projects but separates evidence from the code it cites.

### D4 Proposal lifecycle and approval (closes G4, G6)

A Proposal moves through Drafted, Presented, Approved, Executing, and Verified, and can be Revised or Declined. Each move is an appended entry naming who made it.

&#91;embedded content: Proposal lifecycle · 7 states, approval by the Architect\]

A revision appends a new Draft that supersedes the earlier one, so the presented version stays in the record.

- Approval is a separate entry kind, recorded only through the extension or CLI by a named human Architect.
- MCP tools can draft and present, but cannot record approval. This mirrors your rule, though on a local machine it is a convention, not a security boundary, as Totem's `SECURITY.md` already notes.
- A milestone is an entry that selects a subset of Target items and gaps; the Target itself is never edited.

### D5 VS Code surface (closes G2, G7)

| Surface | Purpose | Phase |
| --- | --- | --- |
| Status bar item | Active STP and stage, one click to the resume card | 1 |
| Activity-bar tree | STPs, then Situation, Target, Gaps, Proposal under each | 1 |
| Resume card (webview) | Where you stopped, what is decided, next open item | 1 |
| Commands with quick picks | Add finding with evidence, add gap, propose change, approve, supersede | 1 |
| STP board (webview) | Three columns with lines from gaps to changes; uncovered gaps highlighted | 2 |
| Lineage view | Revision history of one entry | 2 |
| "Cite selection" code action | Turns the selected lines into a Situation evidence reference | 2 |

### D6 Totem integration (closes G9)

**Direction set 2026-10-20 by Tracey:** when Totem is installed, STP posts a short pointer into the Totems. The pointer flags that an STP exists and links to its file. It keeps the project in sync and tells any arriving agent that the STP is there.

How it would work:

- **Detection.** STP checks for `.aegis/config.json` and `ROOT_TOTEM.md`, and that the `aegis-totem` CLI can run. If Totem is absent, STP works normally and posts nothing.
- **Writes go through Totem's CLI**, never direct file edits, so Totem's hash chain stays valid.
- **When it posts.** On STP creation, on each stage change, and when a Proposal is approved or verified. Each post is a few lines: STP id, title, stage, file path, and the STP entry's chain hash.
- **A setting** `aegisStp.postToTotem` lets you turn it off per workspace. Default on.
- STP evidence can also cite Totem entries, and a later `distill` command can summarize a settled decision into a Totem.

One gap in Totem shapes where the pointer lands. Totem's CLI today can append to a Folder Totem (`totem append <folder>`) or a lane (`lane message`), but has no command for appending to the Root Totem.

| Option | Where the pointer lands | Cost |
| --- | --- | --- |
| **A. Folder Totem nearest the area under review, plus an `aegis-stp` lane (recommended for Phase 1)** | Agents read the nearest Folder Totem before editing, so they see it in context | Works with Totem today; an agent orienting only from the Root Totem may miss it |
| B. Root Totem | Every arriving agent sees it first | Needs a small `root append` command added to Totem, which is a separate change to that repo |
| C. Both, A now and B once Totem supports it | Full coverage | Two small pieces of work, in two repos |

I recommend C: ship A in Phase 1 and propose the `root append` command to Totem as its own change.

**Decided 2026-10-20 by Tracey:** STP posts through its own `aegis-stp` lane, which Totem already supports. A Root Totem append stays a possible later change to Totem, not part of STP's plan.

### Phased path

1. **Phase 0, now, no build.** Run the UI Flow and Design trial on a Markdown template that uses the D2 format by hand. The trial tests the format before code freezes it. Starts only when you say so.
2. **Phase 1, core.** CLI with `new`, `add`, `approve`, `supersede`, `status`, `resume`, `validate`; extension with status bar, tree, resume card, and commands; tests and QA gates copied from Totem.
3. **Phase 2, visibility.** STP board, lineage view, cite-selection, and MCP tools.
4. **Phase 3, integration.** Totem `distill` and back-links; VSIX release through the same path Totem uses.

With the hackathon running October 26 to November 4, a reasonable milestone is Phase 0 starting before October 26, with Phase 1 built alongside it during the event. The full Target stays recorded above.

## Open questions and return point

- [x] D1: its own extension (decided 2026-10-20)
- [x] Repo owner: `5DSSG-Dev` (decided 2026-10-20)
- [x] Vibe Architect IDE repo: `AEGIS_VIBE_ARCHITECT_DEVELOPERS_KIT`, now renamed Vibe-Architect-Developer-IDE
- [x] Hackathon dates: October 26 to November 4, 2026
- [x] D6: STP posts through its own \`aegis-stp\` lane (decided 2026-10-20)
- [x] Vibe Architect IDE is VS Code based, so STP can run inside it (confirmed 2026-10-20)
- [x] Proposal lifecycle states in D4 kept as drafted (confirmed 2026-10-20)

**Return point.** Established: the Situation, the Target list, the gap table, D1 and the repo owner decided, D6 direction set. All open questions are answered. Next step: Phase 0, the UI Flow and Design trial on a Markdown template, when Tracey calls it.
