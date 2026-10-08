import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModBridge } from "../mod-bridge.js";

async function post(descriptorPath: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as { port: number; token: string };
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify({ clientInstanceId: "test-client", ...body }),
  });
  return response.status === 204 || !response.headers.get("content-type")?.includes("json") ? {} : await response.json() as Record<string, unknown>;
}

test("Mod bridge keeps sessions isolated and ties identical text to event origin, never text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  try {
    for (const sessionId of ["session-a", "session-b"]) {
      await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId, cwd: dir, version: "2.1.289", surface: ["terminal"] });
    }
    const dispatch = bridge.command("session-a", "submit", { text: "same text", requestId: "remote-1" });
    const command = await post(bridge.descriptorPath, "/next", { sessionId: "session-a" });
    assert.equal(command.action, "submit");
    assert.equal(command.requestId, "remote-1");
    assert.equal((await post(bridge.descriptorPath, "/next", { sessionId: "session-b" })).id, undefined);
    await post(bridge.descriptorPath, "/event", { kind: "submit-dispatched", sessionId: "session-a", id: command.id });
    await dispatch;
    await post(bridge.descriptorPath, "/event", { kind: "turn.start", sessionId: "session-a", text: "same text", turnId: "turn-a" });
    await post(bridge.descriptorPath, "/event", { kind: "submit-settled", sessionId: "session-a", id: command.id, origin: { kind: "plugin", name: "prism-terminal-control", asUser: true } });
    assert.equal(bridge.remoteRequestForTurn("session-a", "turn-a"), "remote-1");
    assert.equal(bridge.remoteRequestForTurn("session-b", "turn-a"), undefined);
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("one session UUID cannot be claimed or polled by a second live Mod instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  try {
    const first = await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    assert.equal(first.error, undefined);
    const second = await post(bridge.descriptorPath, "/event", { clientInstanceId: "other-client", kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    assert.equal(second.error, "mod_session_owner_conflict");
    const next = await post(bridge.descriptorPath, "/next", { clientInstanceId: "other-client", sessionId: "session-a" });
    assert.equal(next.error, "mod_session_owner_mismatch");
    const nativeApproval = await post(bridge.descriptorPath, "/permission", { sessionId: "session-a", toolName: "Bash", toolInput: { command: "echo safe" } });
    assert.equal(nativeApproval.mode, "native");
    const firstOwnerNext = await post(bridge.descriptorPath, "/next", { clientInstanceId: "test-client", sessionId: "session-a" });
    assert.equal(firstOwnerNext.error, "mod_session_owner_mismatch");
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a reloaded Mod recovers when the old heartbeat expires without permitting two live owners", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-reload-"));
  const bridge = new ModBridge(dir);
  let stamp = Date.now();
  t.mock.method(Date, "now", () => stamp);
  await bridge.start();
  const handshake = (clientInstanceId: string) => post(bridge.descriptorPath, "/event", { kind: "session.current", sessionId: "session-a", clientInstanceId, cwd: dir, version: "2.1.289", surface: ["terminal"], activeTurnId: null });
  try {
    await handshake("old");
    assert.equal((await handshake("new")).error, "mod_session_owner_conflict");
    stamp += 4000;
    assert.equal((await handshake("old")).error, "mod_session_owner_conflict");
    assert.equal((await handshake("new")).error, "mod_session_owner_conflict");
    stamp += 4000;
    assert.equal((await handshake("new")).error, "mod_session_owner_conflict");
    stamp += 1100;
    assert.equal((await handshake("new")).error, undefined);
    assert.equal(bridge.session("session-a")?.client_instance_id, "new");
    const dispatched = bridge.command("session-a", "read");
    const command = await post(bridge.descriptorPath, "/next", { sessionId: "session-a", clientInstanceId: "new" });
    assert.equal(command.action, "read");
    await post(bridge.descriptorPath, "/event", { kind: "read", sessionId: "session-a", clientInstanceId: "new", id: command.id, draft: { text: "preserved", cursor: 9 } });
    await dispatched;
    assert.equal(bridge.session("session-a")?.draft?.text, "preserved");
    assert.equal((await handshake("old")).error, "mod_session_owner_conflict", "a second live owner must block control again");
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a normal session.end releases its Mod incarnation before the same transcript is resumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  try {
    await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    await post(bridge.descriptorPath, "/event", { kind: "session.end", sessionId: "session-a", reason: "exit" });
    assert.equal(bridge.session("session-a"), undefined);
    const resumed = await post(bridge.descriptorPath, "/event", { clientInstanceId: "resumed-client", kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    assert.equal(resumed.error, undefined);
    assert.equal(bridge.session("session-a")?.client_instance_id, "resumed-client");
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("only an identified remote turn can bridge a permission decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  const events: Record<string, unknown>[] = [];
  bridge.onEvent((event) => events.push(event));
  try {
    await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    const local = await post(bridge.descriptorPath, "/permission", { sessionId: "session-a", toolName: "Bash", toolInput: { command: "echo local" } });
    assert.equal(local.mode, "native");

    for (const [requestId, turnId, actionId] of [["remote-allow", "turn-allow", "allow_once"], ["remote-deny", "turn-deny", "deny"]]) {
      const dispatched = bridge.command("session-a", "submit", { text: "request approval", requestId });
      const command = await post(bridge.descriptorPath, "/next", { sessionId: "session-a" });
      await post(bridge.descriptorPath, "/event", { kind: "submit-dispatched", sessionId: "session-a", id: command.id });
      await dispatched;
      await post(bridge.descriptorPath, "/event", { kind: "turn.start", sessionId: "session-a", text: "request approval", turnId });
      await post(bridge.descriptorPath, "/event", { kind: "submit-settled", sessionId: "session-a", id: command.id, origin: { kind: "plugin", name: "prism-terminal-control", asUser: true } });
      const permission = post(bridge.descriptorPath, "/permission", { sessionId: "session-a", toolName: "Bash", toolInput: { command: "echo safe" } });
      for (let i = 0; i < 30 && !events.some((event) => event.kind === "approval.request" && event.requestId === requestId); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      const approval = events.find((event) => event.kind === "approval.request" && event.requestId === requestId);
      assert.ok(approval);
      const approvalRequestId = String(approval.approvalRequestId);
      const wrong = await post(bridge.descriptorPath, "/resolve-approval", { sessionId: "session-a", approvalRequestId: "wrong-id", actionId });
      assert.equal(wrong.error, "approval_stale");
      const resolved = await post(bridge.descriptorPath, "/resolve-approval", { sessionId: "session-a", approvalRequestId, actionId });
      assert.equal(resolved.ok, true);
      const repeated = await post(bridge.descriptorPath, "/resolve-approval", { sessionId: "session-a", approvalRequestId, actionId });
      assert.equal(repeated.error, "approval_stale");
      const decision = await permission;
      assert.equal(decision.decision, actionId === "allow_once" ? "allow" : "deny");
      await post(bridge.descriptorPath, "/event", { kind: "turn.complete", sessionId: "session-a", turnId, reason: "completed" });
    }
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a same-text composer submit makes request-to-turn mapping indeterminate and abort fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  try {
    await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    const dispatch = bridge.command("session-a", "submit", { text: "same text", requestId: "remote-1" });
    const command = await post(bridge.descriptorPath, "/next", { sessionId: "session-a" });
    await post(bridge.descriptorPath, "/event", { kind: "submit-dispatched", sessionId: "session-a", id: command.id });
    await dispatch;
    await post(bridge.descriptorPath, "/event", { kind: "prompt.submit", sessionId: "session-a", text: "same text", origin: { kind: "composer" } });
    await post(bridge.descriptorPath, "/event", { kind: "turn.start", sessionId: "session-a", text: "same text", turnId: "turn-ambiguous" });
    await post(bridge.descriptorPath, "/event", { kind: "submit-settled", sessionId: "session-a", id: command.id, origin: { kind: "plugin", name: "prism-terminal-control", asUser: true } });
    assert.equal(bridge.remoteRequestForTurn("session-a", "turn-ambiguous"), undefined);
    await assert.rejects(bridge.command("session-a", "abort", { turnId: "turn-ambiguous" }), /remote_turn_identity_unavailable/);
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("turn start/completion arriving before submit settles keep one Prism run identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  const events: Record<string, unknown>[] = [];
  bridge.onEvent((event) => events.push(event));
  try {
    await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    const dispatch = bridge.command("session-a", "submit", { text: "quick", requestId: "remote-fast" });
    const command = await post(bridge.descriptorPath, "/next", { sessionId: "session-a" });
    await post(bridge.descriptorPath, "/event", { kind: "submit-dispatched", sessionId: "session-a", id: command.id });
    await dispatch;
    await post(bridge.descriptorPath, "/event", { kind: "turn.start", sessionId: "session-a", turnId: "fast-turn", text: "quick" });
    await post(bridge.descriptorPath, "/event", { kind: "turn.complete", sessionId: "session-a", turnId: "fast-turn", reason: "completed" });
    assert.equal(events.some((event) => event.kind === "turn.complete"), false);
    await post(bridge.descriptorPath, "/event", { kind: "submit-settled", sessionId: "session-a", id: command.id, origin: { kind: "plugin", name: "prism-terminal-control", asUser: true } });
    const settled = events.find((event) => event.kind === "submit-settled" && event.prism_request_id === "remote-fast");
    const correlatedComplete = events.find((event) => event.kind === "turn.complete" && event.prism_request_id === "remote-fast");
    assert.equal(settled?.turnId, "fast-turn");
    assert.equal(correlatedComplete?.turnId, "fast-turn");
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a delivered command timeout retains the uncertain lock; an undelivered command is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  try {
    await post(bridge.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir, version: "2.1.289", surface: ["terminal"] });
    const delivered = bridge.command("session-a", "submit", { text: "maybe", requestId: "uncertain" }, 20);
    await post(bridge.descriptorPath, "/next", { sessionId: "session-a" });
    await assert.rejects(delivered, /mod_command_timeout/);
    await assert.rejects(bridge.command("session-a", "submit", { text: "other", requestId: "other" }), /session_busy/);
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }

  const dir2 = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const bridge2 = new ModBridge(dir2);
  await bridge2.start();
  try {
    await post(bridge2.descriptorPath, "/event", { kind: "session.start", sessionId: "session-a", cwd: dir2, version: "2.1.289", surface: ["terminal"] });
    await assert.rejects(bridge2.command("session-a", "submit", { text: "not delivered", requestId: "removed" }, 20), /mod_command_timeout/);
    const next = bridge2.command("session-a", "submit", { text: "next", requestId: "next" });
    const command = await post(bridge2.descriptorPath, "/next", { sessionId: "session-a" });
    assert.equal(command.requestId, "next");
    await post(bridge2.descriptorPath, "/event", { kind: "submit-dispatched", sessionId: "session-a", id: command.id });
    await next;
  } finally { await bridge2.close(); rmSync(dir2, { recursive: true, force: true }); }
});

test("bridge instance cleanup never deletes a newer descriptor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-bridge-"));
  const older = new ModBridge(dir);
  const newer = new ModBridge(dir);
  await older.start();
  await newer.start();
  const current = readFileSync(newer.descriptorPath, "utf8");
  await older.close();
  assert.equal(readFileSync(newer.descriptorPath, "utf8"), current);
  await newer.close();
  rmSync(dir, { recursive: true, force: true });
});
