/** Starts a Prism-managed Claude in the terminal that invoked `claude`. */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedSupervisorManager } from "./managed-supervisor-manager.js";
import { runAttachClientWithHandoff } from "./managed-terminal-client.js";

export async function launchInCurrentTerminal(args: string[] = process.argv.slice(2)): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Prism Claude launcher requires an interactive terminal");
  if (args.length) throw new Error("Prism Claude launcher currently supports plain `claude`; use the original CLI for arguments");
  const cliPath = process.env.PRISM_CLAUDE_CLI;
  if (!cliPath || !existsSync(cliPath) || realpathSync(cliPath) === realpathSync(process.argv[1])) {
    throw new Error("Set PRISM_CLAUDE_CLI to the original Claude executable");
  }
  const manager = new ManagedSupervisorManager();
  const { sessionID, client } = await manager.create(resolve(process.cwd()));
  try {
    const handoff = await client.terminalHandoff(sessionID);
    client.close();
    manager.close();
    await runAttachClientWithHandoff(handoff);
    return sessionID;
  } finally {
    client.close();
    manager.close();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  launchInCurrentTerminal().catch((error) => {
    process.stderr.write(`Prism Claude launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
