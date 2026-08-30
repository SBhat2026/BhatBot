#!/usr/bin/env node
'use strict';
// BLENDER BRIDGE (lib/blender.js) — the planning half, which is where the security decisions live.
//
// Everything here runs with Blender ABSENT: the audit, the step split, the declarative path and the
// event fold are all pure. The one live check at the end is skipped when Blender isn't installed,
// because a test that silently needs a 400MB application is a test that gets disabled.
//
// Run: node scripts/test-blender.js   (wired into npm run verify)
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const B = require('../lib/blender');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── the import allow-list ───────────────────────────────────────────────────────────────────────
// A model writing bpy has read a lot of internet bpy, and internet bpy writes files. The point of
// the allow-list is that the habit fails at the door instead of halfway through someone's home dir.
{
  for (const bad of ['import os', 'import subprocess', 'import socket', 'from urllib import request',
                     'import shutil', 'import bpy\nimport requests']) {
    const a = B.auditScript(bad);
    ok(!a.ok, `refused: ${JSON.stringify(bad.split('\n').pop())}`);
    ok(a.reasons.length > 0 && /not allowed/.test(a.reasons[0]), 'and it says which import and what IS allowed');
  }
  for (const good of ['import bpy', 'import bmesh, math', 'from mathutils import Vector',
                      'import random\nimport colorsys', 'bpy.ops.mesh.primitive_cube_add()']) {
    ok(B.auditScript(good).ok, `allowed: ${JSON.stringify(good.split('\n')[0])}`);
  }
}

// ── escapes that do not look like imports ───────────────────────────────────────────────────────
{
  for (const [src, why] of [
    ['__import__("os").system("ls")', '__import__'],
    ['eval("1+1")', 'eval'],
    ['exec(payload)', 'exec'],
    ['f = open("/etc/passwd")', 'open'],
    ['getattr(bpy, "utils")', 'getattr'],
    ['bpy.ops.wm.url_open(url="http://x")', 'url_open'],
    ['bpy.ops.wm.save_as_mainfile(filepath="/tmp/x")', 'save_as_mainfile'],
  ]) {
    ok(!B.auditScript(src).ok, `refused ${why}`);
  }
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────
{
  const steps = B.splitSteps('#--step: base\nbpy.ops.a()\n\n#--step: shade\nbpy.ops.b()\n');
  ok(steps.length === 2, 'two markers → two steps');
  ok(steps[0].name === 'base' && steps[1].name === 'shade', 'step names come from the markers');
  ok(steps[0].code === 'bpy.ops.a()', 'code is the chunk between markers, trimmed');
}
{
  const steps = B.splitSteps('bpy.ops.a()');
  ok(steps.length === 1 && steps[0].name === 'build', 'no markers → one step, so markers are an optimisation not a requirement');
}
{
  const steps = B.splitSteps('import bpy\n#--step: one\nbpy.ops.a()');
  ok(steps.length === 2 && steps[0].name === 'setup', 'code before the first marker becomes a setup step rather than being dropped');
}
ok(B.splitSteps('').length === 0, 'an empty script yields no steps');
ok(B.splitSteps('   \n\n  ').length === 0, 'a whitespace-only script yields no steps');

// ── the declarative path ────────────────────────────────────────────────────────────────────────
{
  const r = B.opsToPython([
    { op: 'cube', name: 'Body', size: 2, location: [0, 0, 1], color: [1, 0, 0] },
    { op: 'modifier', target: 'Body', type: 'BEVEL', settings: { width: 0.05 } },
    { op: 'spin', target: 'Body', frames: 48 },
  ]);
  ok(r.errors.length === 0, 'known ops produce no errors');
  ok(r.steps.length === 3, 'one step per op');
  ok(/primitive_cube_add/.test(r.steps[0].code), 'cube maps to the right bpy operator');
  ok(/_paint\(obj, \(1, 0, 0\)\)/.test(r.steps[0].code), 'colour becomes a _paint call on the harness helper');
  ok(/modifiers\.new/.test(r.steps[1].code), 'modifier maps to modifiers.new');
  ok(/_frames\(48\)/.test(r.steps[2].code), 'spin sets the frame range');
  // Generated code must itself survive the audit — otherwise the two paths disagree about what is legal.
  for (const s of r.steps) ok(B.auditScript(s.code).ok, `generated step "${s.name}" passes its own audit`);
}
{
  const r = B.opsToPython([{ op: 'teapot' }]);
  ok(r.errors.length === 1 && /unknown op/.test(r.errors[0]), 'an unknown op is REPORTED, not silently skipped');
  ok(r.steps.length === 0, 'and produces no step');
}
{
  // Injection through a name: the value ends up inside Python SOURCE, so escaping is load-bearing.
  // Asserted with a real Python parse rather than a regex — a regex that tries to strip string
  // literals gets the escaping wrong in exactly the case that matters (it stops at the `\"`).
  const r = B.opsToPython([{ op: 'cube', name: 'x"); import os; ("' }]);
  const code = r.steps[0].code;
  let nodes = '';
  try {
    nodes = require('child_process').execFileSync('python3',
      ['-c', 'import ast,sys;print(",".join(type(n).__name__ for n in ast.walk(ast.parse(sys.stdin.read()))))'],
      { input: code, encoding: 'utf8' });
  } catch (e) { nodes = 'PARSE_FAILED'; }
  ok(nodes !== 'PARSE_FAILED', 'the generated Python still parses with a hostile name in it');
  ok(!/\bImport\b/.test(nodes), 'and the injected `import os` stays a string literal — no Import node exists');
}

// ── planJob ─────────────────────────────────────────────────────────────────────────────────────
{
  const p = B.planJob({ script: 'import os' }, { jobDir: '/tmp/j', name: 'm' });
  ok(!p.ok && /not allowed/.test(p.reasons.join(' ')), 'a failing audit fails the whole plan');
}
{
  const p = B.planJob({}, { jobDir: '/tmp/j', name: 'm' });
  ok(!p.ok && /nothing to build/.test(p.reasons.join(' ')), 'an empty spec says what is missing');
}
{
  const p = B.planJob({ script: 'bpy.ops.mesh.primitive_cube_add()', formats: ['glb', 'stl', 'exe'] },
    { jobDir: '/tmp/j', name: 'm' });
  ok(p.ok, 'a clean script plans');
  ok(p.job.formats.join() === 'glb,stl', 'unknown export formats are dropped rather than passed to Blender');
  ok(p.job.allowed_imports.includes('bpy'), 'the allow-list travels WITH the job — the harness enforces it at runtime');
  ok(p.job.preview.w >= 160 && p.job.preview.w <= 1280, 'preview size is clamped');
}
{
  const p = B.planJob({ script: 'bpy.ops.a()', preview_width: 99999, samples: -4 }, { jobDir: '/tmp/j', name: 'm' });
  ok(p.job.preview.w === 1280 && p.job.preview.samples === 4, 'absurd render settings clamp instead of being sent through');
}

// ── the harness enforces the allow-list at RUNTIME, not just textually ──────────────────────────
// The text audit is a guardrail; this is the line that actually holds, because an `import` statement
// compiles to an `__import__` call and the harness replaces that builtin.
{
  const src = B.harnessSource();
  const body = src.replace(/^\s*#.*$/gm, '');            // the COMMENT describing it is not the thing
  ok(/_BUILTINS\['__import__'\] = _guarded_import/.test(body), 'the guarded import is installed, not just described');
  ok(/for _gone in \('open', 'eval', 'exec', 'compile', 'input', 'breakpoint'\)/.test(body),
    'the dangerous builtins are removed from the step namespace');
  ok(/raise ImportError/.test(body), 'a blocked import raises rather than returning None');
  ok(/read_factory_settings/.test(body), 'the scene is reset deterministically');
  ok(/def frame_all/.test(body), 'the camera is framed on what was built (the "renders an empty grey square" bug)');
}

// ── event parsing ───────────────────────────────────────────────────────────────────────────────
ok(B.parseEvent('@@BB {"k":"done","ok":true}').k === 'done', 'a marker line parses');
ok(B.parseEvent('Blender quit') === null, "Blender's own chatter is ignored");
ok(B.parseEvent('@@BB not json') === null, 'a malformed marker line is ignored, not thrown on');
ok(B.parseEvent('Info: something @@BB {"k":"note","text":"x"}').k === 'note', 'a marker mid-line still parses');

// ── summarize ───────────────────────────────────────────────────────────────────────────────────
{
  const s = B.summarize([
    { k: 'ready', blender: '4.5.4', steps: 2 },
    { k: 'step', i: 0, name: 'base', status: 'run' },
    { k: 'step', i: 0, name: 'base', status: 'ok', ms: 12 },
    { k: 'preview', path: '/p/0.png' },
    { k: 'step', i: 1, name: 'shade', status: 'fail', ms: 3, error: 'boom' },
    { k: 'stats', objects: 2, tris: 300, verts: 150, frame_start: 1, frame_end: 48 },
    { k: 'export', format: 'glb', path: '/p/m.glb', bytes: 1024 },
    { k: 'done', ok: false, failed: 'shade' },
  ]);
  ok(s.blender === '4.5.4', 'the Blender version is captured');
  ok(s.steps.length === 2, "only settled steps are recorded — the 'run' event is progress, not a result");
  ok(s.steps[1].ok === false && s.steps[1].error === 'boom', 'a failed step keeps its error');
  ok(s.frames === 48, 'the frame count is derived from the range');
  ok(s.exports[0].bytes === 1024, 'exports are recorded with their size');
  ok(s.ok === false && s.failedStep === 'shade', 'the failing step is named');
}
{
  const s = B.summarize([]);
  ok(s.ok == null, 'no `done` event → ok stays null, so "Blender died" is distinguishable from "the build failed"');
}

// ── safe names ──────────────────────────────────────────────────────────────────────────────────
// This value becomes a directory and a filename, so a traversal here would escape the workspace.
ok(B.safeName('../../etc/passwd') === 'etc-passwd', 'path traversal is stripped out of the name');
ok(B.safeName('') === 'model', 'an empty name falls back rather than producing a dotfile');
ok(B.safeName('My Cool Lamp!') === 'my-cool-lamp', 'names are normalised');
ok(!/[^a-z0-9_-]/.test(B.safeName('a/b\\c$(x)`y`')), 'nothing shell- or path-special survives');

// ── the child does NOT inherit the environment ──────────────────────────────────────────────────
// main.js bridges vault secrets into process.env, so spawning with {...process.env} would hand every
// resolved API key to model-authored Python. One list, owned by lib/mcphub.js.
{
  process.env.__BB_FAKE_SECRET = 'sk-should-never-be-forwarded';
  const env = require('../lib/mcphub').pluginEnv({ name: 'blender' });
  ok(env.__BB_FAKE_SECRET === undefined, 'an arbitrary env var is NOT forwarded to the Blender child');
  ok(!Object.keys(env).some((k) => /KEY|TOKEN|SECRET|PASS/i.test(k)), 'nothing credential-shaped is in the child env');
  ok(!!env.PATH, 'PATH still is — the child has to be able to find things');
  delete process.env.__BB_FAKE_SECRET;
}

// ── live: only when Blender is actually installed ───────────────────────────────────────────────
(async () => {
  const bin = B.resolveBlender();
  const have = bin !== 'blender' || fs.existsSync(bin);
  if (!have || process.env.BHATBOT_SKIP_BLENDER === '1') {
    console.log(`\n⏭  live build skipped — Blender not found (looked for ${B.MAC_BLENDER})`);
  } else {
    const r = await B.run(
      { name: 'verify-cube', script: '#--step: cube\nbpy.ops.mesh.primitive_cube_add(size=2)', formats: ['glb'] },
      { timeoutMs: 120000, workspace: path.join(require('os').tmpdir(), 'bb-blender-test') });
    ok(r.success === true, 'a real build succeeds: ' + (r.error || ''));
    ok(r.objects === 1 && r.tris === 12, 'a default cube is 1 object and 12 triangles');
    ok(r.exports.some((e) => e.format === 'glb' && e.bytes > 0), 'a non-empty GLB is exported');
    ok(r.preview && fs.existsSync(r.preview), 'a preview image is rendered and lands on disk');
    try { fs.rmSync(r.jobDir, { recursive: true, force: true }); } catch {}

    // A build that fails must still say WHICH step, and still hand back what it managed to make.
    const f = await B.run(
      { name: 'verify-fail', script: '#--step: ok\nbpy.ops.mesh.primitive_cube_add()\n\n#--step: boom\nraise ValueError("nope")' },
      { timeoutMs: 120000, workspace: path.join(require('os').tmpdir(), 'bb-blender-test') });
    ok(f.success === false, 'a raising step fails the build');
    ok(f.failedStep === 'boom', 'and names the step that broke, not a line number');
    ok(/nope/.test(f.error || ''), 'the original exception survives into the error');
    ok(f.steps[0].ok === true, 'the step that DID work is still reported as having worked');
    ok(f.exports.length > 0, 'and the geometry built before the failure is still exported');
    try { fs.rmSync(f.jobDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n✅ blender: ${pass} assertions passed`);
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
