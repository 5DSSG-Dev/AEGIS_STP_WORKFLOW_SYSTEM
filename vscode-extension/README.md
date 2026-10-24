# AEGIS STP for VS Code

Situation, Target, Proposal in the editor. At a glance you can see which STP you are in, its stage, what has been established, and what is still open.

- **Status bar:** shows the active STP and its stage, plus a count of uncovered gaps. Click it for the resume card.
- **Activity bar:** shows each STP with its Situation, Target, Gaps and Proposal. Click an item to jump to its entry. Inline actions present, approve, execute or verify a change, or propose a change for a gap.
- **Resume card:** shows where you stopped, what is decided, and the next open item, with buttons for the next step.
- **Board:** lays out the STP in four columns, with lines from gaps to Target items and from changes to the gaps they close. Uncovered gaps are highlighted.
- **Cite selection:** select lines in any file, then use the lightbulb or the editor context menu to record them as Situation evidence.
- **Lineage:** shows the revision history of any entry. Revisions supersede entries, and nothing is erased.
- **Approval is separate:** approving or verifying a change asks for the Architect's name and a modal confirmation.
- **Totem:** when AEGIS Totem is set up in the repo, STP posts pointers to the `aegis-stp` lane.

Records are append-only Markdown files in `.aegis/stp/`, hash-chained like AEGIS Totem. The extension bundles the `aegis-stp` CLI and writes only through it.

## Settings

- `aegisStp.actor`: your name on entries. If empty, STP uses git `user.name` or the OS user.
- `aegisStp.postToTotem`: posts pointers into the Totem lane. On by default.
- `aegisStp.cliPath`: points the extension at a different CLI, if you need one.
