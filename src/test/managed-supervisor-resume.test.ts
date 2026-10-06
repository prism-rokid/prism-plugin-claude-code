import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedSupervisorManager } from "../managed-supervisor-manager.js";

test("a cleanly closed panel PTY owner is resumed with the same native transcript", { skip: process.platform === "win32" ? "POSIX CLI fixture; Windows terminal acceptance is separate" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-mod-resume-"));
  const oldManaged = process.env.PRISM_CLAUDE_MANAGED_DIR;
  const oldCLI = process.env.PRISM_CLAUDE_CLI;
  const log = join(root, "argv.jsonl");
  const cli = join(root, "claude-mock");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const manager = new ManagedSupervisorManager(join(root, "managed"));
  const ownedClients: Array<{ shutdown(): Promise<void> }> = [];
  try {
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CLAUDE_MOCK_ARGV, JSON.stringify(process.argv.slice(2)) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
    chmodSync(cli, 0o700);
    process.env.PRISM_CLAUDE_CLI = cli;
    process.env.CLAUDE_MOCK_ARGV = log;
    const { sessionID, client } = await manager.create(cwd);
    ownedClients.push(client);
    const launchDeadline = Date.now() + 3000;
    while (Date.now() < launchDeadline && !existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 20));
    const initial = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]) as string[];
    assert.deepEqual(initial.slice(0, 2), ["--session-id", sessionID]);
    await client.shutdown();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !manager.hasSafelyClosedState(sessionID)) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(manager.hasSafelyClosedState(sessionID), true);

    const resumed = await manager.resume(sessionID, cwd);
    ownedClients.push(resumed.client);
    const resumeDeadline = Date.now() + 3000;
    while (Date.now() < resumeDeadline && readFileSync(log, "utf8").trim().split("\n").length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1].slice(0, 2), ["--resume", sessionID]);
    await resumed.client.shutdown();
    const finalDeadline = Date.now() + 5000;
    while (Date.now() < finalDeadline && !manager.hasSafelyClosedState(sessionID)) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(manager.hasSafelyClosedState(sessionID), true);
  } finally {
    for (const client of ownedClients) await client.shutdown().catch(() => {});
    manager.close();
    if (oldManaged === undefined) delete process.env.PRISM_CLAUDE_MANAGED_DIR; else process.env.PRISM_CLAUDE_MANAGED_DIR = oldManaged;
    if (oldCLI === undefined) delete process.env.PRISM_CLAUDE_CLI; else process.env.PRISM_CLAUDE_CLI = oldCLI;
    delete process.env.CLAUDE_MOCK_ARGV;
    rmSync(root, { recursive: true, force: true });
  }
});
