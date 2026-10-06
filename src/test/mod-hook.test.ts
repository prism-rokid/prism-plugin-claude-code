import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModBridge } from "../mod-bridge.js";

type Hook = (api: any, event: any, next: (event: any) => any) => Promise<any>;

async function harness(initiallyOnline = true, descriptorPath?: string) {
  const hooks = new Map<string, Hook>();
  const timers: Array<() => Promise<void>> = [];
  const events: any[] = [];
  const commands: any[] = [];
  let online = initiallyOnline;
  let submitted = "";
  let sessionID = "native-session";
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
    turn: { abort: async () => undefined },
  };
  const moduleURL = new URL("../../mod/hooks/register.js", import.meta.url).href;
  const { register } = await import(moduleURL);
  register((name: string, hook: Hook) => hooks.set(name, hook));
  return {
    hooks, timers, events, commands,
    online: () => { online = true; },
    submitted: () => submitted,
    setSession: (id: string) => { sessionID = id; },
    deferSubmit: (promise: Promise<any>) => { deferred = promise; },
    emit: async (name: string, event: any = {}) => {
      const hook = hooks.get(name);
      assert.ok(hook, `hook ${name} registered`);
      return hook(api, event, (value) => value);
    },
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
