# External App Integrations — Plan & Open Questions

_Started 2026-07-02. These are the FORGE-sprint capabilities that depend on external tooling that
can't be verified fully headless. Siddhant is helping with the visual-aid / setup steps so these are
**not built fully autonomously** — each integration below has a "❓ NEEDS SIDDHANT" block with the
exact questions whose answers raise the success chance. Ask these before/while building each._

## Cross-cutting principles

- **Detect, don't assume.** Every adapter probes for the tool at runtime (`which`, a version call, a
  daemon ping). Absent → the tool returns `{ error, install_hint }` and everything else is unaffected.
- **Untrusted stays walled.** Anything cloned or generated runs through `lib/sandboxexec.js` (scrubbed
  env, throwaway HOME, no secrets/keychain, opportunistic network-deny) or a container — never with
  BhatBot's env. Docker is a *stronger* lane layered ON this floor, not a replacement.
- **One adapter module per tool** under `lib/integrations/`, pure + DI, with its own probe + a headless
  test that skips gracefully when the tool is absent (so `npm run verify` stays green on any machine).
- **Visual-aid handoff points** are marked 📸 — places where a screenshot / recording / manual confirm
  from Siddhant closes a loop the agent can't verify blind.

---

## 1. Docker (repo autopilot preferred lane — Phase 2)

**Purpose.** Run a cloned repo's install/test/build in a real container instead of the scrubbed-subprocess
floor: per-stack base images, `--network=bridge`, `--memory`, clean teardown.
**Design.** `lib/integrations/docker.js`: `available()` (ping `docker info`), `run({image, mount, cmd,
memory, network, timeout})`. `repoauto` auto-selects Docker when present, else the sandbox floor.
**Isolation.** `docker run --rm -v <repo>:/w -w /w --network=bridge --memory=4g` per-stack base image.
**Degrade.** No daemon → sandbox floor + a note.

❓ **NEEDS SIDDHANT**
- Is Docker Desktop installed and running on this Mac? (Apple Silicon → `--platform` defaults?)
- Any private registry / auth I should NOT touch, or is public Docker Hub fine?
- Memory/CPU ceiling you're comfortable giving a container (default 4g / 2 cpu)?
- 📸 First real run: I'll clone a small repo and share the container log + verdict for you to confirm the lane behaves before I trust it.

## 2. Blender (3D depth — Phase 4 / V3)

**Purpose.** Headless renders + geometry Three.js can't do (booleans/modifiers, Cycles/Eevee,
glTF/STL export into the existing viewer + `make_printable`).
**Design.** `lib/integrations/blender.js`: detect install (`/Applications/Blender.app/.../blender` or
`which blender`), `render({script, out, engine})` via `blender -b -P <script>`. Drone role `modeler`.
Check `lib/integrations/trellis.js` first (image→3D) and integrate, not duplicate.
**Degrade.** Absent → install hint; Three.js multi-view stays the floor.

❓ **NEEDS SIDDHANT**
- Is Blender installed? Which version (4.x script API differs)? Path if non-standard.
- Cycles (GPU, slower, photoreal) vs Eevee (fast) as the default render engine?
- 📸 The generate→render→critique loop judges its OWN renders, but I'd like you to eyeball the first 2–3 outputs so I can calibrate the taste rubric (`docs/DESIGN_TASTE.md`) to what you actually like.
- Any existing `.blend` assets/materials you want reused as a starting library?

## 3. iOS Simulator (mobile swarm lane — Phase 3 / S3 stage 2)

**Purpose.** Drive native iOS apps (and the phone PWA) in the Simulator: boot/install/launch +
screenshot, taps/typing via the existing OmniParser `screen_parse → vision_click` loop.
**Design.** `lib/integrations/simctl.js` around `xcrun simctl` (boot/install/launch/screenshot). Input
injection ⚖ `idb` (Facebook, reliable tap/type, extra install) vs Appium/WebDriverAgent (heavy) vs
pure `simctl` + OmniParser vision-tap (dependency-light, already in `tools/vision.js`). Leaning
OmniParser-first for taps, `idb` only if reliability demands.
**Stage 1 (no external dep):** Playwright iPhone-viewport emulation — already doable; PWA is the first target.
**Degrade.** No Xcode → emulation lane only.

❓ **NEEDS SIDDHANT**
- Is Xcode + Command Line Tools installed? (`xcrun simctl list` works?)
- Do you actually need NATIVE iOS testing, or is iPhone-viewport **web** emulation enough for now? (Emulation needs zero setup and covers the PWA — I'd start there unless you have a native app in mind.)
- If native: is there a specific `.app`/simulator target, or just the PWA?
- OK to `brew install idb-companion` if OmniParser taps prove flaky, or keep it dependency-light?

## 4. Scholarly APIs + PDF ingestion (research depth — Phase 6)

**Purpose.** arXiv / Semantic Scholar / bioRxiv / PubMed adapters → normalized records; PDF → text →
chunked into `lib/semantic.js` so follow-ups hit embeddings.
**Design.** `lib/integrations/scholar.js`, keys optional (Semantic Scholar). Recorded fixtures for tests
(no live network in the suite).
**Degrade.** No key → public endpoints + rate-limit backoff.

❓ **NEEDS SIDDHANT**
- Do you have a Semantic Scholar API key (higher limits), or use the keyless tier?
- Primary domains to tune ranking for — comp-bio / GNNs / protein structure (matches your work)?
- A PDF text-extraction lib preference, or let me pick (pdf-parse / pdfjs)? Scanned PDFs are out of scope.

## 5. Comp-bio pack (simulation power — Phase 5 / P3)

**Purpose.** biopython, PDB/AlphaFold fetch → 3Dmol viewer, RDKit presets, a PyTorch-Geometric GNN
harness (`gnn_eval`). Mirrors the existing `~/.bhatbot/sim-venv` pattern.
**Design.** `lib/compbio.js` + a dedicated venv; import-guarded so a missing package = hint, not crash.
`1crn.cif` (repo root) is the offline PDB-viewer fixture.
**Degrade.** Package missing → install hint.

❓ **NEEDS SIDDHANT**
- OK to create a `~/.bhatbot/compbio-venv` and pip-install biopython/rdkit/torch-geometric (large,
  ~GBs, slow first build)? CPU-only torch, or do you have CUDA/MPS expectations?
- Is there existing graph data of yours the `gnn_eval` harness should target first, or start with a
  standard dataset (e.g. a PPI benchmark)?
- AlphaFold DB by UniProt fetch — any auth, or the public EBI endpoint?

## ✅ DECISIONS (Siddhant, 2026-07-02)

- **First wave, in parallel:** native iOS (simctl) + Docker probe + Scholar adapters — "a mix."
- **Second wave:** the comp-bio venv **expanded into a broader scientific-compute pack** — not just
  bio, but **high-complexity math**: real analysis / rigorous numerics, **quant** (stock modeling,
  time-series, options/risk), and **physics analysis**. Same venv, `lib/compute.js` umbrella +
  `lib/compbio.js`. Build with **MPS/GPU torch** (Apple Silicon).
- **Last:** Blender + design-taste loop.
- **Installed:** Blender ✓, Xcode + CLT ✓. **Docker: unconfirmed** → probe first, ask to install if
  absent. iOS: **native REQUIRED** (not just emulation) → `simctl` + OmniParser vision-taps;
  emulation stays as the zero-setup fallback for the PWA.

### Revised scope notes
- **iOS §3** → build the native `simctl` lane now (Xcode present). OmniParser tap-loop first; add
  `idb` only if taps prove flaky (ask before `brew install idb-companion`).
- **Comp-bio §5** → widen to a scientific-compute pack: add SciPy/NumPy/SymPy (real analysis,
  symbolic), statsmodels + a quant lane (pandas/yfinance-or-provided-data, backtest primitives,
  Black-Scholes/Greeks, Monte-Carlo), and a physics lane (ODE/PDE solvers, `sympy.physics`). MPS
  torch for the GNN harness. Provenance (§P4) applies to ALL of it (seed/versions/params logged).
  📸 handoff: I'll share the first quant backtest plot + a physics sim result for you to sanity-check.

## Suggested build order (once questions are answered)

1. **iOS emulation lane (stage 1)** + Docker probe — lowest setup, unblocks swarm + repoauto lanes.
2. **Scholar adapters** — no heavy local deps; high value for your research.
3. **Blender** + design-taste loop — needs your eyeball calibration (📸).
4. **Comp-bio venv** — biggest install; do when you're ready for the GB download.
5. **Native iOS (simctl)** — only if emulation isn't enough.

## How the visual-aid handoff works (proposed)

For each 📸 point: I build to the point where a human eye is needed, produce the artifact (screenshot,
render, container log, sim plot), and pause with a specific yes/no or "which of these" question. You
reply; I calibrate (rubric, thresholds, or fix) and continue. This keeps the visual/taste-dependent
parts human-in-the-loop while everything mechanical stays autonomous + verify-gated.
