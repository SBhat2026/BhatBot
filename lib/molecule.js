'use strict';
// Molecule / protein 3D structure resolver for the `molecule` tool.
//
// Two render paths (user picked BOTH):
//   • interactive  → returns {format,data,...}; main.js streams it into a 3Dmol.js viewer window.
//   • still (PyMOL)→ headless ray-traced PNG via the system pymol (best-effort).
//
// Structure sources (all on-device except the obvious online lookups):
//   • protein PDB id   → RCSB (files.rcsb.org), .pdb then .cif fallback
//   • protein/ligand file → read local .pdb/.cif/.sdf/.mol2/.xyz
//   • small molecule SMILES / name → scripts/mol_prep.py (RDKit embed; PubChem REST for names)
//
// DI factory: ctx = { simPython, pymolBin, dataDir, scriptPath, run }  (run = spawn→{code,stdout,stderr})
const fs = require('fs');
const path = require('path');

const FORMAT_BY_EXT = { '.pdb': 'pdb', '.ent': 'pdb', '.cif': 'cif', '.mmcif': 'cif', '.sdf': 'sdf', '.mol': 'sdf', '.mol2': 'mol2', '.xyz': 'xyz' };

module.exports = function makeMolecule(ctx = {}) {
  const { simPython, pymolBin, dataDir, scriptPath, run } = ctx;

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.text();
  }

  // Resolve a protein by 4-char PDB id from RCSB (.pdb, then .cif).
  async function fromPdbId(id) {
    const code = String(id).trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) throw new Error(`"${id}" is not a 4-character PDB id`);
    try { return { format: 'pdb', data: await fetchText(`https://files.rcsb.org/download/${code}.pdb`), label: code.toUpperCase(), source: 'rcsb' }; }
    catch { return { format: 'cif', data: await fetchText(`https://files.rcsb.org/download/${code}.cif`), label: code.toUpperCase(), source: 'rcsb' }; }
  }

  function fromFile(file) {
    const p = file.replace(/^~/, require('os').homedir());
    if (!fs.existsSync(p)) throw new Error(`file not found: ${p}`);
    const fmt = FORMAT_BY_EXT[path.extname(p).toLowerCase()];
    if (!fmt) throw new Error(`unsupported structure extension: ${path.extname(p)} (want .pdb/.cif/.sdf/.mol2/.xyz)`);
    return { format: fmt, data: fs.readFileSync(p, 'utf8'), label: path.basename(p), source: 'file' };
  }

  // Small molecule via RDKit/PubChem helper (returns SDF + properties).
  async function fromSmall({ smiles, name }) {
    const req = JSON.stringify(smiles ? { smiles } : { name });
    const r = await run(simPython, [scriptPath, req], { timeoutMs: 30000 });
    let out; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { throw new Error(`mol_prep parse failed: ${(r.stderr || r.stdout || '').slice(0, 200)}`); }
    if (!out.ok) throw new Error(out.error || 'mol_prep failed');
    return { format: out.format, data: out.data, label: name || smiles, source: out.source, props: out.props, resolvedSmiles: out.resolved_smiles };
  }

  // kind: 'protein' (default cartoon) vs 'small' (default sticks). Inferred from how it was requested.
  function defaultStyle(kind, style) {
    if (style) return style;
    return kind === 'protein' ? 'cartoon' : 'stick';
  }

  // Resolve a structure from any supported input → payload for the 3Dmol viewer.
  async function prepare(input = {}) {
    let s, kind;
    if (input.pdb) { s = await fromPdbId(input.pdb); kind = 'protein'; }
    else if (input.file) { s = fromFile(input.file); kind = /\.(sdf|mol|mol2|xyz)$/i.test(input.file) ? 'small' : 'protein'; }
    else if (input.smiles || input.name) { s = await fromSmall(input); kind = 'small'; }
    else throw new Error('need one of: pdb (id), file (path), smiles, or name');
    return { ...s, kind, style: defaultStyle(kind, input.style) };
  }

  // PyMOL headless ray-traced still → PNG path. Best-effort; throws a clear message if pymol absent.
  // We resolve the structure in Node (fetch proteins, RDKit-embed small molecules) and have PyMOL
  // just LOAD a local file — avoids PyMOL's own network fetch + cwd-write quirks under -cq.
  const EXT_BY_FORMAT = { pdb: 'pdb', cif: 'cif', sdf: 'sdf', mol2: 'mol2', xyz: 'xyz' };
  async function renderStill(input = {}, outPng) {
    if (!pymolBin || !fs.existsSync(pymolBin)) throw new Error('PyMOL not installed (expected at ' + pymolBin + '). Use the interactive viewer instead.');
    const s = await prepare(input);                       // {format,data,kind,style,...}
    fs.mkdirSync(dataDir, { recursive: true });
    const ext = EXT_BY_FORMAT[s.format] || 'pdb';
    const tmp = path.join(dataDir, `still-${Date.now()}.${ext}`);
    fs.writeFileSync(tmp, s.data);
    const style = input.style || s.style || (s.kind === 'protein' ? 'cartoon' : 'stick');
    const styleCmds = style === 'surface' ? ['hide everything', 'show surface']
      : style === 'sphere' ? ['hide everything', 'show spheres']
      : style === 'stick' ? ['hide everything', 'show sticks', 'set stick_radius, 0.18']
      : ['hide everything', 'show cartoon', 'show sticks, not polymer']; // protein default
    if (s.kind === 'protein' && style === 'cartoon') styleCmds.push('spectrum');
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    // A .pml script file (not -d inline) — PyMOL parses multi-command scripts reliably this way.
    // Bare paths (NO quotes): PyMOL's load/png treat surrounding quotes as literal filename chars.
    // Safe here because tmp + outPng live under ~/.bhatbot/molecules (no spaces).
    const pml = [`load ${tmp}`, ...styleCmds, 'orient', 'bg_color white', 'set ray_opaque_background, 0', `ray 1200, 900`, `png ${outPng}, dpi=150`, 'quit'].join('\n');
    const script = path.join(dataDir, `render-${Date.now()}.pml`);
    fs.writeFileSync(script, pml);
    const r = await run(pymolBin, ['-cq', script], { timeoutMs: 120000 });
    if (!fs.existsSync(outPng)) throw new Error(`PyMOL render produced no image: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
    return outPng;
  }

  return { prepare, renderStill, fromPdbId, fromFile, fromSmall };
};
