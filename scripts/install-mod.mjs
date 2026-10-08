import { resolveClaudeCLI } from "../dist/claude-cli.js";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const action = process.argv[2] || "install";
const resolvedCLI = resolveClaudeCLI();
const cli = resolvedCLI.command;
const home = process.env.HOME || process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? join(process.env.HOMEDRIVE, process.env.HOMEPATH) : "");
if (!home) throw new Error("Could not resolve the user home directory");
const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
const stateDir = join(home, ".prism", "claudecode");
const marketplaceDir = join(stateDir, "mod-marketplace");
const pluginSource = join(marketplaceDir, "plugins", "prism-terminal-control");
const marketplaceName = "prism-local";
const pluginName = "prism-terminal-control";
const pluginID = `${pluginName}@${marketplaceName}`;
const settingsBefore = jsonFile(join(configDir, "settings.json"));
const explicitlyDisabled = settingsBefore.enabledPlugins?.[pluginID] === false;
const shouldEnable = settingsBefore.enabledPlugins?.[pluginID] === undefined;
const sourceLine = '[[ -f "$HOME/.prism/claudecode/claude-shell.zsh" ]] && source "$HOME/.prism/claudecode/claude-shell.zsh"';
const marker = "# Prism-managed interactive Claude in Terminal.app and zsh-based IDE terminals.";

function run(args) {
  const result = spawnSync(cli, args, { encoding: "utf8", timeout: 30_000, env: { ...resolvedCLI.env, CLAUDE_CONFIG_DIR: configDir }, stdio: "pipe" });
  return { status: result.status, error: result.error, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function report(result, label) {
  if (result.status === 0) return;
  const detail = result.error?.message || result.stderr.trim() || `${label} exited ${result.status}`;
  throw new Error(`${label}: ${detail}`);
}
function jsonFile(path) {
  try { return JSON.parse(requireText(path)); } catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}
function requireText(path) {
  try { return readFileSync(path, "utf8"); } catch (error) { throw error; }
}
function removePrismZshLines(text) {
  return text.split(/(?<=\n)/).filter((line) => line.trimEnd() !== sourceLine && line.trimEnd() !== marker).join("");
}
function assertMarketplaceOwned() {
  const known = jsonFile(join(configDir, "plugins", "known_marketplaces.json"));
  const record = known[marketplaceName];
  const registeredPath = record?.source?.path || record?.installLocation;
  if (registeredPath && resolve(registeredPath) !== resolve(marketplaceDir)) {
    throw new Error(`Claude marketplace '${marketplaceName}' already points outside the Prism directory; refusing to update or remove it`);
  }
}
async function removeOldShellIntegration() {
  await rm(join(stateDir, "claude-shell.zsh"), { force: true });
  const zshrc = join(home, ".zshrc");
  if (!existsSync(zshrc)) return;
  const before = await readFile(zshrc, "utf8");
  const after = removePrismZshLines(before);
  if (after !== before) await writeFile(zshrc, after, { mode: statSync(zshrc).mode & 0o777 });
}
function shellQuote(value) { return `'${value.replaceAll("'", `'"'"'`)}'`; }

if (action === "uninstall") {
  assertMarketplaceOwned();
  const installed = jsonFile(join(configDir, "plugins", "installed_plugins.json"));
  const exists = Array.isArray(installed.plugins?.[pluginID]) && installed.plugins[pluginID].length > 0;
  if (exists) report(run(["plugin", "uninstall", pluginID, "--scope", "user", "--yes"]), "Claude Mod uninstall");
  const known = jsonFile(join(configDir, "plugins", "known_marketplaces.json"));
  if (known[marketplaceName]) report(run(["plugin", "marketplace", "remove", marketplaceName]), "Prism marketplace removal");
  await rm(marketplaceDir, { recursive: true, force: true });
  await removeOldShellIntegration();
  process.stdout.write("Claude Code Mod uninstalled; other Claude plugins and settings were kept.\n");
  process.exit(0);
}
if (action !== "install" && action !== "update") throw new Error("usage: install-mod.mjs [install|update|uninstall]");

const version = run(["--version"]);
report(version, "Claude Code version check");
const parsedVersion = version.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
if (!parsedVersion || Number(parsedVersion[1]) < 2 || (Number(parsedVersion[1]) === 2 && (Number(parsedVersion[2]) < 1 || (Number(parsedVersion[2]) === 1 && Number(parsedVersion[3]) < 287)))) {
  throw new Error("Claude Code 2.1.287 or newer is required for Mods");
}
assertMarketplaceOwned();
await mkdir(dirname(pluginSource), { recursive: true, mode: 0o700 });
const stage = `${pluginSource}.stage-${process.pid}`;
const backup = `${pluginSource}.previous-${process.pid}`;
await rm(stage, { recursive: true, force: true });
await cp(join(root, "mod"), stage, { recursive: true });
const hooksPath = join(stage, "hooks", "hooks.json");
const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
for (const group of hooks.hooks?.PermissionRequest || []) for (const hook of group.hooks || []) {
  if (hook.type === "command") hook.command = `${shellQuote(process.execPath)} "\${CLAUDE_PLUGIN_ROOT}/hooks/permission-request.mjs"`;
}
await writeFile(hooksPath, JSON.stringify(hooks, null, 2) + "\n", { mode: 0o600 });
const marketplaceFile = join(marketplaceDir, ".claude-plugin", "marketplace.json");
const marketplaceFileStage = `${marketplaceFile}.${process.pid}.tmp`;
await mkdir(dirname(marketplaceFile), { recursive: true, mode: 0o700 });
await writeFile(marketplaceFileStage, JSON.stringify({
  name: marketplaceName,
  owner: { name: "Prism" },
  plugins: [{ name: pluginName, description: "Local Prism controls for native Claude Code sessions", source: "./plugins/prism-terminal-control" }],
}, null, 2) + "\n", { mode: 0o600 });
let movedOld = false;
let installed = false;
try {
  if (existsSync(pluginSource)) { await rename(pluginSource, backup); movedOld = true; }
  await rename(stage, pluginSource);
  await rename(marketplaceFileStage, marketplaceFile);
  const add = run(["plugin", "marketplace", "add", marketplaceDir]);
  if (add.status !== 0) report(run(["plugin", "marketplace", "update", marketplaceName]), "Claude marketplace update");
  const update = run(["plugin", "update", pluginID, "--scope", "user"]);
  if (update.status !== 0) report(run(["plugin", "install", pluginID, "--scope", "user", "--json"]), "Claude Mod install");
  if (shouldEnable && jsonFile(join(configDir, "settings.json")).enabledPlugins?.[pluginID] !== true) report(run(["plugin", "enable", pluginID, "--scope", "user", "--json"]), "Claude Mod enable");
  // Claude's update command keeps a same-version cache, even when a local
  // marketplace's development module changed. Refresh our owned module atomically.
  const modVersion = jsonFile(join(pluginSource, ".claude-plugin", "plugin.json")).version;
  if (typeof modVersion === "string" && /^\d+\.\d+\.\d+$/.test(modVersion)) {
    const cachedModule = join(configDir, "plugins", "cache", marketplaceName, pluginName, modVersion, "hooks", "register.js");
    if (existsSync(cachedModule)) {
      const temporary = `${cachedModule}.prism-${process.pid}.tmp`;
      await writeFile(temporary, await readFile(join(pluginSource, "hooks", "register.js")), {mode:0o600});
      await rename(temporary, cachedModule);
    }
  }
  installed = true;
  await removeOldShellIntegration();
  await rm(backup, { recursive: true, force: true });
  if (explicitlyDisabled) throw new Error("Claude Code Mod remains disabled because the user explicitly disabled it; enable prism-terminal-control@prism-local to restore remote control");
  process.stdout.write(`Claude Code Mod ${action} completed (${parsedVersion[0]}).\n`);
} catch (error) {
  if (!installed) {
    await rm(pluginSource, { recursive: true, force: true });
    if (movedOld) await rename(backup, pluginSource);
  }
  throw error;
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(marketplaceFileStage, { force: true });
}
