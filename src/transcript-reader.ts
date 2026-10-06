import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type NativeSessionSummary = { sessionId: string; title: string; cwd: string; updatedAt: string };
export type TranscriptEntry = {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  toolUses: Array<{ callId: string; title: string; failed?: boolean }>;
  timestamp?: string;
};
type Row = Record<string, unknown>;
type TranscriptFile = { id: string; path: string; modified: number; size: number };
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function rows(text: string): Row[] {
  const result: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) result.push(value as Row);
    } catch { /* A CLI may still be writing the last JSONL record. */ }
  }
  return result;
}

function blocks(row: Row): Row[] {
  const message = row.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((block): block is Row => !!block && typeof block === "object" && !Array.isArray(block)) : [];
}

function messageText(row: Row): string {
  return blocks(row).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

/** Resolve the current conversation branch rather than replaying abandoned turns. */
function conversationRows(all: Row[]): Row[] {
  const latest = new Map<string, Row>();
  for (const row of all) if (typeof row.uuid === "string") latest.set(row.uuid, row);
  const main = all.filter((row) => row.isSidechain !== true && (typeof row.uuid !== "string" || latest.get(row.uuid) === row));
  const messages = main.filter((row) => row.type === "user" || row.type === "assistant");
  const leaf = messages.at(-1);
  if (!leaf || typeof leaf.uuid !== "string" || !messages.some((row) => typeof row.parentUuid === "string")) return main;
  const byID = new Map(main.filter((row) => typeof row.uuid === "string").map((row) => [row.uuid as string, row]));
  const selected = new Set<string>();
  let current: Row | undefined = leaf;
  while (current && typeof current.uuid === "string" && !selected.has(current.uuid)) {
    selected.add(current.uuid);
    const parent: unknown = typeof current.logicalParentUuid === "string" ? current.logicalParentUuid : current.parentUuid;
    current = typeof parent === "string" ? byID.get(parent) : undefined;
  }
  return main.filter((row) => typeof row.uuid === "string" && selected.has(row.uuid));
}

function entries(all: Row[]): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  const toolResults = new Map<string, boolean>();
  for (const row of conversationRows(all)) {
    if ((row.type !== "user" && row.type !== "assistant") || row.isMeta === true || typeof row.uuid !== "string") continue;
    const content = blocks(row);
    for (const block of content) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") toolResults.set(block.tool_use_id, block.is_error === true);
    }
    const text = messageText(row);
    const toolUses: TranscriptEntry["toolUses"] = row.type === "assistant" ? content.flatMap((block) =>
      block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
        ? [{ callId: block.id, title: block.name }] : []) : [];
    if (!text.trim() && !toolUses.length) continue;
    result.push({ uuid: row.uuid, role: row.type, text, toolUses, ...(typeof row.timestamp === "string" ? { timestamp: row.timestamp } : {}) });
  }
  for (const entry of result) for (const tool of entry.toolUses) {
    if (toolResults.has(tool.callId)) tool.failed = toolResults.get(tool.callId);
  }
  return result;
}

/** Reads Claude's local files only. It never starts a CLI or calls a model. */
export class NativeTranscriptReader {
  readonly configDir: string;
  private summaries = new Map<string, { signature: string; value: NativeSessionSummary }>();
  private knownFiles = new Map<string, TranscriptFile>();

  constructor(options: { configDir?: string } = {}) {
    this.configDir = options.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  }

  async listSessions(): Promise<NativeSessionSummary[]> {
    const files = await this.files();
    const result: NativeSessionSummary[] = [];
    for (const file of files.values()) {
      const summary = await this.summary(file);
      if (summary) result.push(summary);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async sessionInfo(id: string): Promise<NativeSessionSummary | undefined> {
    this.validateID(id);
    const file = await this.findFile(id);
    return file ? this.summary(file) : undefined;
  }

  async readTranscript(id: string): Promise<TranscriptEntry[]> {
    this.validateID(id);
    const file = await this.findFile(id);
    if (!file) return [];
    try { return entries(rows(await readFile(file.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async close(): Promise<void> { this.summaries.clear(); this.knownFiles.clear(); }

  private async findFile(id: string): Promise<TranscriptFile | undefined> {
    const cached = this.knownFiles.get(id);
    if (cached) {
      try {
        const info = await stat(cached.path);
        return { ...cached, modified: info.mtimeMs, size: info.size };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return (await this.files()).get(id);
  }

  private validateID(id: string): void {
    if (!SESSION_ID.test(id)) throw new Error("Invalid Claude session ID");
  }

  private async files(): Promise<Map<string, TranscriptFile>> {
    const result = new Map<string, TranscriptFile>();
    const projects = join(this.configDir, "projects");
    let directories;
    try { directories = await readdir(projects, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const path = join(projects, directory.name);
      let children;
      try { children = await readdir(path, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const child of children) {
        if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
        const id = child.name.slice(0, -6);
        if (!SESSION_ID.test(id)) continue;
        const filename = join(path, child.name);
        let info;
        try { info = await stat(filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        const previous = result.get(id);
        if (!previous || info.mtimeMs > previous.modified) result.set(id, { id, path: filename, modified: info.mtimeMs, size: info.size });
      }
    }
    this.knownFiles = result;
    return result;
  }

  private async summary(file: TranscriptFile): Promise<NativeSessionSummary | undefined> {
    const signature = `${file.modified}:${file.size}`;
    const cached = this.summaries.get(file.path);
    if (cached?.signature === signature) return { ...cached.value };
    let all: Row[];
    try { all = rows(await readFile(file.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    let cwd = "", customTitle = "", summary = "";
    for (const row of all) {
      if (row.isSidechain === true || (typeof row.sessionId === "string" && row.sessionId !== file.id)) continue;
      if (typeof row.cwd === "string") cwd = row.cwd;
      if (typeof row.customTitle === "string") customTitle = row.customTitle;
      if (row.type === "summary" && typeof row.summary === "string") summary = row.summary;
    }
    const first = conversationRows(all).find((row) => row.type === "user" && row.isMeta !== true && messageText(row).trim());
    const title = (customTitle || summary || (first ? messageText(first) : "") || "Claude Code").replace(/\s+/g, " ").trim().slice(0, 100);
    const value = { sessionId: file.id, title, cwd, updatedAt: new Date(file.modified).toISOString() };
    this.summaries.set(file.path, { signature, value });
    return { ...value };
  }
}
