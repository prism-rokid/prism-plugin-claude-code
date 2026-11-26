import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "@rokid-prism/pluginbridge-plugin-sdk";

export const MOD_MINIMUM_CLAUDE_VERSION = "2.1.287";
export const MOD_PLUGIN_ID = "prism-terminal-control@prism-local";
export const MOD_INSTALL_FAILURE_FILE = "mod-install-failure.json";

export function parseClaudeVersion(output: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+)\b/m.exec(output)?.[1];
}

export function supportsClaudeMods(version: string): boolean {
  const actual = version.split(".").map(Number);
  const minimum = MOD_MINIMUM_CLAUDE_VERSION.split(".").map(Number);
  for (const [index, required] of minimum.entries()) {
    if (actual[index] !== required) return actual[index] > required;
  }
  return true;
}

export function readModJSON(path: string): Record<string, any> {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function safeDiagnosticStack(error: unknown, detail: string): string {
  const frames = error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /.test(line)) ?? [] : [];
  return [detail, ...frames.map(frame => {
    const location = /(?:^|[\\/])(mod-diagnostics\.(?:js|ts)|mod-adapter\.(?:js|ts)|mod-bridge\.(?:js|ts)|install-mod\.mjs):(\d+):(\d+)\)?$/.exec(frame);
    const position = /:(\d+):(\d+)\)?$/.exec(frame);
    return location ? `    at ${location[1]}:${location[2]}:${location[3]}`
      : position ? `    at [已脱敏]:${position[1]}:${position[2]}` : "    at [已脱敏]";
  })].join("\n");
}

const installSteps = {
  version: `无法验证 Claude Code 版本，Mod 需要 ${MOD_MINIMUM_CLAUDE_VERSION} 或更新版本。`,
  marketplace: "Prism Mod 市场注册或更新失败",
  plugin: "Claude CLI 安装或更新 Mod 失败",
  enable: "Claude CLI 启用 Mod 失败",
  files: "准备或写入 Mod 文件失败",
} as const;

export function modInstallFailure(step: string, error: unknown, exitStatus?: unknown) {
  const key = Object.hasOwn(installSteps, step) ? step as keyof typeof installSteps : "files";
  const exitCode = typeof exitStatus === "number" && Number.isInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 0xffffffff
    ? exitStatus : undefined;
  const detail = exitCode === undefined ? installSteps[key] : `${installSteps[key]}（退出码 ${exitCode}）`;
  return {
    step: key,
    exitCode,
    detail,
    locations: safeDiagnosticStack(error, detail).split("\n").slice(1),
  };
}

export class ModHandshakeError extends Error {
  constructor(reason: "descriptor" | "network" | "session" | number, options?: ErrorOptions) {
    super(typeof reason === "number" ? `Mod 桥接拒绝握手（HTTP ${reason}）。` : {
      descriptor: "Mod 桥接描述文件缺失、损坏或与当前实例不符。",
      network: "无法访问本地 Mod 桥接服务。",
      session: "最近一次 Claude Code Mod 会话握手被拒绝。",
    }[reason], options);
  }
}

export async function diagnoseClaude(options: {
  versionOutput: string;
  missing: boolean;
  versionCheckFailed: boolean;
  configDir: string;
  stateDir: string;
  handshake: () => Promise<void>;
}): Promise<Diagnostic> {
  const Component = "Claude Code";
  if (options.missing) return {
    State: "not_installed", Code: "dependency_not_installed", Summary: "未安装 Claude Code",
    Component, Actions: ["open_download", "recheck"],
  };
  const ActualVersion = parseClaudeVersion(options.versionOutput);
  const RequiredVersion = `>=${MOD_MINIMUM_CLAUDE_VERSION}`;
  if (options.versionCheckFailed || !ActualVersion) return {
    State: "unavailable", Code: "dependency_version_check_failed", Summary: "无法检测 Claude Code 版本",
    Detail: "Claude Code --version 未成功返回可识别的版本。", Component, RequiredVersion, Actions: ["recheck"],
  };

  let installed = false;
  let enabled = false;
  try {
    const registry = readModJSON(join(options.configDir, "plugins", "installed_plugins.json"));
    const settings = readModJSON(join(options.configDir, "settings.json"));
    const records = registry.plugins?.[MOD_PLUGIN_ID];
    installed = Array.isArray(records) && records.length > 0;
    enabled = settings.enabledPlugins?.[MOD_PLUGIN_ID] === true;
  } catch (error) {
    if (supportsClaudeMods(ActualVersion)) return installError(modInstallFailure("files", error));
  }
  const Facts = { installed: true, mod_installed: installed, mod_enabled: enabled };
  if (!supportsClaudeMods(ActualVersion)) return {
    State: "incompatible", Code: "dependency_version_mismatch", Summary: "Claude Code 版本过低",
    Detail: `检测到 Claude Code ${ActualVersion}，Mod 需要 ${MOD_MINIMUM_CLAUDE_VERSION} 或更新版本。`,
    Component, ActualVersion, RequiredVersion, Actions: ["open_update_help", "recheck"], Facts,
  };

  if (installed && enabled) {
    try {
      await options.handshake();
      return { State: "ready", Code: "ready", Summary: "Claude Code 已连接", Component, ActualVersion, RequiredVersion, Facts: { ...Facts, transport_reachable: true } };
    } catch (error) {
      const reason = error instanceof ModHandshakeError ? error.message : "无法使用当前 Mod 桥接凭据完成本地握手。";
      const Detail = reason;
      return { State: "unavailable", Code: "mod_handshake_failed", Summary: "Claude Code Mod 连接失败", Component, Detail, Actions: ["recheck"], Stack: safeDiagnosticStack(error, Detail) };
    }
  }

  try {
    const failure = readModJSON(join(options.stateDir, MOD_INSTALL_FAILURE_FILE));
    if (typeof failure.step === "string") {
      const detail = modInstallFailure(failure.step, undefined, failure.exitCode).detail;
      const locations = Array.isArray(failure.locations) ? failure.locations.filter(
        line => typeof line === "string" && /^    at (?:mod-diagnostics\.(?:js|ts)|mod-adapter\.(?:js|ts)|mod-bridge\.(?:js|ts)|install-mod\.mjs|\[已脱敏\])(?::\d+:\d+)?$/.test(line),
      ) : [];
      return installError({ detail, locations });
    }
  } catch (error) { return installError(modInstallFailure("files", error)); }

  if (!installed) return { State: "unavailable", Code: "mod_not_installed", Summary: "Claude Code Mod 未安装", Component, Facts, Actions: ["install_mod", "recheck"] };
  return { State: "unavailable", Code: "mod_disabled", Summary: "Claude Code Mod 未启用", Component, Facts, Actions: ["enable_mod", "recheck"] };
}

function installError(failure: { detail: string; locations: string[] }): Diagnostic {
  return { State: "unavailable", Code: "mod_install_failed", Summary: "Claude Code Mod 安装失败",
    Detail: failure.detail, Actions: ["retry_install", "recheck"], Stack: [failure.detail, ...failure.locations].join("\n") };
}
