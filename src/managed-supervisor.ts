/** Detached owner of a single Claude PTY, independent of Hub/plugin restarts. */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { ManagedPtyBroker, type ManagedPtyBrokerOptions } from "./managed-pty-broker.js";
import { PersistentDeliveryLedger } from "./managed-input-arbiter.js";
import { PersistentHookOutbox } from "./managed-hook-outbox.js";

export type SupervisorDescriptor = { version: 1; session_id: string; cwd: string; port: number; token: string; pid: number };
export type SupervisorRequest = { id: string; method: "snapshot" | "output_tail" | "replay_hooks" | "ack_hook" | "send" | "delivery" | "interrupt" | "approval" | "resolve_approval" | "open_terminal" | "hook" | "shutdown"; request_id?: string; event_id?: string; text?: string; native_session_id?: string; approval_request_id?: string; action_id?: string; payload?: Record<string, unknown> };
const MAX_PACKET_BYTES = 1024 * 1024;
type TranscriptRow = { type?: string; timestamp?: string; message?: { content?: unknown } };

function hasInterruptedMarker(row: TranscriptRow, after: number): boolean {
  if (row.type !== "user" || typeof row.timestamp !== "string" || Date.parse(row.timestamp) < after) return false;
  const content = row.message?.content;
  return Array.isArray(content) && content.some((block) => block && typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    /^\[Request interrupted by user(?: for tool use)?\]$/.test(String((block as { text?: unknown }).text || "")));
}

export class ManagedSupervisor {
  readonly broker: ManagedPtyBroker;
  readonly descriptorPath: string;
  private readonly token = randomBytes(32).toString("base64url");
  private server?: Server;
  private sockets = new Set<Socket>();
  private buffers = new WeakMap<Socket, Buffer>();
  private authorized = new WeakSet<Socket>();
  private pendingApproval?: { id: string; toolName: string; title: string; description: string; createdAt: number; resolve: (decision: "allow" | "deny") => void; timer: NodeJS.Timeout };
  private interruptMonitor?: Promise<void>;
  private closing = false;
  private readonly hookOutbox: PersistentHookOutbox;

  constructor(private readonly options: Omit<ManagedPtyBrokerOptions, "ledger" | "onStateChanged"> & { readTranscriptRows?: () => Promise<TranscriptRow[]> }) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.descriptorPath = join(options.dataDir, "supervisor.json");
    const hookScript = fileURLToPath(new URL("./managed-hook.js", import.meta.url));
    const hookSettingsPath = join(options.dataDir, "prism-hooks-settings.json");
    const hooks: Record<string, unknown> = {};
    for (const name of ["SessionStart", "UserPromptSubmit", "MessageDisplay", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "Stop", "StopFailure", "SessionEnd"]) {
      hooks[name] = [{ hooks: [{ type: "command", command: process.execPath, args: [hookScript, this.descriptorPath], timeout: name === "PermissionRequest" ? 120 : 10 }] }];
    }
    writeFileSync(hookSettingsPath, JSON.stringify({ hooks }), { mode: 0o600 });
    this.hookOutbox = new PersistentHookOutbox(options.dataDir);
    this.broker = new ManagedPtyBroker({
      ...options,
      hookSettingsPath,
      startReady: false,
      ledger: new PersistentDeliveryLedger(join(options.dataDir, "delivery-ledger.json")),
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
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.descriptorPath);
    try { this.broker.launch(); }
    catch (error) { await this.close(); throw error; }
    return descriptor;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.resolvePendingApproval("deny");
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await this.broker.close();
    try { rmSync(this.descriptorPath, { force: true }); } catch {}
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
      else if (request.method === "replay_hooks") {
        const events = this.hookOutbox.replay();
        for (const event of events) this.write(socket, { event: "hook", ...event, replayed: true });
        payload = { count: events.length };
      } else if (request.method === "ack_hook" && typeof request.event_id === "string") {
        payload = { removed: this.hookOutbox.ack(request.event_id) };
      } else if (request.method === "send" && typeof request.request_id === "string" && typeof request.text === "string") {
        payload = await this.broker.sendPanel(request.request_id, request.text);
      } else if (request.method === "delivery" && typeof request.request_id === "string") {
        payload = this.broker.input.ledger.get(request.request_id) ?? null;
      } else if (request.method === "interrupt") {
        const startedAt = Date.now();
        const interrupted = await this.broker.interrupt();
        if (interrupted && !this.interruptMonitor) {
          this.interruptMonitor = this.reconcileInterrupt(startedAt - 500).finally(() => { this.interruptMonitor = undefined; });
        }
        payload = { interrupted };
      } else if (request.method === "approval") {
        payload = this.approvalSnapshot();
      } else if (request.method === "resolve_approval" && typeof request.approval_request_id === "string" && typeof request.action_id === "string") {
        if (!this.pendingApproval || this.pendingApproval.id !== request.approval_request_id) throw new Error("approval_stale");
        if (request.action_id !== "allow_once" && request.action_id !== "deny") throw new Error("approval_action_unavailable");
        this.resolvePendingApproval(request.action_id === "allow_once" ? "allow" : "deny");
        payload = { ok: true };
      } else if (request.method === "open_terminal" && typeof request.native_session_id === "string") {
        await this.broker.openManagedTerminal(request.native_session_id);
        payload = { ok: true };
      } else if (request.method === "shutdown") {
        this.write(socket, { id: request.id, ok: true, payload: { ok: true } });
        setImmediate(() => { void this.close(); });
        return;
      } else if (request.method === "hook" && request.payload && request.payload.session_id === this.broker.sessionID) {
        payload = { hook_response: await this.handleHook(request.payload) };
      } else throw new Error("unsupported_supervisor_method");
      this.write(socket, { id: request.id, ok: true, payload });
    } catch (error) {
      this.write(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleHook(hook: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const kind = typeof hook.hook_event_name === "string" ? hook.hook_event_name : "";
    if (kind === "SessionStart") {
      this.broker.input.setStarted();
    } else if (kind === "UserPromptSubmit" && typeof hook.prompt === "string") {
      this.broker.input.promptSubmitted(hook.prompt, typeof hook.turn_id === "string" ? hook.turn_id : "");
    } else if (kind === "Stop" || kind === "StopFailure") {
      this.broker.input.turnCompleted(typeof hook.turn_id === "string" ? hook.turn_id : undefined, kind === "StopFailure");
      this.broker.input.setApprovalPending(false);
    } else if (kind === "PermissionRequest") {
      if (this.broker.snapshot().input_owner === "panel") {
        if (this.pendingApproval) {
          return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Concurrent remote permission request cannot be safely shown" } } };
        }
        const id = randomUUID();
        const toolName = typeof hook.tool_name === "string" ? hook.tool_name : "Claude tool";
        const input = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input as Record<string, unknown> : {};
        const description = typeof input.command === "string" ? input.command.slice(0, 2000) : typeof input.file_path === "string" ? input.file_path.slice(0, 2000) : JSON.stringify(input).slice(0, 2000);
        this.broker.input.setApprovalPending(true, true);
        const decision = new Promise<"allow" | "deny">((resolve) => {
          const timer = setTimeout(() => this.resolvePendingApproval("deny"), 110_000);
          this.pendingApproval = { id, toolName, title: `${toolName} permission`, description, createdAt: Date.now(), resolve, timer };
        });
        this.broadcastHook({ ...hook, approval_request_id: id, approval: this.approvalSnapshot() });
        const outcome = await decision;
        return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: outcome, ...(outcome === "deny" ? { message: "Denied or expired in Prism Panel" } : {}) } } };
      }
      this.broker.input.setApprovalPending(true, false);
    } else if (kind === "PostToolUse" || kind === "PostToolUseFailure" || kind === "PermissionDenied") {
      this.broker.input.setApprovalPending(false);
    }
    this.broadcastHook(hook);
    return null;
  }

  private approvalSnapshot(): Record<string, unknown> | null {
    const item = this.pendingApproval;
    if (!item) return null;
    return { approval_request_id: item.id, title: item.title, summary: item.toolName, description: item.description, created_at: item.createdAt, actions: [
      { id: "allow_once", label: "Allow once", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ] };
  }

  private resolvePendingApproval(decision: "allow" | "deny"): void {
    const item = this.pendingApproval;
    if (!item) return;
    this.pendingApproval = undefined;
    clearTimeout(item.timer);
    item.resolve(decision);
    this.broker.input.setApprovalPending(false);
    this.broadcastHook({ hook_event_name: "PrismApprovalResolved", session_id: this.broker.sessionID, approval_request_id: item.id, action_id: decision === "allow" ? "allow_once" : "deny" });
  }

  private async reconcileInterrupt(after: number): Promise<void> {
    for (let attempt = 0; attempt < 60 && !this.closing; attempt++) {
      if (!this.broker.snapshot().can_interrupt) return; // Stop or CLI exit already settled it.
      try {
        const rows = this.options.readTranscriptRows
          ? await this.options.readTranscriptRows()
          : await getSessionMessages(this.broker.sessionID, { limit: 2000 }) as TranscriptRow[];
        if (rows.some((row) => hasInterruptedMarker(row, after))) {
          this.broker.input.turnCompleted();
          this.broadcastHook({ hook_event_name: "PrismRunInterrupted", session_id: this.broker.sessionID });
          return;
        }
      } catch { /* Transcript may still be flushing. Retry within the bound. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private broadcast(payload: Record<string, unknown>): void {
    for (const socket of this.sockets) if (this.authorized.has(socket)) this.write(socket, payload);
  }
  private broadcastHook(hook: Record<string, unknown>): void {
    const kind = typeof hook.hook_event_name === "string" ? hook.hook_event_name : "";
    if (["UserPromptSubmit", "MessageDisplay", "Stop", "StopFailure", "PrismRunInterrupted"].includes(kind)) {
      // The transcript owns message bodies and tool inputs. The outbox only
      // needs enough information to trigger reconciliation after reconnect.
      const event = this.hookOutbox.append({
        hook_event_name: kind,
        session_id: this.broker.sessionID,
        ...(typeof hook.turn_id === "string" ? { turn_id: hook.turn_id } : {}),
      });
      this.broadcast({ event: "hook", event_id: event.event_id, created_at: event.created_at, hook });
    } else {
      this.broadcast({ event: "hook", event_id: randomUUID(), created_at: new Date().toISOString(), hook });
    }
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
