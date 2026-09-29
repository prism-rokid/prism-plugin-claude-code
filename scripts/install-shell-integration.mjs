import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const configDir = join(home, ".prism", "claudecode");
const destination = join(configDir, "claude-shell.zsh");
const zshrc = join(home, ".zshrc");
const sourceLine = '[[ -f "$HOME/.prism/claudecode/claude-shell.zsh" ]] && source "$HOME/.prism/claudecode/claude-shell.zsh"';
const marker = "# Prism-managed interactive Claude in Terminal.app and zsh-based IDE terminals.";
const source = fileURLToPath(new URL("./claude-shell.zsh", import.meta.url));

mkdirSync(configDir, { recursive: true, mode: 0o700 });
copyFileSync(source, destination);
const before = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
if (!before.includes(sourceLine)) {
  const backup = join(configDir, `zshrc-before-prism-${Date.now()}`);
  if (existsSync(zshrc)) copyFileSync(zshrc, backup);
  const updated = before + (before && !before.endsWith("\n") ? "\n" : "") + `\n${marker}\n${sourceLine}\n`;
  const temporary = join(configDir, `.zshrc-${process.pid}.tmp`);
  writeFileSync(temporary, updated, { mode: existsSync(zshrc) ? statSync(zshrc).mode & 0o777 : 0o644 });
  renameSync(temporary, zshrc);
  console.log(`Installed Prism Claude zsh integration; previous .zshrc saved at ${backup}`);
} else {
  console.log("Prism Claude zsh integration is already enabled");
}
