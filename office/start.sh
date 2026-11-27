#!/bin/zsh
# BhatBot Office — Agent Office (3D) + the research desks, vendored in this repo's office/ directory.
# Uses the Mac's existing Ollama (11434) and Claude Code; downloads nothing; installs no service.
#   office/start.sh          start whatever is not running
#   office/start.sh --stop   stop the office and the research server
set -eu
base="${0:A:h}"; work="$base/work"; app="$base/outputs/research"
export XDG_DATA_HOME="$work/xdg/data" XDG_CACHE_HOME="$work/xdg/cache" XDG_STATE_HOME="$work/xdg/state" XDG_CONFIG_HOME="$work/xdg/config"
export RESEARCH_MODEL="${RESEARCH_MODEL:-qwen3:14b}" RESEARCH_CLAUDE_MODEL="${RESEARCH_CLAUDE_MODEL:-sonnet}"
umask 077
if [[ "${1:-}" == "--stop" ]]; then
  for f in "$work/office.pid" "$work/research.pid"; do [[ -f $f ]] && kill "$(cat $f)" 2>/dev/null || true; rm -f $f; done
  echo stopped; exit 0
fi
touch "$work"/{Planner,Researcher,Reviewer,Politics,"Global health"}.log
if ! curl -fsS localhost:11434/api/tags >/dev/null 2>&1; then echo "Ollama is not running — open the Ollama app first"; fi
if ! curl -fsS localhost:4612/state >/dev/null 2>&1; then
  (cd "$app" && nohup "$work/venv/bin/python" research.py >>"$work/logs/research.log" 2>&1 </dev/null & echo $! > "$work/research.pid")
fi
if ! curl -fsS localhost:4600/api/login >/dev/null 2>&1; then
  nohup node "$work/office/bin/agent-office.js" "$app" --port 4600 --no-open \
    --agent claude --agent-args "--model sonnet" --budget 5 --city Princeton \
    --home "$base/home" --projects "$base/floors" \
    >>"$work/logs/office.log" 2>&1 </dev/null & echo $! > "$work/office.pid"
  for i in {1..40}; do curl -fsS localhost:4600/api/login >/dev/null 2>&1 && break; sleep 1; done
  (cd "$app" && node desks.mjs >>"$work/logs/desks.log" 2>&1 || true)
fi
echo "office http://127.0.0.1:4600 · research http://127.0.0.1:4612"
