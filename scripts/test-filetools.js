'use strict';
// file_tools — real operations on real temp files (no mocks: the whole point is that these shell out
// correctly), plus the sensitivity gate that decides what may leave the machine.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const ft = require(path.join(ROOT, 'lib', 'filetools'));
const { createFileSense } = require(path.join(ROOT, 'lib', 'filesense'));

let pass = 0;
function ok(n) { pass++; console.log('  ✓ ' + n); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bhatft-'));

// A real 120x80 PNG, made with sips from a solid-colour source.
function makePng(p, w = 120, h = 80) {
  const py = `from PIL import Image; Image.new("RGB",(${w},${h}),(30,90,160)).save("${p}")`;
  execFileSync('python3', ['-c', py]);
  return p;
}
// Built with pypdf, not PIL: this machine's Pillow has no libjpeg, so PIL's PDF writer raises
// KeyError:'JPEG'. The fixture must not depend on the capability the tests are probing.
function makePdf(p, pages = 3) {
  const py = `
from pypdf import PdfWriter
w = PdfWriter()
for _ in range(${pages}): w.add_blank_page(width=200, height=260)
w.write("${p}"); w.close()`;
  execFileSync('python3', ['-c', py]);
  return p;
}

(async () => {
  console.log('[filetools]');
  const caps = await ft.capabilities();

  // 1. capabilities() must be HONEST — the agent plans against this, so a false positive means
  //    promising the user an operation that then fails.
  {
    assert.strictEqual(typeof caps.sips, 'boolean');
    for (const op of Object.keys(ft.OPS)) {
      const a = await ft.opAvailable(op);
      assert.ok(typeof a.ok === 'boolean');
      if (!a.ok) { assert.ok(a.missing, 'an unavailable op must name what it needs'); assert.ok(a.error); }
    }
    ok('capabilities()/opAvailable report every op honestly');
  }

  // 2. Image ops, end to end.
  if (caps.sips) {
    const src = makePng(path.join(TMP, 'a.png'));
    const info = await ft.execute('image_info', { path: src });
    assert.strictEqual(info.width, 120); assert.strictEqual(info.height, 80);

    const conv = await ft.execute('image_convert', { path: src, format: 'jpeg' });
    assert.ok(conv.success && fs.existsSync(conv.out), 'png → jpeg');
    assert.ok(conv.out.endsWith('.jpg'));

    const rs = await ft.execute('image_resize', { path: src, maxDimension: 40 });
    assert.ok(rs.success);
    const rsInfo = await ft.execute('image_info', { path: rs.out });
    assert.ok(Math.max(rsInfo.width, rsInfo.height) === 40, 'longest side becomes maxDimension');

    const rot = await ft.execute('image_rotate', { path: src, degrees: 90 });
    const rotInfo = await ft.execute('image_info', { path: rot.out });
    assert.strictEqual(rotInfo.width, 80); assert.strictEqual(rotInfo.height, 120);
    ok('image convert / resize / rotate / info all produce correct real output');
  }

  // 3. PDF ops, end to end — page counts are the assertion that actually proves it worked.
  if (caps.pypdf) {
    const a = makePdf(path.join(TMP, 'a.pdf'), 3);
    const b = makePdf(path.join(TMP, 'b.pdf'), 2);

    const info = await ft.execute('pdf_info', { path: a });
    assert.strictEqual(info.pages, 3);

    const merged = await ft.execute('pdf_merge', { paths: [a, b], out: path.join(TMP, 'm.pdf') });
    assert.ok(merged.success);
    assert.strictEqual((await ft.execute('pdf_info', { path: merged.out })).pages, 5, '3 + 2 = 5');

    const ex = await ft.execute('pdf_extract', { path: merged.out, from: 2, to: 4, out: path.join(TMP, 'ex.pdf') });
    assert.strictEqual((await ft.execute('pdf_info', { path: ex.out })).pages, 3, 'pages 2-4 inclusive');

    const sp = await ft.execute('pdf_split', { path: a, out: path.join(TMP, 'split') });
    assert.strictEqual(sp.count, 3, 'a 3-page pdf splits into 3 files');

    const rot = await ft.execute('pdf_rotate', { path: a, degrees: 90, out: path.join(TMP, 'r.pdf') });
    assert.ok(rot.success && fs.existsSync(rot.out));
    ok('pdf merge / split / extract / rotate / info verified by page counts');
  }

  // 4. Missing ops fail INFORMATIVELY — never silently, never with a fake success.
  {
    for (const op of ['remove_background', 'ocr', 'vectorize']) {
      const a = await ft.opAvailable(op);
      if (a.ok) continue;                       // installed on this machine — nothing to assert
      const r = await ft.execute(op, { path: path.join(TMP, 'a.png') });
      assert.strictEqual(r.success, false);
      assert.ok(r.missing, 'must name the missing dependency');
      assert.ok(r.suggestion && /install/i.test(r.suggestion), 'must say how to fix it locally');
      const fb = ft.toolbusFallback(op);
      assert.ok(fb && fb.url.startsWith('https://www.thetoolbus.ai/'), 'must offer the ToolBus page');
      assert.ok(/bot protection|403/.test(fb.note), 'must explain why it is not automated');
    }
    ok('unavailable ops fail loudly with a local fix AND a ToolBus fallback');
  }

  // 5. Bad input never throws.
  {
    for (const [op, inp] of [['image_info', { path: '/nope/missing.png' }], ['pdf_merge', { paths: [] }], ['nonsense_op', {}]]) {
      const r = await ft.execute(op, inp);
      assert.strictEqual(r.success, false);
      assert.ok(r.error);
    }
    ok('missing files / bad args / unknown ops return errors instead of throwing');
  }

  // ── the upload gate ────────────────────────────────────────────────────────────────────────────
  console.log('[filesense]');
  const HOME = fs.mkdtempSync(path.join(TMP, 'home-'));
  const mk = (rel, body = 'hello') => { const p = path.join(HOME, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };

  // 6. Research + personal are gated; generic downloads are not.
  {
    const fsense = createFileSense({ home: HOME, dir: path.join(HOME, '.bhatbot') });
    assert.strictEqual(fsense.classify(mk('Downloads/meme.png')).level, 'general');
    assert.strictEqual(fsense.classify(mk('Desktop/screenshots/shot.png')).level, 'general');
    assert.strictEqual(fsense.classify(mk('Desktop/Research Files/protfunc/data.csv')).level, 'sensitive');
    assert.strictEqual(fsense.classify(mk('Downloads/binder.pdb')).level, 'sensitive', 'research data by extension, anywhere');
    assert.strictEqual(fsense.classify(mk('Documents/notes.txt')).level, 'sensitive');
    ok('research data and personal folders are gated; downloads/screenshots are not');
  }

  // 7. HARD sensitive: identity/financial names and credential CONTENT, regardless of location.
  {
    const fsense = createFileSense({ home: HOME, dir: path.join(HOME, '.bhatbot') });
    for (const n of ['Downloads/passport_scan.pdf', 'Downloads/2025_tax_return.pdf', 'Downloads/bank-statement.pdf', 'Downloads/my_resume.pdf']) {
      const v = fsense.classify(mk(n));
      assert.strictEqual(v.level, 'sensitive', n + ' must be gated even in Downloads');
      assert.strictEqual(v.hard, true, n + ' must be HARD sensitive (unlearnable)');
    }
    const key = fsense.classify(mk('Downloads/notes.txt', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'));
    assert.strictEqual(key.hard, true, 'a private key in a .txt is caught by content, not name');
    ok('identity/financial filenames and credential contents are HARD sensitive anywhere');
  }

  // 8. LEARNING: two approvals in a folder stop the asking.
  {
    const H2 = fs.mkdtempSync(path.join(TMP, 'h2-'));
    const d = path.join(H2, '.bhatbot');
    const mk2 = (rel) => { const p = path.join(H2, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
    let fsense = createFileSense({ home: H2, dir: d });
    const f1 = mk2('scratch/one.txt');
    assert.strictEqual(fsense.classify(f1).needsConfirm, true, 'unknown folder → ask');

    fsense.record({ filePath: f1, decision: 'allow' });
    fsense.record({ filePath: mk2('scratch/two.txt'), decision: 'allow' });
    fsense = createFileSense({ home: H2, dir: d });                      // reload from disk
    assert.strictEqual(fsense.classify(mk2('scratch/three.txt')).needsConfirm, false, 'two approvals → stop asking');
    ok('two approvals in a folder teach it to stop asking (learned from his decisions)');
  }

  // 9. LEARNING CANNOT UNLOCK THE HARD CASES. This is the assertion that keeps the feature safe:
  //    approving a folder must never make a passport or a private key uploadable.
  {
    const H3 = fs.mkdtempSync(path.join(TMP, 'h3-'));
    const d = path.join(H3, '.bhatbot');
    const mk3 = (rel, body = 'x') => { const p = path.join(H3, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
    let fsense = createFileSense({ home: H3, dir: d });
    for (let i = 0; i < 6; i++) fsense.record({ filePath: mk3(`shared/f${i}.png`), decision: 'allow' });
    fsense = createFileSense({ home: H3, dir: d });
    assert.strictEqual(fsense.classify(mk3('shared/ok.png')).needsConfirm, false, 'the folder itself is learned-general');
    const p = fsense.classify(mk3('shared/passport.pdf'));
    assert.strictEqual(p.level, 'sensitive', 'a passport in a trusted folder is STILL gated');
    assert.strictEqual(p.hard, true);
    const k = fsense.classify(mk3('shared/dump.txt', 'AKIAIOSFODNN7EXAMPLE'));
    assert.strictEqual(k.hard, true, 'an access key in a trusted folder is STILL gated');
    ok('learning can never unlock passports, credentials, or identity documents');
  }

  // 10. A single refusal on a TYPE sticks — refusing once for .pdb should not need repeating.
  {
    const H4 = fs.mkdtempSync(path.join(TMP, 'h4-'));
    const d = path.join(H4, '.bhatbot');
    const mk4 = (rel) => { const p = path.join(H4, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
    let fsense = createFileSense({ home: H4, dir: d });
    fsense.record({ filePath: mk4('a/x.pdb'), decision: 'deny' });
    fsense = createFileSense({ home: H4, dir: d });
    const v = fsense.classify(mk4('b/y.pdb'));
    assert.strictEqual(v.needsConfirm, true, 'one refusal on .pdb keeps every .pdb gated');
    ok('one refusal on a file type keeps that type gated everywhere');
  }

  // 11. Unknown → sensitive. The asymmetry: a click vs an irreversible upload.
  {
    const H5 = fs.mkdtempSync(path.join(TMP, 'h5-'));
    const fsense = createFileSense({ home: H5, dir: path.join(H5, '.bhatbot') });
    const p = path.join(H5, 'weird/thing.xyz'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x');
    const v = fsense.classify(p);
    assert.strictEqual(v.level, 'sensitive');
    assert.ok(/defaulting to asking/.test(v.reasons.join(' ')));
    ok('an unrecognized file defaults to asking, never to uploading');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`[filetools] ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
