// Starts the MCP server against a throwaway repo and checks that agents can draft and present but not approve.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = mkdtempSync(join(tmpdir(), "stp-mcp-qa-"));
const cli = join(process.cwd(), "dist", "src", "cli.js");
const stp = (...args) => execFileSync(process.execPath, [cli, ...args, "--actor", "tracey", "--no-totem"], { cwd: repo, encoding: "utf8" });
const fail = (message) => { console.error(`mcp:qa FAILED: ${message}`); process.exitCode = 1; };

try {
  stp("new", "MCP QA");
  stp("target", "-m", "Agents share the record.");
  stp("gap", "-m", "No agent channel.", "--targets", "T1");

  const client = new Client({ name: "stp-mcp-qa", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist", "src", "mcp-server.js")], env: { ...process.env, AEGIS_REPO_ROOT: repo } }));
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["stp_resume", "stp_add_finding", "stp_draft_change", "stp_present"]) if (!tools.includes(name)) fail(`missing tool ${name}`);
  if (tools.some((name) => /approve|verify/.test(name))) fail("an approval tool is exposed over MCP");

  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  await call("stp_add_finding", { actor: "claude", text: "No MCP server existed.", evidence: ["assumption"] });
  await call("stp_draft_change", { actor: "claude", text: "Add an MCP server.", closes: ["G1"] });
  await call("stp_present", { actor: "claude", ref: "P1" });
  const resume = await call("stp_resume", {});
  if (!resume.includes("P1: Presented; awaiting the Architect")) fail(`resume did not show P1 awaiting approval:\n${resume}`);
  const validation = await call("stp_validate", {});
  if (!validation.startsWith("✓")) fail(`validation failed:\n${validation}`);
  await client.close();

  stp("approve", "P1", "--as", "tracey");
  if (!process.exitCode) console.log(`mcp:qa passed (${tools.length} tools; agent drafted and presented, Architect approved via CLI)`);
} finally {
  rmSync(repo, { recursive: true, force: true });
}
