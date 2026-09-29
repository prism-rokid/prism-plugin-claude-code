/** Plugin-side authenticated connection to a detached Claude PTY supervisor. */
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { readSupervisorDescriptor, type SupervisorDescriptor } from "./managed-supervisor.js";
import type { DeliveryRecord, PanelSendResult, TerminalSnapshot } from "./managed-input-arbiter.js";
import type { ManagedTerminalHandoff } from "./managed-pty-broker.js";

export class ManagedSupervisorClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private state: TerminalSnapshot | undefined;
  private constructor(private readonly socket: Socket, readonly descriptor: SupervisorDescriptor, private readonly onState?: (state: TerminalSnapshot) => void, private readonly onHook?: (hook: Record<string, unknown>, eventID?: string, replayed?: boolean, createdAt?: string) => void) {
    socket.on("data", (chunk: Buffer) => this.consume(chunk));
    socket.on("close", () => this.failAll(new Error("Claude supervisor disconnected")));
    socket.on("error", (error) => this.failAll(error));
  }

  static async connect(descriptorPath: string, onState?: (state: TerminalSnapshot) => void, onHook?: (hook: Record<string, unknown>, eventID?: string, replayed?: boolean, createdAt?: string) => void): Promise<ManagedSupervisorClient> {
    const descriptor = readSupervisorDescriptor(descriptorPath);
    const socket = createConnection({ host: "127.0.0.1", port: descriptor.port });
    const client = new ManagedSupervisorClient(socket, descriptor, onState, onHook);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (_state: TerminalSnapshot) => { client.offReady(onReady); socket.off("close", onClose); resolve(); };
      const onClose = () => { client.offReady(onReady); reject(new Error("Claude supervisor authentication failed")); };
      client.readyListeners.add(onReady);
      socket.once("close", onClose);
    });
    socket.write(JSON.stringify({ type: "auth", token: descriptor.token }) + "\n");
    await ready;
    return client;
  }

  private readonly readyListeners = new Set<(state: TerminalSnapshot) => void>();
  private offReady(listener: (state: TerminalSnapshot) => void): void { this.readyListeners.delete(listener); }
  snapshot(): TerminalSnapshot | undefined { return this.state && { ...this.state }; }
  async refresh(): Promise<TerminalSnapshot> { return await this.call<TerminalSnapshot>({ method: "snapshot" }); }
  async recentOutput(): Promise<string> { return await this.call<string>({ method: "output_tail" }); }
  async replayHooks(): Promise<number> { const result = await this.call<{ count: number }>({ method: "replay_hooks" }); return result.count; }
  async ackHook(eventID: string): Promise<void> { await this.call({ method: "ack_hook", event_id: eventID }); }
  async send(requestID: string, text: string): Promise<PanelSendResult> { return await this.call<PanelSendResult>({ method: "send", request_id: requestID, text }); }
  async delivery(requestID: string): Promise<DeliveryRecord | null> { return await this.call<DeliveryRecord | null>({ method: "delivery", request_id: requestID }); }
  async interrupt(): Promise<boolean> { const result = await this.call<{ interrupted: boolean }>({ method: "interrupt" }); return result.interrupted; }
  async approval(): Promise<Record<string, unknown> | null> { return await this.call<Record<string, unknown> | null>({ method: "approval" }); }
  async resolveApproval(approvalRequestID: string, actionID: string): Promise<void> { await this.call({ method: "resolve_approval", approval_request_id: approvalRequestID, action_id: actionID }); }
  async openTerminal(nativeSessionID: string): Promise<void> { await this.call({ method: "open_terminal", native_session_id: nativeSessionID }); }
  async terminalHandoff(nativeSessionID: string): Promise<ManagedTerminalHandoff> { return await this.call<ManagedTerminalHandoff>({ method: "terminal_handoff", native_session_id: nativeSessionID }); }
  async shutdown(): Promise<void> { await this.call({ method: "shutdown" }); }
  close(): void { this.socket.destroy(); this.failAll(new Error("Claude supervisor client closed")); }

  private call<T>(fields: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Claude supervisor disconnected"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.write(JSON.stringify({ id, ...fields }) + "\n");
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 4 * 1024 * 1024) { this.socket.destroy(new Error("Claude supervisor packet too large")); return; }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      let packet: Record<string, unknown>;
      try { packet = JSON.parse(line) as Record<string, unknown>; } catch { this.socket.destroy(new Error("Invalid Claude supervisor packet")); return; }
      if (packet.type === "ready" || packet.event === "terminal") {
        if (packet.terminal && typeof packet.terminal === "object") {
          const state = packet.terminal as TerminalSnapshot;
          this.state = state;
          this.onState?.(state);
          if (packet.type === "ready") for (const listener of this.readyListeners) listener(state);
        }
        continue;
      }
      if (packet.event === "hook" && packet.hook && typeof packet.hook === "object") {
        this.onHook?.(packet.hook as Record<string, unknown>, typeof packet.event_id === "string" ? packet.event_id : undefined, packet.replayed === true, typeof packet.created_at === "string" ? packet.created_at : undefined);
        continue;
      }
      if (typeof packet.id !== "string") continue;
      const pending = this.pending.get(packet.id);
      if (!pending) continue;
      this.pending.delete(packet.id);
      if (packet.ok === true) pending.resolve(packet.payload);
      else pending.reject(new Error(typeof packet.error === "string" ? packet.error : "Claude supervisor request failed"));
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
