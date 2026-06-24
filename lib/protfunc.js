'use strict';
// FABLE / ProtFunc client — protein FUNCTION prediction + per-residue saliency, wired into the
// `molecule` viewer so a predicted function can be SEEN on the 3D structure.
//
// Talks to the deployed FABLE Space (https://sbhat2026-protfunc.hf.space) by default; override with
// config.protfunc.url (e.g. a local `uvicorn server:app` instance on http://127.0.0.1:7860).
//
// Endpoints used:
//   POST /predict      → GO-MF function predictions (+ organism, calibration warnings)
//   POST /api/saliency → per-residue gradient importance + AlphaFold/ESMFold PDB with saliency
//                        written into B-factors (for structure coloring)
//
// CAVEAT (known): deployed FABLE misclassifies some enzymes — treat function calls as a soft hint,
// not ground truth. We always surface the server's own `warning` field so the caller sees it.
//
// DI factory: ctx = { getUrl }  (getUrl()→base url string)
const DEFAULT_URL = 'https://sbhat2026-protfunc.hf.space';

module.exports = function makeProtfunc(ctx = {}) {
  const getUrl = ctx.getUrl || (() => DEFAULT_URL);
  const base = () => String(getUrl() || DEFAULT_URL).replace(/\/+$/, '');

  // Strip FASTA header(s)/whitespace → bare residues. Keeps a leading header's accession out of the seq.
  function cleanSeq(raw) {
    return String(raw || '')
      .split(/\r?\n/).filter((l) => !l.startsWith('>')).join('')
      .replace(/\s+/g, '').toUpperCase();
  }
  // Best-effort UniProt accession sniff from a FASTA header (sp|P0DTC2|... or bare P0DTC2).
  function sniffAccession(raw) {
    const hdr = String(raw || '').split(/\r?\n/).find((l) => l.startsWith('>')) || '';
    const m = hdr.match(/\b([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})\b/);
    return m ? m[1] : '';
  }

  async function post(path, body, timeoutMs = 90000) {
    const r = await fetch(base() + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`FABLE ${path} → HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.error) throw new Error(j.error);
    return j;
  }

  // Function prediction → flattened top GO-MF terms for the first sequence.
  async function predict({ sequence, uniprotId = '', taxon = 'auto' } = {}) {
    const seq = cleanSeq(sequence);
    if (!seq) throw new Error('empty sequence');
    const j = await post('/predict', { sequence: seq, uniprot_id: uniprotId || sniffAccession(sequence), taxon });
    const res = (j.results || [])[0] || {};
    return {
      length: res.sequence_length || seq.length,
      predictions: (res.predictions || []).map((p) => ({ id: p.go_id, name: p.name, prob: p.prob, depth: p.depth })),
      organism: (res.uniprot && res.uniprot.organism) || res.taxon_applied || '',
      taxonApplied: res.taxon_applied, taxonSource: res.taxon_source, ood: res.ood,
      warning: res.warning || '',
      known: (res.uniprot && res.uniprot.go_mf_known) || [],
    };
  }

  // Fetch an AlphaFold PDB by UniProt accession (BhatBot has unrestricted network; the deployed
  // Space often can't reach AlphaFold/ESMFold, so we fall back to fetching it ourselves).
  async function fetchAlphaFold(uid) {
    const u = String(uid || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{4,10}$/.test(u)) return null;
    const H = { 'User-Agent': 'BhatBot/1.0 (protein structure viewer)', Accept: 'application/json' };
    try {
      const r = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${u}`, { headers: H, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return null;
      const j = await r.json();
      const url = (j[0] || {}).pdbUrl;
      if (!url) return null;
      const r2 = await fetch(url, { headers: { 'User-Agent': H['User-Agent'] }, signal: AbortSignal.timeout(20000) });
      if (!r2.ok) return null;
      return await r2.text();
    } catch { return null; }
  }

  // Write normalized [0,1] per-residue saliency into the B-factor column of a PDB string, so a
  // viewer can color by importance. B-factor occupies cols 61-66 (0-based 60-66), per-residue.
  function writeSaliencyBfactor(pdb, scores) {
    if (!pdb || !scores || !scores.length) return pdb;
    return pdb.split('\n').map((line) => {
      if (!/^(ATOM|HETATM)/.test(line)) return line;
      const resSeq = parseInt(line.slice(22, 26), 10);
      if (!Number.isFinite(resSeq)) return line;
      const s = scores[resSeq - 1];
      if (s == null) return line;
      const b = Math.max(0, Math.min(1, s)).toFixed(2).padStart(6); // 6-wide, e.g. "  0.73"
      return line.slice(0, 60) + b + line.slice(66);
    }).join('\n');
  }

  // Normalize an AlphaFold PDB's native pLDDT B-factors (0-100) into [0,1] so the viewer can use a
  // single gradient domain. Used when saliency is unavailable/flat — pLDDT confidence is always
  // meaningful and per-residue.
  function normalizePlddt(pdb) {
    if (!pdb) return pdb;
    return pdb.split('\n').map((line) => {
      if (!/^(ATOM|HETATM)/.test(line)) return line;
      const v = parseFloat(line.slice(60, 66));
      if (!Number.isFinite(v)) return line;
      const b = Math.max(0, Math.min(1, v / 100)).toFixed(2).padStart(6);
      return line.slice(0, 60) + b + line.slice(66);
    }).join('\n');
  }
  const varies = (a) => a && a.length && Math.max(...a) - Math.min(...a) > 1e-6;

  // Saliency → per-residue importance + a PDB string with saliency in B-factors (for 3D coloring).
  async function saliency({ sequence, uniprotId = '', taxon = 'auto', topK = 20 } = {}) {
    const seq = cleanSeq(sequence);
    if (!seq) throw new Error('empty sequence');
    if (seq.length > 1200) throw new Error('sequence too long for saliency (max 1200 aa)');
    const uid = uniprotId || sniffAccession(sequence);
    const j = await post('/api/saliency', { sequence: seq, uniprot_id: uid, taxon, top_k: topK }, 120000);
    const scores = j.per_residue_scores || [];
    let pdb = null, source = j.structure_source || 'unavailable', coloring = null;
    // 1) Server returned a saliency-colored structure with real variation → use it directly.
    if (j.pdb_with_saliency && varies(scores)) { pdb = j.pdb_with_saliency; coloring = 'saliency'; }
    // 2) Otherwise fetch the AlphaFold model ourselves (the deployed Space often can't reach it,
    //    and its saliency gradient is frequently flat). Needs a UniProt accession.
    if (!pdb && uid) {
      const raw = await fetchAlphaFold(uid);
      if (raw) {
        if (varies(scores)) { pdb = writeSaliencyBfactor(raw, scores); source = 'alphafold (local)'; coloring = 'saliency'; }
        else { pdb = normalizePlddt(raw); source = 'alphafold (local)'; coloring = 'plddt'; } // fall back to confidence coloring
      }
    }
    // 3) Server gave a structure but flat saliency → recolor it by nothing meaningful; keep as plain.
    if (!pdb && j.pdb_with_saliency) { pdb = j.pdb_with_saliency; coloring = varies(scores) ? 'saliency' : null; }
    return { scores, pdb, source, coloring, length: j.sequence_length };
  }

  // Combined: predict function + (best-effort) saliency-colored structure. Saliency failure is
  // non-fatal — function prediction still returns.
  async function analyze({ sequence, uniprotId = '', taxon = 'auto', topK = 20, withStructure = true } = {}) {
    const fn = await predict({ sequence, uniprotId, taxon });
    let sal = null;
    if (withStructure) { try { sal = await saliency({ sequence, uniprotId, taxon, topK }); } catch (e) { sal = { error: e.message }; } }
    return { ...fn, saliency: sal };
  }

  return { predict, saliency, analyze, cleanSeq, sniffAccession, fetchAlphaFold, writeSaliencyBfactor, normalizePlddt };
};
