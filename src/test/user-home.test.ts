import assert from "node:assert/strict";
import test from "node:test";
import { claudeUserHome } from "../user-home.js";
import { resolveClaudeCLI } from "../claude-cli.js";

test("Windows 用户目录优先使用 USERPROFILE 并传给 Claude 子进程", () => {
  const env = { HOME: "C:\\Other", USERPROFILE: "C:\\Users\\测试 用户", PATH: "", PRISM_CLAUDE_CLI: "claude.exe" };
  assert.equal(claudeUserHome(env, "win32", ""), env.USERPROFILE);
  const resolved = resolveClaudeCLI(env, claudeUserHome(env, "win32", ""));
  assert.equal(resolved.env.HOME, env.USERPROFILE);
});

test("Windows 用户目录在 USERPROFILE 缺失时使用驱动器信息", () => {
  assert.equal(claudeUserHome({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\Example" }, "win32", ""), "C:\\Users\\Example");
});

test("其他平台保留 HOME，显式配置始终优先", () => {
  assert.equal(claudeUserHome({ HOME: "/home/current", USERPROFILE: "/other", PRISM_CLAUDE_USER_HOME: "/chosen" }, "linux", ""), "/chosen");
  assert.equal(claudeUserHome({ HOME: "/home/current", USERPROFILE: "/other" }, "linux", ""), "/home/current");
});
