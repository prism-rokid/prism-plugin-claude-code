import type { HistoryMessage, HistoryTurn } from "@rokid-prism/pluginbridge-plugin-sdk";
import type { ModEvent } from "./mod-bridge.js";
import type { TranscriptEntry } from "./transcript-reader.js";

type Preview = { id: string; turnId: string; nativeUserId?: string; userBaseline: Set<string>; step: number; sequence: number; text: string; blocks: Map<number, string>; status: string; timestamp: string; updatedAt: string; baseline: Set<string> };
type State = { submissionBaseline?: Set<string>; entries: TranscriptEntry[]; previews: Map<string, Preview>; bindings: Map<string, { nativeUserId?: string; userBaseline: Set<string>; timestamp: string }>; reconciled: Set<string>; turns: HistoryTurn[]; revision: number };

/** Ephemeral Mod text overlays; Claude's transcript remains the durable source. */
export class LiveTranscript {
  private states = new Map<string, State>();
  private pending = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<(turns: HistoryTurn[]) => void>>();
  constructor(private read: (id: string) => Promise<TranscriptEntry[]>, private message: (entry: TranscriptEntry) => HistoryMessage) {}

  subscribe(id: string, listener: (turns: HistoryTurn[]) => void): () => void {
    let listeners = this.listeners.get(id);
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  async snapshot(id: string): Promise<HistoryTurn[]> {
    await this.refresh(id);
    return this.state(id).turns;
  }
  refresh(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      const state = this.state(id);
      state.entries = await this.read(id);
      this.render(id, state);
    });
  }
  handle(event: ModEvent): Promise<void> {
    const id = event.sessionId;
    return this.enqueue(id, async () => {
      const state = this.state(id);
      if (event.kind === "session.end") {
        state.previews.clear();
        state.bindings.clear();
        state.entries = await this.read(id);
        this.render(id, state);
        if (!this.listeners.has(id)) this.states.delete(id);
        return;
      }
      if ((event.kind === "prompt.submit" || event.kind === "submit-dispatched")) {
        state.entries = await this.read(id);
        state.submissionBaseline = new Set(state.entries.filter((entry) => entry.role === "user").map((entry) => entry.uuid));
        return;
      }
      if (event.kind === "turn.start" && typeof event.turnId === "string") {
        state.entries = await this.read(id);
        const tail = state.entries.at(-1);
        const baseline = state.submissionBaseline;
        state.submissionBaseline = undefined;
        const currentUser = baseline ? state.entries.find((entry) => entry.role === "user" && !baseline.has(entry.uuid)) : tail?.role === "user" ? tail : undefined;
        state.bindings.set(event.turnId, { timestamp: new Date().toISOString(), nativeUserId: currentUser?.uuid, userBaseline: baseline || new Set(state.entries.filter((entry) => entry.role === "user").map((entry) => entry.uuid)) });
        this.render(id, state);
        return;
      }
      if (event.kind === "turn.complete") {
        if (typeof event.turnId === "string") state.bindings.delete(event.turnId);
        for (const preview of state.previews.values()) if (preview.turnId === event.turnId) {
          preview.status = event.isAborted === true ? "interrupted" : event.reason === "error" ? "failed" : "completed";
          preview.updatedAt = new Date().toISOString();
        }
        state.entries = await this.read(id);
        this.render(id, state);
        return;
      }
      if (typeof event.turnId !== "string" || !Number.isInteger(event.stepIndex)) return;
      const step = event.stepIndex as number;
      const key = `${event.turnId}:${step}`;
      if (event.kind === "step.start") {
        state.entries = await this.read(id);
        if (!state.previews.has(key)) state.previews.set(key, {
          id: `mod:${key}`, turnId: event.turnId, nativeUserId: state.bindings.has(event.turnId) ? state.bindings.get(event.turnId)?.nativeUserId : (state.entries.at(-1)?.role === "user" ? state.entries.at(-1)?.uuid : undefined), userBaseline: state.bindings.get(event.turnId)?.userBaseline || new Set(state.entries.filter((entry) => entry.role === "user").map((entry) => entry.uuid)), step, sequence: -1, text: "", blocks: new Map(), status: "running", timestamp: new Date().toISOString(), updatedAt: new Date().toISOString(),
          baseline: new Set(state.entries.map((entry) => entry.uuid)),
        });
      } else {
        const preview = state.previews.get(key);
        if (!preview) return;
        if (event.kind === "step.text") {
          if (typeof event.text !== "string" || !Number.isInteger(event.blockIndex) || !Number.isInteger(event.sequence) || (event.sequence as number) <= preview.sequence) return;
          // Never silently display a truncated preview after a missed chunk.
          if (event.sequence !== preview.sequence + 1) { state.previews.delete(key); this.render(id, state); return; }
          preview.sequence = event.sequence as number;
          const block = event.blockIndex as number;
          preview.blocks.set(block, (preview.blocks.get(block) || "") + event.text);
          preview.text = [...preview.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n");
        } else if (event.kind === "step.complete" || event.kind === "step.failed") {
          preview.status = event.kind === "step.failed" ? "failed" : "completed";
          state.entries = await this.read(id);
        } else return;
        preview.updatedAt = new Date().toISOString();
      }
      this.render(id, state);
    });
  }
  close(): void { this.listeners.clear(); this.states.clear(); }

  private state(id: string): State {
    let state = this.states.get(id);
    if (!state) { state = { entries: [], previews: new Map(), bindings: new Map(), reconciled: new Set(), turns: [], revision: 0 }; this.states.set(id, state); }
    return state;
  }
  private enqueue(id: string, action: () => Promise<void>): Promise<void> {
    const task = (this.pending.get(id) || Promise.resolve()).catch(() => undefined).then(action);
    this.pending.set(id, task);
    void task.finally(() => { if (this.pending.get(id) === task) this.pending.delete(id); }).catch(() => undefined);
    return task;
  }
  private render(id: string, state: State): void {
    const groups: HistoryTurn[] = [];
    for (const [index, entry] of state.entries.entries()) {
      if (entry.role === "user" || !groups.length) groups.push({ turn_id: entry.uuid, order_key: String(index).padStart(10, "0"), revision: 0, messages: [] });
      groups[groups.length - 1].messages.push(this.message(entry));
    }
    const nativeIDs = new Set(state.entries.map((entry) => entry.uuid));
    for (const [key, preview] of state.previews) {
      const matchedUser = state.entries.find((entry) => entry.role === "user" && !preview.userBaseline.has(entry.uuid));
      if (!preview.nativeUserId && matchedUser) {
        preview.nativeUserId = matchedUser.uuid;
        const binding = state.bindings.get(preview.turnId);
        if (binding) binding.nativeUserId = matchedUser.uuid;
      }
      const latest = preview.nativeUserId ? groups.find((group) => group.turn_id === preview.nativeUserId) : undefined;
      if (latest && !preview.nativeUserId) preview.nativeUserId = latest.turn_id;
      if (!preview.text || !latest) continue; // Wait for the native user row; never invent a second turn.
      // Restrict reconciliation to new rows in this turn, so repeated replies
      // in earlier history cannot erase a live preview.
      const persisted = latest.messages.filter((message) => message.Role === "assistant" && nativeIDs.has(message.ID) && !preview.baseline.has(message.ID) && !state.reconciled.has(message.ID) && message.Content.trim());
      const matching = persisted.find((message) => message.Content === preview.text);
      // A finished step's new native row wins even if another Mod changed its
      // text above our hook. Preview text is never the durable authority.
      const replacement = matching || (preview.status !== "running" ? persisted[0] : undefined);
      if (replacement) {
        if (preview.status !== "running") { state.reconciled.add(replacement.ID); state.previews.delete(key); }
        continue;
      }
      latest.messages.push({ ID: preview.id, Role: "assistant", Type: "text", Content: preview.text, Status: preview.status, CreatedAt: preview.timestamp, UpdatedAt: preview.updatedAt });
    }
    for (const [turnId, binding] of state.bindings) {
      if (!binding.nativeUserId) binding.nativeUserId = state.entries.find((entry) => entry.role === "user" && !binding.userBaseline.has(entry.uuid))?.uuid;
      const group = groups.find((group) => group.turn_id === binding.nativeUserId);
      if (!group) continue; // Never put the work indicator above its native user row.
      const userIndex = group.messages.findIndex((message) => message.Role === "user");
      group.messages.splice(userIndex + 1, 0, { ID: `mod:work:${turnId}`, Role: "assistant", Type: "progress", Content: "Claude Code is working", Status: "running", CreatedAt: binding.timestamp, UpdatedAt: binding.timestamp,
        Progress: { Status: "running", StartedAt: binding.timestamp, Steps: [] } });
    }
    const signature = (turns: HistoryTurn[]) => JSON.stringify(turns.map(({ revision: _revision, ...turn }) => turn));
    if (signature(groups) === signature(state.turns)) return;
    state.revision = Math.max(state.revision + 1, Date.now() * 1000);
    for (const turn of groups) {
      const previous = state.turns.find((item) => item.turn_id === turn.turn_id);
      turn.revision = previous && signature([previous]) === signature([turn]) ? previous.revision : state.revision;
    }
    state.turns = groups;
    for (const listener of this.listeners.get(id) || []) listener(groups);
  }
}
