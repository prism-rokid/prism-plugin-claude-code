import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ManagedSupervisor } from "../managed-supervisor.js";
import { ManagedSupervisorClient } from "../managed-supervisor-client.js";

test("supervisor keeps the same PTY while plugin-side controller reconnects", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-supervisor-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writes: string[] = [];
  let spawns = 0;
  let kills = 0;
  const transcriptRows: Array<{ type: string; timestamp: string; message: { content: Array<{ type: string; text: string }> } }> = [];
  const supervisor = new ManagedSupervisor({
    sessionID: "native-reconnect", cwd: dir, cliPath: "claude", helperPath: "attach.js", dataDir: dir,
    readTranscriptRows: async () => transcriptRows,
    platform: "linux", spawner: () => {
      spawns++;
      return {
        pid: 4242, write: (data: string) => { writes.push(data); }, resize: () => {}, kill: () => { kills++; },
        onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      };
    },
    childSpawner: ((_command: string, args: string[]) => {
      rmSync(dirname(args[3]), { recursive: true, force: true });
      return Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
    }) as never,
  });
  await supervisor.start();
  t.after(() => supervisor.close());
  const first = await ManagedSupervisorClient.connect(supervisor.descriptorPath);
  assert.equal(first.descriptor.session_id, "native-reconnect");
  const hookScript = fileURLToPath(new URL("../managed-hook.js", import.meta.url));
  async function invokeHook(event: Record<string, unknown>) {
    const hook = spawn(process.execPath, [hookScript, supervisor.descriptorPath], { stdio: ["pipe", "ignore", "pipe"] });
    hook.stdin.end(JSON.stringify({ session_id: "native-reconnect", ...event }));
    const exit = await new Promise<number | null>((resolve) => hook.once("exit", resolve));
    assert.equal(exit, 0);
  }
  await invokeHook({ hook_event_name: "SessionStart" });
  assert.equal((await first.send("panel-1", "hello")).status, "accepted");
  first.close(); // Simulate Hub/plugin process exiting; supervisor stays alive.
  assert.equal(kills, 0);
  const second = await ManagedSupervisorClient.connect(supervisor.descriptorPath);
  assert.equal((await second.send("panel-1", "hello")).status, "duplicate");
  assert.equal(spawns, 1);
  assert.deepEqual(writes, ["\x1b[200~hello\x1b[201~\r"]);
  await invokeHook({ hook_event_name: "UserPromptSubmit", prompt: "hello" });
  assert.equal(supervisor.broker.input.ledger.get("panel-1")?.state, "submitted");
  await invokeHook({ hook_event_name: "Stop" });
  assert.equal(supervisor.broker.input.ledger.get("panel-1")?.state, "completed");
  const settings = JSON.parse(readFileSync(join(dir, "prism-hooks-settings.json"), "utf8"));
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 120);
  async function permissionHook(): Promise<{ output: Promise<string>; exit: Promise<number | null> }> {
    const hook = spawn(process.execPath, [hookScript, supervisor.descriptorPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    hook.stdout.setEncoding("utf8");
    hook.stdout.on("data", (part: string) => { stdout += part; });
    hook.stdin.end(JSON.stringify({ session_id: "native-reconnect", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo safe" } }));
    const exit = new Promise<number | null>((resolve) => hook.once("exit", resolve));
    return { output: exit.then(() => stdout), exit };
  }
  const remotePermission = await permissionHook();
  let approval: Record<string, unknown> | null = null;
  for (let i = 0; i < 100; i++) {
    approval = await second.approval();
    if (approval) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(approval);
  assert.equal((await second.refresh()).can_approve, true);
  const approvalID = String(approval.approval_request_id);
  assert.equal((await second.approval())?.created_at, approval.created_at);
  await assert.rejects(second.resolveApproval("wrong-id", "allow_once"), /approval_stale/);
  await second.resolveApproval(approvalID, "deny");
  assert.equal(await remotePermission.exit, 0);
  assert.equal(JSON.parse(await remotePermission.output).hookSpecificOutput.decision.behavior, "deny");
  assert.equal(await second.approval(), null);
  await assert.rejects(second.resolveApproval(approvalID, "allow_once"), /approval_stale/);
  const allowedPermission = await permissionHook();
  for (let i = 0; i < 100 && !await second.approval(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const nextApproval = await second.approval();
  assert.ok(nextApproval);
  await second.resolveApproval(String(nextApproval.approval_request_id), "allow_once");
  assert.equal(await allowedPermission.exit, 0);
  assert.equal(JSON.parse(await allowedPermission.output).hookSpecificOutput.decision.behavior, "allow");
  await invokeHook({ hook_event_name: "Stop" });
  supervisor.broker.input.attachLocal();
  await supervisor.broker.input.localInput("\x1d");
  const localPermission = await permissionHook();
  assert.equal(await localPermission.exit, 0);
  assert.equal(await localPermission.output, "");
  assert.equal((await second.refresh()).can_approve, false);
  await invokeHook({ hook_event_name: "PermissionDenied" });
  await invokeHook({ hook_event_name: "Stop" });
  await supervisor.broker.input.localInput("\x1d");
  assert.equal((await second.send("panel-interrupt", "interrupt me")).status, "accepted");
  assert.equal((await second.refresh()).can_interrupt, true);
  assert.equal(await second.interrupt(), true);
  assert.equal(writes.at(-1), "\x03");
  assert.equal(supervisor.broker.input.ledger.get("panel-interrupt")?.state, "indeterminate");
  transcriptRows.push({ type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
  for (let i = 0; i < 100 && (await second.refresh()).can_interrupt; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await second.refresh()).can_interrupt, false);
  await assert.rejects(second.openTerminal("wrong-session"), /managed_session_not_found/);
  second.close();
});
