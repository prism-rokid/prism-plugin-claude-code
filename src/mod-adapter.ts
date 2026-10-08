import { resolveClaudeCLI } from "./claude-cli.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PluginAdapterError, type ApprovalResolutionRequest, type AttachSessionRequest, type Capability, type ControlSessionRequest, type ControlSessionResult, type DiscoveryResult, type DraftOpenRequest, type DraftOpenResult, type HistoryMessage, type HistoryStreamEvent, type HistoryStreamRequest, type InboundMessage, type ManagedTerminalRequest, type NativeSession, type NativeSessionHint, type PluginAdapter, type PluginEvent, type RunStatus, type SendReceipt, type StartDraftWithMessageRequest, type StartSessionWithMessageRequest, type StartSessionWithMessageResult, type VisibilityResult } from "@rokid-prism/pluginbridge-plugin-sdk";
import { NativeTranscriptReader, type TranscriptEntry } from "./transcript-reader.js";
import { ModBridge, type ModEvent } from "./mod-bridge.js";
import { PersistentDeliveryLedger } from "./mod-delivery-ledger.js";
import { ManagedSupervisorManager } from "./managed-supervisor-manager.js";
import { ManagedSupervisorClient } from "./managed-supervisor-client.js";
import { activeClaudeSessionPID, claudeSessionOwner } from "./claude-session-ownership.js";
import type { TerminalSnapshot } from "./native-terminal-state.js";
import { LiveTranscript } from "./live-transcript.js";

const PLUGIN_ID = "claudecode";
const SURFACE = "claudecode-native-mod";
const CONFIRM_TIMEOUT_MS = 10_000;
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
function now(): string { return new Date().toISOString(); }
function canonicalCwd(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function conversationTitle(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim().slice(0, 100) || "Claude Code";
}
function session(id: string, cwd: string): NativeSession {
  return { PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: SURFACE, Endpoint: "local Claude Code Mod", Cwd: cwd, Visible: true };
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

/** Claude Code Mod is the only control mode; a PTY supervisor supplies native terminal lifecycle when needed. */
export class ModClaudeAdapter implements PluginAdapter {
  private readonly manager: ManagedSupervisorManager;
  private readonly reader = new NativeTranscriptReader();
  private readonly bridge = new ModBridge();
  private readonly liveTranscript = new LiveTranscript((id) => this.reader.readTranscript(id), (entry) => this.historyMessage(entry));
  private readonly bridgeReady: Promise<void>;
  private modReady?: Promise<void>;
  private readonly deliveryLedgers = new Map<string, PersistentDeliveryLedger>();
  private modInstallError?: string;
  private readonly modStateSignatures = new Map<string, string>();
  private readonly modelStates = new Map<string, Record<string, unknown>>();
  private readonly modTitleHints = new Map<string, string>();
  private readonly subscribers = new Map<string, Set<EventQueue>>();
  private readonly pluginSubscribers = new Set<EventQueue>();
  private readonly drafts = new Map<string, string>();
  private readonly migrations = new Map<string, Promise<ManagedSupervisorClient>>();
  private readonly historyClosers = new Set<() => void>();
  constructor(baseDir?: string) {
    this.manager = new ManagedSupervisorManager(baseDir, (id, state) => this.publish(id, "desktop.state.changed", "running", "Claude terminal state changed", { detail_snapshot: { terminal: state } }));
    this.bridgeReady = this.bridge.start();
    this.bridge.onEvent((event) => this.handleModEvent(event));
  }
  id(): string { return PLUGIN_ID; }
  async probe(): Promise<Capability> {
    const cli = resolveClaudeCLI();
    const check = spawnSync(cli.command, ["--version"], { timeout: 3000, encoding: "utf8", env: cli.env });
    const match = check.stdout?.match(/(\d+)\.(\d+)\.(\d+)/);
    const tuple = match?.slice(1).map(Number);
    const supported = Boolean(tuple && (tuple[0] > 2 || tuple[0] === 2 && (tuple[1] > 1 || tuple[1] === 1 && tuple[2] >= 287)));
    if (!check.error && check.status === 0 && supported) {
      try { await this.ensureModReady(); } catch { /* Report installation failure as unavailable. */ }
    }
    const available = !check.error && check.status === 0 && supported && !this.modInstallError;
    const canControl = available;
    return {
      PluginID: PLUGIN_ID, Available: available, NativeVisibleInput: true, NativeVisibleOutput: true,
      CanAttachSession: canControl, CanStartSessionWithMessage: canControl, CanOpenDraft: canControl,
      CanListSessions: true, CanReadHistory: true, CanInterrupt: canControl, CanApproval: canControl,
      CanForwardSync: canControl, CanReverseSync: canControl, CanPluginWideWatch: canControl,
      CanWaitRun: canControl, CanReadStatus: canControl, CanControlSession: canControl, CanOpenManagedTerminal: canControl,
      IntegrationMode: "protocol-native", VisibilitySurface: SURFACE,
      UnavailableReason: available ? "" : this.modInstallError || `Claude Code 2.1.287+ with Mods is required: ${check.error?.message || check.stderr || check.stdout || "version check failed"}`,
    };
  }
  async discover(): Promise<DiscoveryResult> {
    const capability = await this.probe();
    return { PluginID: PLUGIN_ID, Surface: SURFACE, Endpoint: this.manager.baseDir, ProcessID: process.pid, SessionHints: { protocol: "claude-code-mod" }, Verified: capability.Available, Detail: capability.UnavailableReason || "Claude Code Mod available" };
  }
  async openDraft(req: DraftOpenRequest): Promise<DraftOpenResult> {
    const cwd = resolve(req.Cwd || process.cwd());
    if (!existsSync(cwd)) throw new PluginAdapterError("invalid_cwd", "Project directory does not exist");
    this.drafts.set(req.DraftID, cwd);
    return { DraftID: req.DraftID, Cwd: cwd, Controls: {}, DraftFingerprint: `managed:${req.DraftID}` };
  }
  async startDraftWithMessage(req: StartDraftWithMessageRequest): Promise<StartSessionWithMessageResult> {
    const cwd = this.drafts.get(req.DraftID);
    if (!cwd) throw new PluginAdapterError("draft_stale", "Claude Code project draft is no longer available");
    const started = await this.startSessionWithMessage({ PluginID: req.PluginID, Cwd: cwd, Message: req.Message, SourceDevice: req.SourceDevice, Metadata: req.Metadata });
    this.drafts.delete(req.DraftID);
    return started;
  }
  async startSessionWithMessage(req: StartSessionWithMessageRequest): Promise<StartSessionWithMessageResult> {
    await this.ensureModReady();
    const cwd = resolve(req.Cwd || process.cwd());
    if (!existsSync(cwd)) throw new PluginAdapterError("invalid_cwd", "Project directory does not exist");
    const { sessionID, client } = await this.manager.create(cwd);
    const native = session(sessionID, client.descriptor.cwd);
    try { await client.openTerminal(sessionID); }
    catch (error) { await client.shutdown(); await this.manager.discardUnstarted(sessionID); throw new PluginAdapterError("native_terminal_open_failed", error instanceof Error ? error.message : String(error)); }
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
    try { await this.bridge.waitForSession(sessionID, CONFIRM_TIMEOUT_MS); }
    catch {
      await client.shutdown();
      await this.manager.discardUnstarted(sessionID);
      throw new PluginAdapterError("mod_unavailable", "Claude Code started without the Prism Mod handshake; refusing a second control path");
    }
    const receipt = await this.send(native, req.Message);
    return { Session: native, Receipt: receipt, Visibility: { Visible: receipt.Visible, Marker: req.Message.PrismMessageID, Evidence: "Claude UserPromptSubmit hook", CheckedAt: now(), FailureReason: receipt.Visible ? "" : "Prompt submit not confirmed" } };
  }
  async listSessions(): Promise<NativeSessionHint[]> {
    const hints: NativeSessionHint[] = [];
    const summaries = await this.reader.listSessions();
    const summaryById = new Map(summaries.map((item) => [item.sessionId, item]));
    const ids = new Set([...this.manager.listSessionIDs(), ...this.bridge.sessionsSnapshot().map((item) => item.session_id), ...summaries.map((item) => item.sessionId)]);
    for (const id of ids) {
      try {
        const client = this.manager.hasSupervisorOwner(id) ? await this.manager.connect(id).catch(() => undefined) : undefined;
        const terminal = client ? await client.refresh().catch(() => undefined) : undefined;
        const mod = this.bridge.session(id);
        const info = summaryById.get(id) || await this.reader.sessionInfo(id).catch(() => undefined);
        const active = Boolean(mod && Date.now() - mod.seen_at < 5000) || Boolean(terminal && terminal.status !== "stopped");
        const cliPID = activeClaudeSessionPID(id, join(this.reader.configDir, "sessions"));
        hints.push({ PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: SURFACE, Endpoint: "local native Claude Code", Cwd: mod?.cwd || client?.descriptor.cwd || info?.cwd || "", Title: conversationTitle(info?.title), PrismConversationID: "", Active: active, Visible: active, LastActivityAt: info?.updatedAt || now(), Metadata: { terminal_status: terminal?.status || (mod ? "attached" : "detached"), claude_version: mod?.version || "", ...(cliPID ? { pid: String(cliPID) } : {}) } });
      } catch { /* stale supervisor descriptors are not live sessions */ }
    }
    return hints;
  }
  async attachSession(req: AttachSessionRequest): Promise<NativeSession> {
    await this.ensureModReady();
    const requested = req.NativeSessionID || req.NativeThreadID;
    const id = requested;
    const mod = this.bridge.session(id);
    if (mod && Date.now() - mod.seen_at < 5000) {
      await this.ensureTerminalVisible(id);
      return session(id, mod.cwd);
    }
    const client = await this.connectOrResume(id, req.Cwd);
    const terminal = await client.refresh();
    if (terminal.status === "stopped") throw new PluginAdapterError("native_session_stopped", "Claude Code session has stopped");
    if (terminal.status !== "attached") await client.openTerminal(id);
    return session(id, client.descriptor.cwd);
  }
  async openManagedTerminal(req: ManagedTerminalRequest): Promise<{ ok: boolean; message: string }> {
    await this.ensureModReady();
    if (!req.native_session_id) {
      const cwd = resolve(req.cwd || process.cwd());
      if (!existsSync(cwd)) throw new PluginAdapterError("invalid_cwd", "Project directory does not exist");
      const { sessionID, client } = await this.manager.create(cwd);
      try { await client.openTerminal(sessionID); }
      catch (error) { await client.shutdown(); await this.manager.discardUnstarted(sessionID); throw error; }
      try { await this.bridge.waitForSession(sessionID, CONFIRM_TIMEOUT_MS); }
      catch { await client.shutdown(); await this.manager.discardUnstarted(sessionID); throw new PluginAdapterError("mod_unavailable", "Native CLI did not load the Prism Mod"); }
      return { ok: true, message: `Claude native Terminal opened for session ${sessionID}` };
    }
    if (req.native_thread_id && req.native_thread_id !== req.native_session_id) throw new PluginAdapterError("managed_session_identity_mismatch", "Claude session and thread identity do not match");
    const id = req.native_session_id;
    const mod = this.bridge.session(id);
    if (mod && Date.now() - mod.seen_at < 5000) return { ok: true, message: "Claude native session is already connected through its Mod" };
    const client = await this.connectOrResume(id, req.cwd || "");
    await client.openTerminal(req.native_session_id);
    return { ok: true, message: "Claude native Terminal attached" };
  }
  async send(native: NativeSession, msg: InboundMessage): Promise<SendReceipt> {
    await this.ensureModReady();
    if (msg.Attachments?.length) throw new PluginAdapterError("attachment_not_supported", "Claude Code Mod prompt submission does not expand Prism attachments; send text only");
    const id = native.NativeSessionID || native.NativeThreadID;
    if (!msg.PrismMessageID.trim() || !msg.Text.trim()) throw new PluginAdapterError("invalid_message", "Message ID and text are required");
    const ledger = this.deliveryLedger(id);
    const prior = ledger.get(msg.PrismMessageID);
    if (prior) {
      const existing = ledger.begin(msg.PrismMessageID, msg.Text);
      if (existing.kind === "conflict") throw new PluginAdapterError("delivery_conflict", "Message ID was already used with different content");
      if (prior.state === "indeterminate") throw new PluginAdapterError("delivery_indeterminate", prior.detail || "Previous delivery is uncertain; automatic retry is unsafe");
      return { NativeMessageID: msg.PrismMessageID, CanonicalNativeSessionID: id, CanonicalNativeThreadID: id, Accepted: true, Visible: Boolean(prior.prompt_id) || prior.state === "submitted" || prior.state === "completed", Detail: `Original delivery state: ${prior.state}` };
    }
    let modSession = this.bridge.session(id);
    if (!modSession || Date.now() - modSession.seen_at > 5000) {
      await this.reconnectNativeSession(id, native.Cwd);
      modSession = this.bridge.session(id);
    }
    if (!modSession || Date.now() - modSession.seen_at > 5000) throw new PluginAdapterError("mod_session_not_connected", "Claude's native Mod is not connected; refusing terminal-key fallback");
    await this.ensureTerminalVisible(id);
    if (modSession.turn_id || this.bridge.activeRemoteTurn(id)) throw new PluginAdapterError("session_busy", "Claude is already processing a turn");
    ledger.begin(msg.PrismMessageID, msg.Text);
    ledger.transition(msg.PrismMessageID, "awaiting_submit", "Waiting for native Mod prompt.submit origin event");
    try {
      await this.bridge.command(id, "submit", { text: msg.Text, requestId: msg.PrismMessageID }, CONFIRM_TIMEOUT_MS);
    } catch (error) {
      ledger.transition(msg.PrismMessageID, "indeterminate", error instanceof Error ? error.message : String(error));
      throw new PluginAdapterError("delivery_indeterminate", "Claude Mod did not confirm prompt dispatch; automatic resend is unsafe");
    }
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = ledger.get(msg.PrismMessageID);
      if (record?.state === "submitted" || record?.state === "completed") return { NativeMessageID: msg.PrismMessageID, CanonicalNativeSessionID: id, CanonicalNativeThreadID: id, Accepted: true, Visible: true, Detail: "Native prompt.submit origin and turn identity confirmed" };
      if (record?.state === "indeterminate" || record?.state === "failed") throw new PluginAdapterError("delivery_indeterminate", record.detail || "Claude prompt delivery is uncertain");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ledger.transition(msg.PrismMessageID, "indeterminate", "Mod dispatch returned but native prompt.submit/turn identity was not confirmed");
    throw new PluginAdapterError("delivery_indeterminate", "Claude did not confirm native prompt.submit before timeout; do not retry automatically");
  }
  async verifyVisibility(native: NativeSession, marker: string): Promise<VisibilityResult> {
    const id = native.NativeSessionID;
    const record = this.deliveryLedger(id).get(marker);
    const visible = Boolean(record?.prompt_id) || record?.state === "submitted" || record?.state === "completed";
    return { Visible: visible, Marker: marker, Evidence: visible ? "Native Mod submit result and turn identity" : "", CheckedAt: now(), FailureReason: visible ? "" : "Prompt submission not confirmed" };
  }
  async waitForRun(native: NativeSession, runID: string): Promise<PluginEvent> {
    const deadline = Date.now() + 14 * 60_000;
    const fallback = (summary: string): PluginEvent => ({
      ID: `${runID}:wait-unconfirmed`, Type: "run.wait_timeout", Status: "running", Summary: summary,
      Payload: { timeout_fallback: true }, CreatedAt: now(),
    });
    while (Date.now() < deadline) {
      const id = native.NativeSessionID;
      const record = this.deliveryLedger(id).get(runID);
      if (!record) return fallback("Claude delivery record is unavailable; completion cannot be confirmed");
      if (record.state === "completed" || record.state === "failed" || record.state === "interrupted") return {
        ID: `${runID}:${record.state}`, Type: record.state === "failed" ? "run.failed" : record.state === "interrupted" ? "run.interrupted" : "run.completed",
        Status: record.state, Summary: record.state === "failed" ? "Claude turn failed" : record.state === "interrupted" ? "Claude turn was interrupted" : "Claude turn completed",
        Payload: {}, CreatedAt: record.updated_at,
      };
      if (record.state === "indeterminate") return fallback("Claude prompt delivery is uncertain; completion cannot be confirmed");
      if (!this.bridge.session(id) && !this.manager.hasSupervisorOwner(id)) return fallback("Claude native Mod session is unavailable; completion cannot be confirmed");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return fallback("Claude run completion was not confirmed within the waiting window");
  }
  async controlSession(req: ControlSessionRequest): Promise<ControlSessionResult> {
    const action = req.action.toLowerCase().replace(/_/g, ".");
    const id = req.session.NativeSessionID;
    if (action === "conversation.select") {
      if (!id || (req.session.NativeThreadID && req.session.NativeThreadID !== id)) throw new PluginAdapterError("invalid_session_id", "Claude session and thread identity do not match");
      if (!this.bridge.session(id) && !await this.reader.sessionInfo(id)) throw new PluginAdapterError("native_session_not_found", "Claude native session is unavailable");
      // Selecting history does not launch a process or change its model.
      return {ok:true, action:req.action, thread_id:id, details_confirmed:false};
    }
    if (action !== "model.switch") throw new PluginAdapterError("unsupported_control", "Only native model switching is supported");
    const target = typeof req.target === "string" ? req.target : req.target && typeof req.target === "object" ? String((req.target as Record<string, unknown>).option_id || (req.target as Record<string, unknown>).id || "") : "";
    if (!target) throw new PluginAdapterError("invalid_model_option", "Model option ID is required");
    const result = await this.bridge.command(id, "model.set", {model:target});
    this.updateModels(id, result);
    return {ok:true, action:req.action, details:await this.readDetail(req.session), details_confirmed:true};
  }
  private updateModels(id: string, event: Record<string, unknown>): void {
    if (typeof event.model !== "string" || !Array.isArray(event.modelOptions)) return;
    const detail = {current_model:{id:event.model,option_id:event.model,label:event.model}, model_options:event.modelOptions.filter((option): option is string => typeof option === "string").map(option => ({id:option,option_id:option,target:{option_id:option},label:option,available:event.modelLocked !== true})), actions:event.modelLocked === true ? [] : [{id:"model.switch",label:"Switch model",available:true}]};
    if (JSON.stringify(this.modelStates.get(id)) === JSON.stringify(detail)) return;
    this.modelStates.set(id,detail);
    this.publish(id,"desktop.state.changed","running","Claude native model configuration changed",{detail_snapshot:detail});
  }
  async readDetail(native: NativeSession): Promise<Record<string, unknown>> {
    const id = native.NativeSessionID;
    const mod = this.bridge.session(id);
    if (mod && Date.now() - mod.seen_at < 5000) {
      const activeRemote = this.bridge.activeRemoteTurn(id);
      const submission = this.bridge.remoteSubmission(id);
      const terminal: TerminalSnapshot = { status: mod.surface.includes("terminal") ? "attached" : "detached", input_owner: null, can_send: !mod.turn_id && !submission, can_interrupt: Boolean(activeRemote), can_approve: false, ...(mod.turn_id && !activeRemote ? { reason: "A local Claude turn is running; Prism will not reassign it" } : submission ? { reason: "A Prism prompt is awaiting a native turn result" } : {}) };
      const client = this.manager.hasSupervisorOwner(id) ? await this.manager.connect(id).catch(() => undefined) : undefined;
      const approval = this.bridge.approval(id);
      terminal.can_approve = Boolean(approval);
      return { ...this.modelStates.get(id), terminal, approval, primary_action: approval ? "approval" : "send", run: { status: mod.turn_id ? (activeRemote ? "running" : "busy_local") : "idle" }, actions: this.modelStates.get(id)?.actions || [] };
    }
    if (!this.manager.hasSupervisorOwner(id) && !this.manager.hasUncertainManagedState(id)) {
      await this.legacySummary(id, native.Cwd);
      const active = activeClaudeSessionPID(id, join(this.reader.configDir, "sessions"));
      const terminal: TerminalSnapshot = { status: active ? "reconnecting" : "detached", input_owner: null,
        can_send: !active, can_interrupt: false, can_approve: false,
        reason: active ? "An older Claude process still owns this session; close it before managed resume" : "The next send resumes this historical Claude session in a new managed process" };
      return { terminal, approval: null, primary_action: "send", run: { status: "idle" }, actions: [] };
    }
    const client = await this.manager.connect(id);
    const [terminal, approval] = await Promise.all([client.refresh(), Promise.resolve(null)]);
    if (terminal.status !== "stopped") {
      terminal.can_send = false;
      terminal.reason = "This Claude process has no current Mod handshake. Reopen it once with the installed Mod; no second writer was started.";
    }
    return { terminal, approval, primary_action: approval ? "approval" : "send", run: { status: approval ? "waiting_approval" : terminal.can_interrupt ? "running" : "idle" }, actions: [] };
  }
  async readStatus(native: NativeSession, _runID: string): Promise<RunStatus> {
    const detail = await this.readDetail(native);
    const terminal = detail.terminal as TerminalSnapshot;
    const run = detail.run as { status?: string } | undefined;
    const status = run?.status === "busy_local" ? "running" : run?.status || (terminal.can_interrupt ? "running" : "idle");
    return { status, phase: { id: terminal.status }, preview: terminal.reason || "", steps: [], interruptible: terminal.can_interrupt, approval_blocked: status === "waiting_approval" || terminal.can_approve };
  }
  async readHistory(native: NativeSession, limit: number): Promise<HistoryMessage[]> {
    const entries = await this.reader.readTranscript(native.NativeSessionID);
    return entries.slice(-Math.max(1, limit)).map((entry) => this.historyMessage(entry));
  }
  async *readHistoryStream(native: NativeSession, request: HistoryStreamRequest, signal?: AbortSignal): AsyncIterable<HistoryStreamEvent> {
    const id = native.NativeSessionID;
    type Turns = Awaited<ReturnType<LiveTranscript["snapshot"]>>;
    const updates: Turns[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let overflow = false;
    const abort = () => { wake?.(); wake = undefined; };
    const close = () => { closed = true; abort(); };
    this.historyClosers.add(close);
    const off = request.live ? this.liveTranscript.subscribe(id, (turns) => {
      if (closed || overflow) return;
      if (updates.length >= 1024) overflow = true;
      else updates.push(turns);
      abort();
    }) : () => undefined;
    const timer = request.live ? setInterval(() => { void this.liveTranscript.refresh(id).catch(() => undefined); }, 1000) : undefined;
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const groups = await this.liveTranscript.snapshot(id);
      const seen = new Map(groups.map((group) => [group.turn_id, group.revision]));
      for (const group of groups.slice(-Math.max(1, request.limit))) {
        if (signal?.aborted || closed) return;
        yield { stream_id: request.stream_id, type: "turn", source: "initial", operation: "append", turn: group };
      }
      yield { stream_id: request.stream_id, type: "page_end" };
      while (request.live && !signal?.aborted && !closed) {
        if (overflow) {
          yield { stream_id: request.stream_id, type: "error", error: "Live history consumer fell behind; reconnect to recover the current reply", retryable: true };
          return;
        }
        if (!updates.length) await new Promise<void>((resolve) => { wake = resolve; });
        if (signal?.aborted || closed) return;
        const next = updates.shift();
        if (!next) continue;
        for (const group of next) {
          const previous = seen.get(group.turn_id);
          if (previous !== undefined && previous >= group.revision) continue;
          seen.set(group.turn_id, group.revision);
          yield { stream_id: request.stream_id, type: "turn", source: "live", operation: previous === undefined ? "append" : "replace", turn: group };
        }
      }
      yield { stream_id: request.stream_id, type: "end" };
    } finally {
      off(); this.historyClosers.delete(close); if (timer) clearInterval(timer); signal?.removeEventListener("abort", abort);
    }
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
      if (this.manager.hasSupervisorOwner(id)) detail = await this.readDetail(native);
      queue.push({ ID: `${id}:terminal-initial:${randomUUID()}`, Type: "desktop.state.changed", Status: "running", Summary: "Claude terminal state", Payload: { detail_snapshot: detail }, CreatedAt: now() });
      if (!this.manager.hasSupervisorOwner(id)) {
        let previous = JSON.stringify(detail.terminal);
        let checking = false;
        poll = setInterval(() => {
          if (checking || this.manager.hasSupervisorOwner(id)) return;
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
  async *subscribePlugin(signal?: AbortSignal): AsyncIterable<PluginEvent> {
    const queue = new EventQueue();
    this.pluginSubscribers.add(queue);
    const subscriptions = new Map<string, AbortController>();
    const titles = new Map<string, string>();
    const promptTitles = new Map<string, string>();
    const checkedTitlesAt = new Map<string, number>();
    const abort = () => queue.close();
    signal?.addEventListener("abort", abort, { once: true });
    const publishIndex = (native: NativeSession, title: string, terminalStatus = "ready") => {
      const id = native.NativeSessionID;
      if (titles.get(id) === title) return;
      titles.set(id, title);
      queue.push({
        ID: `${id}:index:${randomUUID()}`, Type: "desktop.session.index.changed", Status: "idle",
        Summary: "Claude session directory item changed", CreatedAt: now(),
        Payload: {
          native_session: { plugin_id: PLUGIN_ID, native_session_id: id, native_thread_id: id, surface: SURFACE, endpoint: native.Endpoint, cwd: native.Cwd },
          session_hint: { plugin_id: PLUGIN_ID, native_session_id: id, native_thread_id: id, surface: SURFACE, endpoint: native.Endpoint, cwd: native.Cwd, title, last_activity_at: now(), metadata: { terminal_status: terminalStatus } },
        },
      });
    };
    let scanning = false;
    const scan = async () => {
      if (scanning || signal?.aborted) return;
      scanning = true;
      try {
        const live = new Set([...this.manager.listSessionIDs(), ...this.bridge.sessionsSnapshot().filter((item) => Date.now() - item.seen_at < 5000).map((item) => item.session_id)]);
        for (const [id, controller] of subscriptions) {
          if (!live.has(id)) {
            const staleMod = this.bridge.session(id);
            if (staleMod) this.publish(id, "desktop.state.changed", "idle", "Claude Mod heartbeat lost; remote control revoked", {
              detail_snapshot: { terminal: { status: "detached", input_owner: null, can_send: false, can_interrupt: false, can_approve: false, reason: "Claude Code Mod heartbeat is unavailable" } },
            });
            controller.abort(); subscriptions.delete(id);
            titles.delete(id); promptTitles.delete(id); checkedTitlesAt.delete(id);
          }
        }
        for (const id of live) {
          if (subscriptions.has(id)) {
            if (Date.now() - (checkedTitlesAt.get(id) || 0) >= 5000) {
              checkedTitlesAt.set(id, Date.now());
              const info = await this.reader.sessionInfo(id).catch(() => undefined);
              const title = conversationTitle(info?.title && info.title !== "Claude Code session" ? info.title : promptTitles.get(id) || this.modTitleHints.get(id));
              const client = await this.manager.connect(id).catch(() => undefined);
              const mod = this.bridge.session(id);
              publishIndex(session(id, mod?.cwd || client?.descriptor.cwd || info?.cwd || process.cwd()), title, mod ? "attached" : "ready");
            }
            continue;
          }
          const mod = this.bridge.session(id);
          if (mod && Date.now() - mod.seen_at < 5000) {
            const native = session(id, mod.cwd);
            const controller = new AbortController();
            subscriptions.set(id, controller);
            const info = await this.reader.sessionInfo(id).catch(() => undefined);
            checkedTitlesAt.set(id, Date.now());
            publishIndex(native, conversationTitle(info?.title), "attached");
            void (async () => {
              try { for await (const event of this.subscribe(native, controller.signal)) queue.push({ ...event, Payload: { ...event.Payload, native_session: { plugin_id: PLUGIN_ID, native_session_id: id, native_thread_id: id, surface: native.Surface, endpoint: native.Endpoint, cwd: native.Cwd } } }); }
              catch { /* Next scan reconnects after the local bridge returns. */ }
              finally { if (subscriptions.get(id) === controller) subscriptions.delete(id); }
            })();
            continue;
          }
          let client: ManagedSupervisorClient;
          try { client = await this.manager.connect(id); }
          catch { continue; }
          let terminal: TerminalSnapshot;
          try { terminal = await client.refresh(); }
          catch { continue; }
          const native = session(id, client.descriptor.cwd);
          const controller = new AbortController();
          subscriptions.set(id, controller);
          const info = await this.reader.sessionInfo(id).catch(() => undefined);
          checkedTitlesAt.set(id, Date.now());
          publishIndex(native, conversationTitle(info?.title && info.title !== "Claude Code session" ? info.title : undefined), terminal.status);
          void (async () => {
            try {
              for await (const event of this.subscribe(native, controller.signal)) {
                if (event.Type === "message.user.accepted" && typeof event.Payload.text === "string") {
                  promptTitles.set(id, conversationTitle(event.Payload.text));
                  const info = await this.reader.sessionInfo(id).catch(() => undefined);
                  publishIndex(native, conversationTitle(info?.title && info.title !== "Claude Code session" ? info.title : promptTitles.get(id)));
                }
                queue.push({ ...event, Payload: {
                  ...event.Payload,
                  native_session: { plugin_id: PLUGIN_ID, native_session_id: id, native_thread_id: id, surface: SURFACE, endpoint: native.Endpoint, cwd: native.Cwd },
                } });
              }
            } catch { /* A later scan can reconnect an unavailable supervisor. */ }
            finally { if (subscriptions.get(id) === controller) subscriptions.delete(id); }
          })();
        }
      } finally { scanning = false; }
    };
    let watcher: ReturnType<typeof watch> | undefined;
    try { watcher = watch(this.manager.baseDir, () => { void scan(); }); }
    catch { /* The interval below also discovers new sessions. */ }
    const poll = setInterval(() => { void scan(); }, 1000);
    try {
      await scan();
      for await (const event of queue) yield event;
    } finally {
      clearInterval(poll);
      watcher?.close();
      for (const controller of subscriptions.values()) controller.abort();
      subscriptions.clear();
      queue.close();
      this.pluginSubscribers.delete(queue);
      signal?.removeEventListener("abort", abort);
    }
  }
  async ackEvent(native: NativeSession, eventID: string): Promise<void> {
    const prefix = `${native.NativeSessionID}:`;
    if (!eventID.startsWith(prefix)) throw new PluginAdapterError("event_ack_mismatch", "Claude event does not belong to this session");
    // Mod events are live local observations; transcript polling repairs missed history updates.
    void prefix;
  }
  async interrupt(native: NativeSession): Promise<void> {
    const id = native.NativeSessionID;
    const active = this.bridge.activeRemoteTurn(id);
    if (!active) throw new PluginAdapterError("interrupt_unavailable", "Only a Prism-origin turn with a verified native turn ID can be interrupted");
    try { await this.bridge.command(id, "abort", { turnId: active.turnId }, CONFIRM_TIMEOUT_MS); }
    catch (error) { throw new PluginAdapterError("interrupt_unavailable", error instanceof Error ? error.message : String(error)); }
  }
  async resolveApproval(req: ApprovalResolutionRequest): Promise<void> {
    if (req.Session.PluginID !== PLUGIN_ID || !req.Session.NativeSessionID) throw new PluginAdapterError("approval_stale", "Claude approval session does not match");
    const id = req.Session.NativeSessionID;
    if (this.bridge.approval(id)) {
      try { await this.bridge.resolveApproval(id, req.ApprovalRequestID, req.ActionID); }
      catch (error) { throw new PluginAdapterError("approval_stale", error instanceof Error ? error.message : String(error)); }
      return;
    }
    throw new PluginAdapterError("approval_stale", "This native Claude session has no active Prism-routed approval");
  }
  async close(): Promise<void> {
    for (const close of this.historyClosers) close();
    this.historyClosers.clear();
    this.liveTranscript.close();
    for (const listeners of this.subscribers.values()) for (const queue of listeners) queue.close();
    for (const queue of this.pluginSubscribers) queue.close();
    this.manager.close(); // The detached supervisor and native Claude PTY stay alive.
    await this.bridge.close();
    await this.reader.close();
  }
  private async ensureModReady(): Promise<void> {
    try {
      await this.bridgeReady;
      if (!this.modReady) {
        this.modReady = Promise.resolve().then(() => {
          const cli = resolveClaudeCLI();
          const install = spawnSync(process.execPath, [join(PLUGIN_ROOT, "scripts", "install-mod.mjs"), "install"], { timeout: 120_000, encoding: "utf8", env: cli.env, stdio: ["ignore", "ignore", "pipe"] });
          if (install.error || install.status !== 0) throw new Error(install.error?.message || String(install.stderr || "Claude Code Mod install/update failed").trim());
          this.modInstallError = undefined;
        }).catch((error: unknown) => {
          this.modReady = undefined;
          this.modInstallError = error instanceof Error ? error.message : String(error);
          throw error;
        });
      }
      await this.modReady;
    }
    catch (error) { throw new PluginAdapterError("mod_unavailable", this.modInstallError || (error instanceof Error ? error.message : String(error))); }
  }
  private deliveryLedger(id: string): PersistentDeliveryLedger {
    let ledger = this.deliveryLedgers.get(id);
    if (ledger) return ledger;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new PluginAdapterError("invalid_session_id", "Claude native session ID is invalid");
    const dir = join(this.bridge.stateDir, "deliveries");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ledger = new PersistentDeliveryLedger(join(dir, `${id}.json`));
    this.deliveryLedgers.set(id, ledger);
    return ledger;
  }
  private async ensureTerminalVisible(id: string): Promise<void> {
    // Externally launched native/IDE terminals remain controlled by their Mod.
    if (!this.manager.hasSupervisorOwner(id)) return;
    const client = await this.manager.connect(id);
    if ((await client.refresh()).status === "detached") await client.openTerminal(id);
  }
  private async reconnectNativeSession(id: string, cwd: string): Promise<void> {
    const owner = claudeSessionOwner(id, join(this.reader.configDir, "sessions"));
    if (owner.state === "active") throw new PluginAdapterError("mod_session_not_connected", "This Claude process is still active but has no Mod heartbeat; reopen it once with the installed Mod before remote control");
    if (owner.state === "unknown") throw new PluginAdapterError("mod_session_owner_uncertain", "Claude's live-session registry is unavailable; refusing to create a second writer");
    const reconciled = this.bridge.reconcileExitedOwner(id);
    if (!reconciled.released) throw new PluginAdapterError("mod_session_owner_uncertain", "A Mod owner is still heartbeating; refusing to create a second writer");
    if (reconciled.requestID) {
      try { this.deliveryLedger(id).transition(reconciled.requestID, "indeterminate", "The owning Claude process exited before Prism received a confirmed turn completion"); } catch {}
    }
    let client: ManagedSupervisorClient;
    try {
      client = await this.connectOrResume(id, cwd);
      await client.openTerminal(id);
      await this.bridge.waitForSession(id, CONFIRM_TIMEOUT_MS);
    } catch (error) {
      throw new PluginAdapterError("mod_session_not_connected", error instanceof Error ? error.message : String(error));
    }
  }
  private handleModEvent(event: ModEvent): void {
    const id = event.sessionId;
    if (event.kind === "models.current" || event.kind === "models-returned") { this.updateModels(id, event); return; }
    if (event.kind.startsWith("step.") || event.kind === "prompt.submit" || event.kind === "submit-dispatched" || event.kind === "turn.start" || event.kind === "turn.complete" || event.kind === "session.end") {
      void this.liveTranscript.handle(event).catch(() => undefined);
      if (event.kind.startsWith("step.")) return;
    }
    const requestID = typeof event.prism_request_id === "string" ? event.prism_request_id : "";
    const deliveryID = typeof event.prism_delivery_request_id === "string" ? event.prism_delivery_request_id : "";
    if (event.kind === "session.start" || event.kind === "session.current") {
      const snapshot = this.bridge.session(id);
      if (!snapshot) return;
      const signature = `${snapshot.cwd}|${snapshot.version}|${snapshot.surface.join(",")}|${snapshot.turn_id || ""}`;
      if (this.modStateSignatures.get(id) === signature) return;
      this.modStateSignatures.set(id, signature);
      const terminal: TerminalSnapshot = { status: snapshot.surface.includes("terminal") ? "attached" : "detached", input_owner: null, can_send: !snapshot.turn_id, can_interrupt: Boolean(this.bridge.activeRemoteTurn(id)), can_approve: false, ...(snapshot.turn_id && !this.bridge.activeRemoteTurn(id) ? { reason: "A local Claude turn is running; Prism will not reassign it" } : {}) };
      this.publish(id, "desktop.state.changed", "running", "Native Claude Mod session connected", { detail_snapshot: { terminal, approval: null }, native_session: session(id, snapshot.cwd) });
      if (typeof event.previousSessionId === "string" && event.previousSessionId !== id) {
        const previousID = event.previousSessionId;
        if (typeof event.previousRequestId === "string") this.deliveryLedger(previousID).transition(event.previousRequestId, "indeterminate", "Native session identity changed before this Prism request completed; it remains bound to the previous transcript");
        this.publish(previousID, "desktop.state.changed", "idle", "Claude session identity changed", { lifecycle: "native_session_changed", next_native_session_id: id, remote_control_revoked: true });
        this.publish(id, "desktop.session.index.changed", "idle", "Claude native session identity changed", { native_session: session(id, snapshot.cwd) });
      }
      return;
    }
    if (event.kind === "prompt.submit") {
      const origin = event.origin && typeof event.origin === "object" ? event.origin as Record<string, unknown> : {};
      if (!(origin.kind === "plugin" && origin.name === "prism-terminal-control") && typeof event.text === "string" && event.text.trim()) {
        this.modTitleHints.set(id, conversationTitle(event.text));
      }
      return;
    }
    if (event.kind === "session.end") {
      if (requestID) {
        try { this.deliveryLedger(id).transition(requestID, "indeterminate", "Claude native session ended before Prism received a confirmed turn completion"); } catch {}
      }
      this.modelStates.delete(id);
      this.modStateSignatures.delete(id);
      this.publish(id, "desktop.state.changed", "idle", "Claude Code session ended", { remote_control_revoked: true });
      return;
    }
    if (event.kind === "submit-settled") {
      const reqID = deliveryID;
      if (reqID) {
        const ledger = this.deliveryLedger(id);
        const record = ledger.get(reqID);
        if (event.dropped === true) ledger.transition(reqID, "failed", "Claude rejected the native prompt submission");
        else if (event.prism_request_ambiguous === true) ledger.transition(reqID, "indeterminate", "A local or other prompt raced with the remote submit; native turn identity is ambiguous");
        else if (requestID && typeof event.turnId === "string") {
          ledger.transition(reqID, "submitted", "Native Mod submit result and turn identity confirmed", event.turnId);
          this.publish(id, "message.user.accepted", "accepted", typeof event.text === "string" ? event.text.slice(0, 160) : "Claude prompt accepted", { role: "user", text: event.text || "", prism_message_id: reqID, request_id: reqID, turn_id: event.turnId });
          this.publish(id, "run.started", "running", "Claude turn started", { run_id: reqID, turn_id: event.turnId, source: "prism" });
        }
        if (record?.state === "indeterminate") return;
      }
      return;
    }
    if (event.kind === "turn.start") {
      const turnID = typeof event.turnId === "string" ? event.turnId : "";
      if (requestID) {
        const ledger = this.deliveryLedger(id);
        if (ledger.get(requestID)) ledger.transition(requestID, "submitted", "Native Mod correlated the remote submit to this turn", turnID);
        this.publish(id, "message.user.accepted", "accepted", typeof event.text === "string" ? event.text.slice(0, 160) : "Claude prompt accepted", { role: "user", text: event.text || "", prism_message_id: requestID, request_id: requestID, turn_id: turnID });
      }
      if (!requestID && typeof event.prism_pending_request_id === "string") return;
      if (!requestID && event.prism_request_ambiguous === true) {
        this.publish(id, "desktop.state.changed", "running", "A concurrent native prompt made Prism request attribution uncertain", { turn_id: turnID });
        return;
      }
      this.publish(id, "run.started", "running", "Claude turn started", { run_id: requestID || turnID, turn_id: turnID, source: requestID ? "prism" : "native" });
      return;
    }
    if (event.kind === "turn.complete") {
      const turnID = typeof event.turnId === "string" ? event.turnId : "";
      if (requestID) {
        const ledger = this.deliveryLedger(id);
        const next = event.isAborted === true ? "interrupted" : event.reason === "error" ? "failed" : "completed";
        ledger.transition(requestID, next, event.isAborted === true ? "Claude confirmed the target turn was aborted" : event.reason === "error" ? "Claude turn failed" : "Claude turn completed", turnID);
        this.publish(id, next === "interrupted" ? "run.interrupted" : next === "failed" ? "run.failed" : "run.completed", next, "Claude turn ended", { run_id: requestID, turn_id: turnID });
      }
      this.publish(id, "conversation.history.changed", "running", "Claude transcript changed", {});
      return;
    }
    if (event.kind === "approval.request") {
      const approval = this.bridge.approval(id);
      if (approval) this.publish(id, "approval.required", "waiting_approval", String(approval.title || "Claude permission request"), { ...approval, detail_snapshot: { approval } });
      return;
    }
    if (event.kind === "session.end") this.publish(id, "desktop.state.changed", "idle", "Claude native session ended", { lifecycle: "session_end", reason: event.reason });
  }
  private historyMessage(entry: TranscriptEntry): HistoryMessage {
    const stamp = entry.timestamp || "1970-01-01T00:00:00.000Z";
    return { ID: entry.uuid, Role: entry.role, Type: "text", Content: entry.text, Status: "completed", CreatedAt: stamp, UpdatedAt: stamp,
      ...(entry.toolUses.length ? { Progress: { Status: "completed", StartedAt: stamp, CompletedAt: stamp, Steps: entry.toolUses.map((tool) => ({ ID: `tool:${tool.callId}`, CallID: tool.callId, Kind: "tool", Title: tool.title, Detail: "", Status: tool.failed ? "failed" : "completed", CreatedAt: stamp })) } } : {}) };
  }
  private async legacySummary(id: string, cwd: string): Promise<{ cwd: string }> {
    if (this.manager.hasSupervisorOwner(id) || this.manager.hasUncertainManagedState(id)) throw new PluginAdapterError("managed_session_not_found", "Claude terminal owner is uncertain; refusing to start another writer");
    const summary = await this.reader.sessionInfo(id);
    if (!summary || !summary.cwd || (cwd && canonicalCwd(summary.cwd) !== canonicalCwd(cwd))) {
      throw new PluginAdapterError("managed_session_not_found", "Claude historical session is unavailable or belongs to another project");
    }
    return { cwd: resolve(summary.cwd) };
  }
  private async connectOrResume(id: string, cwd: string): Promise<ManagedSupervisorClient> {
    if (this.manager.hasSupervisorOwner(id)) {
      const current = await this.manager.connect(id);
      if ((await current.refresh()).status !== "stopped") return current;
      await current.shutdown();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !this.manager.hasSafelyClosedState(id)) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!this.manager.hasSafelyClosedState(id)) throw new PluginAdapterError("managed_owner_uncertain", "Stopped Claude process exit was not confirmed; refusing to resume the transcript");
      const summary = await this.legacySummary(id, cwd);
      return (await this.manager.resume(id, summary.cwd)).client;
    }
    if (this.manager.hasUncertainManagedState(id)) {
      const registryDir = join(this.reader.configDir, "sessions");
      if (!this.bridge.reconcileExitedOwner(id).released || !this.manager.recoverOrphanedState(id, registryDir)) {
        throw new PluginAdapterError("managed_owner_uncertain", "Prior Claude owner is still active or cannot be verified; refusing to resume the transcript");
      }
    }
    if (this.manager.hasSafelyClosedState(id)) {
      const summary = await this.legacySummary(id, cwd);
      return (await this.manager.resume(id, summary.cwd)).client;
    }
    const existing = this.migrations.get(id);
    if (existing) return await existing;
    const migration = this.resumeLegacy(id, cwd);
    this.migrations.set(id, migration);
    try { return await migration; }
    finally { this.migrations.delete(id); }
  }
  private async resumeLegacy(id: string, cwd: string): Promise<ManagedSupervisorClient> {
    const summary = await this.legacySummary(id, cwd);
    const owner = claudeSessionOwner(id, join(this.reader.configDir, "sessions"));
    if (owner.state !== "inactive") throw new PluginAdapterError(owner.state === "active" ? "legacy_session_active" : "managed_session_owner_uncertain", owner.state === "active" ? "An older Claude process still owns this session; close it before native resume" : "Claude's live-session registry is unavailable; refusing to create a second writer");
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
}
