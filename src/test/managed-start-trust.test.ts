import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedClaudeAdapter } from "../managed-adapter.js";

test("Panel start in an untrusted directory reports trust requirement and stops its orphan supervisor", { skip: process.platform === "win32" }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), "prism-trust-start-"));
  const cwd = join(base, "project");
  const state = join(base, "managed");
  mkdirSync(cwd);
  const cli = join(base, "fake-claude");
  writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdout.write('Quick safety check: Is this a project you trust?\\r\\nNo, exit\\r\\nYes, I trust this folder\\r\\n'); process.stdin.resume();\n", { mode: 0o755 });
  chmodSync(cli, 0o755);
  const previous = process.env.PRISM_CLAUDE_CLI;
  process.env.PRISM_CLAUDE_CLI = cli;
  const adapter = new ManagedClaudeAdapter(state);
  t.after(async () => {
    await adapter.close();
    if (previous === undefined) delete process.env.PRISM_CLAUDE_CLI;
    else process.env.PRISM_CLAUDE_CLI = previous;
    rmSync(base, { recursive: true, force: true });
  });
  await assert.rejects(adapter.startSessionWithMessage({
    PluginID: "claudecode", Cwd: cwd, SourceDevice: "web", Metadata: {},
    Message: { PrismMessageID: "trust-message", Text: "hello", SourceDevice: "web", Timestamp: new Date().toISOString(), Metadata: {} },
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "workspace_trust_required");
  for (let i = 0; i < 50 && readdirSync(state).some((id) => existsSync(join(state, id, "supervisor.json"))); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(readdirSync(state).some((id) => existsSync(join(state, id, "supervisor.json"))), false);
});
