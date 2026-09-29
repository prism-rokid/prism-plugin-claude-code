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

test("an idle attached Terminal and Panel alternate without closing the native window", async (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.attachLocal();
  assert.equal(h.arbiter.snapshot().can_send, true);
  assert.equal((await h.arbiter.panelSend("remote-after-local-idle", "remote")).status, "accepted");
  assert.equal(h.arbiter.snapshot().input_owner, "panel");
  h.arbiter.promptSubmitted("remote", "prompt-remote");
  h.arbiter.turnCompleted("prompt-remote");
  assert.deepEqual(await h.arbiter.localInput("native draft"), { accepted: true, control: "takeover" });
  assert.equal(h.arbiter.snapshot().can_send, false);
  await h.arbiter.localInput("\x15");
  assert.equal(h.arbiter.snapshot().can_send, true);
  assert.equal((await h.arbiter.panelSend("remote-after-clear", "remote again")).status, "accepted");
});

test("failed Claude stop remains failed in the durable delivery ledger", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.equal((await h.arbiter.panelSend("failed-message", "hello")).status, "accepted");
  h.arbiter.promptSubmitted("hello", "");
  h.arbiter.turnCompleted(undefined, true);
  assert.equal(h.ledger.get("failed-message")?.state, "failed");
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

test("native Terminal auto-attachment stays read-only after a detached Panel send", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.equal((await h.arbiter.panelSend("remote-attach", "continue")).status, "accepted");
  const attachment = h.arbiter.attachLocal();
  assert.deepEqual(attachment, { readOnly: true, owner: "panel" });
  assert.equal((await h.arbiter.localInput("local keys")).accepted, false);
  assert.deepEqual(h.writes, ["\x1b[200~continue\x1b[201~\r"]);
});

test("first local keystroke after a Panel turn takes the lease and blocks later Panel sends", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.equal((await h.arbiter.panelSend("remote-then-local", "continue")).status, "accepted");
  h.arbiter.attachLocal();
  assert.equal((await h.arbiter.localInput("too early")).accepted, false);
  h.arbiter.promptSubmitted("continue", "prompt-1");
  h.arbiter.turnCompleted("prompt-1");
  assert.deepEqual(await h.arbiter.localInput("local draft"), { accepted: true, control: "takeover" });
  assert.equal(h.arbiter.snapshot().input_owner, "local");
  assert.equal((await h.arbiter.panelSend("must-wait", "remote text")).status, "busy");
  assert.deepEqual(h.writes, ["\x1b[200~continue\x1b[201~\r", "local draft"]);
});

test("typing within the same local draft does not publish duplicate terminal states", async (t) => {
  const h = harness();
  t.after(h.close);
  const states: string[] = [];
  const arbiter = new ManagedInputArbiter({ write: (data) => h.writes.push(data) }, h.ledger, (state) => states.push(JSON.stringify(state)));
  arbiter.setStarted();
  arbiter.attachLocal();
  await arbiter.localInput("hello");
  const published = states.length;
  await arbiter.localInput(" world");
  assert.equal(states.length, published);
  assert.deepEqual(h.writes, ["hello", " world"]);
});

test("terminal navigation and focus escapes do not strand a phantom local draft", async (t) => {
  const h = harness();
  t.after(h.close);
  h.arbiter.attachLocal();
  await h.arbiter.localInput("\x1b");
  await h.arbiter.localInput("[A\x1b[I\x1b[O");
  h.arbiter.detachLocal();
  assert.equal(h.arbiter.snapshot().input_owner, null);
  assert.equal(h.arbiter.snapshot().can_send, true);
  assert.deepEqual(h.writes, ["\x1b", "[A\x1b[I\x1b[O"]);
});

test("terminal control traffic does not silently take the lease from Panel after a turn", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.equal((await h.arbiter.panelSend("panel-keeps-lease", "hello")).status, "accepted");
  h.arbiter.attachLocal();
  h.arbiter.promptSubmitted("hello", "prompt-1");
  h.arbiter.turnCompleted("prompt-1");
  assert.equal((await h.arbiter.localInput("\x1b")).accepted, false);
  assert.equal((await h.arbiter.localInput("[I\x1b[O")).accepted, false);
  assert.equal(h.arbiter.snapshot().input_owner, "panel");
  assert.equal(h.arbiter.snapshot().can_send, true);
  assert.deepEqual(await h.arbiter.localInput("local text"), { accepted: true, control: "takeover" });
  assert.equal(h.arbiter.snapshot().input_owner, "local");
  assert.deepEqual(h.writes, ["\x1b[200~hello\x1b[201~\r", "local text"]);
});

test("a standalone Escape does not swallow the first typed draft character", async (t) => {
  const h = harness();
  t.after(h.close);
  assert.equal((await h.arbiter.panelSend("panel-before-escape", "hello")).status, "accepted");
  h.arbiter.attachLocal();
  h.arbiter.promptSubmitted("hello", "prompt-escape");
  h.arbiter.turnCompleted("prompt-escape");
  assert.equal((await h.arbiter.localInput("\x1b")).accepted, false);
  assert.deepEqual(await h.arbiter.localInput("first character"), { accepted: true, control: "takeover" });
  assert.deepEqual(h.writes, ["\x1b[200~hello\x1b[201~\r", "first character"]);
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
