import assert from "node:assert/strict";
import test from "node:test";
import { LiveTranscript } from "../live-transcript.js";
import type { TranscriptEntry } from "../transcript-reader.js";

const entry = (uuid: string, role: TranscriptEntry["role"], text: string): TranscriptEntry => ({ uuid, role, text, toolUses: [], timestamp: "2026-10-08T00:00:00.000Z" });
test("a reply waits for its new native user row instead of appearing above the new user message", async () => {
  const h = harness();
  h.set([entry("old-user", "user", "old"), entry("old-answer", "assistant", "old answer")]);
  await h.event("turn.start");
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "new reply" });
  const pending = await h.live.snapshot("session");
  assert.deepEqual(pending[0].messages.map((message) => message.Content), ["old", "old answer"]);
  h.set([entry("old-user", "user", "old"), entry("old-answer", "assistant", "old answer"), entry("new-user", "user", "new input")]);
  const current = await h.live.snapshot("session");
  assert.deepEqual(current[1].messages.filter((message) => message.Type !== "progress").map((message) => message.Content), ["new input", "new reply"]);
  h.live.close();
});
function harness() {
  let entries = [entry("u1", "user", "hello")];
  const live = new LiveTranscript(async () => entries, (e) => ({ ID: e.uuid, Role: e.role, Type: "text", Content: e.text, Status: "completed", CreatedAt: e.timestamp!, UpdatedAt: e.timestamp! }));
  const event = (kind: string, fields: Record<string, unknown> = {}) => live.handle({ sessionId: "session", kind, turnId: "turn", stepIndex: 0, ...fields });
  return { live, event, set: (value: TranscriptEntry[]) => { entries = value; } };
}

test("each delta yields its own history revision and reconnect restores the partial reply", async () => {
  const h = harness();
  await h.live.snapshot("session");
  await h.event("step.start");
  const frames: string[] = [];
  const off = h.live.subscribe("session", (turns) => frames.push(turns[0].messages.at(-1)!.Content));
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "你" });
  await h.event("step.text", { sequence: 1, blockIndex: 0, text: "好" });
  assert.deepEqual(frames, ["你", "你好"]);
  const turns = await h.live.snapshot("session");
  assert.equal(turns[0].messages.at(-1)!.Content, "你好");
  assert.equal(turns[0].messages.at(-1)!.Status, "running");
  off(); h.live.close();
});

test("final native history replaces the preview without duplicates or stale partial text", async () => {
  const h = harness();
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "first" });
  await h.event("step.text", { sequence: 1, blockIndex: 1, text: "second" });
  await h.event("step.complete");
  h.set([entry("u1", "user", "hello"), entry("a1", "assistant", "first\nsecond")]);
  const turns = await h.live.snapshot("session");
  assert.deepEqual(turns[0].messages.map((e) => e.ID), ["u1", "a1"]);
  assert.equal(turns[0].messages[1].Status, "completed");
  h.live.close();
});

test("interrupt preserves partial text and previews cannot migrate into the next native turn", async () => {
  const h = harness();
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "partial" });
  await h.event("turn.complete", { isAborted: true });
  h.set([entry("u1", "user", "hello"), entry("u2", "user", "next")]);
  const turns = await h.live.snapshot("session");
  assert.equal(turns[0].messages.at(-1)!.Status, "interrupted");
  assert.equal(turns[1].messages.length, 1);
  h.live.close();
});

test("repeated deltas are ignored and missing deltas fall back to native history", async () => {
  const h = harness();
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "first" });
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "first" });
  assert.equal((await h.live.snapshot("session"))[0].messages.at(-1)!.Content, "first");
  await h.event("step.text", { sequence: 2, blockIndex: 0, text: "third" });
  assert.equal((await h.live.snapshot("session"))[0].messages.length, 1);
  h.set([entry("u1", "user", "hello"), entry("a1", "assistant", "first second third")]);
  assert.equal((await h.live.snapshot("session"))[0].messages[1].Content, "first second third");
  h.live.close();
});

test("an earlier identical answer cannot hide streaming and unchanged old turns keep their revision", async () => {
  const h = harness();
  h.set([entry("old", "user", "old"), entry("old-answer", "assistant", "same"), entry("u1", "user", "hello")]);
  const before = await h.live.snapshot("session");
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "same" });
  await h.event("step.complete");
  const after = await h.live.snapshot("session");
  assert.equal(after[0].revision, before[0].revision);
  assert.ok(after[1].revision > before[1].revision);
  assert.equal(after[1].messages[1].Content, "same");
  h.live.close();
});

test("the authoritative final reply wins if another Mod changed the streamed text", async () => {
  const h = harness();
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "original" });
  h.set([entry("u1", "user", "hello"), entry("a1", "assistant", "rewritten by another Mod")]);
  await h.event("step.complete");
  const turns = await h.live.snapshot("session");
  assert.deepEqual(turns[0].messages.map((message) => message.Content), ["hello", "rewritten by another Mod"]);
  h.live.close();
});

 test("later steps remain below the same user after native assistant rows appear", async () => {
  const h = harness();
  await h.event("turn.start");
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "first" });
  h.set([entry("u1", "user", "hello"), entry("a1", "assistant", "first")]);
  await h.event("step.complete");
  await h.event("step.start", { stepIndex: 1 });
  await h.event("step.text", { stepIndex: 1, sequence: 0, blockIndex: 0, text: "second" });
  const turns = await h.live.snapshot("session");
  assert.deepEqual(turns[0].messages.filter((message) => message.Type !== "progress").map((message) => message.Content), ["hello", "first", "second"]);
  h.live.close();
});

 test("native work progress appears below the user before text and clears on completion or interruption", async () => {
  for (const isAborted of [false, true]) {
    const h = harness();
    await h.event("turn.start");
    let turns = await h.live.snapshot("session");
    assert.equal(turns[0].messages[0].Role, "user");
    assert.equal(turns[0].messages[1].Type, "progress");
    assert.equal(turns[0].messages[1].Progress?.Status, "running");
    await h.event("step.start");
    await h.event("step.text", {sequence: 0, blockIndex: 0, text: "reply"});
    turns = await h.live.snapshot("session");
    assert.equal(turns[0].messages[1]?.Type, "progress");
    assert.equal(turns[0].messages[2]?.Content, "reply");
    await h.event("turn.complete", {isAborted});
    turns = await h.live.snapshot("session");
    assert.equal(turns[0].messages.some(message => message.Type === "progress"), false);
    h.live.close();
  }
});

 test("prompt boundary prevents a delayed repeated input from binding to the previous user even without a visible prior reply", async () => {
  const h = harness();
  h.set([entry("old-user", "user", "11")]);
  await h.event("prompt.submit");
  await h.event("turn.start");
  await h.event("step.start");
  await h.event("step.text", { sequence: 0, blockIndex: 0, text: "new reply" });
  assert.deepEqual((await h.live.snapshot("session"))[0].messages.map(message => message.Content), ["11"]);
  h.set([entry("old-user", "user", "11"), entry("new-user", "user", "11")]);
  const turns = await h.live.snapshot("session");
  assert.deepEqual(turns[0].messages.map(message => message.Content), ["11"]);
  assert.deepEqual(turns[1].messages.filter(message => message.Type !== "progress").map(message => message.Content), ["11", "new reply"]);
  assert.equal(turns[1].messages.filter(message => message.Type === "progress").length, 1);
  h.live.close();
});
