import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { claudeUserHome } from "./user-home.js";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

/** Batch launchers need cmd.exe; quoting the complete command preserves spaces in GUI install paths. */
export function runClaudeCLI(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return spawnSync(command, args, options);
  const quote = (value: string) => {
    if (/["\r\n]/.test(value)) throw new Error("Invalid character in Claude CLI command argument");
    return `"${value}"`;
  };
  return spawnSync(options.env?.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`], {
    ...options, shell: false, windowsVerbatimArguments: true, windowsHide: true,
  });
}

/** Resolve without executing shell startup files, which may prompt or change user state. */
export function resolveClaudeCLI(env: NodeJS.ProcessEnv = process.env, home = claudeUserHome(env)): { command: string; env: NodeJS.ProcessEnv } {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const executable = (path: string) => { try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
  const inheritedPath = env.PATH || env.Path || "";
  const inPath = (name: string) => inheritedPath.split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ""), name)).find(executable);
  // mise shims follow the active version instead of pinning an install. Custom
  // data/shim directories can be on any volume; never scan disks for tools.
  const miseData = env.MISE_DATA_DIR || (process.platform === "win32"
    ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "mise")
    : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "mise"));
  const miseShims = env.MISE_SHIMS_DIR || join(miseData, "shims");
  const miseName = process.platform === "win32" ? "mise.exe" : "mise";
  const miseBinary = (env.MISE_BIN && executable(env.MISE_BIN) ? env.MISE_BIN : undefined)
    || inPath(miseName)
    || [join(home, ".local", "bin", miseName), join(miseData, "bin", miseName)].find(executable);
  let command: string | undefined;
  if (env.PRISM_CLAUDE_CLI) {
    const explicit = env.PRISM_CLAUDE_CLI;
    // An explicit override must never silently select a different installation.
    command = isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\") ? resolve(explicit) : inPath(explicit) || explicit;
  } else {
    command = names.map(inPath).find(Boolean);
    if (!command) {
      const bins = [join(home, ".local", "bin"), join(home, ".claude", "local"), ...(miseBinary ? [miseShims] : [])];
      if (process.platform === "win32") bins.push(
        join(env.APPDATA || join(home, "AppData", "Roaming"), "npm"),
        ...[env.NVM_SYMLINK, env.NVM_HOME, env.VOLTA_HOME && join(env.VOLTA_HOME, "bin")].filter((path): path is string => Boolean(path)),
        join(home, ".volta", "bin"),
      );
      const nvm = env.NVM_DIR || join(home, ".nvm");
      const versionsDir = join(nvm, "versions", "node");
      const versionBins: string[] = [];
      try {
        const versions = readdirSync(versionsDir).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).sort((a,b) => {
          const av=a.slice(1).split(".").map(Number), bv=b.slice(1).split(".").map(Number);
          return bv[0]-av[0] || bv[1]-av[1] || bv[2]-av[2];
        });
        let preferred = "";
        try { preferred = readFileSync(join(nvm, "alias", "default"), "utf8").trim().replace(/^v?/, "v"); } catch {}
        versions.sort((a,b) => Number(b === preferred)-Number(a === preferred));
        versionBins.push(...versions.map(v => join(versionsDir, v, "bin")));
      } catch {}
      const fallbackBins = ["/opt/homebrew/bin", "/usr/local/bin"];
      command = [...bins, ...versionBins, ...fallbackBins]
        .flatMap(bin => names.map(name => join(bin,name)))
        .find(executable);
    }
  }
  command ||= "claude";
  // npm CLIs use /usr/bin/env node. Supply the Hub runtime when a GUI PATH has no Node.
  const path = [...new Set([...(isAbsolute(command) ? [dirname(command)] : []), ...(miseBinary ? [dirname(miseBinary)] : []), dirname(process.execPath), ...inheritedPath.split(delimiter).filter(Boolean)])].join(delimiter);
  const childEnv = { ...env };
  // Node passes only one case-insensitive PATH key to Windows children.
  if (process.platform === "win32") for (const key of Object.keys(childEnv)) if (key.toUpperCase() === "PATH") delete childEnv[key];
  return { command, env: { ...childEnv, HOME: home, ...(process.platform === "win32" ? { USERPROFILE: env.USERPROFILE || home } : {}), PATH: path, PRISM_CLAUDE_CLI: command } };
}
