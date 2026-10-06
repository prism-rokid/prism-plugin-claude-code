/** Discovers or starts per-session detached Claude PTY supervisors. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ManagedSupervisorClient } from "./managed-supervisor-client.js";
import type { TerminalSnapshot } from "./native-terminal-state.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ManagedSupervisorManager {
  readonly baseDir: string;
  private clients = new Map<string, ManagedSupervisorClient>();
  constructor(
    baseDir = process.env.PRISM_CLAUDE_MANAGED_DIR || join(homedir(), ".prism", "claudecode", "managed"),
    private readonly onState?: (sessionID: string, state: TerminalSnapshot) => void,
    private readonly onHook?: (sessionID: string, hook: Record<string, unknown>, eventID?: string, replayed?: boolean, createdAt?: string) => void,
  ) {
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  }

  sessionDir(sessionID: string): string {
    if (!SESSION_ID.test(sessionID)) throw new Error("Invalid Claude managed session ID");
    return join(this.baseDir, sessionID);
  }

  listSessionIDs(): string[] {
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name) && existsSync(join(this.baseDir, entry.name, "supervisor.json")))
      .map((entry) => entry.name);
  }

  async connect(sessionID: string): Promise<ManagedSupervisorClient> {
    const existing = this.clients.get(sessionID);
    if (existing) {
      try { await existing.refresh(); return existing; } catch { existing.close(); this.clients.delete(sessionID); }
    }
    const path = join(this.sessionDir(sessionID), "supervisor.json");
    if (!existsSync(path)) throw new Error("managed_session_not_found");
    try {
      const client = await ManagedSupervisorClient.connect(path, (state) => this.onState?.(sessionID, state), (hook, eventID, replayed, createdAt) => this.onHook?.(sessionID, hook, eventID, replayed, createdAt));
      if (client.descriptor.session_id !== sessionID) { client.close(); throw new Error("managed_session_identity_mismatch"); }
      this.clients.set(sessionID, client);
      return client;
    } catch {
      // A stale descriptor is never permission to resume the same transcript
      // in a second Claude process. Existing canonical bindings fail closed.
      throw new Error("managed_session_not_found");
    }
  }

  async create(cwd: string): Promise<{ sessionID: string; client: ManagedSupervisorClient }> {
    const sessionID = randomUUID();
    return await this.startSupervisor(sessionID, cwd, false);
  }

  async resume(sessionID: string, cwd: string): Promise<{ sessionID: string; client: ManagedSupervisorClient }> {
    // An existing managed directory, including one left by a crashed owner,
    // is not permission to launch a second writer for the same transcript.
    return await this.startSupervisor(sessionID, cwd, true);
  }

  hasManagedState(sessionID: string): boolean { return existsSync(this.sessionDir(sessionID)); }
  hasSupervisorOwner(sessionID: string): boolean { return existsSync(join(this.sessionDir(sessionID), "supervisor.json")); }
  hasSafelyClosedState(sessionID: string): boolean { const dir = this.sessionDir(sessionID); return !existsSync(join(dir, "supervisor.json")) && existsSync(join(dir, "closed.json")); }
  hasUncertainManagedState(sessionID: string): boolean { return this.hasManagedState(sessionID) && !this.hasSupervisorOwner(sessionID) && !this.hasSafelyClosedState(sessionID); }

  private async startSupervisor(sessionID: string, cwd: string, resume: boolean): Promise<{ sessionID: string; client: ManagedSupervisorClient }> {
    const dataDir = this.sessionDir(sessionID);
    if (existsSync(dataDir)) {
      if (!resume || !this.hasSafelyClosedState(sessionID)) throw new Error("managed_session_owner_uncertain");
      this.clients.get(sessionID)?.close();
      this.clients.delete(sessionID);
      rmSync(dataDir, { recursive: true, force: true });
    }
    mkdirSync(dataDir, { recursive: false, mode: 0o700 });
    const supervisor = fileURLToPath(new URL("./managed-supervisor.js", import.meta.url));
    const helper = fileURLToPath(new URL("./managed-terminal-client.js", import.meta.url));
    const child = spawn(process.execPath, [supervisor, sessionID, cwd, process.env.PRISM_CLAUDE_CLI || "claude", helper, dataDir, resume ? "resume" : "new"], {
      detached: true, stdio: "ignore", cwd,
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.unref();
    const descriptor = join(dataDir, "supervisor.json");
    for (let i = 0; i < 120; i++) {
      if (existsSync(descriptor)) return { sessionID, client: await this.connect(sessionID) };
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Claude managed supervisor did not start");
  }

  async discardUnstarted(sessionID: string): Promise<void> {
    const dir = this.sessionDir(sessionID);
    const descriptor = join(dir, "supervisor.json");
    for (let i = 0; i < 80 && existsSync(descriptor); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    if (existsSync(descriptor)) throw new Error("Cannot discard a Claude session while its supervisor is still active");
    const ledger = join(dir, "delivery-ledger.json");
    if (existsSync(ledger)) {
      const records = JSON.parse(readFileSync(ledger, "utf8")) as unknown;
      if (!Array.isArray(records) || records.length > 0) throw new Error("Cannot discard a Claude session with recorded delivery");
    }
    this.clients.get(sessionID)?.close();
    this.clients.delete(sessionID);
    rmSync(dir, { recursive: true, force: true });
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
