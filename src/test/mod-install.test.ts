import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../../scripts/install-mod.mjs", import.meta.url));
const unsupportedWindows = { skip: process.platform === "win32" ? "fixture is a POSIX executable; Windows installer requires native CLI acceptance" : false };

function fixture(version: string) {
  const home = mkdtempSync(join(tmpdir(), "prism-mod-install-test-"));
  const cli = join(home, "fake-claude");
  writeFileSync(cli, `#!${process.execPath}\n` +
    `import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';\n` +
    `const args=process.argv.slice(2);\n` +
    `appendFileSync(process.env.HOME+'/commands.jsonl',JSON.stringify(args)+'\\n');\n` +
    `if(args[0]==='--version') console.log(${JSON.stringify(version + " (Claude Code)")});\n` +
    `if(process.env.PRISM_TEST_AUTO_ENABLE==='1' && args[0]==='plugin' && ['install','update'].includes(args[1])) {mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});writeFileSync(process.env.CLAUDE_CONFIG_DIR+'/settings.json',JSON.stringify({enabledPlugins:{'prism-terminal-control@prism-local':true}}));}\n` +
    `if(process.env.PRISM_TEST_INSTALL_FAIL==='1' && args[0]==='plugin' && ['install','update'].includes(args[1])) {console.error('isolated installation failure');process.exit(1)}\n`);
  chmodSync(cli, 0o700);
  return {
    home,
    run: (env: Record<string, string> = {}) => spawnSync(process.execPath, [installer, "install"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PRISM_CLAUDE_CLI: cli, ...env },
      timeout: 10_000,
    }),
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("Mod installation rejects pre-Mod Claude versions before writing plugin files", unsupportedWindows, () => {
  const f = fixture("2.0.1000");
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /2\.1\.287/);
    assert.equal(existsSync(join(f.home, ".prism", "claudecode", "mod-marketplace")), false);
  } finally { f.close(); }
});

test("a failed Mod update restores its prior payload and preserves the shell migration state", unsupportedWindows, () => {
  const f = fixture("2.1.289");
  const oldPlugin = join(f.home, ".prism", "claudecode", "mod-marketplace", "plugins", "prism-terminal-control");
  mkdirSync(oldPlugin, { recursive: true });
  writeFileSync(join(oldPlugin, "previous-payload"), "keep previous version");
  const before = '# user shell\n[[ -f "$HOME/.prism/claudecode/claude-shell.zsh" ]] && source "$HOME/.prism/claudecode/claude-shell.zsh"\n';
  writeFileSync(join(f.home, ".zshrc"), before);
  try {
    const result = f.run({ PRISM_TEST_INSTALL_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isolated installation failure/);
    assert.equal(readFileSync(join(oldPlugin, "previous-payload"), "utf8"), "keep previous version");
    assert.equal(readFileSync(join(f.home, ".zshrc"), "utf8"), before);
  } finally { f.close(); }
});

test("Hub initialization cannot silently re-enable a user-disabled installed Mod", unsupportedWindows, () => {
  const f = fixture("2.1.289");
  const id = "prism-terminal-control@prism-local";
  mkdirSync(join(f.home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(f.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: "user", version: "0.3.0" }] } }));
  const settings = JSON.stringify({ enabledPlugins: { [id]: false }, userSetting: "keep" });
  writeFileSync(join(f.home, ".claude", "settings.json"), settings);
  try {
    const result = f.run();
    assert.notEqual(result.status, 0, "explicitly disabled Mod should leave control unavailable");
    assert.match(result.stderr, /disabled/i);
    assert.equal(readFileSync(join(f.home, ".claude", "settings.json"), "utf8"), settings);
    const log = existsSync(join(f.home, "commands.jsonl")) ? readFileSync(join(f.home, "commands.jsonl"), "utf8") : "";
    assert.equal(log.split("\n").some((line) => line && (JSON.parse(line) as string[])[1] === "enable"), false);
  } finally { f.close(); }
});

test("migration installs a user Mod and removes only Prism's legacy zsh interception", unsupportedWindows, () => {
  const f = fixture("2.1.289");
  const keep = '# my own settings\nexport MY_SETTING="keep"\nsource "$HOME/my-shell.zsh"\n';
  writeFileSync(join(f.home, ".zshrc"), keep +
    '# Prism-managed interactive Claude in Terminal.app and zsh-based IDE terminals.\n' +
    '[[ -f "$HOME/.prism/claudecode/claude-shell.zsh" ]] && source "$HOME/.prism/claudecode/claude-shell.zsh"\n');
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.home, ".zshrc"), "utf8"), keep);
    const commands = readFileSync(join(f.home, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(commands.some((args) => args[0] === "plugin" && ["install", "update"].includes(args[1]) && args.includes("user")));
    const plugin = JSON.parse(readFileSync(join(f.home, ".prism", "claudecode", "mod-marketplace", "plugins", "prism-terminal-control", ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(plugin.name, "prism-terminal-control");
  } finally { f.close(); }
});


test("Claude auto-enabling a newly installed Mod does not trigger a redundant enable failure", unsupportedWindows, () => {
 const f=fixture("2.1.289");
 try {
  const result=f.run({PRISM_TEST_AUTO_ENABLE:"1"});
  assert.equal(result.status,0,result.stderr);
  const calls=readFileSync(join(f.home,"commands.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line) as string[]);
  assert.equal(calls.some(args=>args[1]==="enable"),false);
 }finally{f.close();}
});
