import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ManagedPtyBroker, type ManagedPtyProcess } from "../managed-pty-broker.js";

test("Windows 的 claude.cmd 经系统命令解释器进入 PTY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-windows-pty-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  const listeners = new Set<(event: { exitCode: number }) => void>();
  const pty: ManagedPtyProcess = {
    pid: 1, write: () => {}, resize: () => {}, kill: () => { for (const listener of listeners) listener({ exitCode: 0 }); },
    onData: () => ({ dispose() {} }), onExit: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
  };
  const broker = new ManagedPtyBroker({
    sessionID: "session-one", cwd: dir, cliPath: "C:\\Program Files\\Claude\\claude.cmd", helperPath: "attach.js", dataDir: dir,
    platform: "win32", spawner: (command, args) => { calls.push({ command, args }); return pty; },
  });
  try {
    broker.launch();
    assert.equal(calls[0].command, process.env.ComSpec || "cmd.exe");
    assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(calls[0].args[3], '""C:\\Program Files\\Claude\\claude.cmd" --session-id session-one --permission-mode default"');
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows Terminal 缺失时使用系统控制台继续接入", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-windows-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launches: Array<{ command: string; args: string[]; child: EventEmitter }> = [];
  const listeners = new Set<(event: { exitCode: number }) => void>();
  const pty: ManagedPtyProcess = {
    pid: 2, write: () => {}, resize: () => {}, kill: () => { for (const listener of listeners) listener({ exitCode: 0 }); },
    onData: () => ({ dispose() {} }), onExit: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
  };
  const broker = new ManagedPtyBroker({
    sessionID: "windows-terminal", cwd: dir, cliPath: "claude.exe", helperPath: "attach.js", dataDir: dir,
    platform: "win32", attachTimeoutMs: 2000, spawner: () => pty,
    childSpawner: ((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { unref() {}, kill() {} });
      launches.push({ command, args, child });
      return child as ChildProcess;
    }) as never,
  });
  await broker.start();
  t.after(() => broker.close());
  const opening = broker.openManagedTerminal("windows-terminal");
  const handoff = JSON.parse(readFileSync(launches[0].args[3], "utf8")) as { host: string; port: number; token: string };
  launches[0].child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
  assert.equal(launches[1].command, "cmd.exe");
  assert.match(launches[1].args[3], /start ""/);
  const socket = createConnection({ host: handoff.host, port: handoff.port });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ type: "auth", token: handoff.token }) + "\n");
  await opening;
  socket.destroy();
});

test("native attach preserves terminal input bytes through the PTY lifecycle broker", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-broker-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writes: string[] = [];
  let spawned = 0;
  let handoffFile = "";
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const pty: ManagedPtyProcess = {
    pid: 4242, write: (value) => { writes.push(value); }, resize: () => {}, kill: () => { for (const listener of exitListeners) listener({ exitCode: 0 }); },
    onData: () => ({ dispose() {} }), onExit: (listener) => { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
  };
  const broker = new ManagedPtyBroker({
    sessionID: "native-1", cwd: dir, cliPath: "claude", helperPath: "attach.js", dataDir: dir,
    platform: "linux", attachTimeoutMs: 2000,
    spawner: () => { spawned++; return pty; },
    childSpawner: ((_command: string, args: string[]) => {
      handoffFile = args[3];
      return Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
    }) as never,
  });
  await broker.start();
  t.after(() => broker.close());
  await assert.rejects(broker.openManagedTerminal("other-native"), /managed_session_not_found/);
  const opening = broker.openManagedTerminal("native-1");
  const handoff = JSON.parse(readFileSync(handoffFile, "utf8")) as { host: string; port: number; token: string };
  assert.equal(handoff.host, "127.0.0.1");
  const socket = createConnection({ host: handoff.host, port: handoff.port });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ type: "auth", token: handoff.token }) + "\n");
  await new Promise<void>((resolve) => socket.once("data", () => resolve()));
  await opening;
  socket.write(JSON.stringify({ type: "input", data: Buffer.from("unfinished draft").toString("base64") }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(writes, ["unfinished draft"]);
  await assert.rejects(broker.openManagedTerminal("native-1"), /native_terminal_attach_timeout/);
  assert.equal(spawned, 1);
});

test("Claude workspace trust prompt disables remote send after PTY startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-trust-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let onData: ((data: string) => void) | undefined;
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const pty: ManagedPtyProcess = {
    pid: 4243, write: () => {}, resize: () => {}, kill: () => { for (const listener of exitListeners) listener({ exitCode: 0 }); },
    onData: (listener) => { onData = listener; return { dispose() {} }; },
    onExit: (listener) => { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
  };
  const broker = new ManagedPtyBroker({
    sessionID: "trust-test", cwd: dir, cliPath: "claude", helperPath: "attach.js", dataDir: dir,
    platform: "linux", spawner: () => pty,
  });
  await broker.start();
  t.after(() => broker.close());
  assert.equal(broker.snapshot().can_send, true);

  onData?.("Quick safety check: Is this a project you created or one you trust?\r\nYes, I trust this folder\r\nNo, exit");

  assert.equal(broker.snapshot().setup_required, true);
  assert.equal(broker.snapshot().can_send, false);
});
