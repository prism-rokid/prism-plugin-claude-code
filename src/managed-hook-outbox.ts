import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StoredHook = { event_id: string; created_at: string; hook: Record<string, unknown> };

/** The supervisor records a Hook before broadcasting it to plugin clients. */
export class PersistentHookOutbox {
  private readonly directory: string;
  private readonly sequencePath: string;
  private readonly filenames = new Map<string, string>();
  private nextSequence: number;
  private replayCursor = 1;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "hook-outbox");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.sequencePath = join(this.directory, "next-sequence");
    const names = readdirSync(this.directory).filter((name) => /^\d{12}-[0-9a-f-]{36}\.json$/i.test(name));
    const nextFromDisk = existsSync(this.sequencePath) ? Number(readFileSync(this.sequencePath, "utf8")) : 1;
    if (!Number.isSafeInteger(nextFromDisk) || nextFromDisk < 1) throw new Error("Claude Hook outbox sequence is corrupt");
    this.nextSequence = Math.max(nextFromDisk, names.reduce((max, name) => Math.max(max, Number(name.slice(0, 12)) || 0), 0) + 1);
    for (const name of names) this.filenames.set(name.slice(13, -5), name);
  }

  append(hook: Record<string, unknown>): StoredHook {
    const event: StoredHook = { event_id: randomUUID(), created_at: new Date().toISOString(), hook };
    const sequence = this.nextSequence++;
    const name = `${String(sequence).padStart(12, "0")}-${event.event_id}.json`;
    const nextTemporary = join(this.directory, `.next-sequence-${event.event_id}.tmp`);
    writeFileSync(nextTemporary, String(this.nextSequence), { mode: 0o600, flag: "wx" });
    const counter = openSync(nextTemporary, "r");
    try { fsyncSync(counter); } finally { closeSync(counter); }
    renameSync(nextTemporary, this.sequencePath);
    const temporary = join(this.directory, `.${name}.tmp`);
    const final = join(this.directory, name);
    writeFileSync(temporary, JSON.stringify(event) + "\n", { mode: 0o600, flag: "wx" });
    const file = openSync(temporary, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, final);
    this.filenames.set(event.event_id, name);
    try {
      const directory = openSync(this.directory, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* Some platforms do not support directory fsync. */ }
    return event;
  }

  replay(limit = 256): StoredHook[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const names = [...this.filenames.values()].sort();
    if (names.length === 0) return [];
    // Rotate through unacknowledged entries. A permanently failing early
    // event must not prevent later events from being delivered and acked.
    const found = names.findIndex((name) => Number(name.slice(0, 12)) >= this.replayCursor);
    const start = found < 0 ? 0 : found;
    const ordered = names.slice(start);
    const selected = ordered.slice(0, Math.min(limit, 256));
    const lastSequence = Number(selected[selected.length - 1].slice(0, 12));
    const maxSequence = Number(names[names.length - 1].slice(0, 12));
    this.replayCursor = lastSequence >= maxSequence ? Number(names[0].slice(0, 12)) : lastSequence + 1;
    return selected.map((name) => {
      const value = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as StoredHook;
      if (!value || typeof value.event_id !== "string" || !value.hook || typeof value.hook !== "object") {
        throw new Error("Claude Hook outbox is corrupt; refusing incomplete replay");
      }
      return value;
    });
  }

  ack(eventID: string): boolean {
    const name = this.filenames.get(eventID);
    if (!name) return false;
    unlinkSync(join(this.directory, name));
    this.filenames.delete(eventID);
    try {
      const directory = openSync(this.directory, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* Some platforms do not support directory fsync. */ }
    return true;
  }
}
