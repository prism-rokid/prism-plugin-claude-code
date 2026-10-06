import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeSessionOwner = { state: "active"; pid: number } | { state: "inactive" } | { state: "unknown" };

/** Check Claude's live-session registry before resuming a transcript. */
export function claudeSessionOwner(sessionID: string, registryDir = join(homedir(), ".claude", "sessions")): ClaudeSessionOwner {
  let files: string[];
  try { files = readdirSync(registryDir).filter((name) => name.endsWith(".json")); }
  catch { return { state: "unknown" }; }
  for (const name of files) {
    let record: { sessionId?: unknown; pid?: unknown };
    try { record = JSON.parse(readFileSync(join(registryDir, name), "utf8")) as typeof record; }
    catch { continue; }
    if (record.sessionId !== sessionID) continue;
    if (!Number.isInteger(record.pid) || Number(record.pid) < 1) return { state: "unknown" };
    const pid = Number(record.pid);
    try { process.kill(pid, 0); return { state: "active", pid }; }
    catch (error) {
      // EPERM means the owner exists but this process cannot inspect it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return { state: "active", pid };
      if (code !== "ESRCH") return { state: "unknown" };
    }
  }
  return { state: "inactive" };
}

/** Compatibility helper for discovery metadata and callers needing only a live PID. */
export function activeClaudeSessionPID(sessionID: string, registryDir = join(homedir(), ".claude", "sessions")): number | null {
  const owner = claudeSessionOwner(sessionID, registryDir);
  return owner.state === "active" ? owner.pid : null;
}
