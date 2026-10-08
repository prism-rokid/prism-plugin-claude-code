import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModBridge } from "../mod-bridge.js";

type Hook = (api: any, event: any, next: (event: any) => any) => any;

async function harness(initiallyOnline = true, descriptorPath?: string) {
  const hooks = new Map<string, Hook>();
  const timers: Array<() => Promise<void>> = [];
  const events: any[] = [];
  const commands: any[] = [];
  let online = initiallyOnline;
  let submitted = "";
  let sessionID = "native-session";
  let model = "opus";
  let locked = false;
  let denied = "";
  let modelWrites = 0;
  let deferred: Promise<any> | undefined;
  const api = {
    env: { get: async () => "/isolated-home" },
    fs: { read: async () => {
      if (!online) throw new Error("Hub is not running");
      if (descriptorPath) return readFileSync(descriptorPath, "utf8");
      return JSON.stringify({ port: 12345, token: "isolated-token", instance_id: "bridge-a" });
    } },
    http: { fetch: async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (descriptorPath) {
        if (!url.endsWith("/next")) events.push(body);
        const response = await fetch(url, options);
        return { ok: response.ok, status: response.status, text: await response.text() };
      }
      const value = url.endsWith("/next") ? commands.shift() || {} : (events.push(body), {});
      return { ok: true, status: 200, text: JSON.stringify(value) };
    } },
    session: {
      model: async () => "resolved-" + model,
      id: async () => sessionID,
      cwd: async () => "/isolated-project",
      version: async () => ({ version: "2.1.289" }),
      surfaces: async () => ["terminal"],
    },
    clock: { every: (_ms: number, callback: () => Promise<void>) => timers.push(callback) },
    ui: { status: () => undefined },
    prompt: {
      read: async () => ({ text: "本地未提交草稿", cursor: 7 }),
      // Claude skips this Mod's own prompt.submit hook for API submissions.
      submit: async (options: any) => {
        submitted = options.text;
        if (deferred) return deferred;
        return { text: options.text, origin: { kind: "plugin", name: "prism-terminal-control", asUser: true } };
      },
    },
    config: {
      list: async () => [{key:'model',options:['opus','sonnet'],isLocked:locked}],
      set: async ({value}: any) => { modelWrites++; if (denied) return {deny:denied}; model = value; return {value}; },
    },
    turn: { abort: async () => undefined },
  };
  const moduleURL = new URL("../../mod/hooks/register.js", import.meta.url).href;
  const { register } = await import(moduleURL);
  register((name: string, hook: Hook) => hooks.set(name, hook));
  return {
    hooks, timers, events, commands,
    lockModel: () => { locked = true; },
    denyModel: () => { denied = "native policy denied"; },
    modelWrites: () => modelWrites,
    online: () => { online = true; },
    submitted: () => submitted,
    setSession: (id: string) => { sessionID = id; },
    deferSubmit: (promise: Promise<any>) => { deferred = promise; },
    emit: async (name: string, event: any = {}) => {
      const hook = hooks.get(name);
      assert.ok(hook, `hook ${name} registered`);
      return hook(api, event, (value) => value);
    },
    stream: (event: any, next: (event: any) => any) => hooks.get("turn.step")!(api, event, next) as AsyncGenerator<any, any>,
    tick: async () => { for (const timer of timers) await timer(); },
  };
}

test("a native Claude started before Hub registers its heartbeat and reconnects later", async () => {
  const h = await harness(false);
  await h.emit("session.start");
  assert.ok(h.timers.length > 0, "Hub unavailable must not prevent retry timer registration");
  h.online();
  await h.tick();
  assert.ok(h.events.some((event) => event.sessionId === "native-session" && ["session.start", "session.current"].includes(event.kind)));
});

test("turn.step forwards each text chunk separately and preserves all engine chunks and result", async () => {
  const h = await harness();
  await h.emit("session.start");
  const chunks = [{ kind: "engine", ref: 1 }, { kind: "thinking", index: 0, text: "private" }, { kind: "text", index: 1, text: "你" }, { kind: "text", index: 1, text: "好" }, { kind: "tool", index: 2, id: "tool" }, { kind: "stop" }];
  const result = { turnId: "turn", index: 0, answer: "你好", toolUses: [], stopReason: "end_turn" };
  let calls = 0;
  const stream = h.stream({ turnId: "turn", index: 0 }, () => {
    calls++;
    return Object.assign((async function* () { for (const chunk of chunks) yield chunk; return result; })(), { result: Promise.resolve(result) });
  });
  const output = [];
  let finished;
  while (true) { const value = await stream.next(); if (value.done) { finished = value.value; break; } output.push(value.value); }
  assert.equal(calls, 1);
  assert.deepEqual(output, chunks);
  assert.equal(finished, result);
  const text = h.events.filter((event) => event.kind === "step.text");
  assert.deepEqual(text.map((event) => [event.sequence, event.blockIndex, event.text]), [[0, 1, "你"], [1, 1, "好"]]);
  assert.ok(h.events.some((event) => event.kind === "step.complete"));
  assert.ok(!h.events.some((event) => event.text === "private"));
});

test("turn.step preserves native output when Hub is offline and excludes subagents", async () => {
  const h = await harness(false);
  const chunk = { kind: "text", index: 0, text: "still native" };
  const next = () => Object.assign((async function* () { yield chunk; })(), { result: Promise.resolve({ answer: chunk.text }) });
  const output = [];
  for await (const value of h.stream({ turnId: "turn", index: 0 }, next)) output.push(value);
  assert.deepEqual(output, [chunk]);
  h.online();
  for await (const _value of h.stream({ turnId: "child", index: 0, agentId: "agent" }, next)) {}
  assert.equal(h.events.length, 0);
});

test("turn.step reports a failed stream without swallowing the native error", async () => {
  const h = await harness();
  await h.emit("session.start");
  const failure = new Error("interrupted");
  const stream = h.stream({ turnId: "turn", index: 0 }, () => Object.assign((async function* () { yield { kind: "text", index: 0, text: "partial" }; throw failure; })(), { result: Promise.resolve(undefined) }));
  await assert.rejects(async () => { for await (const _chunk of stream) {} }, failure);
  assert.ok(h.events.some((event) => event.kind === "step.failed"));
  assert.ok(!h.events.some((event) => event.kind === "step.complete"));
});

test("Mod remote submission works without receiving its own prompt.submit hook and preserves draft", async () => {
  const h = await harness();
  await h.emit("session.start");
  h.commands.push({ id: "read-command", action: "read" });
  await h.tick();
  assert.ok(h.events.some((event) => event.id === "read-command" && event.draft?.text === "本地未提交草稿"));
  h.commands.push({ id: "submit-command", action: "submit", requestId: "remote-request", text: "远程消息" });
  await h.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.submitted(), "远程消息");
  assert.ok(h.events.some((event) => event.id === "submit-command" && event.kind === "submit-settled"));
});

test("subagent completion cannot report the main turn as completed", async () => {
  const h = await harness();
  await h.emit("session.start");
  await h.emit("turn.start", { turnId: "parent-turn" });
  await h.emit("turn.complete", { turnId: "child-turn", agentId: "subagent-1", reason: "completed" });
  assert.equal(h.events.filter((event) => event.kind === "turn.complete").length, 0);
  await h.emit("turn.complete", { turnId: "parent-turn", reason: "completed" });
  assert.equal(h.events.filter((event) => event.kind === "turn.complete").length, 1);
});

test("repeated session starts do not create parallel command pollers", async () => {
  const h = await harness();
  await h.emit("session.start");
  await h.emit("session.start", { reason: "clear" });
  assert.equal(h.timers.length, 1, "the same Mod instance must have only one polling loop");
});


test("clear rebinds the Mod and a late captured submit receipt cannot revive the old session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-mod-clear-"));
  const bridge = new ModBridge(dir);
  await bridge.start();
  try {
    const h = await harness(true, bridge.descriptorPath);
    await h.emit("session.start");
    let settle!: (value: any) => void;
    h.deferSubmit(new Promise((resolve) => { settle = resolve; }));
    const dispatched = bridge.command("native-session", "submit", { text: "before clear", requestId: "old-request" });
    await h.tick();
    await dispatched;
    h.setSession("after-clear");
    await h.tick();
    assert.equal(bridge.session("native-session")?.seen_at || 0, 0);
    assert.ok(bridge.session("after-clear"));
    settle({ text: "before clear", origin: { kind: "plugin", name: "prism-terminal-control", asUser: true } });
    for (let i = 0; i < 20 && !h.events.some((event) => event.kind === "submit-settled"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(h.events.some((event) => event.kind === "submit-settled" && event.sessionId === "native-session"));
    assert.equal(bridge.session("native-session")?.seen_at || 0, 0);
    assert.equal(bridge.activeRemoteTurn("native-session"), undefined);
    await assert.rejects(bridge.command("native-session", "submit", { text: "old control", requestId: "must-reject" }), /mod_session_not_connected/);
    assert.equal(bridge.activeRemoteTurn("after-clear"), undefined);
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

 test("model list and switch use native configuration and read back the resolved session model", async () => {
  const h = await harness(); await h.emit('session.start');
  h.commands.push({id:'list',action:'models.read'}); await h.tick();
  const list = h.events.find(event => event.id === 'list');
  assert.deepEqual(list.modelOptions, ['opus','sonnet']); assert.equal(list.model,'resolved-opus');
  h.commands.push({id:'switch',action:'model.set',model:'sonnet'}); await h.tick();
  const switched = h.events.find(event => event.id === 'switch');
  assert.equal(switched.model,'resolved-sonnet'); assert.equal(h.modelWrites(),1);
  h.commands.push({id:'invalid',action:'model.set',model:'fabricated'}); await h.tick();
  assert.equal(h.events.find(event => event.id === 'invalid').kind,'models-error'); assert.equal(h.modelWrites(),1);
  await h.emit('turn.start',{turnId:'busy'});
  h.commands.push({id:'busy',action:'model.set',model:'opus'}); await h.tick();
  assert.match(h.events.find(event => event.id === 'busy' && event.kind === 'models-error').error,/session_busy/);
});
 test("locked or denied native model settings never report switch success", async () => {
  for (const mode of ['locked','denied']) {
    const h = await harness(); await h.emit('session.start');
    if (mode === 'locked') h.lockModel(); else h.denyModel();
    h.commands.push({id:mode,action:'model.set',model:'sonnet'}); await h.tick();
    assert.equal(h.events.find(event => event.id === mode).kind,'models-error');
  }
});
