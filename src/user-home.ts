import { homedir } from "node:os";
import { win32 } from "node:path";

export function claudeUserHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform, fallback = homedir()): string {
  const explicit = env.PRISM_CLAUDE_USER_HOME?.trim();
  if (explicit) return explicit;
  if (platform === "win32") {
    const profile = env.USERPROFILE?.trim();
    if (profile) return profile;
    if (env.HOMEDRIVE && env.HOMEPATH) return win32.join(env.HOMEDRIVE, env.HOMEPATH);
  }
  return env.HOME?.trim() || env.USERPROFILE?.trim() || fallback;
}
