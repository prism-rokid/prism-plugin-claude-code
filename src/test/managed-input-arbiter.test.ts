import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedInputArbiter, PersistentDeliveryLedger } from "../managed-input-arbiter.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "prism-managed-input-"));
  const writes: string[] = [];
  const ledgerPath = join(dir, "ledger.json");
  const ledger = new PersistentDeliveryLedger(ledgerPath);
  const arbiter = new ManagedInputArbiter({ write: (data) => { writes.push(data); } }, ledger);
  arbiter.setStarted();
  return { dir, writes, ledgerPath, ledger, arbiter, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("local attachment owns stdin and blocks Panel without changing the draft", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.deepEqual(h.arbiter.attachLocal(), { readOnly: false, owner: "local" });
  assert.equal((await h.arbiter.localInput("draft that must remain")).accepted, true);
  const before = [...h.writes];
  const result = await h.arbiter.panelSend("message-1", "Panel text");
  assert.equal(result.status, "busy");
  assert.deepEqual(h.writes, before);
  assert.equal(h.arbiter.snapshot().input_owner, "local");
});

test("Ctrl-] refuses handoff while a local draft is present and allows it after Ctrl-U", async (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.attachLocal();
  await h.arbiter.localInput("draft");
  const refused = await h.arbiter.localInput("\x1d");
  assert.equal(refused.accepted, false);
  assert.match(refused.reason || "", /draft/i);
  assert.deepEqual(h.writes, ["draft"]);

  await h.arbiter.localInput("\x15");
  const yielded = await h.arbiter.localInput("\x1d");
  assert.deepEqual(yielded, { accepted: true, control: "handoff" });
  assert.equal(h.arbiter.snapshot().input_owner, "panel");
  assert.equal(h.arbiter.snapshot().can_send, true);
});

test("detaching with an unfinished local draft keeps Panel input blocked", async (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.attachLocal();
  await h.arbiter.localInput("unfinished draft");
  h.arbiter.detachLocal();
  assert.equal(h.arbiter.snapshot().input_owner, "local");
  assert.equal(h.arbiter.snapshot().can_send, false);
  assert.equal((await h.arbiter.panelSend("message-detached", "remote prompt")).status, "busy");
  assert.deepEqual(h.writes, ["unfinished draft"]);
  h.arbiter.attachLocal();
  await h.arbiter.localInput("\x15");
  h.arbiter.detachLocal();
  assert.equal(h.arbiter.snapshot().can_send, true);
});

test("startup trust-menu keys do not become an unfinished prompt draft", async (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.setReconnect();
  h.arbiter.attachLocal();
  await h.arbiter.localInput("\x1b[B\r");
  h.arbiter.detachLocal();
  assert.equal(h.arbiter.snapshot().can_send, false);
  h.arbiter.setStarted();
  assert.equal(h.arbiter.snapshot().can_send, true);
});

test("workspace trust is explicit and never grants remote send before SessionStart", (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.setReconnect();
  h.arbiter.setSetupRequired();
  assert.equal(h.arbiter.snapshot().setup_required, true);
  assert.equal(h.arbiter.snapshot().can_send, false);
  assert.match(h.arbiter.snapshot().reason || "", /project trust/);
  h.arbiter.setStarted();
  assert.equal(h.arbiter.snapshot().setup_required, undefined);
  assert.equal(h.arbiter.snapshot().can_send, true);
});

test("Panel messages are serialized and local key bytes cannot enter while Panel owns input", async (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.attachLocal();
  await h.arbiter.localInput("\x15");
  await h.arbiter.localInput("\x1d");
  const sent = await h.arbiter.panelSend("message-2", "hello\nworld");
  assert.equal(sent.status, "accepted");
  assert.deepEqual(h.writes, ["\x15", "\x1b[200~hello\nworld\x1b[201~\r"]);
  const dropped = await h.arbiter.localInput("must not reach Claude");
  assert.equal(dropped.accepted, false);
  assert.equal(h.writes.length, 2);
  assert.equal(h.arbiter.snapshot().input_owner, "panel");
});

test("same request id is idempotent; changed text conflicts; crash recovery is indeterminate", async (t) => {
  const h = harness();
  t.after(h.close);
  const accepted = await h.arbiter.panelSend("message-3", "test prompt");
  assert.equal(accepted.status, "accepted");
  assert.equal((await h.arbiter.panelSend("message-3", "test prompt")).status, "duplicate");
  assert.equal((await h.arbiter.panelSend("message-3", "different")).status, "conflict");
  assert.equal(h.writes.length, 1);
  assert.equal(readFileSync(h.ledgerPath, "utf8").includes("test prompt"), false);

  // Reopening the fsynced ledger treats an unconfirmed PTY write as uncertain.
  const recovered = new PersistentDeliveryLedger(h.ledgerPath);
  assert.equal(recovered.get("message-3")?.state, "indeterminate");
  const afterRestart = new ManagedInputArbiter({ write: () => assert.fail("indeterminate retry must not write") }, recovered);
  afterRestart.setStarted();
  assert.equal((await afterRestart.panelSend("message-3", "test prompt")).status, "indeterminate");
  assert.equal((await afterRestart.panelSend("message-3", "other prompt")).status, "conflict");
  assert.equal(JSON.parse(readFileSync(h.ledgerPath, "utf8"))[0].state, "indeterminate");
});

test("hook confirmation and completion advance the durable delivery state", async (t) => {
  const h = harness();
  t.after(h.close);
  const sent = await h.arbiter.panelSend("message-4", "confirm me");
  assert.equal(sent.status, "accepted");
  h.arbiter.promptSubmitted("confirm me", "claude-prompt-4");
  assert.equal(h.ledger.get("message-4")?.state, "submitted");
  h.arbiter.turnCompleted("claude-prompt-4");
  assert.equal(h.ledger.get("message-4")?.state, "completed");
});

test("interrupt serializes Ctrl-C and preserves uncertainty before native submit", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.equal((await h.arbiter.panelSend("message-interrupt", "stop me")).status, "accepted");
  assert.equal(h.arbiter.snapshot().can_interrupt, true);
  assert.equal(await h.arbiter.interrupt(), true);
  assert.equal(h.ledger.get("message-interrupt")?.state, "indeterminate");
  assert.deepEqual(h.writes, ["\x1b[200~stop me\x1b[201~\r", "\x03"]);
});

test("control sequences are rejected from Panel text", async (t) => {
  const h = harness();
  t.after(h.close);
  const result = await h.arbiter.panelSend("message-5", "hello\x1b[2J");
  assert.equal(result.status, "invalid");
  assert.equal(h.writes.length, 0);
});
