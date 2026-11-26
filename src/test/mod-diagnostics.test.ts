import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnoseClaude, MOD_INSTALL_FAILURE_FILE, MOD_PLUGIN_ID, modInstallFailure } from "../mod-diagnostics.js";
import { ModBridge } from "../mod-bridge.js";

test("Claude Probe 区分依赖版本、安装和启用状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-claude-diagnostic-"));
  try {
    mkdirSync(join(dir, "plugins"));
    const options = {
      versionOutput: "2.1.203 (Claude Code)", missing: false, versionCheckFailed: false,
      configDir: dir, stateDir: dir, handshake: async () => {},
    };
    assert.equal((await diagnoseClaude({ ...options, missing: true })).Code, "dependency_not_installed");
    assert.equal((await diagnoseClaude({ ...options, versionOutput: "", versionCheckFailed: true })).Code, "dependency_version_check_failed");
    const low = await diagnoseClaude(options);
    assert.equal(low.Code, "dependency_version_mismatch");
    assert.equal(low.ActualVersion, "2.1.203");
    assert.equal(low.RequiredVersion, ">=2.1.287");
    options.versionOutput = "2.1.287 (Claude Code)";
    assert.equal((await diagnoseClaude(options)).Code, "mod_not_installed");
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { [MOD_PLUGIN_ID]: [{ version: "0.3.4" }] } }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { [MOD_PLUGIN_ID]: false } }));
    assert.equal((await diagnoseClaude(options)).Code, "mod_disabled");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { [MOD_PLUGIN_ID]: true } }));
    assert.equal((await diagnoseClaude(options)).Code, "ready");
    options.versionOutput = "2.1.330 (Claude Code)";
    assert.equal((await diagnoseClaude(options)).ActualVersion, "2.1.330");

    const error = new Error("password=用户密码 Bearer 凭据 /Users/person/private");
    error.stack += "\n    at privateToken (/Users/person/private/token.js:3:4)";
    const installFailure = join(dir, MOD_INSTALL_FAILURE_FILE);
    writeFileSync(installFailure, JSON.stringify(modInstallFailure("plugin", error)));
    const registryPath = join(dir, "plugins", "installed_plugins.json");
    const installedRegistry = readFileSync(registryPath, "utf8");
    rmSync(registryPath);
    const failed = await diagnoseClaude(options);
    assert.equal(failed.Code, "mod_install_failed");
    assert.match(failed.Stack!, /已脱敏.*3:4/);
    assert.doesNotMatch(JSON.stringify(failed), /password|凭据|用户密码|Users|privateToken/);
    writeFileSync(registryPath, installedRegistry);
    const repaired = await diagnoseClaude(options);
    assert.equal(repaired.Code, "ready");
    assert.equal(repaired.Detail, undefined);
    assert.equal(repaired.Stack, undefined);
    assert.match(readFileSync(installFailure, "utf8"), /"step":"plugin"/);
    const handshake = await diagnoseClaude({ ...options, handshake: async () => { throw error; } });
    assert.equal(handshake.Code, "mod_handshake_failed");
    assert.match(handshake.Stack!, /已脱敏.*3:4/);
    assert.doesNotMatch(handshake.Stack!, /password|用户密码|Users|privateToken/);
    assert.equal((await diagnoseClaude(options)).Stack, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("桥接诊断检测真实会话握手失败并在有效握手后恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-claude-handshake-"));
  const bridge = new ModBridge(dir);
  try {
    await bridge.start();
    await bridge.probeHandshake();
    const file = join(dir, "mod-bridge.json");
    const descriptor = JSON.parse(readFileSync(file, "utf8"));
    const url = `http://127.0.0.1:${descriptor.port}/event`;
    const send = async (body: object) => {
      const response = await fetch(url, {
        method: "POST", headers: { authorization: `Bearer ${descriptor.token}` }, body: JSON.stringify(body),
      });
      await response.arrayBuffer();
      return response.status;
    };
    const event = { kind: "session.start", sessionId: "session", clientInstanceId: "instance" };
    assert.equal(await send(event), 400);
    await assert.rejects(bridge.probeHandshake(), /会话握手被拒绝/);
    assert.equal(await send({ ...event, cwd: dir, version: "2.1.330" }), 204);
    await bridge.probeHandshake();
    writeFileSync(file, JSON.stringify({ ...descriptor, token: "无效凭据" }));
    await assert.rejects(bridge.probeHandshake(), /HTTP 401|无法访问/);
    writeFileSync(file, JSON.stringify(descriptor));
    await bridge.probeHandshake();
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});
