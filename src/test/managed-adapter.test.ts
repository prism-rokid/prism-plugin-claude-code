import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ManagedClaudeAdapter } from "../managed-adapter.js";
import { ManagedSupervisor } from "../managed-supervisor.js";
import { ManagedSupervisorClient } from "../managed-supervisor-client.js";

test("managed adapter attaches the exact native supervisor and confirms Panel send through Claude hook", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "prism-managed-adapter-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionID = "550e8400-e29b-41d4-a716-446655440000";
  const dataDir = join(base, sessionID);
  mkdirSync(dataDir);
  const writes: string[] = [];
  const supervisor = new ManagedSupervisor({
    sessionID, cwd: base, cliPath: "claude", helperPath: "attach.js", dataDir,
    platform: "linux", spawner: () => ({
      pid: 4242, write: (data: string) => { writes.push(data); }, resize: () => {}, kill: () => {},
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    }),
    childSpawner: ((_command: string, args: string[]) => {
      rmSync(dirname(args[3]), { recursive: true, force: true });
      return Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
    }) as never,
  });
  await supervisor.start();
  t.after(() => supervisor.close());
  const hookScript = fileURLToPath(new URL("../managed-hook.js", import.meta.url));
  const startHook = spawn(process.execPath, [hookScript, supervisor.descriptorPath], { stdio: ["pipe", "ignore", "pipe"] });
  startHook.stdin.end(JSON.stringify({ session_id: sessionID, hook_event_name: "SessionStart" }));
  assert.equal(await new Promise<number | null>((resolve) => startHook.once("exit", resolve)), 0);
  const adapter = new ManagedClaudeAdapter(base);
  t.after(() => adapter.close());
  const hints = await adapter.listSessions();
  assert.equal(hints.length, 1);
  assert.equal(hints[0].NativeSessionID, sessionID);
  const native = await adapter.attachSession({ PluginID: "claudecode", PrismConversationID: "conversation-1", NativeSessionID: sessionID, NativeThreadID: sessionID, Cwd: base, SourceDevice: "web", Metadata: {} });
  assert.equal(native.NativeSessionID, sessionID);
  await assert.rejects(adapter.openManagedTerminal({ plugin_id: "claudecode", native_session_id: "550e8400-e29b-41d4-a716-446655440001" }), (error: unknown) => error instanceof Error && "code" in error && error.code === "managed_session_not_found");
  const pending = adapter.send(native, { PrismMessageID: "message-1", Text: "hello", SourceDevice: "web", Timestamp: new Date().toISOString(), Metadata: {} });
  for (let i = 0; i < 100 && writes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writes.length, 1);
  const hook = spawn(process.execPath, [hookScript, supervisor.descriptorPath], { stdio: ["pipe", "ignore", "pipe"] });
  hook.stdin.end(JSON.stringify({ session_id: sessionID, hook_event_name: "UserPromptSubmit", prompt: "hello" }));
  assert.equal(await new Promise<number | null>((resolve) => hook.once("exit", resolve)), 0);
  const receipt = await pending;
  assert.equal(receipt.Visible, true);
  assert.equal((await adapter.verifyVisibility(native, "message-1")).Visible, true);
  assert.deepEqual(writes, ["\x1b[200~hello\x1b[201~\r"]);
  const permission = spawn(process.execPath, [hookScript, supervisor.descriptorPath], { stdio: ["pipe", "pipe", "pipe"] });
  let permissionOutput = "";
  permission.stdout.setEncoding("utf8");
  permission.stdout.on("data", (part: string) => { permissionOutput += part; });
  permission.stdin.end(JSON.stringify({ session_id: sessionID, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "pwd" } }));
  let approval: Record<string, unknown> | null = null;
  for (let i = 0; i < 100; i++) {
    approval = (await adapter.readDetail(native)).approval as Record<string, unknown> | null;
    if (approval) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(approval);
  assert.equal((await adapter.readStatus(native, "")).approval_blocked, true);
  await adapter.resolveApproval({ PrismConversationID: "conversation-1", PluginID: "claudecode", Session: native, ApprovalRequestID: String(approval.approval_request_id), ActionID: "allow_once", SourceDevice: "web", Metadata: {} });
  assert.equal(await new Promise<number | null>((resolve) => permission.once("exit", resolve)), 0);
  assert.equal(JSON.parse(permissionOutput).hookSpecificOutput.decision.behavior, "allow");
  assert.equal((await adapter.readDetail(native)).approval, null);
});

test("a new plugin subscription receives the same durable Hook event ID after reconnect", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "prism-managed-replay-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sessionID = "550e8400-e29b-41d4-a716-446655440002";
  const dataDir = join(base, sessionID);
  mkdirSync(dataDir);
  const supervisor = new ManagedSupervisor({
    sessionID, cwd: base, cliPath: "claude", helperPath: "attach.js", dataDir,
    platform: "linux", spawner: () => ({
      pid: 4242, write: () => {}, resize: () => {}, kill: () => {},
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    }),
    childSpawner: ((_command: string, args: string[]) => {
      rmSync(dirname(args[3]), { recursive: true, force: true });
      return Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
    }) as never,
  });
  await supervisor.start();
  t.after(() => supervisor.close());
  await (supervisor as unknown as { handleHook(hook: Record<string, unknown>): Promise<unknown> }).handleHook({ session_id: sessionID, hook_event_name: "SessionStart" });
  await (supervisor as unknown as { handleHook(hook: Record<string, unknown>): Promise<unknown> }).handleHook({ session_id: sessionID, hook_event_name: "MessageDisplay", message: "offline content" });
  const native = { PluginID: "claudecode", NativeSessionID: sessionID, NativeThreadID: sessionID, Cwd: base, Surface: "claudecode-managed-pty", Endpoint: "", Visible: true };
  const readReplay = async () => {
    const adapter = new ManagedClaudeAdapter(base);
    const abort = new AbortController();
    try {
      const stream = adapter.subscribe(native, abort.signal)[Symbol.asyncIterator]();
      let replay: Awaited<ReturnType<typeof stream.next>> | undefined;
      for (let i = 0; i < 5; i++) {
        const entry = await stream.next();
        if (entry.value?.Type === "conversation.history.changed") { replay = entry; break; }
      }
      assert.ok(replay);
      abort.abort();
      await stream.return?.();
      return replay.value.ID;
    } finally { abort.abort(); await adapter.close(); }
  };
  const eventID = await readReplay();
  assert.equal(eventID, await readReplay());
  const acknowledger = new ManagedClaudeAdapter(base);
  await acknowledger.ackEvent(native, eventID);
  await acknowledger.close();
  const client = await ManagedSupervisorClient.connect(supervisor.descriptorPath);
  assert.equal(await client.replayHooks(), 0);
  client.close();
});
