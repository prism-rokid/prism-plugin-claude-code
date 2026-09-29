import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { ManagedInputArbiter, ManagedTerminalStatus, PersistentDeliveryLedger, TerminalSnapshot } from "./managed-input-arbiter.js";
import { ManagedInputArbiter as InputArbiter } from "./managed-input-arbiter.js";

const MAX_LINE_BYTES = 1024 * 1024;

export interface ManagedPtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type ManagedPtySpawner = (
  command: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => ManagedPtyProcess;

export type ManagedPtyBrokerOptions = {
  sessionID: string;
  cwd: string;
  cliPath: string;
  helperPath: string;
  dataDir: string;
  ledger: PersistentDeliveryLedger;
  onStateChanged?: (snapshot: TerminalSnapshot) => void;
  onOutput?: (data: string) => void;
  spawner?: ManagedPtySpawner;
  childSpawner?: typeof spawnChild;
  platform?: NodeJS.Platform;
  executablePath?: string;
  hookSettingsPath?: string;
  startReady?: boolean;
  attachTimeoutMs?: number;
  resumeSession?: boolean;
};

export type ManagedTerminalHandoff = { host: string; port: number; token: string; session_id: string };

function safeSessionID(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid Claude native session ID");
  return value;
}

function writePacket(socket: Socket, value: Record<string, unknown>): void {
  if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n");
}

/**
 * Owns the PTY master for one Claude CLI process. The native Terminal helper
 * only receives an authenticated loopback byte stream; it never attaches to
 * the PTY directly. Panel and local input therefore pass through one arbiter.
 */
export class ManagedPtyBroker {
  readonly sessionID: string;
  readonly cwd: string;
  pty!: ManagedPtyProcess;
  readonly input: ManagedInputArbiter;
  private server?: Server;
  private client?: Socket;
  private token = randomBytes(32).toString("base64url");
  private lineBuffers = new WeakMap<Socket, Buffer>();
  private status: ManagedTerminalStatus = "starting";
  private outputTail = "";
  private ptyDataSubscription?: { dispose(): void };
  private ptyExitSubscription?: { dispose(): void };
  private attachWaiter?: { resolve(): void; reject(error: Error): void };
  private readonly platform: NodeJS.Platform;
  private readonly childSpawner: typeof spawnChild;
  private readonly executablePath: string;

  constructor(private readonly options: ManagedPtyBrokerOptions) {
    this.sessionID = safeSessionID(options.sessionID);
    this.cwd = options.cwd;
    this.platform = options.platform ?? process.platform;
    this.childSpawner = options.childSpawner ?? spawnChild;
    this.executablePath = options.executablePath ?? process.execPath;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.input = new InputArbiter({ write: (data) => this.pty.write(data) }, options.ledger, (snapshot) => {
      this.status = snapshot.status;
      options.onStateChanged?.({ ...snapshot, status: this.status });
    });
  }

  launch(): void {
    if (this.pty) return;
    const spawner = this.options.spawner ?? ((command, args, opts) => spawnPty(command, args, opts) as IPty);
    // A stable session ID is explicit. We never use --resume here: an attach
    // request must only connect to an already-owned PTY broker.
    this.pty = spawner(this.options.cliPath, [this.options.resumeSession ? "--resume" : "--session-id", this.sessionID, "--permission-mode", "default", ...(this.options.hookSettingsPath ? ["--settings", this.options.hookSettingsPath] : [])], {
      name: "xterm-256color", cols: 100, rows: 32, cwd: this.options.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    this.ptyDataSubscription = this.pty.onData((data) => {
      this.outputTail = (this.outputTail + data).slice(-64 * 1024);
      if (!this.input.isStarted() && this.status !== "stopped" && !this.input.snapshot().setup_required) {
        const prompt = this.outputTail.slice(-4096).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "").toLowerCase();
        if (prompt.includes("no,exit") && prompt.includes("yes,itrustthisfolder")) this.input.setSetupRequired();
      }
      this.options.onOutput?.(data);
      if (this.client && !this.client.destroyed) writePacket(this.client, { type: "output", data: Buffer.from(data, "utf8").toString("base64") });
    });
    this.ptyExitSubscription = this.pty.onExit((event) => {
      this.status = "stopped";
      this.input.setStopped();
      if (this.client) writePacket(this.client, { type: "stopped", exit_code: event.exitCode, signal: event.signal });
    });
    if (this.options.startReady !== false) this.input.setStarted();
  }

  async start(deferLaunch = false): Promise<void> {
    if (this.server) return;
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    if (!deferLaunch) this.launch();
  }

  snapshot(): TerminalSnapshot { return { ...this.input.snapshot(), status: this.status }; }
  recentOutput(): string { return this.outputTail; }

  async sendPanel(requestID: string, text: string) { return await this.input.panelSend(requestID, text); }
  async interrupt(): Promise<boolean> { return await this.input.interrupt(); }

  /** Only attach to this in-memory managed PTY. Missing sessions fail closed. */
  async openManagedTerminal(nativeSessionID: string): Promise<void> {
    const connection = this.terminalHandoff(nativeSessionID);
    const handoff = this.createHandoff(connection);
    let rejectAttach!: (error: Error) => void;
    const attached = new Promise<void>((resolve, reject) => {
      rejectAttach = reject;
      this.attachWaiter = { resolve, reject };
    });
    const timeout = setTimeout(() => this.attachWaiter?.reject(new Error("native_terminal_attach_timeout")), this.options.attachTimeoutMs ?? 15_000);
    let launcher: ChildProcess | undefined;
    let confirmed = false;
    try {
      launcher = this.launchTerminalClient(handoff);
      await attached;
      confirmed = true;
    } catch (error) {
      if (!launcher) {
        rejectAttach(error instanceof Error ? error : new Error(String(error)));
        await attached.catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.attachWaiter = undefined;
      if (!confirmed && typeof launcher?.kill === "function") launcher.kill();
      try { rmSync(handoff, { force: true }); } catch {}
      try { rmSync(dirname(handoff), { recursive: true, force: true }); } catch {}
    }
  }

  /** Authenticated callers can attach their already-open native Terminal. */
  terminalHandoff(nativeSessionID: string): ManagedTerminalHandoff {
    if (safeSessionID(nativeSessionID) !== this.sessionID) throw new Error("managed_session_not_found");
    if (this.status === "stopped") throw new Error("managed_session_not_found");
    if (this.client && !this.client.destroyed) throw new Error("local_terminal_already_attached");
    if (this.attachWaiter) throw new Error("local_terminal_launch_pending");
    if (!this.server || !this.server.address() || typeof this.server.address() === "string") throw new Error("managed_session_not_found");
    const address = this.server.address() as { port: number };
    return { host: "127.0.0.1", port: address.port, token: this.token, session_id: this.sessionID };
  }

  async close(): Promise<void> {
    this.attachWaiter?.reject(new Error("managed_session_not_found"));
    this.ptyDataSubscription?.dispose();
    this.ptyExitSubscription?.dispose();
    this.client?.destroy();
    this.client = undefined;
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    // Plugin shutdown owns the PTY lifecycle in this first version. A detached
    // supervisor is required before claiming Hub/plugin restart survival.
    this.pty?.kill();
    this.token = "";
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    this.lineBuffers.set(socket, Buffer.alloc(0));
    socket.on("data", (chunk) => this.consume(socket, Buffer.from(chunk)));
    socket.on("error", () => { if (this.client === socket) this.detach(socket); });
    socket.on("close", () => { if (this.client === socket) this.detach(socket); });
  }

  private consume(socket: Socket, chunk: Buffer): void {
    let lineBuffer = Buffer.concat([this.lineBuffers.get(socket) ?? Buffer.alloc(0), chunk]);
    if (lineBuffer.length > MAX_LINE_BYTES) { socket.destroy(); return; }
    for (;;) {
      const newline = lineBuffer.indexOf(0x0a);
      if (newline < 0) { this.lineBuffers.set(socket, lineBuffer); return; }
      const line = lineBuffer.subarray(0, newline).toString("utf8");
      lineBuffer = lineBuffer.subarray(newline + 1);
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(line) as Record<string, unknown>; } catch { socket.destroy(); return; }
      if (!this.client) {
        if (packet.type !== "auth" || packet.token !== this.token) { socket.destroy(); return; }
        if (this.client && this.client !== socket) { socket.destroy(); return; }
        this.client = socket;
        const attached = this.input.attachLocal();
        writePacket(socket, { type: "ready", session_id: this.sessionID, owner: attached.owner, read_only: attached.readOnly, terminal: this.snapshot(), output: Buffer.from(this.outputTail, "utf8").toString("base64") });
        this.pty.resize(100, 32); // Ask the TUI to redraw after a detached interval.
        this.attachWaiter?.resolve();
        continue;
      }
      if (this.client !== socket) { socket.destroy(); return; }
      void this.handleClientPacket(socket, packet);
    }
  }

  private async handleClientPacket(socket: Socket, packet: Record<string, unknown>): Promise<void> {
    if (packet.type === "input" && typeof packet.data === "string") {
      const decoded = Buffer.from(packet.data, "base64").toString("utf8");
      const result = await this.input.localInput(decoded);
      if (!result.accepted) writePacket(socket, { type: "input_rejected", reason: result.reason || "input lease unavailable" });
      else if (result.control) writePacket(socket, { type: "lease", owner: this.snapshot().input_owner, terminal: this.snapshot() });
      return;
    }
    if (packet.type === "resize") {
      const columns = Number(packet.columns), rows = Number(packet.rows);
      if (Number.isInteger(columns) && Number.isInteger(rows) && columns >= 20 && columns <= 500 && rows >= 5 && rows <= 300) this.pty.resize(columns, rows);
    }
  }

  private detach(socket: Socket): void {
    if (this.client !== socket) return;
    this.client = undefined;
    this.lineBuffers.delete(socket);
    this.input.detachLocal();
  }

  private createHandoff(value: ManagedTerminalHandoff): string {
    const dir = mkdtempSync(join(tmpdir(), "prism-claude-attach-"));
    try { chmodSync(dir, 0o700); } catch {}
    const file = join(dir, "connection.json");
    writeFileSync(file, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(file, "r");
    try { closeSync(fd); } catch {}
    return file;
  }

  private launchTerminalClient(handoffFile: string): ChildProcess {
    const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const command = shellQuote(this.executablePath) + " " + shellQuote(this.options.helperPath) + " " + shellQuote(handoffFile);
    let child: ChildProcess;
    if (this.platform === "darwin") {
      const script = "tell application \"Terminal\" to do script " + JSON.stringify(command);
      child = this.childSpawner("/usr/bin/osascript", ["-e", script], { detached: true, stdio: "ignore" });
    } else if (this.platform === "win32") {
      child = this.childSpawner("wt.exe", ["new-tab", this.executablePath, this.options.helperPath, handoffFile], { detached: true, stdio: "ignore" });
    } else {
      child = this.childSpawner("x-terminal-emulator", ["-e", this.executablePath, this.options.helperPath, handoffFile], { detached: true, stdio: "ignore" });
    }
    child.once("error", (error) => {
      this.attachWaiter?.reject(error);
      try { rmSync(handoffFile, { force: true }); } catch {}
    });
    child.once("exit", (code) => { if (code !== 0) this.attachWaiter?.reject(new Error(`native_terminal_launch_failed:${code ?? "unknown"}`)); });
    child.unref();
    return child;
  }
}
