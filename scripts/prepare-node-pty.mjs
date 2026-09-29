import { chmodSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// The upstream node-pty macOS tarball can unpack spawn-helper without its
// executable bit. A real PTY then fails at runtime with EACCES even though
// TypeScript builds and the protocol probe pass.
if (process.platform === "darwin") {
  const helper = resolve("node_modules", "node-pty", "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  if (!existsSync(helper)) throw new Error(`node-pty spawn-helper is missing: ${helper}`);
  if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  if ((statSync(helper).mode & 0o111) === 0) throw new Error(`node-pty spawn-helper is not executable: ${helper}`);
}
