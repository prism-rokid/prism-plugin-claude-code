export type NativeTerminalStatus = "starting" | "attached" | "detached" | "stopped" | "reconnecting";
export type TerminalSnapshot = {
  status: NativeTerminalStatus;
  input_owner: null;
  setup_required?: boolean;
  can_send: boolean;
  can_interrupt: boolean;
  can_approve: boolean;
  reason?: string;
};

/** Tracks only the native terminal lifecycle; remote control is handled by the Claude Mod bridge. */
export class NativeTerminalState {
  private status: NativeTerminalStatus = "starting";
  private ready = false;
  private setupRequired = false;
  constructor(private readonly onStateChanged: (snapshot: TerminalSnapshot) => void = () => {}) {}

  snapshot(): TerminalSnapshot {
    const reason = this.setupRequired ? "Claude Code requires local project trust; accept its native workspace prompt"
      : !this.ready && this.status !== "stopped" ? "Waiting for Claude Code to start"
        : this.status === "stopped" ? "Claude CLI is stopped" : undefined;
    return { status: this.status, input_owner: null, ...(this.setupRequired ? { setup_required: true } : {}), can_send: this.ready && (this.status === "attached" || this.status === "detached"), can_interrupt: false, can_approve: false, ...(reason ? { reason } : {}) };
  }
  isStarted(): boolean { return this.ready; }
  setStarted(): void { this.ready = true; this.setupRequired = false; this.status = this.status === "attached" ? "attached" : "detached"; this.changed(); }
  setSetupRequired(): void { if (!this.ready && !this.setupRequired) { this.setupRequired = true; this.changed(); } }
  setStopped(): void { this.ready = false; this.setupRequired = false; this.status = "stopped"; this.changed(); }
  attachLocal(): void { if (this.status !== "stopped") this.status = "attached"; this.changed(); }
  detachLocal(): void { if (this.status !== "stopped") this.status = "detached"; this.changed(); }
  private changed(): void { this.onStateChanged(this.snapshot()); }
}
