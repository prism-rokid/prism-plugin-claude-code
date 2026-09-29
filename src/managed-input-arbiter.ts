import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ManagedInputOwner = "local" | "panel" | null;
export type ManagedTerminalStatus = "starting" | "attached" | "detached" | "stopped" | "reconnecting";
export type DeliveryState = "injecting" | "awaiting_submit" | "submitted" | "completed" | "indeterminate" | "failed";

export type DeliveryRecord = {
  request_id: string;
  text_sha256: string;
  state: DeliveryState;
  created_at: string;
  updated_at: string;
  prompt_id?: string;
  detail?: string;
};

export type TerminalSnapshot = {
  status: ManagedTerminalStatus;
  input_owner: ManagedInputOwner;
  setup_required?: boolean;
  can_send: boolean;
  can_interrupt: boolean;
  can_approve: boolean;
  reason?: string;
};

export class PersistentDeliveryLedger {
  private records = new Map<string, DeliveryRecord>();

  constructor(private readonly filePath: string) { this.load(); }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as DeliveryRecord[];
      if (Array.isArray(data)) for (const record of data) {
        if (record && typeof record.request_id === "string") {
          // Older ledgers included the full prompt. Keep the delivery state,
          // but discard that redundant plaintext when the ledger is loaded.
          delete (record as DeliveryRecord & { text?: string }).text;
          this.records.set(record.request_id, record);
        }
      }
      let changed = JSON.stringify(data) !== JSON.stringify([...this.records.values()]);
      for (const record of this.records.values()) {
        if (record.state === "injecting" || record.state === "awaiting_submit") {
          record.state = "indeterminate";
          record.detail = "Plugin restarted before transcript submission was confirmed; automatic resend is unsafe";
          record.updated_at = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) this.persist();
    } catch {
      throw new Error("Claude managed delivery ledger is unreadable; refusing remote sends");
    }
  }

  get(requestID: string): DeliveryRecord | undefined {
    const record = this.records.get(requestID);
    return record && { ...record };
  }

  begin(requestID: string, text: string): { kind: "new"; record: DeliveryRecord } | { kind: "duplicate"; record: DeliveryRecord } | { kind: "conflict"; record: DeliveryRecord } {
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const existing = this.records.get(requestID);
    if (existing) return { kind: existing.text_sha256 === digest ? "duplicate" : "conflict", record: { ...existing } };
    const stamp = new Date().toISOString();
    const record: DeliveryRecord = { request_id: requestID, text_sha256: digest, state: "injecting", created_at: stamp, updated_at: stamp };
    this.records.set(requestID, record);
    this.persist();
    return { kind: "new", record: { ...record } };
  }

  transition(requestID: string, state: DeliveryState, detail?: string, promptID?: string): DeliveryRecord {
    const record = this.records.get(requestID);
    if (!record) throw new Error("Claude delivery request is not in the persistent ledger");
    record.state = state;
    record.updated_at = new Date().toISOString();
    if (detail) record.detail = detail;
    if (promptID) record.prompt_id = promptID;
    this.persist();
    return { ...record };
  }

  pendingByDigest(digest: string): DeliveryRecord | undefined {
    for (const record of this.records.values()) {
      if (record.text_sha256 === digest && (record.state === "injecting" || record.state === "awaiting_submit")) return { ...record };
    }
    return undefined;
  }

  snapshot(): DeliveryRecord[] { return [...this.records.values()].map((record) => ({ ...record })); }

  private persist(): void {
    const folder = dirname(this.filePath);
    const temporary = join(folder, ".delivery-ledger-" + process.pid + "-" + Date.now() + ".tmp");
    writeFileSync(temporary, JSON.stringify([...this.records.values()]) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.filePath);
    try {
      const dir = openSync(folder, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* Directory fsync is not available on every supported platform. */ }
  }
}

export interface PtyInputSink { write(data: string): void; }
export type PanelSendResult =
  | { status: "accepted" | "duplicate" | "indeterminate"; request_id: string; detail: string }
  | { status: "conflict" | "busy" | "invalid"; request_id: string; detail: string };

const LOCAL_HANDOFF = "\x1d"; // Ctrl-]
const CTRL_U = "\x15";
const BACKSPACE = new Set(["\x7f", "\x08"]);

/**
 * Serializes every PTY write. Local Terminal is only a byte client of this
 * arbiter; it never receives a PTY file descriptor and cannot bypass owner
 * checks. When Claude is idle, either surface can take the lease. An unfinished
 * local draft keeps Panel from replacing the native composer's contents.
 */
export class ManagedInputArbiter {
  private owner: ManagedInputOwner = null;
  private localAttached = false;
  private busy = false;
  private approvalPending = false;
  private remoteApprovalPending = false;
  private draftHasInput = false;
  private escapeState: "none" | "escape" | "csi" | "osc" | "osc_escape" | "ss3" = "none";
  private status: ManagedTerminalStatus = "starting";
  private ready = false;
  private setupRequired = false;
  private writeChain: Promise<void> = Promise.resolve();
  private lastStateSignature = "";

  constructor(
    private readonly sink: PtyInputSink,
    readonly ledger: PersistentDeliveryLedger,
    private readonly onStateChanged: (snapshot: TerminalSnapshot) => void = () => {},
  ) {}

  snapshot(): TerminalSnapshot {
    const canSend = this.ready && !(this.owner === "local" && this.draftHasInput) && !this.busy && !this.approvalPending && (this.status === "attached" || this.status === "detached");
    const reason = this.setupRequired ? "Claude Code requires local project trust; open its managed Terminal and accept the workspace prompt"
      : !this.ready && this.status !== "stopped" ? "Waiting for Claude Code to start"
      : this.status === "reconnecting" ? "Reconnecting to Claude Code"
        : this.status === "stopped" ? "Claude CLI is stopped"
      : this.approvalPending ? "A permission request is awaiting approval"
        : this.busy ? "Claude Code is processing a turn"
          : this.owner === "local" && this.draftHasInput
            ? this.localAttached ? "Local draft remains in Claude Code; clear or submit it before Panel sends" : "Local draft remains in Claude Code; reattach and clear or submit it before Panel sends"
            : undefined;
    return {
      status: this.status,
      input_owner: this.owner,
      ...(this.setupRequired ? { setup_required: true } : {}),
      can_send: canSend,
      can_interrupt: this.ready && this.busy && !this.approvalPending && this.status !== "stopped",
      can_approve: this.ready && this.approvalPending && this.remoteApprovalPending && this.status !== "stopped",
      ...(reason ? { reason } : {}),
    };
  }

  isStarted(): boolean { return this.ready; }

  setStarted(): void { this.ready = true; this.setupRequired = false; this.status = this.localAttached ? "attached" : "detached"; this.changed(); }
  setSetupRequired(): void { if (!this.ready && !this.setupRequired) { this.setupRequired = true; this.changed(); } }
  setStopped(): void { this.ready = false; this.setupRequired = false; this.status = "stopped"; this.owner = null; this.localAttached = false; this.changed(); }
  setReconnect(): void { this.ready = false; this.status = "reconnecting"; this.changed(); }

  attachLocal(): { readOnly: boolean; owner: ManagedInputOwner } {
    if (this.status === "stopped") return { readOnly: true, owner: null };
    this.localAttached = true;
    this.status = "attached";
    if (this.owner === null) this.owner = "local";
    this.changed();
    return { readOnly: this.owner !== "local", owner: this.owner };
  }

  detachLocal(): void {
    this.localAttached = false;
    if (this.status !== "stopped") this.status = "detached";
    // A detached Terminal can leave an unfinished Claude input buffer. Keep
    // its lease until the user reattaches and clears/submits that draft.
    if (this.owner === "local" && !this.draftHasInput) this.owner = null;
    this.changed();
  }

  async localInput(data: string): Promise<{ accepted: boolean; control?: "handoff" | "takeover"; reason?: string }> {
    if (!data) return { accepted: true };
    if (data.includes(LOCAL_HANDOFF)) {
      const before = data.slice(0, data.indexOf(LOCAL_HANDOFF));
      const after = data.slice(data.indexOf(LOCAL_HANDOFF) + LOCAL_HANDOFF.length);
      if (before) {
        const accepted = await this.localInput(before);
        if (!accepted.accepted) return accepted;
      }
      const transition = this.toggleOwner();
      if (!transition.accepted) return transition;
      if (after) return await this.localInput(after);
      return transition;
    }
    const scanned = this.scanLocalInput(data);
    let takeover = false;
    if (this.owner === "panel" && scanned.hasText && this.ready && !this.busy && !this.approvalPending) {
      // The first local keystroke after a Panel turn is an explicit local
      // action. Claim the lease before forwarding those bytes to the PTY.
      this.owner = "local";
      takeover = true;
    }
    if (this.owner !== "local") return { accepted: false, reason: this.snapshot().reason || "Panel input is active; wait for the turn to finish" };
    if (this.ready) this.draftHasInput = scanned.draftHasInput;
    await this.enqueueWrite(data);
    this.changed();
    return takeover ? { accepted: true, control: "takeover" } : { accepted: true };
  }

  async panelSend(requestID: string, text: string): Promise<PanelSendResult> {
    if (!requestID.trim() || !text.trim()) return { status: "invalid", request_id: requestID, detail: "Message ID and text are required" };
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (/[^\P{C}\t\n]/u.test(normalizedText)) return { status: "invalid", request_id: requestID, detail: "Message contains terminal control characters" };
    const existing = this.ledger.get(requestID);
    if (existing) {
      const begun = this.ledger.begin(requestID, text);
      if (begun.kind === "conflict") return { status: "conflict", request_id: requestID, detail: "Message ID was already used with different content" };
      return existing.state === "indeterminate"
        ? { status: "indeterminate", request_id: requestID, detail: existing.detail || "Delivery outcome is unknown; automatic resend is unsafe" }
        : { status: "duplicate", request_id: requestID, detail: "Original delivery state: " + existing.state };
    }
    if (this.owner === "local" && this.draftHasInput) return { status: "busy", request_id: requestID, detail: "Local Terminal has an unfinished draft; clear or submit it before Panel sends" };
    if (!this.ready || this.busy || this.approvalPending || this.status === "stopped" || this.status === "starting" || this.status === "reconnecting") {
      return { status: "busy", request_id: requestID, detail: this.snapshot().reason || "Claude Code is not ready for Panel input" };
    }
    const begun = this.ledger.begin(requestID, normalizedText);
    if (begun.kind !== "new") return { status: "conflict", request_id: requestID, detail: "Message ID collision" };
    this.owner = "panel";
    this.busy = true;
    this.changed();
    await this.enqueueWrite("\x1b[200~" + normalizedText + "\x1b[201~\r");
    this.ledger.transition(requestID, "awaiting_submit", "PTY write completed; waiting for UserPromptSubmit hook confirmation");
    this.changed();
    return { status: "accepted", request_id: requestID, detail: "Input serialized to the managed Claude PTY; waiting for transcript confirmation" };
  }

  async interrupt(): Promise<boolean> {
    if (!this.snapshot().can_interrupt) return false;
    for (const record of this.ledger.snapshot()) {
      if (record.state === "injecting" || record.state === "awaiting_submit") {
        this.ledger.transition(record.request_id, "indeterminate", "Interrupted before Claude confirmed prompt submission");
      }
    }
    await this.enqueueWrite("\x03");
    return true;
  }

  promptSubmitted(text: string, promptID: string): void {
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const pending = this.ledger.pendingByDigest(digest);
    if (pending) this.ledger.transition(pending.request_id, "submitted", "Claude Code accepted the prompt", promptID);
    this.draftHasInput = false;
    this.busy = true;
    this.changed();
  }

  turnCompleted(promptID?: string, failed = false): void {
    for (const record of this.ledger.snapshot()) {
      if (record.state === "submitted" && (!promptID || !record.prompt_id || record.prompt_id === promptID)) this.ledger.transition(record.request_id, failed ? "failed" : "completed");
    }
    this.busy = false;
    this.changed();
  }

  setApprovalPending(pending: boolean, remote = false): void { this.approvalPending = pending; this.remoteApprovalPending = pending && remote; if (pending) this.busy = true; this.changed(); }

  private toggleOwner(): { accepted: boolean; control?: "handoff" | "takeover"; reason?: string } {
    if (this.busy || this.approvalPending) return { accepted: false, reason: "Input ownership cannot change during a turn or pending approval" };
    if (this.owner === "local") {
      if (this.draftHasInput) return { accepted: false, reason: "Clear or submit the local draft before handing input to Panel" };
      this.owner = "panel";
      this.changed();
      return { accepted: true, control: "handoff" };
    }
    this.owner = "local";
    this.localAttached = true;
    this.status = "attached";
    this.changed();
    return { accepted: true, control: "takeover" };
  }

  private scanLocalInput(data: string): { hasText: boolean; draftHasInput: boolean } {
    let hasText = false;
    let draftHasInput = this.draftHasInput;
    for (const character of data) {
      if (this.escapeState === "escape") {
        if (character === "[" || character === "]" || character === "O") {
          this.escapeState = character === "[" ? "csi" : character === "]" ? "osc" : "ss3";
          continue;
        }
        // Escape is also a standalone Claude key. The next printable byte
        // belongs to the user's draft, even if it arrives in another packet.
        this.escapeState = "none";
      }
      if (this.escapeState === "csi") {
        if (character >= "@" && character <= "~") this.escapeState = "none";
        continue;
      }
      if (this.escapeState === "osc") {
        if (character === "\x07") this.escapeState = "none";
        else if (character === "\x1b") this.escapeState = "osc_escape";
        continue;
      }
      if (this.escapeState === "osc_escape") {
        this.escapeState = character === "\\" ? "none" : "osc";
        continue;
      }
      if (this.escapeState === "ss3") { this.escapeState = "none"; continue; }
      if (character === "\x1b") { this.escapeState = "escape"; continue; }
      if (character === CTRL_U) draftHasInput = false;
      else if (BACKSPACE.has(character)) { /* Keep non-empty state conservative. */ }
      else if (character === "\r" || character === "\n") { /* Hook confirmation clears the submitted draft. */ }
      else if (character >= " " || character === "\t") { hasText = true; draftHasInput = true; }
    }
    return { hasText, draftHasInput };
  }

  private enqueueWrite(data: string): Promise<void> {
    const current = this.writeChain.then(() => this.sink.write(data));
    this.writeChain = current.catch(() => {});
    return current;
  }

  private changed(): void {
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (signature === this.lastStateSignature) return;
    this.lastStateSignature = signature;
    this.onStateChanged(snapshot);
  }
}
