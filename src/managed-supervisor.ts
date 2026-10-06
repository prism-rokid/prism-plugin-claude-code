/** Detached owner of a single Claude PTY, independent of Hub/plugin restarts. */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedPtyBroker, type ManagedPtyBrokerOptions } from "./managed-pty-broker.js";
import type { TerminalSnapshot } from "./native-terminal-state.js";

export type SupervisorDescriptor = { version: 1; session_id: string; cwd: string; port: number; token: string; pid: number };
export type SupervisorRequest = { id: string; method: "snapshot" | "output_tail" | "open_terminal" | "terminal_handoff" | "shutdown"; native_session_id?: string };
const MAX_PACKET_BYTES = 1024 * 1024;

export class ManagedSupervisor {
  readonly broker: ManagedPtyBroker;
  readonly descriptorPath: string;
  private readonly token = randomBytes(32).toString("base64url");
  private server?: Server;
  private sockets = new Set<Socket>();
  private buffers = new WeakMap<Socket, Buffer>();
  private authorized = new WeakSet<Socket>();
  private closing = false;

  constructor(private readonly options: Omit<ManagedPtyBrokerOptions, "onStateChanged">) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.descriptorPath = join(options.dataDir, "supervisor.json");
    this.broker = new ManagedPtyBroker({
      ...options,
      onStateChanged: (terminal) => this.broadcast({ event: "terminal", terminal }),
    });
  }

  async start(): Promise<SupervisorDescriptor> {
    await this.broker.start(true);
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Supervisor control listener unavailable");
    const descriptor: SupervisorDescriptor = { version: 1, session_id: this.broker.sessionID, cwd: this.broker.cwd, port: address.port, token: this.token, pid: process.pid };
    const temporary = join(this.options.dataDir, `.supervisor-${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.descriptorPath);
    try { this.broker.launch(); }
    catch (error) { await this.close(); throw error; }
    return descriptor;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await this.broker.close();
    try { rmSync(this.descriptorPath, { force: true }); } catch {}
    writeFileSync(join(this.options.dataDir, "closed.json"), JSON.stringify({ session_id: this.broker.sessionID, supervisor_pid: process.pid, closed_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    this.buffers.set(socket, Buffer.alloc(0));
    socket.on("data", (chunk: Buffer) => this.consume(socket, chunk));
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  private consume(socket: Socket, chunk: Buffer): void {
    let buffer = Buffer.concat([this.buffers.get(socket) ?? Buffer.alloc(0), chunk]);
    if (buffer.length > MAX_PACKET_BYTES) { socket.destroy(); return; }
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) { this.buffers.set(socket, buffer); return; }
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(line) as Record<string, unknown>; } catch { socket.destroy(); return; }
      if (!this.authorized.has(socket)) {
        if (packet.type !== "auth" || packet.token !== this.token) { socket.destroy(); return; }
        this.authorized.add(socket);
        this.write(socket, { type: "ready", session_id: this.broker.sessionID, terminal: this.broker.snapshot() });
        continue;
      }
      void this.dispatch(socket, packet as SupervisorRequest);
    }
  }

  private async dispatch(socket: Socket, request: SupervisorRequest): Promise<void> {
    if (typeof request.id !== "string" || !request.id) { socket.destroy(); return; }
    try {
      let payload: unknown;
      if (request.method === "snapshot") payload = this.broker.snapshot();
      else if (request.method === "output_tail") payload = this.broker.recentOutput();
      else if (request.method === "open_terminal" && typeof request.native_session_id === "string") {
        await this.broker.openManagedTerminal(request.native_session_id);
        payload = { ok: true };
      } else if (request.method === "terminal_handoff" && typeof request.native_session_id === "string") {
        payload = this.broker.terminalHandoff(request.native_session_id);
      } else if (request.method === "shutdown") {
        this.write(socket, { id: request.id, ok: true, payload: { ok: true } });
        setImmediate(() => { void this.close(); });
        return;
      } else throw new Error("unsupported_supervisor_method");
      this.write(socket, { id: request.id, ok: true, payload });
    } catch (error) {
      this.write(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private broadcast(payload: Record<string, unknown>): void {
    for (const socket of this.sockets) if (this.authorized.has(socket)) this.write(socket, payload);
  }
  private write(socket: Socket, payload: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(JSON.stringify(payload) + "\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sessionID, cwd, cliPath, helperPath, dataDir, launchMode] = process.argv.slice(2);
  const supervisor = new ManagedSupervisor({ sessionID, cwd, cliPath, helperPath, dataDir, resumeSession: launchMode === "resume" });
  supervisor.start().catch((error) => {
    process.stderr.write(`Prism Claude supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
  const stop = () => { void supervisor.close().finally(() => { process.exitCode = 0; }); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export function readSupervisorDescriptor(path: string): SupervisorDescriptor {
  const value = JSON.parse(readFileSync(path, "utf8")) as SupervisorDescriptor;
  if (value.version !== 1 || !value.session_id || typeof value.cwd !== "string" || !Number.isInteger(value.port) || !value.token) throw new Error("Invalid Claude supervisor descriptor");
  return value;
}
