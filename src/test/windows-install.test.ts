import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows 可通过 claude.cmd 安装 Mod 并生成本机 hook 路径", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "prism-claude-windows-"));
  try {
    const cli = join(home, "claude.cmd");
    writeFileSync(cli, "@echo off\r\nif \"%1\"==\"--version\" echo 2.1.289\r\n");
    const installer = fileURLToPath(new URL("../../scripts/install-mod.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [installer, "install"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PRISM_CLAUDE_CLI: cli, CLAUDE_CONFIG_DIR: join(home, ".claude") },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const hookFile = join(home, ".prism", "claudecode", "mod-marketplace", "plugins", "prism-terminal-control", "hooks", "hooks.json");
    const hooks = JSON.parse(readFileSync(hookFile, "utf8"));
    const command = hooks.hooks.PermissionRequest[0].hooks[0].command as string;
    assert.match(command, /permission-request\.mjs/);
    assert.doesNotMatch(command, /CLAUDE_PLUGIN_ROOT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
