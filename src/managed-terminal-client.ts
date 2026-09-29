/** Terminal.app / Windows Terminal / x-terminal-emulator side of a managed Claude PTY. */
import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Handoff = { host: string; port: number; token: string; session_id: string };
type Packet = { type?: string; data?: string; output?: string; reason?: string; owner?: string; exit_code?: number };

export async function runAttachClient(handoffPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Managed Claude attach requires a native terminal");
  let handoff: Handoff;
  try {
    handoff = JSON.parse(readFileSync(handoffPath, "utf8")) as Handoff;
  } finally {
    // This file carries a one-use local credential. Never leave it behind in
    // a terminal scrollback, command argument or reusable filesystem path.
    try { unlinkSync(handoffPath); } catch { /* already removed */ }
    try { rmdirSync(dirname(handoffPath)); } catch { /* may contain another file */ }
  }
  if (handoff.host !== "127.0.0.1" || !Number.isInteger(handoff.port) || handoff.port < 1 || handoff.port > 65535 || !handoff.token) {
    throw new Error("Invalid managed Claude terminal handoff");
  }
  const socket = createConnection({ host: handoff.host, port: handoff.port });
  let buffer = Buffer.alloc(0);
  let ready = false;
  let finished = false;
  const rawBefore = process.stdin.isRaw;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    process.stdin.off("data", forwardInput);
    process.stdout.off("resize", resize);
    if (!rawBefore) process.stdin.setRawMode(false);
    process.stdin.pause();
    socket.destroy();
  };
  const forwardInput = (data: Buffer) => {
    if (ready && !socket.destroyed) socket.write(JSON.stringify({ type: "input", data: data.toString("base64") }) + "\n");
  };
  const resize = () => {
    if (ready && !socket.destroyed) socket.write(JSON.stringify({ type: "resize", columns: process.stdout.columns, rows: process.stdout.rows }) + "\n");
  };
  socket.on("connect", () => socket.write(JSON.stringify({ type: "auth", token: handoff.token }) + "\n"));
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 4 * 1024 * 1024) { socket.destroy(new Error("Managed terminal packet too large")); return; }
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      let packet: Packet;
      try { packet = JSON.parse(line) as Packet; } catch { socket.destroy(new Error("Invalid managed terminal packet")); return; }
      if (packet.type === "ready") {
        ready = true;
        if (packet.output) process.stdout.write(Buffer.from(packet.output, "base64"));
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", forwardInput);
        process.stdout.on("resize", resize);
        resize();
        process.stderr.write(`\r\nPrism Claude session ${handoff.session_id} attached. Ctrl-] switches input ownership.\r\n`);
      } else if (packet.type === "output" && typeof packet.data === "string") {
        process.stdout.write(Buffer.from(packet.data, "base64"));
      } else if (packet.type === "input_rejected") {
        process.stderr.write(`\r\nPrism: ${packet.reason || "input lease unavailable"}\r\n`);
      } else if (packet.type === "lease") {
        process.stderr.write(`\r\nPrism input owner: ${packet.owner || "none"}\r\n`);
      } else if (packet.type === "stopped") {
        process.stderr.write(`\r\nClaude Code exited (${packet.exit_code ?? "unknown"}).\r\n`);
        socket.end();
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", () => { cleanup(); resolve(); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAttachClient(process.argv[2] || "").catch((error) => {
    process.stderr.write(`Prism managed terminal failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
