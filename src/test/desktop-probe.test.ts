import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("桌面 Probe 通过 nvm 检测 CLI，仅显式安装会改变 Mod 状态", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "prism-desktop-probe-"));
  try {
    const cli = join(home, ".nvm/versions/node/v24.20.0/bin/claude");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const config = process.env.CLAUDE_CONFIG_DIR;
const id = "prism-terminal-control@prism-local";
fs.appendFileSync(path.join(process.env.HOME, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "--version") console.log("2.1.289 (Claude Code)");
else if (fs.existsSync(path.join(process.env.HOME, "fail"))) process.exit(1);
else if (args[0] === "plugin" && args[1] === "update") {
  fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(config, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { [id]: [{ version: "0.3.4" }] } }));
} else if (args[0] === "plugin" && args[1] === "enable") {
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ enabledPlugins: { [id]: true } }));
}
`);
    chmodSync(cli, 0o700);
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home, PRISM_CLAUDE_USER_HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      CLAUDE_CONFIG_DIR: join(home, ".claude"), PRISM_CLAUDE_MOD_STATE_DIR: join(home, ".prism/claudecode"),
      PRISM_CLAUDE_MANAGED_DIR: join(home, ".prism/terminal"),
    };
    delete env.PRISM_CLAUDE_CLI;
    delete env.NVM_DIR;
    const run = (args: string[]) => spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 15_000 });
    const calls = (): string[][] => readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const probe = () => {
      const input = JSON.stringify({ id: "1", method: "adapter.probe" }) + "\n";
      const result = spawnSync(process.execPath, ["dist/index.js"], { env, input, encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr);
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      return response.payload;
    };
    assert.equal(probe().diagnostics.code, "mod_not_installed");
    assert.equal(probe().diagnostics.code, "mod_not_installed");
    assert.deepEqual(calls(), [["--version"], ["--version"]]);

    const marker = join(home, "fail");
    writeFileSync(marker, "失败");
    const installer = ["scripts/install-mod.mjs", "install"];
    assert.notEqual(run(installer).status, 0);
    assert.equal(probe().diagnostics.code, "mod_install_failed");
    rmSync(marker);
    const installed = run(installer);
    assert.equal(installed.status, 0, installed.stderr);
    const ready = probe();
    assert.equal(ready.diagnostics.code, "ready");
    assert.equal(ready.available, true);
    assert.equal(ready.unavailable_reason, "");
    assert.equal(ready.diagnostics.stack, undefined);
    assert.ok(calls().some(args => args[0] === "plugin" && args[1] === "enable"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
