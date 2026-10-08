import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Resolve without executing shell startup files, which may prompt or change user state. */
export function resolveClaudeCLI(env: NodeJS.ProcessEnv = process.env, home = env.HOME || env.USERPROFILE || homedir()): { command: string; env: NodeJS.ProcessEnv } {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const executable = (path: string) => { try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
  const inPath = (name: string) => (env.PATH || "").split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(executable);
  let command: string | undefined;
  if (env.PRISM_CLAUDE_CLI) {
    const explicit = env.PRISM_CLAUDE_CLI;
    // An explicit override must never silently select a different installation.
    command = isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\") ? resolve(explicit) : inPath(explicit) || explicit;
  } else {
    command = names.map(inPath).find(Boolean);
    if (!command) {
      const bins = [join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
      const nvm = env.NVM_DIR || join(home, ".nvm");
      const versionsDir = join(nvm, "versions", "node");
      try {
        const versions = readdirSync(versionsDir).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).sort((a,b) => {
          const av=a.slice(1).split(".").map(Number), bv=b.slice(1).split(".").map(Number);
          return bv[0]-av[0] || bv[1]-av[1] || bv[2]-av[2];
        });
        let preferred = "";
        try { preferred = readFileSync(join(nvm, "alias", "default"), "utf8").trim().replace(/^v?/, "v"); } catch {}
        versions.sort((a,b) => Number(b === preferred)-Number(a === preferred));
        bins.push(...versions.map(v => join(versionsDir, v, "bin")));
      } catch {}
      command = bins.flatMap(bin => names.map(name => join(bin,name))).find(executable);
    }
  }
  command ||= "claude";
  // npm CLIs use /usr/bin/env node. Supply the Hub runtime when a GUI PATH has no Node.
  const path = [...new Set([...(isAbsolute(command) ? [dirname(command)] : []), dirname(process.execPath), ...(env.PATH || "").split(delimiter).filter(Boolean)])].join(delimiter);
  return { command, env: { ...env, PATH: path, PRISM_CLAUDE_CLI: command } };
}
