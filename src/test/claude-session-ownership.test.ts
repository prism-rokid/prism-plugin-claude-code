import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeClaudeSessionPID } from "../claude-session-ownership.js";

test("legacy migration refuses a session with a live Claude registry owner", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-claude-ownership-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "live.json"), JSON.stringify({ sessionId: "session-live", pid: process.pid }));
  writeFileSync(join(dir, "stale.json"), JSON.stringify({ sessionId: "session-stale", pid: 2147483647 }));
  assert.equal(activeClaudeSessionPID("session-live", dir), process.pid);
  assert.equal(activeClaudeSessionPID("session-stale", dir), null);
  assert.equal(activeClaudeSessionPID("unknown", dir), null);
});
