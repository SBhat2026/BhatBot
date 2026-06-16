#!/usr/bin/env python3
"""
One-shot smolagents CodeAgent for complex MATH REASONING (used by BhatBot's math_reason tool).

A CodeAgent writes and executes Python to reason through multi-step quantitative problems, with
the scientific stack (numpy/sympy/scipy/…) authorized for import — so it can actually COMPUTE
rather than guess. Reads one JSON request on stdin, writes one JSON response on stdout.

  request : {"task": "...", "model": "anthropic/claude-sonnet-4-6", "api_key": "...", "max_steps": 6}
  response: {"ok": true, "answer": "...", "steps": N, "code": ["...per step..."]}

stdout is kept PURE JSON: smolagents/litellm print rich logs to stdout, which would corrupt the
response — so we route everything else to stderr and reserve the real stdout for the result.
"""
import sys, os, json, io, traceback

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

def out(obj):
    _REAL_STDOUT.write(json.dumps(obj) + "\n"); _REAL_STDOUT.flush()

def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        return out({"ok": False, "error": "bad request json: %s" % e})

    task = (req.get("task") or "").strip()
    if not task:
        return out({"ok": False, "error": "empty task"})
    model_id = req.get("model") or "anthropic/claude-sonnet-4-6"
    api_key = req.get("api_key") or os.environ.get("ANTHROPIC_API_KEY")
    max_steps = int(req.get("max_steps") or 6)

    try:
        from smolagents import CodeAgent, LiteLLMModel
        model = LiteLLMModel(model_id=model_id, api_key=api_key, temperature=0.2)
        agent = CodeAgent(
            tools=[],
            model=model,
            max_steps=max_steps,
            verbosity_level=0,
            additional_authorized_imports=[
                "math", "cmath", "statistics", "fractions", "decimal", "itertools",
                "numpy", "sympy", "scipy", "scipy.integrate", "scipy.optimize",
                "scipy.linalg", "scipy.stats", "networkx",
            ],
        )
        answer = agent.run(task)
        # Pull the code the agent actually executed (best-effort across smolagents versions).
        code_steps = []
        try:
            for s in getattr(agent, "memory", agent).steps if hasattr(agent, "memory") else []:
                c = getattr(s, "code_action", None) or getattr(s, "tool_call", None)
                if c: code_steps.append(str(c)[:1500])
        except Exception:
            pass
        out({"ok": True, "answer": str(answer), "steps": len(code_steps) or None, "code": code_steps})
    except Exception as e:
        out({"ok": False, "error": str(e), "trace": traceback.format_exc()[-1500:]})

if __name__ == "__main__":
    main()
