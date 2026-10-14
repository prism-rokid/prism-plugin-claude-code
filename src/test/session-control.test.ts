import assert from "node:assert/strict";
import test from "node:test";
import { ModClaudeAdapter } from "../mod-adapter.js";

test("conversation selection accepts native history without invoking model control or launching a process", async () => {
  const adapter = {bridge:{session: () => undefined, command: () => {throw new Error("must not mutate");}},reader:{sessionInfo: async (id: string) => id === "native" ? {sessionId:id} : undefined}};
  const invoke = (session: any, action = "conversation.select") => ModClaudeAdapter.prototype.controlSession.call(adapter as any, {session, action, metadata:{}});
  const result = await invoke({NativeSessionID:"native", NativeThreadID:"native"});
  assert.equal(result.ok,true); assert.equal(result.thread_id,"native"); assert.equal(result.details_confirmed,false);
  await assert.rejects(invoke({NativeSessionID:"missing"}), /unavailable/);
  await assert.rejects(invoke({NativeSessionID:"native",NativeThreadID:"different"}), /identity/);
  await assert.rejects(invoke({NativeSessionID:"native"},"unsupported.action"), /Only native model/);
});

test("Mod session heartbeats publish idle after the active Claude turn ends", () => {
  const events: any[] = [];
  const snapshots = new Map<string, any>([["native", { cwd: "/tmp", version: "2.1.289", surface: ["terminal"], turn_id: "turn-1" }]]);
  const activeTurns = new Map<string, any>([["native", { requestId: "request-1", turnId: "turn-1" }]]);
  const adapter = {
    bridge: {
      session: (id: string) => snapshots.get(id),
      activeRemoteTurn: (id: string) => activeTurns.get(id),
    },
    modStateSignatures: new Map(),
    publish: (...args: any[]) => events.push(args),
  };
  const publishHeartbeat = (ModClaudeAdapter.prototype as any).handleModEvent.bind(adapter);

  publishHeartbeat({ kind: "session.current", sessionId: "native" });
  assert.equal(events.at(-1)[2], "running");
  assert.equal(events.at(-1)[4].detail_snapshot.terminal.can_interrupt, true);
  assert.equal(events.at(-1)[4].detail_snapshot.run.status, "running");

  snapshots.set("native", { cwd: "/tmp", version: "2.1.289", surface: ["terminal"] });
  activeTurns.delete("native");
  publishHeartbeat({ kind: "session.current", sessionId: "native" });
  assert.equal(events.at(-1)[2], "idle");
  assert.equal(events.at(-1)[4].detail_snapshot.terminal.can_send, true);
  assert.equal(events.at(-1)[4].detail_snapshot.run.status, "idle");
});

test("native model options carry the explicit Panel selection target", () => {
  const modelStates = new Map();
  const adapter = {modelStates, publish: () => {}};
  (ModClaudeAdapter.prototype as any).updateModels.call(adapter, "native", {model:"resolved-sonnet",modelOption:"sonnet",modelOptions:["sonnet","opus"],modelLocked:false});
  const detail = modelStates.get("native");
  assert.equal(detail.current_model.id,"sonnet");
  assert.equal(detail.current_model.resolved_model,"resolved-sonnet");
  assert.deepEqual(detail.model_options[0].target,{option_id:"sonnet"});
  assert.equal(detail.model_options[0].available,true);
  assert.equal(detail.actions[0].id,"model.switch");
});

test("model switch accepts the selected alias when its provider model has a different family", async () => {
  const adapter = {
    bridge:{session: () => ({surface:["terminal"]}), command: async () => ({model:"claude-opus-4-7",modelOptions:["sonnet","opus"],modelOption:"sonnet"})},
    modelStates:new Map(), manager:{hasSupervisorOwner: () => false}, publish: () => {},
    updateModels: (ModClaudeAdapter.prototype as any).updateModels,
    readDetail: async () => ({current_model:{id:"sonnet",resolved_model:"claude-opus-4-7"}}),
  };
  const invoke = () => ModClaudeAdapter.prototype.controlSession.call(adapter as any, {session:{NativeSessionID:"native",NativeThreadID:"native",Cwd:"/tmp"} as any,action:"model.switch",target:{option_id:"sonnet"},metadata:{}});
  const result = await invoke();
  assert.equal(result.ok,true);
  assert.equal((result.details as any).current_model.id,"sonnet");
  assert.equal((result.details as any).current_model.resolved_model,"claude-opus-4-7");
});

test("model switch fails when the native readback does not select the requested alias", async () => {
  const adapter = {
    bridge:{session: () => ({surface:["terminal"]}), command: async () => ({model:"claude-opus-4-7",modelOptions:["sonnet","opus"],modelOption:"opus"})},
    modelStates:new Map(), manager:{hasSupervisorOwner: () => false}, publish: () => {},
    updateModels: (ModClaudeAdapter.prototype as any).updateModels,
  };
  const invoke = () => ModClaudeAdapter.prototype.controlSession.call(adapter as any, {session:{NativeSessionID:"native",NativeThreadID:"native",Cwd:"/tmp"} as any,action:"model.switch",target:{option_id:"sonnet"},metadata:{}});
  await assert.rejects(invoke(), /selected opus after choosing sonnet/);
});
