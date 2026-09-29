import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ManagedSupervisorClient } from "../managed-supervisor-client.js";

test("detached supervisor retains a real PTY across controller process disconnect", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-real-pty-"));
  const cli = join(dir, "fake-claude");
  writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('data', () => {});\n", { mode: 0o755 });
  chmodSync(cli, 0o755);
  const supervisorScript = fileURLToPath(new URL("../managed-supervisor.js", import.meta.url));
  const helperScript = fileURLToPath(new URL("../managed-terminal-client.js", import.meta.url));
  const child = spawn(process.execPath, [supervisorScript, "native-process", dir, cli, helperScript, dir], { detached: true, stdio: "ignore" });
  child.unref();
  t.after(async () => {
    if (child.pid) { try { process.kill(child.pid, "SIGTERM"); } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(dir, { recursive: true, force: true });
  });
  const descriptorPath = join(dir, "supervisor.json");
  for (let i = 0; i < 120 && !existsSync(descriptorPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(existsSync(descriptorPath), true, "detached supervisor should publish descriptor after PTY starts");
  const first = await ManagedSupervisorClient.connect(descriptorPath);
  const pid = first.descriptor.pid;
  assert.equal(first.snapshot()?.status, "starting");
  const hookScript = fileURLToPath(new URL("../managed-hook.js", import.meta.url));
  const startHook = spawn(process.execPath, [hookScript, descriptorPath], { stdio: ["pipe", "ignore", "pipe"] });
  startHook.stdin.end(JSON.stringify({ session_id: "native-process", hook_event_name: "SessionStart" }));
  assert.equal(await new Promise<number | null>((resolve) => startHook.once("exit", resolve)), 0);
  assert.equal((await first.refresh()).status, "detached");
  first.close();
  const offlineHook = spawn(process.execPath, [hookScript, descriptorPath], { stdio: ["pipe", "ignore", "pipe"] });
  offlineHook.stdin.end(JSON.stringify({ session_id: "native-process", hook_event_name: "MessageDisplay", message: "offline" }));
  assert.equal(await new Promise<number | null>((resolve) => offlineHook.once("exit", resolve)), 0);
  const replayed: Array<{ kind: unknown; id: string | undefined }> = [];
  const second = await ManagedSupervisorClient.connect(descriptorPath, undefined, (hook, id) => replayed.push({ kind: hook.hook_event_name, id }));
  assert.equal(second.descriptor.pid, pid);
  assert.equal(await second.replayHooks(), 1);
  assert.equal(replayed[0]?.kind, "MessageDisplay");
  assert.ok(replayed[0]?.id);
  assert.equal((await second.send("message-1", "hello")).status, "accepted");
  assert.equal((await second.send("message-1", "hello")).status, "duplicate");
  second.close();
});
