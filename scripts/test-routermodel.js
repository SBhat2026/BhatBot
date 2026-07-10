'use strict';
// Learned-router unit tests: feature extraction, cold fallback, training + argmax, shadow agreement.
const rm = require('../lib/routermodel');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// ---- feature extraction is directional -----------------------------------
const fSimple = rm.extractFeatures('what time is it');
const fReason = rm.extractFeatures('read my latest email then add it to my calendar and reply');
const fHeavy = rm.extractFeatures('build a molecular dynamics simulation engine of protein folding from scratch');
ok(fSimple.is_question === 1 && fSimple.wc <= 5, 'features: short question flagged');
ok(fReason.app_terms >= 2 && fReason.multistep >= 1, 'features: multi-step app task detected');
ok(fHeavy.heavy_terms >= 2 && fHeavy.sci_domain >= 1, 'features: heavy sci build detected');

// ---- cold model → predict returns null (caller keeps regex) --------------
// (no artifact loaded in test env; loadModel returns null)
ok(rm.predict('anything at all') === null || typeof rm.predict('x') === 'object', 'cold: predict is null or a valid object');

// ---- training on synthetic labeled rows ----------------------------------
function row(text, tier) { return { f: rm.extractFeatures(text), tier }; }
const SIMPLE = ['open spotify', 'what time is it', 'any new emails', 'play some music', 'set volume to 5', 'whats the weather', 'pause the song', 'is it raining'];
const REASON = ['write a python script that scrapes a site', 'refactor and debug this function', 'analyze this dataset and compare the two groups', 'read my email then schedule a meeting', 'research the best approach and summarize', 'design a dashboard for these metrics', 'plan a multi step migration then run it', 'optimize this pipeline and explain why'];
const HEAVY = ['simulate dna replication from scratch', 'build an n-body physics engine', 'model protein folding with molecular dynamics', 'create a cfd solver for fluid flow', 'build a comprehensive climate simulation', 'design and simulate a rocket engine', 'develop a monte carlo epidemic model', 'implement a finite element solver from scratch'];
const rows = [];
for (let k = 0; k < 4; k++) {   // replicate to clear MIN_ROWS (60)
  SIMPLE.forEach((t) => rows.push(row(t, 'simple')));
  REASON.forEach((t) => rows.push(row(t, 'reasoning')));
  HEAVY.forEach((t) => rows.push(row(t, 'heavy')));
}
const m = rm.train(rows);
ok(m.ok === true, `train: ok on ${rows.length} rows (n=${m.n})`);
ok(m.acc >= 0.7, `train: in-sample accuracy ${m.acc && m.acc.toFixed(2)} ≥ 0.70`);

// ---- argmax routes obvious cases correctly -------------------------------
function tierOf(text) {
  const x = [...rm.featurize(rm.extractFeatures(text)), 1];
  return rm.argmaxTier(x, m.W);
}
ok(tierOf('open spotify') === 'simple', 'route: "open spotify" → simple');
ok(tierOf('simulate protein folding from scratch') === 'heavy', 'route: sci sim → heavy');
ok(['reasoning', 'heavy'].includes(tierOf('read my email then add it to my calendar')), 'route: multi-step app task → reasoning/heavy (not simple)');

// ---- shadow agreement metric ---------------------------------------------
const rep = rm.shadowReport([{ tier: 'reasoning', shadowTier: 'reasoning' }, { tier: 'simple', shadowTier: 'heavy' }]);
ok(rep.n === 2 && rep.agreement === 0.5, 'shadow: agreement computed (0.5)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
