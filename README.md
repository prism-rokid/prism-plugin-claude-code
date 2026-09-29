# Claude Code plugin for Prism

This plugin has two runtime modes. `sdk` is the existing default: it uses the
Claude Agent SDK to create and resume SDK-owned Claude processes. `managed` is
the in-progress native Terminal mode: a detached local supervisor owns one
Claude CLI process and one PTY per session. The computer's Terminal app and
Prism Panel attach to that same running instance through one input arbiter.

Managed mode accepts the user's local Claude configuration, including custom
API endpoints and API-key based access. It does not depend on Claude Channels,
Remote Control or a claude.ai subscription. PluginBridge stdio remains separate
from the Claude PTY and is never used as a terminal.

The managed supervisor survives Plugin/Hub control-connection restarts. It
records remote message IDs and delivery stages, confirms submission through
Claude Hooks, and reconciles displayed history from Claude's local transcript.
It durably records minimal Hook markers before broadcast and replays them to a
new plugin subscription with stable event IDs. The Hub suppresses duplicate
native event IDs after replay. Hub waits for a matching Realtime server receipt
after the server processes the conversation event, then acknowledges the plugin
and the supervisor deletes its outbox file. Failed writes and missing receipts
remain pending for replay. The receipt confirms server-side processing, not
delivery to an open Panel or durable storage of the transient notification.
History remains recoverable from Claude's local transcript. Full end-to-end
restart acceptance is still outstanding.
Only one side owns input at a time. In Terminal, `Ctrl-]` switches input
ownership; an unfinished local draft blocks handoff until it is cleared or
submitted. Permission requests from Panel-owned turns can be allowed once or
denied in Panel. Local-owned requests stay in Claude's native TUI.

Managed mode remains opt-in while Terminal.app attachment, complete upgrade
and restart recovery, and all release targets complete acceptance. It
currently rejects attachments rather than silently dropping them. The SDK mode
remains available for existing installations.

An old SDK conversation is readable while its original process runs. Managed
mode refuses a second writer to that session. Once the old process exits, the
next send starts a new managed Claude process with `--resume` and the same
session ID; it does not attach to the old process in place.

Claude's first interactive visit to a new project requires workspace trust.
Panel does not auto-accept it: a remote first-message attempt returns
`workspace_trust_required` without submitting text or leaving a running orphan.
Open the project from the local Dashboard's managed Terminal action, accept
the native prompt, then retry the Panel message.

For local development:

```bash
npm ci --registry=https://registry.npmmirror.com
npm test
PRISM_PLUGIN_MODE=managed node dist/index.js
```

The release build uses Node 22 and includes a fixed PluginBridge SDK 0.1.3
package under `vendor/` until that SDK version is published independently.
`npm ci` runs `scripts/prepare-node-pty.mjs` to ensure the macOS PTY helper is
executable; release CI also spawns a real PTY on every target runner. Build
artifacts must be assembled on their target platform so `node-pty` and the
Claude Agent SDK's platform packages match that platform.
