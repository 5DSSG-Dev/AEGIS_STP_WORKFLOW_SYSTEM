// Bundles the built CLI into the extension (so it works before npm publication) and packages a VSIX.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outDir = join(root, "dist");
const extensionDir = join(root, "vscode-extension");
const version = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8")).version;
const packagePath = join(outDir, `aegis-stp-vscode-${version}.vsix`);
const vsceBin = join(root, "node_modules", "@vscode", "vsce", "vsce");
const bundledCliDir = join(extensionDir, "cli-dist");

mkdirSync(outDir, { recursive: true });
rmSync(bundledCliDir, { recursive: true, force: true });
cpSync(join(root, "dist", "src"), join(bundledCliDir, "src"), { recursive: true });
// The MCP server needs the MCP SDK; agents run it from the npm install instead.
rmSync(join(bundledCliDir, "src", "mcp-server.js"), { force: true });
writeFileSync(join(bundledCliDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
mkdirSync(join(bundledCliDir, "node_modules"), { recursive: true });
cpSync(join(root, "node_modules", "commander"), join(bundledCliDir, "node_modules", "commander"), { recursive: true });

const result = spawnSync(process.execPath, [vsceBin, "package", "--no-dependencies", "--out", packagePath], { cwd: extensionDir, stdio: "inherit", shell: false });
rmSync(bundledCliDir, { recursive: true, force: true });
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`VSIX: ${packagePath}`);
