import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Conservative guard against resuming a transcript owned by a live CLI. */
export function activeClaudeSessionPID(sessionID: string, registryDir = join(homedir(), ".claude", "sessions")): number | null {
  let files: string[];
  try { files = readdirSync(registryDir).filter((name) => name.endsWith(".json")); }
  catch { return null; }
  for (const name of files) {
    let record: { sessionId?: unknown; pid?: unknown };
    try { record = JSON.parse(readFileSync(join(registryDir, name), "utf8")) as typeof record; }
    catch { continue; }
    if (record.sessionId !== sessionID || !Number.isInteger(record.pid) || Number(record.pid) < 1) continue;
    const pid = Number(record.pid);
    try { process.kill(pid, 0); return pid; }
    catch (error) {
      // EPERM means the owner exists but this process cannot inspect it.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return pid;
    }
  }
  return null;
}
