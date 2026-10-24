// Same append law and hash chain as AEGIS Totem (src/fs/append.ts), so STP files
// and Totems validate the same way and one reader understands both.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";

const lockWaitMs = 10;
const lockTimeoutMs = 5000;
const staleLockMs = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(target: string): Promise<string> {
  const lockPath = `${target}.lock`;
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      return lockPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > staleLockMs) await rm(lockPath, { recursive: true, force: true });
      } catch {
        // Another writer may be replacing the lock; retry until the bounded timeout.
      }
      if (Date.now() - started >= lockTimeoutMs) throw new Error(`Timed out waiting to append: ${target}`);
      await sleep(lockWaitMs);
    }
  }
}

export async function withLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const lockPath = await acquireLock(target);
  try {
    return await work();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export function hashEntry(previousHash: string, heading: string, body: string): string {
  return createHash("sha256").update(`${previousHash}\n${heading}\n${body}`, "utf8").digest("hex");
}

export function escapeEntryHeadings(body: string): string {
  return body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.startsWith("### ") ? `> ${line}` : line)
    .join("\n");
}

export function latestChainHash(content: string): string {
  const matches = [...content.matchAll(/^Chain-Hash:\s+([a-f0-9]{64})$/gmi)];
  return matches.at(-1)?.[1]?.toLowerCase() ?? "GENESIS";
}

function normalizeEntryBody(body: string): string {
  return `${body.replace(/(\r?\n)+$/, "")}\n`;
}

/**
 * Appends one chained entry. `prepare` runs inside the lock against the current
 * file content, so reference numbers and pre-append checks cannot race another writer.
 */
export async function appendChained(
  target: string,
  prepare: (existing: string) => { heading: string; body: string }
): Promise<{ heading: string; hash: string }> {
  return withLock(target, async () => {
    const existing = await readFile(target, "utf8");
    if (!existing.includes("## Append Log")) throw new Error(`${target} is missing an Append Log.`);
    const { heading, body } = prepare(existing);
    const previousHash = latestChainHash(existing);
    const safeBody = `${escapeEntryHeadings(body)}\n`;
    const entryHash = hashEntry(previousHash, heading, safeBody);
    await appendFile(target, `\n${heading}\nChain-Prev: ${previousHash}\nChain-Hash: ${entryHash}\n${safeBody}`, "utf8");
    return { heading, hash: entryHash };
  });
}

export function validateChainedEntries(content: string): string[] {
  const errors: string[] = [];
  const starts = [...content.matchAll(/^### .+$/gm)].map((match) => ({ index: match.index ?? 0, heading: match[0] }));
  let previousHash = "GENESIS";
  let chainStarted = false;

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const nextStart = starts[index + 1]?.index ?? content.length;
    const entry = content.slice(start.index, nextStart);
    const lines = entry.split(/\r?\n/);
    const previousLine = lines[1]?.match(/^Chain-Prev:\s+(.+)$/i);
    const hashLine = lines[2]?.match(/^Chain-Hash:\s+([a-f0-9]{64})$/i);

    if (!previousLine && !hashLine) {
      if (chainStarted) errors.push(`entry "${start.heading}" is missing chain metadata after the chain started`);
      continue;
    }
    chainStarted = true;
    if (!previousLine || !hashLine) {
      errors.push(`entry "${start.heading}" has incomplete chain metadata`);
      continue;
    }
    const declaredPrevious = previousLine[1].trim();
    const declaredHash = hashLine[1].toLowerCase();
    const body = normalizeEntryBody(lines.slice(3).join("\n"));
    const expectedHash = hashEntry(declaredPrevious, start.heading, body);
    if (declaredPrevious !== previousHash) errors.push(`entry "${start.heading}" links to ${declaredPrevious} but expected ${previousHash}`);
    if (declaredHash !== expectedHash) errors.push(`entry "${start.heading}" hash mismatch`);
    previousHash = declaredHash;
  }

  return errors;
}
