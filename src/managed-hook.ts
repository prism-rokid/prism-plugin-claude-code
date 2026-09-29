/** Claude Code command hook: relay JSON stdin to the authenticated supervisor. */
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { readSupervisorDescriptor } from "./managed-supervisor.js";

export async function relayHook(descriptorPath: string): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Claude hook payload exceeds limit");
    chunks.push(value);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  const descriptor = readSupervisorDescriptor(descriptorPath);
  if (payload.session_id !== descriptor.session_id || typeof payload.hook_event_name !== "string") throw new Error("Claude hook session mismatch");
  const socket = createConnection({ host: "127.0.0.1", port: descriptor.port });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let buffer = Buffer.alloc(0);
  const reply = new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        let packet: Record<string, unknown>;
        try { packet = JSON.parse(line) as Record<string, unknown>; } catch { reject(new Error("Invalid supervisor hook response")); return; }
        if (packet.id === "hook") {
          if (packet.ok === true) {
            const response = packet.payload && typeof packet.payload === "object" ? packet.payload as Record<string, unknown> : {};
            if (response.hook_response && typeof response.hook_response === "object") process.stdout.write(JSON.stringify(response.hook_response));
            resolve();
          } else reject(new Error(String(packet.error || "hook rejected")));
          return;
        }
        if (packet.type === "ready") socket.write(JSON.stringify({ id: "hook", method: "hook", payload }) + "\n");
      }
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Claude supervisor hook connection closed")));
  });
  socket.write(JSON.stringify({ type: "auth", token: descriptor.token }) + "\n");
  try { await reply; } finally { socket.destroy(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  relayHook(process.argv[2] || "").catch((error) => {
    // Hook failures must be visible in Claude diagnostics. They never output a
    // permission decision and therefore cannot accidentally grant a tool.
    process.stderr.write(`Prism Claude hook relay failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
