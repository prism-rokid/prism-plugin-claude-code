import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isolatedHome = await mkdtemp(join(tmpdir(), "prism-claude-probe-"));
let child;
try {
  const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
  const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
  const raw = manifest.match(/^command:\s*(\[[^\n]+\])$/m)?.[1];
  if (!id || !raw) throw new Error("invalid manifest command");
  const command = JSON.parse(raw).map((part) => part === "${runtime.node}" ? process.execPath : part);
  if (command[0].startsWith("./")) command[0] = resolve(root, command[0]);
  child = spawn(command[0], command.slice(1), {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome,
      CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
      PRISM_CLAUDE_MANAGED_DIR: join(isolatedHome, ".prism", "managed"),
      PRISM_CLAUDE_MOD_STATE_DIR: join(isolatedHome, ".prism", "claudecode"),
      PRISM_CLAUDE_CLI: join(isolatedHome, "no-claude"),
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const response = await new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`probe timed out: ${stderr}`)); }, 15_000);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((value) => value.trim());
      if (!line) return;
      clearTimeout(timer);
      try { resolveResponse(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== 0) reject(new Error(`probe exited ${code}: ${stderr}`)); });
    child.stdin.write('{"id":"release-probe","method":"adapter.probe","params":{}}\n');
  });
  if (response.id !== "release-probe" || response.ok !== true || response.payload?.plugin_id !== id || response.payload?.available !== false) throw new Error("invalid isolated probe response");
  child.stdin.end();
  const code = await new Promise((resolveExit) => {
    const timer = setTimeout(() => { child.kill(); resolveExit(-1); }, 3000);
    child.once("exit", (status) => { clearTimeout(timer); resolveExit(status); });
  });
  if (code !== 0) throw new Error(`probe child failed to exit cleanly (${code}): ${stderr}`);
  console.log(`protocol probe passed for ${id}; unavailable Claude CLI reported cleanly`);
} finally {
  if (child && child.exitCode === null) child.kill();
  await rm(isolatedHome, { recursive: true, force: true });
}
