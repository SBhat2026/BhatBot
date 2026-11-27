#!/bin/zsh
set -eu
cd "${0:A:h}"
office_dir="$PWD"
runtime="${PWD:h:h}/work"
export PATH="$runtime/node/bin:$runtime/bin:$runtime/ollama:$PATH"
export XDG_DATA_HOME="$runtime/xdg/data" XDG_CACHE_HOME="$runtime/xdg/cache" XDG_STATE_HOME="$runtime/xdg/state" XDG_CONFIG_HOME="$runtime/xdg/config"
export OLLAMA_MODELS="$runtime/models" OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_CONTEXT_LENGTH=8192
export RESEARCH_MODEL="${RESEARCH_MODEL:-qwen3:1.7b}"
umask 077
touch "$runtime"/{Planner,Researcher,Reviewer,Politics,"Global health"}.log
if ! curl -fsS localhost:11434/api/tags >/dev/null 2>&1; then
    nohup ollama serve >>"$runtime/ollama.log" 2>&1 </dev/null &!
    for i in {1..30}; do curl -fsS localhost:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi
if [[ "$RESEARCH_MODEL" == "qwen3:1.7b" ]] && ! curl -fsS localhost:11436/health >/dev/null 2>&1; then
    nohup "$runtime/ollama/llama-server" --device none --no-op-offload --no-kv-offload -ngl 0 --fit off --reasoning-budget 0 -np 1 -c 8192 -t 6 -m "$runtime/models/blobs/sha256-3d0b790534fe4b79525fc3692950408dca41171676ed7e21db57af5c65ef6ab6" --alias "$RESEARCH_MODEL" --port 11436 >>"$runtime/cpu.log" 2>&1 </dev/null &!
fi
if ! curl -fsS localhost:4612/state >/dev/null 2>&1; then
    nohup "$runtime/venv/bin/python" research.py >>"$runtime/research.log" 2>&1 </dev/null &!
fi
if ! curl -fsS localhost:4600/api/login >/dev/null 2>&1; then
    nohup node "$runtime/office/bin/agent-office.js" "$office_dir" --agent opencode --no-open >>"$runtime/office.log" 2>&1 </dev/null &!
    for i in {1..30}; do curl -fsS localhost:4600/api/login >/dev/null 2>&1 && break; sleep 1; done
    node desks.mjs
fi
if [[ "${1:-}" != "--background" ]]; then open http://127.0.0.1:4612; fi
