import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModSession = {
  session_id: string;
  cwd: string;
  pid?: number;
  client_instance_id?: string;
  version: string;
  surface: string[];
  seen_at: number;
  turn_id?: string;
  draft?: { text: string; cursor: number } | null;
};
export type ModEvent = Record<string, unknown> & { kind: string; sessionId: string };
export type ModCommand = { id: string; action: "read" | "submit" | "abort" | "models.read" | "model.set"; text?: string; model?: string; turnId?: string; requestId?: string; delivered?: boolean };
export type ModRemoteSubmission = { requestId: string; turnId?: string; accepted: boolean; ambiguous: boolean };

type Pending = { command: ModCommand; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Approval = { id: string; requestId: string; toolName: string; description: string; createdAt: number; resolve: (decision: "allow" | "deny") => void; timer: NodeJS.Timeout };

/** Authenticated loopback bridge between a user-scoped Claude Code Mod and PluginBridge. */
export class ModBridge {
  readonly descriptorPath: string;
  readonly instanceID = randomUUID();
  private readonly token = randomBytes(32).toString("base64url");
  private server?: Server;
  private sessions = new Map<string, ModSession>();
  private conflictedSessions = new Set<string>();
  private ownerHeartbeats = new Map<string, Map<string, number>>();
  private commands = new Map<string, ModCommand[]>();
  private pending = new Map<string, Pending>();
  private approvals = new Map<string, Approval>();
  private inFlight = new Map<string, ModCommand>();
  private remoteTurn = new Map<string, { requestId: string; turnId?: string; accepted: boolean; ambiguous: boolean }>();
  private deferredCompletion = new Map<string, ModEvent>();
  private listeners = new Set<(event: ModEvent) => void>();
  private descriptor?: { version: 1; instance_id: string; port: number; token: string };

  constructor(readonly stateDir = process.env.PRISM_CLAUDE_MOD_STATE_DIR || join(homedir(), ".prism", "claudecode")) {
    this.descriptorPath = join(stateDir, "mod-bridge.json");
  }

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mod bridge listener unavailable");
    this.descriptor = { version: 1, instance_id: this.instanceID, port: address.port, token: this.token };
    const temporary = `${this.descriptorPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.descriptor), { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.descriptorPath);
  }

  onEvent(listener: (event: ModEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  session(id: string): ModSession | undefined { const value = this.sessions.get(id); return value && { ...value }; }
  sessionsSnapshot(): ModSession[] { return [...this.sessions.values()].map((value) => ({ ...value })); }
  remoteRequestForTurn(sessionID: string, turnID: string): string | undefined {
    const active = this.remoteTurn.get(sessionID);
    return active && active.accepted && !active.ambiguous && active.turnId === turnID ? active.requestId : undefined;
  }
  activeRemoteTurn(sessionID: string): { requestId: string; turnId: string } | undefined {
    const active = this.remoteTurn.get(sessionID);
    return active && active.accepted && !active.ambiguous && active.turnId ? { requestId: active.requestId, turnId: active.turnId } : undefined;
  }
  remoteSubmission(sessionID: string): ModRemoteSubmission | undefined { const value = this.remoteTurn.get(sessionID); return value && { ...value }; }
  reconcileExitedOwner(sessionID: string): { released: boolean; requestID?: string } {
    const session = this.sessions.get(sessionID);
    if (session && Date.now() - session.seen_at <= 5000) return { released: false };
    const requestID = this.remoteTurn.get(sessionID)?.requestId || this.inFlight.get(sessionID)?.requestId;
    this.revokeOwner(sessionID);
    this.sessions.delete(sessionID);
    this.conflictedSessions.delete(sessionID);
    this.ownerHeartbeats.delete(sessionID);
    return { released: true, ...(requestID ? { requestID } : {}) };
  }
  approval(sessionID: string): Record<string, unknown> | null {
    const value = this.approvals.get(sessionID);
    return value ? { approval_request_id: value.id, title: `${value.toolName} permission`, summary: value.toolName, description: value.description, created_at: value.createdAt, actions: [{ id: "allow_once", label: "Allow once", style: "primary" }, { id: "deny", label: "Deny", style: "danger" }] } : null;
  }
  async resolveApproval(sessionID: string, approvalID: string, actionID: string): Promise<void> {
    const item = this.approvals.get(sessionID);
    const active = this.activeRemoteTurn(sessionID);
    if (!item || item.id !== approvalID || !active || active.requestId !== item.requestId) throw new Error("approval_stale");
    if (actionID !== "allow_once" && actionID !== "deny") throw new Error("approval_action_unavailable");
    this.approvals.delete(sessionID); clearTimeout(item.timer); item.resolve(actionID === "allow_once" ? "allow" : "deny");
  }

  async waitForSession(id: string, timeoutMs = 10_000): Promise<ModSession> {
    const existing = this.sessions.get(id);
    if (existing && Date.now() - existing.seen_at < 5000) return { ...existing };
    return await new Promise<ModSession>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("mod_session_not_connected")); }, timeoutMs);
      const off = this.onEvent((event) => {
        if ((event.kind !== "session.start" && event.kind !== "session.current") || event.sessionId !== id) return;
        clearTimeout(timer); off();
        const session = this.sessions.get(id);
        if (session) resolve({ ...session }); else reject(new Error("mod_session_unavailable"));
      });
    });
  }

  async command(sessionID: string, action: ModCommand["action"], fields: Omit<ModCommand, "id" | "action"> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionID);
    if (!session || Date.now() - session.seen_at > 5000) throw new Error("mod_session_not_connected");
    if ((action === "submit" || action === "model.set") && (session.turn_id || this.inFlight.has(sessionID) || (this.commands.get(sessionID)?.length || 0) > 0)) throw new Error("session_busy");
    if (action === "abort") {
      const active = this.remoteTurn.get(sessionID);
      if (!active || !active.turnId || !fields.turnId || active.turnId !== fields.turnId || active.ambiguous) throw new Error("remote_turn_identity_unavailable");
    }
    const command: ModCommand = { ...fields, id: randomUUID(), action };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        const queued = this.commands.get(sessionID) || [];
        const stillQueued = queued.some((item) => item.id === command.id);
        this.commands.set(sessionID, queued.filter((item) => item.id !== command.id));
        // Once /next has handed a command to the Mod, a lost acknowledgement is
        // ambiguous: the prompt may still execute. Keep the session locked.
        if (stillQueued) {
          if (this.inFlight.get(sessionID)?.id === command.id) this.inFlight.delete(sessionID);
          if (this.remoteTurn.get(sessionID)?.requestId === command.requestId) this.remoteTurn.delete(sessionID);
        } else if (command.delivered && command.action === "submit") {
          const active = this.remoteTurn.get(sessionID);
          if (active && active.requestId === command.requestId) active.ambiguous = true;
        }
        reject(new Error("mod_command_timeout"));
      }, timeoutMs);
      this.pending.set(command.id, { command, resolve, reject, timer });
      const queue = this.commands.get(sessionID) || [];
      queue.push(command); this.commands.set(sessionID, queue);
      if (action === "submit") {
        this.inFlight.set(sessionID, command);
        this.remoteTurn.set(sessionID, { requestId: command.requestId!, accepted: false, ambiguous: false });
      }
    });
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("mod_bridge_closed")); }
    for (const approval of this.approvals.values()) { clearTimeout(approval.timer); approval.resolve("deny"); }
    this.approvals.clear();
    this.ownerHeartbeats.clear(); this.conflictedSessions.clear();
    this.pending.clear(); this.commands.clear(); this.inFlight.clear(); this.remoteTurn.clear(); this.deferredCompletion.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    try {
      const current = JSON.parse(readFileSync(this.descriptorPath, "utf8")) as { instance_id?: string };
      if (current.instance_id === this.instanceID) { const { rmSync } = await import("node:fs"); rmSync(this.descriptorPath, { force: true }); }
    } catch { /* A newer bridge or no descriptor owns the stable path. */ }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || !req.url || !["/event", "/next", "/permission", "/resolve-approval"].includes(new URL(req.url, "http://127.0.0.1").pathname)) return this.respond(res, 404, { error: "not_found" });
    if (!this.authorized(req)) return this.respond(res, 401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try { body = await this.readBody(req); } catch { return this.respond(res, 400, { error: "invalid_json" }); }
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/permission") return await this.permission(body, res);
    if (path === "/resolve-approval") {
      try {
        await this.resolveApproval(String(body.sessionId || ""), String(body.approvalRequestId || ""), String(body.actionId || ""));
        return this.respond(res, 200, { ok: true });
      } catch (error) { return this.respond(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (path === "/next") {
      const id = typeof body.sessionId === "string" ? body.sessionId : "";
      const session = this.sessions.get(id);
      if (this.conflictedSessions.has(id) || !session || typeof body.clientInstanceId !== "string" || session.client_instance_id !== body.clientInstanceId || Date.now() - session.seen_at > 5000) return this.respond(res, 409, { error: "mod_session_owner_mismatch" });
      const queue = this.commands.get(id) || [];
      const command = queue.shift() || null;
      if (command) command.delivered = true;
      this.commands.set(id, queue);
      return this.respond(res, 200, command || {});
    }
    if (typeof body.kind !== "string" || typeof body.sessionId !== "string") return this.respond(res, 400, { error: "invalid_event" });
    let event = body as ModEvent;
    if (typeof event.clientInstanceId !== "string" || !event.clientInstanceId) return this.respond(res, 400, { error: "missing_client_instance" });
    if ((event.kind === "turn.start" || event.kind === "turn.complete") && typeof event.agentId === "string") return this.respond(res, 204, {});
    if (event.kind === "session.start" || event.kind === "session.current") {
      if (typeof event.cwd !== "string" || typeof event.version !== "string") return this.respond(res, 400, { error: "invalid_handshake" });
      const previousID = typeof event.previousSessionId === "string" ? event.previousSessionId : "";
      if (previousID && previousID !== event.sessionId) {
        const previous = this.sessions.get(previousID);
        if (previous?.client_instance_id === event.clientInstanceId) {
          const oldRemote = this.remoteTurn.get(previousID);
          if (oldRemote?.requestId) event = { ...event, previousRequestId: oldRemote.requestId };
          previous.seen_at = 0;
          previous.turn_id = undefined;
          this.commands.delete(previousID);
          this.inFlight.delete(previousID);
          this.remoteTurn.delete(previousID);
        }
      }
      const previous = this.sessions.get(event.sessionId);
      // A reload creates a new Mod incarnation in the same native process.
      // Track contenders even while blocked: two live owners stay blocked,
      // while a replacement recovers after the old heartbeat has expired.
      const stamp = Date.now();
      let owners = this.ownerHeartbeats.get(event.sessionId);
      if (!owners) { owners = new Map(); this.ownerHeartbeats.set(event.sessionId, owners); }
      if (previous?.client_instance_id && !owners.has(previous.client_instance_id)) owners.set(previous.client_instance_id, previous.seen_at);
      owners.set(event.clientInstanceId as string, stamp);
      for (const [owner, seen] of owners) if (stamp - seen > 5000) owners.delete(owner);
      if (owners.size > 1) {
        this.conflictedSessions.add(event.sessionId);
        this.revokeOwner(event.sessionId);
        return this.respond(res, 409, { error: "mod_session_owner_conflict" });
      }
      this.conflictedSessions.delete(event.sessionId);
      if (previous?.client_instance_id && previous.client_instance_id !== event.clientInstanceId) this.revokeOwner(event.sessionId);
      this.sessions.set(event.sessionId, { ...previous, session_id: event.sessionId, cwd: event.cwd as string, ...(typeof event.pid === "number" ? { pid: event.pid } : {}), client_instance_id: event.clientInstanceId as string, version: event.version as string, surface: Array.isArray(event.surface) ? event.surface.filter((x): x is string => typeof x === "string") : [], seen_at: Date.now(), turn_id: typeof event.activeTurnId === "string" ? event.activeTurnId : event.activeTurnId === null ? undefined : previous?.turn_id });
    } else {
      if (this.conflictedSessions.has(event.sessionId)) return this.respond(res, 409, { error: "mod_session_owner_conflict" });
      const owner = this.sessions.get(event.sessionId);
      if (!owner || owner.client_instance_id !== event.clientInstanceId || Date.now() - owner.seen_at > 5000) return this.respond(res, 409, { error: "mod_session_owner_mismatch" });
    }
    const session = this.sessions.get(event.sessionId);
    if (session) {
      session.seen_at = Date.now();
      if (event.kind === "turn.start" && typeof event.turnId === "string") session.turn_id = event.turnId;
      if (event.kind === "turn.complete") session.turn_id = undefined;
      if (event.kind === "read" && event.draft && typeof event.draft === "object") session.draft = event.draft as ModSession["draft"];
      if (event.kind === "session.end") {
        const active = this.remoteTurn.get(event.sessionId);
        if (active?.requestId) event = { ...event, prism_request_id: active.requestId };
        this.revokeOwner(event.sessionId);
        this.sessions.delete(event.sessionId);
        this.ownerHeartbeats.delete(event.sessionId);
      }
    }
    if (event.kind === "prompt.submit") {
      const command = this.inFlight.get(event.sessionId);
      const active = this.remoteTurn.get(event.sessionId);
      const origin = event.origin && typeof event.origin === "object" ? event.origin as Record<string, unknown> : {};
      const isThisMod = origin.kind === "plugin" && origin.name === "prism-terminal-control";
      if (command && active && active.requestId === command.requestId && !active.accepted && !isThisMod) active.ambiguous = true;
    }
    let followup: ModEvent | undefined;
    if (event.kind === "submit-settled") {
      const command = this.inFlight.get(event.sessionId);
      const origin = event.origin && typeof event.origin === "object" ? event.origin as Record<string, unknown> : {};
      if (command?.requestId && origin.kind === "plugin" && origin.name === "prism-terminal-control" && event.dropped !== true) {
        const active = this.remoteTurn.get(event.sessionId) || { requestId: command.requestId, accepted: false, ambiguous: false };
        if (active.requestId === command.requestId) {
          active.accepted = true;
          this.remoteTurn.set(event.sessionId, active);
          if (active.turnId && !active.ambiguous) event = { ...event, prism_request_id: active.requestId, turnId: active.turnId };
          else if (active.ambiguous) event = { ...event, prism_request_ambiguous: true };
          if (active.turnId && !active.ambiguous) {
            const completed = this.deferredCompletion.get(event.sessionId);
            if (completed?.turnId === active.turnId) {
              followup = { ...completed, prism_request_id: active.requestId };
              this.deferredCompletion.delete(event.sessionId);
              this.inFlight.delete(event.sessionId);
              this.remoteTurn.delete(event.sessionId);
            }
          }
        }
      } else if (command) {
        const active = this.remoteTurn.get(event.sessionId);
        if (active) active.ambiguous = true;
      }
      if (command?.requestId) event = { ...event, prism_delivery_request_id: command.requestId };
    }
    if (event.kind === "turn.start") {
      const active = this.remoteTurn.get(event.sessionId);
      if (active && !active.ambiguous && typeof event.turnId === "string") {
        active.turnId = event.turnId;
        if (active.accepted) event = { ...event, prism_request_id: active.requestId };
        else event = { ...event, prism_pending_request_id: active.requestId };
      } else if (active?.ambiguous) event = { ...event, prism_request_ambiguous: true };
    }
    if (event.kind === "turn.complete") {
      const active = this.remoteTurn.get(event.sessionId);
      if (active && !active.ambiguous && active.turnId === event.turnId) {
        if (active.accepted) event = { ...event, prism_request_id: active.requestId };
        else {
          this.deferredCompletion.set(event.sessionId, event);
          // Do not publish an uncorrelated completion; submit-settled will
          // release it with the same Prism request ID used by run.started.
          return this.respond(res, 204, {});
        }
      }
      this.inFlight.delete(event.sessionId);
      this.remoteTurn.delete(event.sessionId);
      const approval = this.approvals.get(event.sessionId);
      if (approval) { this.approvals.delete(event.sessionId); clearTimeout(approval.timer); approval.resolve("deny"); }
    }
    if (typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (pending && (event.kind === "read" || event.kind.endsWith("-returned"))) {
        clearTimeout(pending.timer); this.pending.delete(event.id); pending.resolve(event);
      } else if (pending && (event.kind === "submit-dispatched" || event.kind === "abort-returned")) {
        // Dispatch acknowledgement is deliberately distinct from a turn start/completion.
        clearTimeout(pending.timer); this.pending.delete(event.id); pending.resolve(event);
      } else if (pending && event.kind.endsWith("-error")) {
        clearTimeout(pending.timer); this.pending.delete(event.id); pending.reject(new Error(String(event.error || "mod_command_failed")));
      }
    }
    for (const listener of this.listeners) listener(event);
    if (followup) for (const listener of this.listeners) listener(followup);
    return this.respond(res, 204, {});
  }

  private authorized(req: IncomingMessage): boolean {
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    const a = Buffer.from(supplied); const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private revokeOwner(sessionID: string): void {
    const queued = this.commands.get(sessionID) || [];
    const active = this.inFlight.get(sessionID);
    const ids = new Set([...queued.map((item) => item.id), ...(active ? [active.id] : [])]);
    this.commands.delete(sessionID);
    this.inFlight.delete(sessionID);
    this.remoteTurn.delete(sessionID);
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error("mod_session_owner_changed"));
    }
    const approval = this.approvals.get(sessionID);
    if (approval) { this.approvals.delete(sessionID); clearTimeout(approval.timer); approval.resolve("deny"); }
  }
  private async permission(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const sessionID = typeof body.sessionId === "string" ? body.sessionId : "";
    if (this.conflictedSessions.has(sessionID)) return this.respond(res, 200, { mode: "native" });
    const active = this.activeRemoteTurn(sessionID);
    if (!active || typeof body.toolName !== "string") return this.respond(res, 200, { mode: "native" });
    if (this.approvals.has(sessionID)) return this.respond(res, 200, { mode: "decision", decision: "deny", message: "Concurrent remote permission request was denied" });
    const input = body.toolInput && typeof body.toolInput === "object" ? body.toolInput as Record<string, unknown> : {};
    const description = typeof input.command === "string" ? input.command.slice(0, 2000) : typeof input.file_path === "string" ? input.file_path.slice(0, 2000) : JSON.stringify(input).slice(0, 2000);
    const approvalID = randomUUID();
    const decision = await new Promise<"allow" | "deny">((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(sessionID); resolve("deny");
      }, 110_000);
    this.approvals.set(sessionID, { id: approvalID, requestId: active.requestId, toolName: body.toolName as string, description, createdAt: Date.now(), resolve, timer });
      for (const listener of this.listeners) listener({ kind: "approval.request", sessionId: sessionID, requestId: active.requestId, approvalRequestId: approvalID, toolName: body.toolName as string, description, createdAt: Date.now() });
    });
    const current = this.activeRemoteTurn(sessionID);
    if (!current || current.requestId !== active.requestId) return this.respond(res, 200, { mode: "decision", decision: "deny", message: "Remote turn ended before approval" });
    return this.respond(res, 200, { mode: "decision", decision, ...(decision === "deny" ? { message: "Denied in Prism" } : {}) });
  }
  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 1024 * 1024) throw new Error("body_too_large"); chunks.push(buffer); }
    const value = Buffer.concat(chunks).toString("utf8");
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_body");
    return parsed as Record<string, unknown>;
  }
  private respond(res: ServerResponse, status: number, value: unknown): void { res.statusCode = status; res.end(status === 204 ? "" : JSON.stringify(value)); }
}
