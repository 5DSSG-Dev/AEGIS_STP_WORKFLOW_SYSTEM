const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

const KIND_META = {
  finding: { section: "Situation", icon: "search", label: "Situation finding" },
  target: { section: "Target", icon: "star-full", label: "Target item" },
  milestone: { section: "Target", icon: "milestone", label: "Milestone" },
  gap: { section: "Gaps", icon: "debug-disconnect", label: "Gap" },
  change: { section: "Proposal", icon: "git-pull-request-draft", label: "Proposed change" },
  decision: { section: "Proposal", icon: "law", label: "Decision" },
  note: { section: "Notes", icon: "note", label: "Note" }
};
const SECTIONS = ["Situation", "Target", "Gaps", "Proposal", "Notes"];
const STATUS_ICONS = {
  Drafted: "edit",
  Presented: "megaphone",
  Approved: "pass",
  Executing: "sync",
  Verified: "verified-filled",
  Declined: "circle-slash",
  Revised: "history"
};
const STAGES = ["Situation", "Target", "Gap", "Proposal", "Execution", "Complete"];

let extensionContext;
let output;

// ---------- workspace and CLI ----------

function hasStp(folder) {
  return fs.existsSync(path.join(folder, ".aegis", "stp"));
}

/** The folder STP works in: the active editor's folder if it has STPs, else the first folder that does, else the active or first folder. */
function repoRoot() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  const editorFolder = editorUri ? vscode.workspace.getWorkspaceFolder(editorUri)?.uri.fsPath : undefined;
  if (editorFolder && hasStp(editorFolder)) return editorFolder;
  const withStp = folders.find((folder) => hasStp(folder.uri.fsPath));
  if (withStp) return withStp.uri.fsPath;
  return editorFolder ?? folders[0].uri.fsPath;
}

function cliInvocation() {
  const configured = vscode.workspace.getConfiguration("aegisStp").get("cliPath");
  if (configured) return configured.endsWith(".js") ? { command: process.execPath, prefix: [configured] } : { command: configured, prefix: [] };
  const bundled = path.join(extensionContext.extensionPath, "cli-dist", "src", "cli.js");
  if (fs.existsSync(bundled)) return { command: process.execPath, prefix: [bundled] };
  return { command: "aegis-stp", prefix: [] };
}

/** Lets STP post pointers through the Totem extension's bundled CLI when no global aegis-totem exists. */
function totemCliEnv() {
  const totem = vscode.extensions.getExtension("thelight1122.aegis-totem-vscode");
  const bundled = totem ? path.join(totem.extensionPath, "cli-dist", "src", "cli.js") : undefined;
  return bundled && fs.existsSync(bundled) && !process.env.AEGIS_TOTEM_CLI ? { AEGIS_TOTEM_CLI: bundled } : {};
}

function run(args, { write = false } = {}) {
  const root = repoRoot();
  const cli = cliInvocation();
  const settings = vscode.workspace.getConfiguration("aegisStp");
  const extra = [];
  if (write) {
    extra.push("--channel", "extension");
    if (!settings.get("postToTotem", true)) extra.push("--no-totem");
    const actor = settings.get("actor");
    if (actor && !args.includes("--as") && !args.includes("--actor")) extra.push("--actor", actor);
  }
  return new Promise((resolve, reject) => {
    if (!root) return reject(new Error("Open a folder first."));
    cp.execFile(cli.command, [...cli.prefix, ...args, ...extra], { cwd: root, env: { ...process.env, ...totemCliEnv() }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      output.appendLine(`$ aegis-stp ${[...args, ...extra].join(" ")}`);
      if (stdout.trim()) output.appendLine(stdout.trim());
      if (stderr.trim()) output.appendLine(stderr.trim());
      if (error && !(args[0] === "validate" && error.code === 1)) return reject(new Error((stderr || stdout || error.message).replace(/^aegis-stp:\s*/, "").trim()));
      resolve(stdout.trim());
    });
  });
}

async function runJson(args) {
  return JSON.parse(await run([...args, "--json"]));
}

function stpFolderPath() {
  const root = repoRoot();
  return root ? path.join(root, ".aegis", "stp") : undefined;
}

// ---------- state cache ----------

const cache = { root: undefined, list: [], states: new Map(), resume: undefined };

async function reload() {
  cache.root = repoRoot();
  cache.states.clear();
  cache.resume = undefined;
  if (!cache.root || !hasStp(cache.root)) {
    cache.list = [];
  } else {
    try {
      cache.list = await runJson(["list"]);
      await Promise.all(cache.list.map(async (stp) => cache.states.set(stp.id, await runJson(["status", "--stp", stp.id]))));
      const active = cache.list.find((stp) => stp.active) ?? (cache.list.length === 1 ? cache.list[0] : undefined);
      if (active) cache.resume = await runJson(["resume", "--stp", active.id]);
    } catch (error) {
      output.appendLine(`Refresh failed: ${error.message}`);
      cache.list = [];
    }
  }
  vscode.commands.executeCommand("setContext", "aegisStp.hasStp", cache.list.length > 0);
  tree.refresh();
  updateStatusBar();
  if (resumePanel) renderResume();
  if (boardPanel) renderBoard();
}

function activeStp() {
  return cache.list.find((stp) => stp.active) ?? (cache.list.length === 1 ? cache.list[0] : undefined);
}

function activeState() {
  const stp = activeStp();
  return stp ? cache.states.get(stp.id) : undefined;
}

function liveItems(state, kinds) {
  return (state?.items ?? []).filter((item) => !item.supersededBy && (!kinds || kinds.includes(item.kind)));
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 250);
}

// ---------- tree ----------

class StpTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getTreeItem(node) { return node.item; }
  getChildren(node) {
    if (!node) {
      return cache.list.map((stp) => {
        const item = new vscode.TreeItem(`${stp.id} · ${stp.title}`, stp.active || cache.list.length === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${stp.active ? "● " : ""}${stp.stage}${stp.uncoveredGaps ? ` · ${stp.uncoveredGaps} uncovered` : ""}`;
        item.tooltip = `${stp.file}\n${stp.entries} entries · ${stp.openCount} open${stp.issues ? ` · ${stp.issues} issues` : ""}`;
        item.iconPath = new vscode.ThemeIcon(stp.issues ? "warning" : "compass", stp.active ? new vscode.ThemeColor("charts.blue") : undefined);
        item.contextValue = stp.active ? "stp.active" : "stp";
        return { type: "stp", id: stp.id, item };
      });
    }
    if (node.type === "stp") {
      const state = cache.states.get(node.id);
      if (!state) return [];
      const nodes = SECTIONS.map((section) => {
        const items = liveItems(state).filter((entry) => KIND_META[entry.kind].section === section);
        if (section === "Notes" && items.length === 0) return undefined;
        const item = new vscode.TreeItem(section, items.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        const uncovered = section === "Gaps" ? state.uncoveredGaps.length : 0;
        item.description = items.length ? `${items.length}${uncovered ? ` · ${uncovered} uncovered` : ""}` : "empty";
        item.iconPath = new vscode.ThemeIcon({ Situation: "eye", Target: "target", Gaps: "debug-disconnect", Proposal: "git-pull-request", Notes: "note" }[section]);
        item.contextValue = `stpSection.${section}`;
        return { type: "section", id: node.id, section, item };
      }).filter(Boolean);
      if (state.issues.length) {
        const item = new vscode.TreeItem(`Issues (${state.issues.length})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
        nodes.push({ type: "issues", id: node.id, item });
      }
      return nodes;
    }
    if (node.type === "issues") {
      return cache.states.get(node.id).issues.map((issue) => {
        const item = new vscode.TreeItem(issue);
        item.iconPath = new vscode.ThemeIcon("circle-small-filled");
        return { type: "issue", item };
      });
    }
    if (node.type === "section") {
      const state = cache.states.get(node.id);
      return liveItems(state).filter((entry) => KIND_META[entry.kind].section === node.section).map((entry) => {
        const item = new vscode.TreeItem(`${entry.ref}  ${entry.text.replace(/\s+/g, " ")}`);
        const uncovered = entry.kind === "gap" && state.uncoveredGaps.includes(entry.ref);
        const links = [entry.closes.length && `closes ${entry.closes.join(", ")}`, entry.targets.length && `→ ${entry.targets.join(", ")}`, entry.gaps.length && `gaps ${entry.gaps.join(", ")}`].filter(Boolean).join(" · ");
        item.description = [entry.status, uncovered && "no change closes this", links, entry.supersedes && `revises ${entry.supersedes}`].filter(Boolean).join(" · ");
        const icon = entry.kind === "change" ? STATUS_ICONS[entry.status] : uncovered ? "warning" : KIND_META[entry.kind].icon;
        item.iconPath = new vscode.ThemeIcon(icon, uncovered ? new vscode.ThemeColor("list.warningForeground") : entry.status === "Approved" || entry.status === "Verified" ? new vscode.ThemeColor("testing.iconPassed") : undefined);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${entry.ref}** · ${KIND_META[entry.kind].label}${entry.status ? ` · ${entry.status}` : ""}\n\n`);
        tooltip.appendText(entry.text);
        if (entry.evidence.length) tooltip.appendMarkdown(`\n\n**Evidence:** ${entry.evidence.map((e) => `\`${e}\``).join(", ")}`);
        tooltip.appendMarkdown(`\n\n${entry.utc} by ${entry.actor}`);
        item.tooltip = tooltip;
        item.contextValue = `stpItem.${entry.kind}${entry.status ? `.${entry.status}` : ""}`;
        item.command = { command: "aegisStp.revealEntry", title: "Open entry", arguments: [state.file, entry.line] };
        return { type: "item", id: node.id, ref: entry.ref, entry, item };
      });
    }
    return [];
  }
}

const tree = new StpTree();

// ---------- status bar ----------

let statusBar;
function updateStatusBar() {
  const stp = activeStp();
  if (!stp) {
    statusBar.text = "$(compass) STP";
    statusBar.tooltip = cache.root ? "No active STP. Click to open one." : "Open a folder to use STP.";
    statusBar.command = "aegisStp.new";
  } else {
    const next = cache.resume?.next;
    statusBar.text = `$(compass) ${stp.id} · ${stp.stage}${stp.uncoveredGaps ? ` $(warning)${stp.uncoveredGaps}` : ""}`;
    statusBar.tooltip = `${stp.title}\nStage: ${stp.stage}\nNext: ${next ? `${next.ref ? `${next.ref} ` : ""}${next.reason}` : "nothing open"}\n\nClick for the resume card.`;
    statusBar.command = "aegisStp.resume";
  }
  statusBar.show();
}

// ---------- webviews ----------

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pageShell(title, nonce, body, script = "") {
  return `<!doctype html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${escapeHtml(title)}</title>
<style>
  body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 16px 20px; line-height: 1.45; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 2px; }
  h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 22px 0 8px; font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.85em; }
  .card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; padding: 8px 10px; margin: 6px 0; background: var(--vscode-editorWidget-background); }
  .card.next { border-color: var(--vscode-focusBorder); border-width: 2px; }
  .card.warn { border-color: var(--vscode-editorWarning-foreground); }
  .card.ok { border-left: 3px solid var(--vscode-testing-iconPassed); }
  .ref { font-weight: 600; font-family: var(--vscode-editor-font-family); cursor: pointer; text-decoration: underline dotted; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; border-radius: 3px; cursor: pointer; margin: 2px 4px 2px 0; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .stages { display: flex; gap: 4px; flex-wrap: wrap; margin: 10px 0 0; }
  .stage { padding: 2px 8px; border-radius: 3px; font-size: 0.85em; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); color: var(--vscode-descriptionForeground); }
  .stage.done { color: var(--vscode-foreground); }
  .stage.now { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  ul { padding-left: 18px; margin: 4px 0; }
</style></head>
<body>${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (target) vscode.postMessage({ action: target.dataset.action, ref: target.dataset.ref });
  });
  ${script}
</script></body></html>`;
}

function stageStrip(stage) {
  const index = STAGES.indexOf(stage);
  return `<div class="stages">${STAGES.map((name, i) => `<span class="stage ${i < index ? "done" : ""} ${i === index ? "now" : ""}">${name}</span>`).join("")}</div>`;
}

function refLink(ref) {
  return `<span class="ref" data-action="reveal" data-ref="${escapeHtml(ref)}">${escapeHtml(ref)}</span>`;
}

let resumePanel;
function renderResume() {
  const card = cache.resume;
  const nonce = crypto.randomBytes(16).toString("hex");
  if (!card) {
    resumePanel.webview.html = pageShell("STP Resume", nonce, `<h1>No active STP</h1><p class="sub">Open an STP to get a return point here.</p><button data-action="new">Open a new STP</button>`);
    return;
  }
  const nextActions = (next) => {
    if (!next?.ref) return "";
    const item = liveItems(activeState()).find((entry) => entry.ref === next.ref);
    if (!item) return "";
    if (item.kind === "gap") return `<button data-action="propose" data-ref="${item.ref}">Propose a change for ${item.ref}</button>`;
    if (item.status === "Drafted") return `<button data-action="present" data-ref="${item.ref}">Present ${item.ref}</button>`;
    if (item.status === "Presented") return `<button data-action="approve" data-ref="${item.ref}">Approve ${item.ref} as Architect</button><button class="secondary" data-action="supersede" data-ref="${item.ref}">Revise</button><button class="secondary" data-action="decline" data-ref="${item.ref}">Decline</button>`;
    if (item.status === "Approved") return `<button data-action="execute" data-ref="${item.ref}">Start executing ${item.ref}</button>`;
    if (item.status === "Executing") return `<button data-action="verify" data-ref="${item.ref}">Verify ${item.ref} as Architect</button>`;
    return "";
  };
  const firstStep = (reason) => reason.startsWith("Record the first Situation") ? "addFinding" : reason.startsWith("Record the Target") ? "addTarget" : reason.startsWith("Name the gaps") ? "addGap" : undefined;
  const next = card.next;
  const nextHtml = next
    ? `<div class="card next">${next.ref ? `${refLink(next.ref)} · ` : ""}<strong>${escapeHtml(next.reason)}</strong>${next.text ? `<div>${escapeHtml(next.text)}</div>` : ""}<div style="margin-top:6px">${nextActions(next)}${!next.ref && firstStep(next.reason) ? `<button data-action="${firstStep(next.reason)}">Do it now</button>` : ""}</div></div>`
    : `<div class="card ok">Nothing open.</div>`;
  const body = `
    <h1>${escapeHtml(card.id)} · ${escapeHtml(card.title)}</h1>
    <div class="sub">${escapeHtml(card.file)}</div>
    ${stageStrip(card.stage)}
    <h2>Where you stopped</h2>
    ${card.stoppedAt ? `<div class="card"><div class="meta">${escapeHtml(card.stoppedAt.utc)} · ${escapeHtml(card.stoppedAt.actor)}</div>${escapeHtml(card.stoppedAt.what)} <span class="ref" data-action="revealLine" data-ref="${card.stoppedAt.line}">open</span></div>` : `<div class="card">No entries yet.</div>`}
    <h2>Next open item</h2>
    ${nextHtml}
    <h2>Decided (${card.decided.length})</h2>
    ${card.decided.length ? card.decided.map((item) => `<div class="card ok">${refLink(item.ref)}${item.status ? ` <span class="pill">${escapeHtml(item.status)}</span>` : ""} ${escapeHtml(item.text)}</div>`).join("") : `<div class="sub">Nothing decided yet.</div>`}
    ${card.open.length > 1 ? `<h2>Also open (${card.open.length - 1})</h2><ul>${card.open.slice(1).map((item) => `<li>${item.ref ? `${refLink(item.ref)} ` : ""}${escapeHtml(item.reason)}${item.text ? ` <span class="meta">— ${escapeHtml(item.text)}</span>` : ""}</li>`).join("")}</ul>` : ""}
    <h2>Record</h2>
    <div class="meta">${Object.entries(card.counts).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(" · ") || "empty"}</div>
    ${card.issues.length ? `<div class="card warn"><strong>${card.issues.length} issue(s)</strong><ul>${card.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul></div>` : ""}
    <div style="margin-top:16px">
      <button data-action="board">Open board</button>
      <button class="secondary" data-action="addFinding">Add finding</button>
      <button class="secondary" data-action="addGap">Add gap</button>
      <button class="secondary" data-action="propose">Propose change</button>
      <button class="secondary" data-action="setStage">Change stage</button>
      <button class="secondary" data-action="openFile">Open file</button>
    </div>`;
  resumePanel.webview.html = pageShell(`${card.id} Resume`, nonce, body);
}

let boardPanel;
function renderBoard() {
  const state = activeState();
  const nonce = crypto.randomBytes(16).toString("hex");
  if (!state) {
    boardPanel.webview.html = pageShell("STP Board", nonce, `<h1>No active STP</h1>`);
    return;
  }
  const cardHtml = (item) => {
    const uncovered = item.kind === "gap" && state.uncoveredGaps.includes(item.ref);
    const cls = uncovered ? "warn" : item.status === "Approved" || item.status === "Verified" ? "ok" : "";
    const links = item.kind === "change" ? item.closes : item.kind === "gap" || item.kind === "milestone" ? [...item.targets, ...item.gaps] : [];
    return `<div class="card ${cls}" data-ref="${item.ref}" data-links="${links.join(",")}">
      ${refLink(item.ref)} ${item.status ? `<span class="pill">${escapeHtml(item.status)}</span>` : ""}${item.kind === "milestone" ? ` <span class="pill">milestone</span>` : ""}${item.kind === "decision" ? ` <span class="pill">decision</span>` : ""}
      <div>${escapeHtml(item.text)}</div>
      ${item.evidence.length ? `<div class="meta">${item.evidence.map(escapeHtml).join(" · ")}</div>` : ""}
      ${uncovered ? `<div class="meta">No change closes this gap. <span class="ref" data-action="propose" data-ref="${item.ref}">Propose one</span></div>` : ""}
    </div>`;
  };
  const column = (title, kinds, action) => `<div class="col"><h2>${title}</h2>${liveItems(state, kinds).map(cardHtml).join("") || `<div class="sub">empty</div>`}<button class="secondary" data-action="${action}">+ Add</button></div>`;
  const body = `
    <h1>${escapeHtml(state.id)} · ${escapeHtml(state.title)}</h1>
    ${stageStrip(state.stage)}
    <p class="meta">Lines run from each gap to the Target items it concerns, and from each proposed change to the gaps it closes. Gaps outlined in amber have no change closing them.</p>
    <div id="board">
      <svg id="lines"></svg>
      ${column("Situation", ["finding"], "addFinding")}
      ${column("Target", ["target", "milestone"], "addTarget")}
      ${column("Gaps", ["gap"], "addGap")}
      ${column("Proposal", ["change", "decision"], "propose")}
    </div>
    <style>
      #board { position: relative; display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 28px; align-items: start; }
      #lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
      .col { position: relative; z-index: 1; }
    </style>`;
  const script = `
    function draw() {
      const board = document.getElementById("board");
      const svg = document.getElementById("lines");
      const box = board.getBoundingClientRect();
      svg.innerHTML = "";
      const color = getComputedStyle(document.body).getPropertyValue("--vscode-focusBorder") || "#888";
      for (const card of board.querySelectorAll(".card[data-links]")) {
        for (const ref of card.dataset.links.split(",").filter(Boolean)) {
          const other = board.querySelector('.card[data-ref="' + ref + '"]');
          if (!other) continue;
          const a = card.getBoundingClientRect(), b = other.getBoundingClientRect();
          const leftToRight = b.left < a.left;
          const x1 = (leftToRight ? a.left : a.right) - box.left, y1 = a.top + a.height / 2 - box.top;
          const x2 = (leftToRight ? b.right : b.left) - box.left, y2 = b.top + b.height / 2 - box.top;
          const mid = (x1 + x2) / 2;
          const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
          p.setAttribute("d", "M" + x1 + "," + y1 + " C" + mid + "," + y1 + " " + mid + "," + y2 + " " + x2 + "," + y2);
          p.setAttribute("fill", "none"); p.setAttribute("stroke", color); p.setAttribute("stroke-width", "1.5"); p.setAttribute("opacity", "0.7");
          svg.appendChild(p);
        }
      }
    }
    window.addEventListener("resize", draw);
    requestAnimationFrame(draw);`;
  boardPanel.webview.html = pageShell(`${state.id} Board`, nonce, body, script);
}

function handleWebviewMessage(message) {
  const ref = message.ref;
  switch (message.action) {
    case "reveal": return revealRef(ref);
    case "revealLine": return revealEntry(activeState()?.file, Number(ref));
    case "board": return vscode.commands.executeCommand("aegisStp.board");
    case "openFile": return vscode.commands.executeCommand("aegisStp.openFile");
    case "propose": return vscode.commands.executeCommand("aegisStp.propose", ref ? { ref } : undefined);
    case "present": case "approve": case "execute": case "verify": case "decline": case "supersede":
      return vscode.commands.executeCommand(`aegisStp.${message.action}`, ref ? { ref } : undefined);
    default:
      return vscode.commands.executeCommand(`aegisStp.${message.action}`);
  }
}

function showPanel(kind) {
  const existing = kind === "resume" ? resumePanel : boardPanel;
  if (existing) {
    existing.reveal();
    return kind === "resume" ? renderResume() : renderBoard();
  }
  const panel = vscode.window.createWebviewPanel(`aegisStp.${kind}`, kind === "resume" ? "STP Resume" : "STP Board", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
  panel.webview.onDidReceiveMessage((message) => Promise.resolve(handleWebviewMessage(message)).catch(showError));
  panel.onDidDispose(() => { if (kind === "resume") resumePanel = undefined; else boardPanel = undefined; });
  if (kind === "resume") { resumePanel = panel; renderResume(); } else { boardPanel = panel; renderBoard(); }
}

// ---------- navigation ----------

async function revealEntry(file, line) {
  if (!file) return;
  const absolute = path.isAbsolute(file) ? file : path.join(repoRoot(), file);
  const document = await vscode.workspace.openTextDocument(absolute);
  const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function revealRef(ref) {
  const state = activeState();
  const item = state?.items.find((entry) => entry.ref === ref);
  if (item) await revealEntry(state.file, item.line);
}

// ---------- prompts ----------

function showError(error) {
  vscode.window.showErrorMessage(`STP: ${error.message}`);
}

function requireActive() {
  const state = activeState();
  if (!state) throw new Error("No active STP. Open one first (STP: New) or pick one (STP: Use).");
  return state;
}

async function askText(prompt, value = "") {
  const text = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, validateInput: (input) => input.trim() ? undefined : "Text is required" });
  return text?.trim();
}

async function pickRefs(items, title, { canPickMany = true, preselect = [] } = {}) {
  if (items.length === 0) return [];
  const picks = items.map((item) => ({ label: item.ref, description: item.status ?? "", detail: item.text, picked: preselect.includes(item.ref), ref: item.ref }));
  const chosen = await vscode.window.showQuickPick(picks, { title, canPickMany, ignoreFocusOut: true, matchOnDetail: true });
  if (chosen === undefined) return undefined;
  return (Array.isArray(chosen) ? chosen : [chosen]).map((pick) => pick.ref);
}

/** Resolves the item a command acts on: from a tree node, a webview argument, or a quick pick. */
async function targetRef(arg, filter, title) {
  if (arg?.ref) return arg.ref;
  const state = requireActive();
  const candidates = liveItems(state).filter(filter);
  if (candidates.length === 0) throw new Error(`Nothing to ${title.toLowerCase()} right now.`);
  const refs = await pickRefs(candidates, title, { canPickMany: false });
  return refs?.[0];
}

function selectionCitation(editor = vscode.window.activeTextEditor, range) {
  if (!editor || editor.document.uri.scheme !== "file") return "";
  const root = repoRoot();
  const relative = path.relative(root, editor.document.uri.fsPath).replace(/\\/g, "/");
  if (relative.startsWith("..")) return "";
  const selection = range ?? editor.selection;
  const start = selection.start.line + 1;
  let end = selection.end.line + 1;
  if (selection.end.character === 0 && end > start) end -= 1;
  return start === end ? `${relative}:${start}` : `${relative}:${start}-${end}`;
}

async function writeAndReport(args, message) {
  const result = await run(args, { write: true });
  await reload();
  const totemLine = result.split(/\r?\n/).find((line) => /Totem/.test(line));
  vscode.window.setStatusBarMessage(`$(check) ${message ?? result.split(/\r?\n/)[0]}`, 4000);
  if (totemLine && /failed|not found/i.test(totemLine)) vscode.window.showWarningMessage(`STP: ${totemLine}`);
  return result;
}

function stpArgs() {
  const stp = activeStp();
  return stp ? ["--stp", stp.id] : [];
}

// ---------- commands ----------

const commands = {
  async refresh() { await reload(); },

  async new() {
    const title = await askText("Title for the new STP (one review area, e.g. 'UI Flow and Design')");
    if (!title) return;
    await writeAndReport(["new", title], `Opened STP: ${title}`);
    showPanel("resume");
  },

  async use(arg) {
    let id = arg?.id;
    if (!id) {
      const pick = await vscode.window.showQuickPick(cache.list.map((stp) => ({ label: stp.id, description: stp.stage, detail: stp.title, id: stp.id })), { title: "Make an STP active" });
      id = pick?.id;
    }
    if (!id) return;
    await run(["use", id]);
    await reload();
  },

  async resume() { await reload(); showPanel("resume"); },
  async board() { await reload(); showPanel("board"); },

  async openFile(arg) {
    const id = arg?.id ?? activeStp()?.id;
    const state = id ? cache.states.get(id) : undefined;
    if (state) await revealEntry(state.file, 1);
  },

  async revealEntry(file, line) { await revealEntry(file, line); },

  async validate() {
    const result = await runJson(["validate", "--all"]);
    if (result.ok) vscode.window.showInformationMessage(`STP: ${result.results.length} file(s) valid; hash chains intact.`);
    else {
      output.show(true);
      output.appendLine(result.results.filter((r) => r.errors.length).map((r) => `✗ ${r.file}\n  ${r.errors.join("\n  ")}`).join("\n"));
      vscode.window.showErrorMessage("STP: validation found problems. See the AEGIS STP output.");
    }
  },

  async addFinding(arg) {
    requireActive();
    const text = await askText("Situation finding: what is true now?");
    if (!text) return;
    const evidence = await vscode.window.showInputBox({
      prompt: "Evidence (separate several with ;): path:line[-line], commit:<sha>, URL, totem:<path>, or assumption",
      value: arg?.citation ?? selectionCitation(),
      ignoreFocusOut: true,
      validateInput: (input) => input.trim() ? undefined : "A finding needs evidence; write \"assumption\" if it is one"
    });
    if (!evidence) return;
    const args = ["finding", ...stpArgs(), "-m", text];
    for (const citation of evidence.split(";").map((part) => part.trim()).filter(Boolean)) args.push("-e", citation);
    await writeAndReport(args);
  },

  async citeSelection(uri, range) {
    const editor = vscode.window.activeTextEditor;
    const citation = uri && range ? selectionCitation({ document: { uri }, selection: range }, range) : selectionCitation(editor);
    if (!citation) throw new Error("Select lines in a file inside the workspace to cite them.");
    await commands.addFinding({ citation });
  },

  async addTarget() {
    requireActive();
    const text = await askText("Target item: part of the whole ideal (never a milestone)");
    if (text) await writeAndReport(["target", ...stpArgs(), "-m", text]);
  },

  async addMilestone() {
    const state = requireActive();
    const text = await askText("Milestone: a scoped slice that points back to the Target");
    if (!text) return;
    const targets = await pickRefs(liveItems(state, ["target"]), "Target items this milestone selects");
    if (targets === undefined) return;
    const gaps = await pickRefs(liveItems(state, ["gap"]), "Gaps this milestone selects");
    if (gaps === undefined) return;
    const args = ["milestone", ...stpArgs(), "-m", text];
    if (targets.length) args.push("--targets", targets.join(","));
    if (gaps.length) args.push("--gaps", gaps.join(","));
    await writeAndReport(args);
  },

  async addGap() {
    const state = requireActive();
    const text = await askText("Gap: what separates the Situation from the Target?");
    if (!text) return;
    const targets = await pickRefs(liveItems(state, ["target"]), "Target items this gap concerns");
    if (targets === undefined) return;
    const args = ["gap", ...stpArgs(), "-m", text];
    if (targets.length) args.push("--targets", targets.join(","));
    await writeAndReport(args);
  },

  async propose(arg) {
    const state = requireActive();
    const gaps = liveItems(state, ["gap"]);
    if (gaps.length === 0) throw new Error("Name a gap first; every proposed change says which gaps it closes.");
    const ordered = [...gaps].sort((a, b) => Number(!state.uncoveredGaps.includes(a.ref)) - Number(!state.uncoveredGaps.includes(b.ref)));
    const closes = arg?.ref ? [arg.ref] : await pickRefs(ordered.map((gap) => ({ ...gap, status: state.uncoveredGaps.includes(gap.ref) ? "uncovered" : "" })), "Gaps this change closes");
    if (!closes?.length) return;
    const text = await askText(`Proposed change (closes ${closes.join(", ")}). Drafting is not approval.`);
    if (text) await writeAndReport(["propose", ...stpArgs(), "-m", text, "--closes", closes.join(",")]);
  },

  async addDecision() {
    requireActive();
    const text = await askText("Decision: what was settled, and the reason");
    if (text) await writeAndReport(["decision", ...stpArgs(), "-m", text]);
  },

  async addNote() {
    requireActive();
    const text = await askText("Note");
    if (text) await writeAndReport(["note", ...stpArgs(), "-m", text]);
  },

  async present(arg) {
    const ref = await targetRef(arg, (item) => item.kind === "change" && item.status === "Drafted", "Present");
    if (ref) await writeAndReport(["present", ...stpArgs(), ref], `${ref} presented; awaiting the Architect`);
  },

  async approve(arg) { await architectMove(arg, "approve", "Approved", (item) => item.status === "Presented"); },
  async verify(arg) { await architectMove(arg, "verify", "Verified", (item) => item.status === "Executing"); },

  async execute(arg) {
    const ref = await targetRef(arg, (item) => item.kind === "change" && item.status === "Approved", "Execute");
    if (ref) await writeAndReport(["execute", ...stpArgs(), ref], `${ref} executing`);
  },

  async decline(arg) {
    const ref = await targetRef(arg, (item) => item.kind === "change" && ["Drafted", "Presented", "Approved"].includes(item.status), "Decline");
    if (!ref) return;
    const reason = await vscode.window.showInputBox({ prompt: `Why is ${ref} declined? (optional)`, ignoreFocusOut: true });
    if (reason === undefined) return;
    await writeAndReport(["decline", ...stpArgs(), ref, ...(reason.trim() ? ["-m", reason.trim()] : [])], `${ref} declined`);
  },

  async supersede(arg) {
    const ref = await targetRef(arg, (item) => !(item.kind === "change" && ["Verified", "Declined"].includes(item.status)), "Revise");
    if (!ref) return;
    const item = liveItems(activeState()).find((entry) => entry.ref === ref);
    const text = await askText(`Revision of ${ref}. The earlier entry stays in the record.`, item?.text ?? "");
    if (!text) return;
    await writeAndReport(["supersede", ...stpArgs(), ref, "-m", text]);
  },

  async showLineage(arg) {
    const ref = await targetRef(arg, () => true, "Show lineage of");
    if (!ref) return;
    const textOut = await run(["show", ...stpArgs(), ref]);
    const document = await vscode.workspace.openTextDocument({ content: `Lineage of ${ref}\n\n${textOut}\n`, language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  },

  async setStage() {
    const state = requireActive();
    const pick = await vscode.window.showQuickPick(STAGES.filter((stage) => stage !== state.stage).map((stage) => ({ label: stage, description: STAGES.indexOf(stage) < STAGES.indexOf(state.stage) ? "back" : "" })), { title: `Stage (now ${state.stage})` });
    if (pick) await writeAndReport(["stage", ...stpArgs(), pick.label], `Stage: ${pick.label}`);
  },

  async distill(arg) {
    const ref = await targetRef(arg, (item) => item.kind === "decision" || (item.kind === "change" && ["Approved", "Executing", "Verified"].includes(item.status)), "Distill");
    if (!ref) return;
    const folder = await vscode.window.showInputBox({ prompt: `Folder Totem to receive ${ref} (repo-relative folder, e.g. src/ui)`, ignoreFocusOut: true, validateInput: (v) => v.trim() ? undefined : "Folder is required" });
    if (!folder) return;
    await writeAndReport(["distill", ...stpArgs(), ref, "--folder", folder.trim()], `Distilled ${ref} into ${folder.trim()}`);
  },

  async copyMcpConfig() {
    const root = repoRoot();
    const snippet = JSON.stringify({ mcpServers: { "aegis-stp": { command: "aegis-stp-mcp", env: { AEGIS_REPO_ROOT: root } } } }, null, 2);
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage("STP: MCP config copied. It needs the CLI installed globally (npm install -g aegis-stp).");
  }
};

async function architectMove(arg, verb, status, filter) {
  const ref = await targetRef(arg, (item) => item.kind === "change" && filter(item), verb[0].toUpperCase() + verb.slice(1));
  if (!ref) return;
  const item = liveItems(activeState()).find((entry) => entry.ref === ref);
  const configured = vscode.workspace.getConfiguration("aegisStp").get("actor");
  const name = await vscode.window.showInputBox({
    title: `Record ${status} for ${ref} as Architect`,
    prompt: `${item?.text ?? ""}\n\nYour name as Architect. This is a separate, attributed act.`,
    value: configured || os.userInfo().username,
    ignoreFocusOut: true,
    validateInput: (v) => v.trim() ? undefined : "The Architect must be named"
  });
  if (!name) return;
  const confirm = await vscode.window.showWarningMessage(`Record ${ref} as ${status} by ${name.trim()}?`, { modal: true, detail: item?.text }, status === "Approved" ? "Approve" : "Verify");
  if (!confirm) return;
  await writeAndReport([verb, ...stpArgs(), ref, "--as", name.trim()], `${ref} ${status} by ${name.trim()}`);
}

// ---------- activation ----------

class CiteSelectionProvider {
  provideCodeActions(document, range) {
    if (range.isEmpty || document.uri.scheme !== "file") return [];
    const action = new vscode.CodeAction("STP: Cite selection as Situation evidence", vscode.CodeActionKind.Empty);
    action.command = { command: "aegisStp.citeSelection", title: "Cite selection", arguments: [document.uri, range] };
    return [action];
  }
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel("AEGIS STP");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerTreeDataProvider("aegisStpView", tree),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new CiteSelectionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.Empty] })
  );
  for (const [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`aegisStp.${name}`, async (...args) => {
      try { await handler(...args); } catch (error) { showError(error); }
    }));
  }

  const watcher = vscode.workspace.createFileSystemWatcher("**/.aegis/stp/**");
  watcher.onDidChange(scheduleReload);
  watcher.onDidCreate(scheduleReload);
  watcher.onDidDelete(scheduleReload);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleReload),
    vscode.window.onDidChangeActiveTextEditor(() => { if (repoRoot() !== cache.root) scheduleReload(); })
  );

  reload();
}

function deactivate() {}

module.exports = { activate, deactivate };
