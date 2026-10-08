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

 test("native model options carry the explicit Panel selection target", () => {
  const modelStates = new Map();
  const adapter = {modelStates, publish: () => {}};
  (ModClaudeAdapter.prototype as any).updateModels.call(adapter, "native", {model:"resolved-sonnet",modelOptions:["sonnet","opus"],modelLocked:false});
  const detail = modelStates.get("native");
  assert.deepEqual(detail.model_options[0].target,{option_id:"sonnet"});
  assert.equal(detail.model_options[0].available,true);
  assert.equal(detail.actions[0].id,"model.switch");
});
