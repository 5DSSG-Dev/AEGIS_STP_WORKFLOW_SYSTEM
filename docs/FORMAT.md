# STP record format

Each STP is one Markdown file at `.aegis/stp/STP-<NNN>-<slug>.md`. The file has a header, then an append log of chained entries. The format is readable in any editor, and `aegis-stp validate` checks it strictly.

## Header

```markdown
# STP-001 · UI Flow and Design

Id: STP-001
Title: UI Flow and Design
Created: 2026-10-24T17:48:31.030Z
Created-By: tracey

...

## Append Log
```

## Entries

```markdown
### 2026-10-24T17:48:31.416Z | tracey | finding S1
Chain-Prev: b96bb6d2…
Chain-Hash: de519e8d…
Stage: Situation
Kind: finding
Evidence: src/ui/Shell.tsx:42-88; commit:a8d0fb9
Channel: cli

The left panel and the 3D canvas compete for focus on first load.
```

- **Heading:** `### <utc> | <actor> | <kind> [ref]`.
- **Chain lines:** `Chain-Hash` is the SHA-256 of `<Chain-Prev>\n<heading>\n<body>`, where the body is everything after the chain lines. This is the same scheme as AEGIS Totem; the first entry links to `GENESIS`.
- **Fields:** short `Name: value` lines in a fixed order, then a blank line, then free text. The blank line keeps prose that happens to look like a field from being read as one.

### Fields

| Field | Used by | Meaning |
| --- | --- | --- |
| `Stage` | all | The stage the entry belongs to (for `stage` entries, the new stage) |
| `Kind` | all | Repeats the heading kind |
| `Evidence` | finding (required) | `;`-separated citations: `path:line[-line]`, `commit:<sha>`, URL, `totem:<path>`, `assumption` |
| `Closes` | change (required) | Gaps the change closes, e.g. `G1, G4` |
| `Targets` | gap, milestone | Target items referred to |
| `Gaps` | milestone | Gaps the milestone selects |
| `Supersedes` | any item | The earlier entry this one revises (same kind) |
| `Item`, `Status` | status | The change being moved and its new status |
| `Role` | status | `architect` for Approved and Verified |
| `Channel` | all | `cli`, `extension`, or `mcp` |

### Kinds

| Kind | Ref | Notes |
| --- | --- | --- |
| `finding` | S1… | Situation. Evidence required. |
| `target` | T1… | Part of the whole ideal. |
| `milestone` | M1… | Selects Target items and/or gaps. |
| `gap` | G1… | Between Situation and Target. |
| `change` | P1… | Starts as `Drafted`; must name the gaps it closes. |
| `decision` | D1… | A settled decision. |
| `note` | N1… | Anything else, including distill back-links. |
| `stage` | — | Moves the STP to a stage. |
| `status` | — | Moves a change through its lifecycle. |

### Lifecycle

```
Drafted → Presented → Approved → Executing → Verified
   │          │           │
   └──────────┴───────────┴──→ Declined
Superseding a Drafted, Presented, Approved or Executing change marks it Revised.
```

`Approved` and `Verified` need `Role: architect` and a `cli` or `extension` channel.

## Computed state

Stage, active items, gap coverage, decisions, and the next open item are computed from the log and never stored. `aegis-stp status --json` and `aegis-stp resume --json` expose them to adapters.

## Phase 0: writing by hand

You can trial the format by hand before relying on the tools. Write entries without the `Chain-` lines. `validate` accepts unchained entries as long as they come before the first chained one, and the tools start the chain from the next write.
