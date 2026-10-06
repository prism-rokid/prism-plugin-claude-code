import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DeliveryState = "awaiting_submit" | "submitted" | "completed" | "interrupted" | "indeterminate" | "failed";
export type DeliveryRecord = {
  request_id: string;
  text_sha256: string;
  state: DeliveryState;
  created_at: string;
  updated_at: string;
  prompt_id?: string;
  detail?: string;
};

/** Durable idempotency ledger for Mod-originated requests; never stores prompt text. */
export class PersistentDeliveryLedger {
  private records = new Map<string, DeliveryRecord>();
  constructor(private readonly filePath: string) { this.load(); }
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as DeliveryRecord[];
      if (!Array.isArray(data)) throw new Error("invalid ledger");
      for (const record of data) if (record && typeof record.request_id === "string") {
        delete (record as DeliveryRecord & { text?: string }).text;
        this.records.set(record.request_id, record);
      }
      let changed = JSON.stringify(data) !== JSON.stringify([...this.records.values()]);
      for (const record of this.records.values()) if (record.state === "awaiting_submit" || record.state === "submitted") {
        record.state = "indeterminate";
        record.detail = "Plugin restarted before native Mod turn completion was confirmed; delivery outcome is indeterminate and automatic resend is unsafe";
        record.updated_at = new Date().toISOString();
        changed = true;
      }
      if (changed) this.persist();
    } catch { throw new Error("Claude Mod delivery ledger is unreadable; refusing remote sends"); }
  }
  get(requestID: string): DeliveryRecord | undefined { const value = this.records.get(requestID); return value && { ...value }; }
  begin(requestID: string, text: string): { kind: "new"; record: DeliveryRecord } | { kind: "duplicate"; record: DeliveryRecord } | { kind: "conflict"; record: DeliveryRecord } {
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const existing = this.records.get(requestID);
    if (existing) return { kind: existing.text_sha256 === digest ? "duplicate" : "conflict", record: { ...existing } };
    const stamp = new Date().toISOString();
    const record: DeliveryRecord = { request_id: requestID, text_sha256: digest, state: "awaiting_submit", created_at: stamp, updated_at: stamp };
    this.records.set(requestID, record);
    this.persist();
    return { kind: "new", record: { ...record } };
  }
  transition(requestID: string, state: DeliveryState, detail?: string, promptID?: string): DeliveryRecord {
    const record = this.records.get(requestID);
    if (!record) throw new Error("Claude Mod request is not in the persistent ledger");
    record.state = state;
    record.updated_at = new Date().toISOString();
    if (detail) record.detail = detail;
    if (promptID) record.prompt_id = promptID;
    this.persist();
    return { ...record };
  }
  snapshot(): DeliveryRecord[] { return [...this.records.values()].map((record) => ({ ...record })); }
  private persist(): void {
    const folder = dirname(this.filePath);
    const temporary = join(folder, `.mod-ledger-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(temporary, JSON.stringify([...this.records.values()]) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.filePath);
    try { const dir = openSync(folder, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Unsupported on some platforms. */ }
  }
}
