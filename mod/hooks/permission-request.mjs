import { readFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.HOME || process.env.USERPROFILE;
if (!home) process.exit(0);
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  const value = Buffer.from(chunk);
  bytes += value.length;
  if (bytes > 1024 * 1024) process.exit(2);
  chunks.push(value);
}
const input = Buffer.concat(chunks).toString("utf8");
try {
  const hook = JSON.parse(input);
  const descriptor = JSON.parse(await readFile(join(home, ".prism", "claudecode", "mod-bridge.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/permission`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: hook.session_id,
      toolName: hook.tool_name,
      toolInput: hook.tool_input,
    }),
  });
  if (!response.ok) process.exit(0);
  const value = await response.json();
  if (value.mode !== "decision") process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: value.decision, ...(value.message ? { message: value.message } : {}) },
    },
  }));
} catch {
  // Fail closed by leaving the native permission prompt untouched.
  process.exit(0);
}
