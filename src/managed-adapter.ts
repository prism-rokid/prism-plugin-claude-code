import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PluginAdapterError, type ApprovalResolutionRequest, type AttachSessionRequest, type Capability, type DiscoveryResult, type DraftOpenRequest, type DraftOpenResult, type HistoryMessage, type HistoryStreamEvent, type HistoryStreamRequest, type InboundMessage, type ManagedTerminalRequest, type NativeSession, type NativeSessionHint, type PluginAdapter, type PluginEvent, type RunStatus, type SendReceipt, type StartDraftWithMessageRequest, type StartSessionWithMessageRequest, type StartSessionWithMessageResult, type VisibilityResult } from "@rokid-prism/pluginbridge-plugin-sdk";
import { ClaudeSdkRuntime, type SdkTranscriptEntry } from "./sdk-runtime.js";
import { ManagedSupervisorManager } from "./managed-supervisor-manager.js";
import { ManagedSupervisorClient } from "./managed-supervisor-client.js";
import { activeClaudeSessionPID } from "./claude-session-ownership.js";
import type { TerminalSnapshot } from "./managed-input-arbiter.js";

const PLUGIN_ID = "claudecode";
const SURFACE = "claudecode-managed-pty";
const CONFIRM_TIMEOUT_MS = 10_000;
function now(): string { return new Date().toISOString(); }
function canonicalCwd(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function session(id: string, cwd: string): NativeSession {
  return { PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: SURFACE, Endpoint: "local managed Claude PTY", Cwd: cwd, Visible: true };
}

class EventQueue implements AsyncIterable<PluginEvent> {
  private static readonly MAX_PENDING = 1024;
  private events: PluginEvent[] = [];
  private waiter?: (value: IteratorResult<PluginEvent>) => void;
  private ended = false;
  push(value: PluginEvent) {
    if (this.ended) return;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); }
    else if (this.events.length < EventQueue.MAX_PENDING) this.events.push(value);
  }
  close() { this.ended = true; this.waiter?.({ value: undefined as never, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<PluginEvent> { return { next: () => {
    const value = this.events.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise<IteratorResult<PluginEvent>>((resolve) => { this.waiter = resolve; });
  } }; }
}

/** Native managed mode: all writes reach one detached supervisor and one PTY. */
export class ManagedClaudeAdapter implements PluginAdapter {
  private readonly manager: ManagedSupervisorManager;
  private readonly reader = new ClaudeSdkRuntime({ onUpdate() {}, onPermission: async () => ({ outcome: "deny", message: "read-only transcript reader" }), onStderr() {} });
  private readonly subscribers = new Map<string, Set<EventQueue>>();
  private readonly drafts = new Map<string, string>();
  private readonly migrations = new Map<string, Promise<ManagedSupervisorClient>>();
  constructor(baseDir?: string) {
    this.manager = new ManagedSupervisorManager(baseDir, (id, state) => this.publish(id, "desktop.state.changed", "running", "Claude terminal state changed", { detail_snapshot: { terminal: state } }), (id, hook, eventID, replayed, createdAt) => this.handleHook(id, hook, eventID, replayed, createdAt));
  }
  id(): string { return PLUGIN_ID; }
  probe(): Capability {
    const cli = process.env.PRISM_CLAUDE_CLI || "claude";
    const check = spawnSync(cli, ["--version"], { timeout: 3000, encoding: "utf8" });
    const available = !check.error && check.status === 0;
    return {
      PluginID: PLUGIN_ID, Available: available, NativeVisibleInput: true, NativeVisibleOutput: true,
      CanAttachSession: true, CanStartSessionWithMessage: true, CanOpenDraft: true,
      CanListSessions: true, CanReadHistory: true, CanInterrupt: true, CanApproval: true,
      CanForwardSync: true, CanReverseSync: true, CanPluginWideWatch: false,
      CanWaitRun: false, CanReadStatus: true, CanControlSession: false, CanOpenManagedTerminal: true,
      IntegrationMode: "protocol-native", VisibilitySurface: SURFACE,
      UnavailableReason: available ? "" : `Claude CLI unavailable: ${check.error?.message || check.stderr || "version check failed"}`,
    };
  }
  discover(): DiscoveryResult {
    const capability = this.probe();
    return { PluginID: PLUGIN_ID, Surface: SURFACE, Endpoint: this.manager.baseDir, ProcessID: process.pid, SessionHints: { protocol: "managed-pty" }, Verified: capability.Available, Detail: capability.UnavailableReason || "Claude managed PTY available" };
  }
  async openDraft(req: DraftOpenRequest): Promise<DraftOpenResult> {
    const cwd = resolve(req.Cwd || process.cwd());
    if (!existsSync(cwd)) throw new PluginAdapterError("invalid_cwd", "Project directory does not exist");
    this.drafts.set(req.DraftID, cwd);
    return { DraftID: req.DraftID, Cwd: cwd, Controls: {}, DraftFingerprint: `managed:${req.DraftID}` };
  }
  async startDraftWithMessage(req: StartDraftWithMessageRequest): Promise<StartSessionWithMessageResult> {
    const cwd = this.drafts.get(req.DraftID);
    if (!cwd) throw new PluginAdapterError("draft_stale", "Claude managed draft is no longer available");
    const started = await this.startSessionWithMessage({ PluginID: req.PluginID, Cwd: cwd, Message: req.Message, SourceDevice: req.SourceDevice, Metadata: req.Metadata });
    this.drafts.delete(req.DraftID);
    return started;
  }
  async startSessionWithMessage(req: StartSessionWithMessageRequest): Promise<StartSessionWithMessageResult> {
    const cwd = resolve(req.Cwd || process.cwd());
    if (!existsSync(cwd)) throw new PluginAdapterError("invalid_cwd", "Project directory does not exist");
    const { sessionID, client } = await this.manager.create(cwd);
    const native = session(sessionID, client.descriptor.cwd);
    const readyDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const terminal = await client.refresh();
      if (terminal.can_send) { ready = true; break; }
      if (terminal.setup_required) {
        await client.shutdown();
        await this.manager.discardUnstarted(sessionID);
        throw new PluginAdapterError("workspace_trust_required", "Claude requires project trust in a local managed Terminal before Panel can start this project");
      }
      if (terminal.status === "stopped") {
        await client.shutdown();
        await this.manager.discardUnstarted(sessionID);
        throw new PluginAdapterError("managed_session_not_found", "Claude Code exited before its first prompt");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      await client.shutdown();
      await this.manager.discardUnstarted(sessionID);
      throw new PluginAdapterError("session_start_timeout", "Claude Code did not become ready for Panel input");
    }
    const receipt = await this.send(native, req.Message);
    return { Session: native, Receipt: receipt, Visibility: { Visible: receipt.Visible, Marker: req.Message.PrismMessageID, Evidence: "Claude UserPromptSubmit hook", CheckedAt: now(), FailureReason: receipt.Visible ? "" : "Prompt submit not confirmed" } };
  }
  async listSessions(): Promise<NativeSessionHint[]> {
    const hints: NativeSessionHint[] = [];
    for (const id of this.manager.listSessionIDs()) {
      try {
        const client = await this.manager.connect(id);
        const terminal = await client.refresh();
        hints.push({ PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: SURFACE, Endpoint: "local managed Claude PTY", Cwd: client.descriptor.cwd, Title: "Claude Code", PrismConversationID: "", Active: terminal.status !== "stopped", Visible: terminal.status !== "stopped", LastActivityAt: now(), Metadata: { terminal_status: terminal.status } });
      } catch { /* stale supervisor descriptors are not live sessions */ }
    }
    return hints;
  }
  async attachSession(req: AttachSessionRequest): Promise<NativeSession> {
    const id = req.NativeSessionID || req.NativeThreadID;
    const client = await this.connectOrResume(id, req.Cwd);
    const terminal = await client.refresh();
    if (terminal.status === "stopped") throw new PluginAdapterError("managed_session_not_found", "Claude managed session has stopped");
    return session(id, client.descriptor.cwd);
  }
  async openManagedTerminal(req: ManagedTerminalRequest): Promise<{ ok: boolean; message: string }> {
    if (!req.native_session_id) {
      const cwd = resolve(req.cwd || process.cwd());
      if (!existsSync(cwd)) throw new PluginAdapterError("invalid_cwd", "Project directory does not exist");
      const { sessionID, client } = await this.manager.create(cwd);
      try { await client.openTerminal(sessionID); }
      catch (error) { await client.shutdown(); await this.manager.discardUnstarted(sessionID); throw error; }
      return { ok: true, message: `Claude native Terminal opened for session ${sessionID}` };
    }
    if (req.native_thread_id && req.native_thread_id !== req.native_session_id) throw new PluginAdapterError("managed_session_identity_mismatch", "Claude session and thread identity do not match");
    const client = await this.connectOrResume(req.native_session_id, req.cwd || "");
    await client.openTerminal(req.native_session_id);
    return { ok: true, message: "Claude native Terminal attached" };
  }
  async send(native: NativeSession, msg: InboundMessage): Promise<SendReceipt> {
    if (msg.Attachments?.length) throw new PluginAdapterError("attachment_not_supported", "Claude managed terminal attachments are not available yet");
    const id = native.NativeSessionID || native.NativeThreadID;
    const client = await this.connectOrResume(id, native.Cwd);
    const result = await client.send(msg.PrismMessageID, msg.Text);
    if (result.status === "conflict") throw new PluginAdapterError("delivery_conflict", result.detail);
    if (result.status === "busy") throw new PluginAdapterError("session_busy", result.detail);
    if (result.status === "invalid") throw new PluginAdapterError("invalid_message", result.detail);
    if (result.status === "indeterminate") throw new PluginAdapterError("delivery_indeterminate", result.detail);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = await client.delivery(msg.PrismMessageID);
      if (record?.state === "submitted" || record?.state === "completed") {
        return { NativeMessageID: msg.PrismMessageID, CanonicalNativeSessionID: id, CanonicalNativeThreadID: id, Accepted: true, Visible: true, Detail: "Claude UserPromptSubmit confirmed" };
      }
      if (record?.state === "indeterminate") throw new PluginAdapterError("delivery_indeterminate", record.detail || "Claude prompt delivery is uncertain");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new PluginAdapterError("delivery_indeterminate", "Claude did not confirm prompt submission before timeout; do not retry automatically");
  }
  async verifyVisibility(native: NativeSession, marker: string): Promise<VisibilityResult> {
    const client = await this.manager.connect(native.NativeSessionID);
    const record = await client.delivery(marker);
    const visible = record?.state === "submitted" || record?.state === "completed";
    return { Visible: visible, Marker: marker, Evidence: visible ? "Claude UserPromptSubmit hook" : "", CheckedAt: now(), FailureReason: visible ? "" : "Prompt submission not confirmed" };
  }
  async readDetail(native: NativeSession): Promise<Record<string, unknown>> {
    if (!this.manager.hasManagedState(native.NativeSessionID)) {
      await this.legacySummary(native.NativeSessionID, native.Cwd);
      const active = activeClaudeSessionPID(native.NativeSessionID);
      const terminal: TerminalSnapshot = { status: active ? "reconnecting" : "detached", input_owner: null,
        can_send: !active, can_interrupt: false, can_approve: false,
        reason: active ? "An older Claude process still owns this session; close it before managed resume" : "The next send resumes this historical Claude session in a new managed process" };
      return { terminal, approval: null, primary_action: "send", run: { status: "idle" }, actions: [] };
    }
    const client = await this.manager.connect(native.NativeSessionID);
    const [terminal, approval] = await Promise.all([client.refresh(), client.approval()]);
    return { terminal, approval, primary_action: approval ? "approval" : "send", run: { status: approval ? "waiting_approval" : terminal.can_interrupt ? "running" : "idle" }, actions: [] };
  }
  async readStatus(native: NativeSession, _runID: string): Promise<RunStatus> {
    const terminal = (await this.readDetail(native)).terminal as TerminalSnapshot;
    return { status: terminal.can_interrupt ? "running" : "idle", phase: { id: terminal.status }, preview: terminal.reason || "", steps: [], interruptible: terminal.can_interrupt, approval_blocked: terminal.can_approve };
  }
  async readHistory(native: NativeSession, limit: number): Promise<HistoryMessage[]> {
    const entries = await this.reader.readTranscript(native.NativeSessionID);
    return entries.slice(-Math.max(1, limit)).map((entry) => this.historyMessage(entry));
  }
  async *readHistoryStream(native: NativeSession, request: HistoryStreamRequest, signal?: AbortSignal): AsyncIterable<HistoryStreamEvent> {
    const entries = await this.reader.readTranscript(native.NativeSessionID);
    const groups: Array<{ turn_id: string; order_key: string; revision: number; messages: HistoryMessage[] }> = [];
    for (const [index, entry] of entries.entries()) {
      const message = this.historyMessage(entry);
      if (entry.role === "user" || groups.length === 0) groups.push({ turn_id: entry.uuid, order_key: String(index).padStart(10, "0"), revision: 1, messages: [message] });
      else groups[groups.length - 1].messages.push(message);
    }
    for (const group of groups.slice(-Math.max(1, request.limit))) {
      if (signal?.aborted) return;
      yield { stream_id: request.stream_id, type: "turn", source: "initial", operation: "append", turn: group };
    }
    yield { stream_id: request.stream_id, type: "page_end" };
    if (request.live) {
      // Live history reconciliation is driven by the local transcript. This
      // polling path also repairs missed display hooks after reconnects.
      const seen = new Map(groups.map((group) => [group.turn_id, { signature: JSON.stringify(group.messages), revision: group.revision }]));
      while (!signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const next = await this.reader.readTranscript(native.NativeSessionID);
        const latest: typeof groups = [];
        for (const [index, entry] of next.entries()) {
          const message = this.historyMessage(entry);
          if (entry.role === "user" || latest.length === 0) latest.push({ turn_id: entry.uuid, order_key: String(index).padStart(10, "0"), revision: 1, messages: [message] });
          else latest[latest.length - 1].messages.push(message);
        }
        for (const group of latest) {
          const signature = JSON.stringify(group.messages);
          const previous = seen.get(group.turn_id);
          if (previous?.signature === signature) continue;
          const operation = previous ? "replace" : "append";
          group.revision = previous ? previous.revision + 1 : 1;
          seen.set(group.turn_id, { signature, revision: group.revision });
          yield { stream_id: request.stream_id, type: "turn", source: "live", operation, turn: group };
        }
      }
    }
    yield { stream_id: request.stream_id, type: "end" };
  }
  async *subscribe(native: NativeSession, signal?: AbortSignal): AsyncIterable<PluginEvent> {
    const id = native.NativeSessionID;
    const queue = new EventQueue();
    let listeners = this.subscribers.get(id);
    if (!listeners) { listeners = new Set(); this.subscribers.set(id, listeners); }
    listeners.add(queue);
    const abort = () => queue.close();
    signal?.addEventListener("abort", abort, { once: true });
    let poll: NodeJS.Timeout | undefined;
    let replayPoll: NodeJS.Timeout | undefined;
    try {
      let detail = await this.readDetail(native);
      if (this.manager.hasManagedState(id)) {
        const client = await this.manager.connect(id);
        await client.replayHooks();
        let replaying = false;
        replayPoll = setInterval(() => {
          if (replaying) return;
          replaying = true;
          void this.manager.connect(id).then((current) => current.replayHooks()).catch(() => {}).finally(() => { replaying = false; });
        }, 15_000);
        // Replayed lifecycle events describe the past. End replay with the
        // current supervisor state so a new turn or approval is not hidden.
        detail = await this.readDetail(native);
      }
      queue.push({ ID: `${id}:terminal-initial:${randomUUID()}`, Type: "desktop.state.changed", Status: "running", Summary: "Claude terminal state", Payload: { detail_snapshot: detail }, CreatedAt: now() });
      if (!this.manager.hasManagedState(id)) {
        let previous = JSON.stringify(detail.terminal);
        let checking = false;
        poll = setInterval(() => {
          if (checking || this.manager.hasManagedState(id)) return;
          checking = true;
          void this.readDetail(native).then((latest) => {
            const signature = JSON.stringify(latest.terminal);
            if (signature !== previous) {
              previous = signature;
              this.publish(id, "desktop.state.changed", "running", "Historical Claude owner changed", { detail_snapshot: latest });
            }
          }).catch(() => {}).finally(() => { checking = false; });
        }, 2000);
      }
      for await (const event of queue) yield event;
    } finally { if (poll) clearInterval(poll); if (replayPoll) clearInterval(replayPoll); queue.close(); listeners.delete(queue); signal?.removeEventListener("abort", abort); }
  }
  async ackEvent(native: NativeSession, eventID: string): Promise<void> {
    const prefix = `${native.NativeSessionID}:`;
    if (!eventID.startsWith(prefix)) throw new PluginAdapterError("event_ack_mismatch", "Claude event does not belong to this session");
    const client = await this.manager.connect(native.NativeSessionID);
    await client.ackHook(eventID.slice(prefix.length));
  }
  async interrupt(native: NativeSession): Promise<void> {
    const client = await this.manager.connect(native.NativeSessionID);
    if (!await client.interrupt()) throw new PluginAdapterError("interrupt_unavailable", "Claude Code is not in a safely interruptible run");
  }
  async resolveApproval(req: ApprovalResolutionRequest): Promise<void> {
    if (req.Session.PluginID !== PLUGIN_ID || !req.Session.NativeSessionID) throw new PluginAdapterError("approval_stale", "Claude approval session does not match");
    const client = await this.manager.connect(req.Session.NativeSessionID);
    try { await client.resolveApproval(req.ApprovalRequestID, req.ActionID); }
    catch (error) { throw new PluginAdapterError("approval_stale", error instanceof Error ? error.message : String(error)); }
  }
  async close(): Promise<void> {
    for (const listeners of this.subscribers.values()) for (const queue of listeners) queue.close();
    this.manager.close(); // The detached supervisor and native Claude PTY stay alive.
    await this.reader.close();
  }
  private historyMessage(entry: SdkTranscriptEntry): HistoryMessage {
    const stamp = entry.timestamp || "1970-01-01T00:00:00.000Z";
    return { ID: entry.uuid, Role: entry.role, Type: "text", Content: entry.text, Status: "completed", CreatedAt: stamp, UpdatedAt: stamp,
      ...(entry.toolUses.length ? { Progress: { Status: "completed", StartedAt: stamp, CompletedAt: stamp, Steps: entry.toolUses.map((tool) => ({ ID: `tool:${tool.callId}`, CallID: tool.callId, Kind: "tool", Title: tool.title, Detail: "", Status: tool.failed ? "failed" : "completed", CreatedAt: stamp })) } } : {}) };
  }
  private async legacySummary(id: string, cwd: string): Promise<{ cwd: string }> {
    if (this.manager.hasManagedState(id)) throw new PluginAdapterError("managed_session_not_found", "Managed Claude session owner is unavailable");
    const summary = await this.reader.sessionInfo(id);
    if (!summary || !summary.cwd || (cwd && canonicalCwd(summary.cwd) !== canonicalCwd(cwd))) {
      throw new PluginAdapterError("managed_session_not_found", "Claude historical session is unavailable or belongs to another project");
    }
    return { cwd: resolve(summary.cwd) };
  }
  private async connectOrResume(id: string, cwd: string): Promise<ManagedSupervisorClient> {
    if (this.manager.hasManagedState(id)) return await this.manager.connect(id);
    const existing = this.migrations.get(id);
    if (existing) return await existing;
    const migration = this.resumeLegacy(id, cwd);
    this.migrations.set(id, migration);
    try { return await migration; }
    finally { this.migrations.delete(id); }
  }
  private async resumeLegacy(id: string, cwd: string): Promise<ManagedSupervisorClient> {
    const summary = await this.legacySummary(id, cwd);
    if (activeClaudeSessionPID(id)) throw new PluginAdapterError("legacy_session_active", "An older Claude process still owns this session; close it before managed resume");
    const { client } = await this.manager.resume(id, summary.cwd);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const terminal = await client.refresh();
      if (terminal.can_send) {
        this.publish(id, "desktop.state.changed", "running", "Historical Claude session resumed in a new managed process", { detail_snapshot: { terminal }, lifecycle: "legacy_resumed" });
        return client;
      }
      if (terminal.setup_required || terminal.status === "stopped") {
        await client.shutdown();
        await this.manager.discardUnstarted(id);
        throw new PluginAdapterError(terminal.setup_required ? "workspace_trust_required" : "managed_session_not_found", terminal.reason || "Claude could not resume its historical session");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await client.shutdown();
    await this.manager.discardUnstarted(id);
    throw new PluginAdapterError("session_start_timeout", "Claude historical session did not become ready");
  }
  private publish(id: string, type: string, status: string, summary: string, payload: Record<string, unknown>, eventID?: string, createdAt?: string): void {
    const event: PluginEvent = { ID: eventID ? `${id}:${eventID}` : `${id}:${randomUUID()}`, Type: type, Status: status, Summary: summary, Payload: payload, CreatedAt: createdAt || now() };
    for (const listener of this.subscribers.get(id) || []) listener.push(event);
  }
  private handleHook(id: string, hook: Record<string, unknown>, eventID?: string, replayed = false, createdAt?: string): void {
    const kind = typeof hook.hook_event_name === "string" ? hook.hook_event_name : "";
    // Approval prompts are ephemeral: on reconnect the current approval is
    // obtained from the supervisor snapshot, never from an old Hook replay.
    if (replayed && (kind === "PermissionRequest" || kind === "PrismApprovalResolved")) return;
    if (kind === "UserPromptSubmit" && replayed) this.publish(id, "conversation.history.changed", "running", "Claude prompt accepted while offline", { prism_outbox: true }, eventID, createdAt);
    else if (kind === "UserPromptSubmit" && typeof hook.prompt === "string") this.publish(id, "message.user.accepted", "accepted", hook.prompt.slice(0, 160), { role: "user", text: hook.prompt, prism_outbox: true }, eventID, createdAt);
    else if (kind === "PermissionRequest" && hook.approval && typeof hook.approval === "object") {
      const approval = hook.approval as Record<string, unknown>;
      this.publish(id, "approval.required", "waiting_approval", String(approval.title || "Claude permission request"), { ...approval, detail_snapshot: { approval } }, eventID, createdAt);
    }
    else if (kind === "PrismApprovalResolved") this.publish(id, "desktop.state.changed", "running", "Claude permission resolved", { detail_snapshot: { approval: null } }, eventID, createdAt);
    else if (kind === "PrismRunInterrupted") this.publish(id, "run.interrupted", "interrupted", "Claude run interrupted", { prism_outbox: true }, eventID, createdAt);
    else if (kind === "Stop" || kind === "StopFailure") this.publish(id, "run.completed", kind === "Stop" ? "completed" : "failed", "Claude turn ended", { prism_outbox: true }, eventID, createdAt);
    else if (kind === "MessageDisplay") this.publish(id, "conversation.history.changed", "running", "Claude response updated", { prism_outbox: true }, eventID, createdAt);
  }
}
