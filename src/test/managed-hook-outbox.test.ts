import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ManagedSupervisor } from "../managed-supervisor.js";
import { ManagedSupervisorClient } from "../managed-supervisor-client.js";
import { PersistentHookOutbox } from "../managed-hook-outbox.js";

test("acknowledged Hook files stay removed and sequence remains monotonic after reopen", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-hook-sequence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new PersistentHookOutbox(dir);
  const a = first.append({ hook_event_name: "MessageDisplay" });
  assert.equal(first.ack(a.event_id), true);
  assert.equal(first.ack(a.event_id), false);
  const second = new PersistentHookOutbox(dir);
  const b = second.append({ hook_event_name: "Stop" });
  assert.notEqual(a.event_id, b.event_id);
  assert.deepEqual(second.replay().map((entry) => entry.event_id), [b.event_id]);
  assert.equal(readFileSync(join(dir, "hook-outbox", "next-sequence"), "utf8"), "3");
});

test("replay rotates through backlogs larger than one page", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-hook-pages-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outbox = new PersistentHookOutbox(dir);
  const events = Array.from({ length: 600 }, (_, index) => outbox.append({ index }));

  const first = outbox.replay();
  const second = outbox.replay();
  const third = outbox.replay();
  assert.equal(first.length, 256);
  assert.equal(second.length, 256);
  assert.equal(third.length, 88);
  assert.deepEqual(
    new Set([...first, ...second, ...third].map((entry) => entry.event_id)),
    new Set(events.map((entry) => entry.event_id)),
  );
  assert.equal(outbox.replay()[0].event_id, first[0].event_id);
});

test("Hooks produced while plugin is offline replay in order with stable IDs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-hook-outbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const supervisor = new ManagedSupervisor({
    sessionID: "hook-replay", cwd: dir, cliPath: "claude", helperPath: "attach.js", dataDir: dir,
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
  const first = await ManagedSupervisorClient.connect(supervisor.descriptorPath);
  first.close();
  await (supervisor as unknown as { handleHook(hook: Record<string, unknown>): Promise<unknown> }).handleHook({ session_id: "hook-replay", hook_event_name: "SessionStart" });
  await (supervisor as unknown as { handleHook(hook: Record<string, unknown>): Promise<unknown> }).handleHook({ session_id: "hook-replay", hook_event_name: "MessageDisplay" });
  await (supervisor as unknown as { handleHook(hook: Record<string, unknown>): Promise<unknown> }).handleHook({ session_id: "hook-replay", hook_event_name: "Stop" });
  const observe = async () => {
    const seen: Array<{ kind: unknown; id: string | undefined; replayed: boolean | undefined; createdAt: string | undefined }> = [];
    const client = await ManagedSupervisorClient.connect(supervisor.descriptorPath, undefined, (hook, id, replayed, createdAt) => {
      seen.push({ kind: hook.hook_event_name, id, replayed, createdAt });
    });
    assert.equal(await client.replayHooks(), 2);
    client.close();
    return seen;
  };
  const second = await observe();
  const third = await observe();
  assert.deepEqual(second.map((entry) => entry.kind), ["MessageDisplay", "Stop"]);
  assert.deepEqual(third, second);
  assert.ok(second.every((entry) => entry.replayed && entry.id && entry.createdAt));
  const acknowledger = await ManagedSupervisorClient.connect(supervisor.descriptorPath);
  for (const entry of second) await acknowledger.ackHook(entry.id!);
  assert.equal(await acknowledger.replayHooks(), 0);
  acknowledger.close();
});
