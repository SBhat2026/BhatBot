# BhatBot — real-app benchmark

_Measured 2026-08-13T22:07:15.692Z against the installed build (not simulated)._

```json
{
  "ts": "2026-08-13T22:07:15.692Z",
  "sections": {
    "intake": {
      "total": 16,
      "correct": 15,
      "accuracy": 93.8,
      "falseChat": 0,
      "falseAction": 1,
      "misses": [
        {
          "text": "who won the 2022 world cup",
          "want": "chat",
          "got": "action"
        }
      ]
    },
    "toolselect": {
      "total": 10,
      "recall": 0,
      "top1": 0,
      "tools": 81,
      "misses": [
        {
          "q": "resize these screenshots to 800px",
          "want": "file_tools",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "merge these three PDFs",
          "want": "file_tools",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "undo what you archived this morning",
          "want": "triage_mail",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "what did you do to my inbox today",
          "want": "triage_mail",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "search my gmail for the adaptyv thread",
          "want": "gmail",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "put an event on my calendar for tuesday",
          "want": "calendar",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "take a screenshot of the screen",
          "want": "screen_parse",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "run a python simulation of the pendulum",
          "want": "simulate",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "what is on my calendar tomorrow",
          "want": "calendar",
          "got": "(no retrieval — full catalog passed)"
        },
        {
          "q": "render this molecule",
          "want": "molecule",
          "got": "(no retrieval — full catalog passed)"
        }
      ],
      "note": "full-catalog mode"
    },
    "triage": {
      "total": 16,
      "correct": 16,
      "accuracy": 100,
      "importantLostAsNoise": 0,
      "noiseLeaked": 0,
      "misses": []
    },
    "graph": {
      "nodes": 1928,
      "edges": 6395,
      "types": {
        "project": 63,
        "memory": 153,
        "file": 1712
      },
      "embedded": 1928,
      "embedCoverage": 100,
      "dims": {
        "768": 1928
      },
      "relatesTo": 565,
      "crossProject": 565,
      "withinProject": 0,
      "crossProjectPct": 100,
      "explained": 27,
      "explainedPct": 4.8,
      "spendUsd": 0.45859123999999996
    },
    "endurance": {
      "heapMb": 52,
      "rssMb": 174,
      "uptimeMin": 2,
      "governor": "level=nominal · thermal=nominal · mem=61% free",
      "lockHolder": "weaver",
      "bgSkipped": 3,
      "lockTimeouts": 0,
      "agent": "idle",
      "jobsActive": 0
    },
    "throughput": {
      "batch": 24,
      "ok": 24,
      "ms": 397,
      "perNodeMs": 16.5,
      "model": "nomic-embed-text",
      "local": true,
      "fellBackFrom": null,
      "error": null,
      "nodesLeft": 0,
      "minsToFullCoverage": 0
    }
  }
}
```