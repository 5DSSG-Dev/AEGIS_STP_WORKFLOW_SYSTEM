# AEGIS STP

**Situation, Target, Proposal: append-only, evidence-grounded engineering reviews that live in the repo.**

When engineering work runs long, decisions get buried in chat. Resuming after an interruption then means piecing the discussion back together. STP keeps a review's structure in the repo and in the editor instead. At a glance you can see which STP you are in, what stage it is at, what has been established, and what is still open.

STP follows the laws of [AEGIS Totem](https://github.com/5DSSG-Dev/AEGIS_MULTI_AGENT_TOTEM_SYSTEM): local-first, free, human-readable Markdown, append-only, and tamper-evident through the same SHA-256 hash chain. One canonical CLI holds the logic. The VS Code extension and the MCP server are thin adapters over it, so humans and agents share one source of truth.

## The three spaces

| Space | Kinds | Rule |
| --- | --- | --- |
| **Situation** | `finding` (S1, S2, …) | What is true now. Every finding cites evidence: `path:line[-line]`, `commit:<sha>`, a URL, `totem:<path>`, or `assumption`. |
| **Target** | `target` (T…), `milestone` (M…) | The whole ideal. A milestone selects Target items and gaps; it never overwrites the Target. |
| **Gap** | `gap` (G…) | Each named distance between Situation and Target, linked to the Target items it concerns. |
| **Proposal** | `change` (P…), `decision` (D…) | Each change names the gaps it closes. Gaps that no change closes stay flagged. |

The stage of the STP moves through Situation → Target → Gap → Proposal → Execution → Complete.

### A Proposal is not approval

A change moves Drafted → Presented → Approved → Executing → Verified, and it can be Declined. Revising a change supersedes it, so the version that was presented stays in the record as Revised. Each move is an appended entry that names who made it.

**Approved** and **Verified** are separate, attributed acts. Only a named human Architect can record them, and only through the CLI or the extension. The MCP tools can draft and present, but they cannot approve, and `validate` flags any approval that arrives on the agent channel. On a local machine this is an integrity convention, not a security boundary.

## Install

From this repo:

```bash
npm install
npm run build
npm install -g .
```

This puts `aegis-stp` (the CLI) and `aegis-stp-mcp` (the MCP server) on your PATH.

For the VS Code extension (it also works in Cursor and in VS Code-based IDEs such as the Vibe Architect IDE):

```bash
npm run package:vscode
code --install-extension dist/aegis-stp-vscode-0.1.0.vsix
```

The VSIX bundles the CLI, so the extension works without the global install.

## CLI

```bash
aegis-stp new "UI Flow and Design"                 # opens STP-001 and makes it active
aegis-stp finding -m "Panels compete for focus on first load." -e src/ui/Shell.tsx:42-88
aegis-stp target  -m "The user always knows where focus is."
aegis-stp gap     -m "No focus owner on first load." --targets T1
aegis-stp propose -m "Collapse the left panel by default." --closes G1
aegis-stp present P1
aegis-stp approve P1 --as tracey                    # Architect only
aegis-stp execute P1
aegis-stp verify  P1 --as tracey                    # Architect only
aegis-stp supersede G1 -m "Revised wording"         # appends G2; G1 stays in the record
aegis-stp stage Proposal
aegis-stp resume                                    # where you stopped, what is decided, what's next
aegis-stp status | show <ref> | list | validate [--all] | read
aegis-stp milestone -m "Hackathon slice" --targets T1 --gaps G1
aegis-stp decision -m "D1: its own extension, owned by 5DSSG-Dev"
aegis-stp distill P1 --folder src/ui                # summarize into a Folder Totem, with back-link
```

Global options: `--stp <id|number|slug>` acts on an STP other than the active one, `--actor <name>` names the writer, `--json` prints machine-readable output, and `--no-totem` skips the Totem pointer for one write. If you don't pass `--actor`, the writer is taken from `AEGIS_STP_ACTOR`, then git `user.name`, then the OS user.

## Where records live

```
.aegis/stp/STP-001-ui-flow-and-design.md   # one append-only file per review area
.aegis/stp/config.json                      # active STP and settings (not part of the record)
```

See [docs/FORMAT.md](docs/FORMAT.md) for the entry format. Write through the tools: a hand edit breaks the hash chain, and `validate` reports the break.

## Totem integration

When the repo has AEGIS Totem set up (`.aegis/config.json` and `ROOT_TOTEM.md`), STP posts a short pointer to its own `aegis-stp` lane. It posts when an STP is created, when the stage changes, and when a change is approved or verified. Each pointer carries the STP id, title, stage, file path, and the STP entry's chain hash. STP writes these pointers through Totem's own CLI, so Totem's chain stays valid. If Totem is absent, STP works normally and posts nothing.

STP finds the Totem CLI in one of three ways: the `AEGIS_TOTEM_CLI` environment variable, an `aegis-totem` on your PATH, or the CLI bundled with the Totem VS Code extension. You can turn posting off per repo with `aegis-stp config --post-to-totem off`, or per workspace with the `aegisStp.postToTotem` setting.

`distill` summarizes a settled decision into a Folder Totem and records the back-link in the STP. Evidence can also cite Totem entries with `totem:<path>`.

## Agents (MCP)

```json
{
  "mcpServers": {
    "aegis-stp": { "command": "aegis-stp-mcp", "env": { "AEGIS_REPO_ROOT": "/path/to/repo" } }
  }
}
```

The server's tools are `stp_list`, `stp_resume`, `stp_status`, `stp_show`, `stp_read`, `stp_add_finding`, `stp_add_gap`, `stp_draft_change`, `stp_add_note`, `stp_supersede`, `stp_present` and `stp_validate`. None of them approves or verifies.

## Development

```bash
npm test            # build + unit tests
npm run mcp:qa      # MCP server round trip
npm run package:vscode
npm run check       # all of the above
```

## License

MIT
