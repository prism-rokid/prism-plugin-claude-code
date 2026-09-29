import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ManagedPtyBroker, type ManagedPtyProcess } from "../managed-pty-broker.js";
import { PersistentDeliveryLedger } from "../managed-input-arbiter.js";

test("native attach and Panel share one broker and cannot merge a detached local draft", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-broker-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writes: string[] = [];
  let spawned = 0;
  let handoffFile = "";
  const pty: ManagedPtyProcess = {
    pid: 4242, write: (value) => { writes.push(value); }, resize: () => {}, kill: () => {},
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  };
  const broker = new ManagedPtyBroker({
    sessionID: "native-1", cwd: dir, cliPath: "claude", helperPath: "attach.js", dataDir: dir,
    ledger: new PersistentDeliveryLedger(join(dir, "ledger.json")), platform: "linux", attachTimeoutMs: 30,
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
  assert.equal((await broker.sendPanel("panel-1", "remote prompt")).status, "busy");
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await broker.sendPanel("panel-1", "remote prompt")).status, "busy");
  assert.deepEqual(writes, ["unfinished draft"]);
  await assert.rejects(broker.openManagedTerminal("native-1"), /native_terminal_attach_timeout/);
  assert.equal(spawned, 1);
});
