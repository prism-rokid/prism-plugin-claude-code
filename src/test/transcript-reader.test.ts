import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeTranscriptReader } from "../transcript-reader.js";

function fixture(t: test.TestContext) {
  const configDir = mkdtempSync(join(tmpdir(), "prism-transcript-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const project = join(configDir, "projects", "-tmp-project");
  mkdirSync(project, { recursive: true });
  const file = join(project, "session-one.jsonl");
  const write = (rows: unknown[]) => writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { reader: new NativeTranscriptReader({ configDir }), configDir, project, file, write };
}
const prompt = (uuid: string, text: string, parentUuid: string | null = null) => ({ type: "user", uuid, parentUuid, sessionId: "session-one", cwd: "/tmp/project", message: { content: text }, timestamp: "2026-10-05T01:00:00Z" });
const answer = (uuid: string, parentUuid: string, content: unknown[]) => ({ type: "assistant", uuid, parentUuid, message: { content } });

test("native history resolves branches and tool failures without showing tool-result users", async (t) => {
  const f = fixture(t);
  f.write([
    prompt("u1", "Question"),
    answer("abandoned", "u1", [{ type: "text", text: "Rewound answer" }]),
    answer("a1", "u1", [{ type: "text", text: "Current answer" }, { type: "tool_use", id: "call-1", name: "Read" }]),
    { type: "user", uuid: "result", parentUuid: "a1", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true }] } },
    answer("a2", "result", [{ type: "text", text: "Handled error" }]),
    { ...prompt("agent", "Subagent text"), isSidechain: true },
  ]);
  const entries = await f.reader.readTranscript("session-one");
  assert.deepEqual(entries.map((entry) => entry.uuid), ["u1", "a1", "a2"]);
  assert.deepEqual(entries[1].toolUses, [{ callId: "call-1", title: "Read", failed: true }]);
  assert.equal(entries[0].timestamp, "2026-10-05T01:00:00Z");
});

test("native titles update after rename and partially written JSONL is retried", async (t) => {
  const f = fixture(t);
  f.write([prompt("u1", "First\nquestion"), answer("a1", "u1", [{ type: "text", text: "OK" }])]);
  assert.equal((await f.reader.sessionInfo("session-one"))?.title, "First question");
  appendFileSync(f.file, '{"type":"custom-title","customTitle":"Renamed');
  assert.equal((await f.reader.readTranscript("session-one")).length, 2);
  appendFileSync(f.file, ' session","sessionId":"session-one"}\n');
  const list = await f.reader.listSessions();
  assert.equal(list[0].title, "Renamed session");
  assert.equal(list[0].cwd, "/tmp/project");
});

test("native history follows logical parents across compaction boundaries", async (t) => {
  const f = fixture(t);
  f.write([
    prompt("u1", "Before compaction"), answer("a1", "u1", [{ type: "text", text: "Earlier answer" }]),
    { type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: null, logicalParentUuid: "a1" },
    prompt("u2", "Continue", "compact"), answer("a2", "u2", [{ type: "text", text: "Later answer" }]),
  ]);
  assert.deepEqual((await f.reader.readTranscript("session-one")).map((entry) => entry.uuid), ["u1", "a1", "u2", "a2"]);
});

test("native discovery ignores subagent files and validates requested session paths", async (t) => {
  const f = fixture(t);
  f.write([prompt("u1", "Question")]);
  mkdirSync(join(f.project, "session-one", "subagents"), { recursive: true });
  writeFileSync(join(f.project, "session-one", "subagents", "agent-other.jsonl"), JSON.stringify(prompt("agent", "Hidden")));
  assert.equal((await f.reader.listSessions()).length, 1);
  assert.deepEqual(await f.reader.readTranscript("missing"), []);
  await assert.rejects(f.reader.readTranscript("../../settings"), /Invalid Claude session ID/);
});

test("updated assistant records with the same UUID replace their earlier content", async (t) => {
  const f = fixture(t);
  f.write([
    prompt("u1", "Question"),
    answer("a1", "u1", [{ type: "text", text: "Partial" }]),
    answer("a1", "u1", [{ type: "text", text: "Complete answer" }]),
  ]);
  const entries = await f.reader.readTranscript("session-one");
  assert.deepEqual(entries.map((entry) => entry.uuid), ["u1", "a1"]);
  assert.equal(entries[1].text, "Complete answer");
});
