import { serve, checkProtocolVersion } from "@rokid-prism/pluginbridge-plugin-sdk";
import { ClaudeCodeAdapter } from "./adapter.js";
import { ManagedClaudeAdapter } from "./managed-adapter.js";

checkProtocolVersion();
const adapter = process.env.PRISM_PLUGIN_MODE === "managed" ? new ManagedClaudeAdapter() : new ClaudeCodeAdapter();

serve(adapter)
  .then(() => adapter.close())
  .catch((error) => {
    // stdout is exclusively reserved for PluginBridge JSON lines.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
