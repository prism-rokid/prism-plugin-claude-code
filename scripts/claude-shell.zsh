# Prism-managed interactive Claude in Terminal.app and zsh-based IDE terminals.
claude() {
  if (( $# > 0 )) || [[ ! -t 0 || ! -t 1 ]]; then
    command claude "$@"
    return
  fi

  local cli_path launcher runtime
  local -a runtimes
  cli_path="$(whence -p claude)"
  launcher="$HOME/.prism/pluginbridge-plugins/claudecode/current/dist/managed-terminal-launcher.js"
  runtimes=("$HOME"/.prism/pluginbridge-runtimes/node/22.*/bin/node(N))
  runtime="${runtimes[-1]}"
  if [[ ! -x "$cli_path" || ! -f "$launcher" || ! -x "$runtime" ]]; then
    print -u2 'Prism Claude launcher is unavailable; use `command claude` for the original CLI.'
    return 127
  fi
  PRISM_CLAUDE_CLI="$cli_path" "$runtime" "$launcher"
}

# The native installer also exposes an uppercase `Claude` executable on macOS.
Claude() { claude "$@"; }
