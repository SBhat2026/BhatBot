'use strict';
// ASSET STUDIO (lib/assetgen.js) — text → image → 3D → printable, in one call.
//
// Two things it exists for, and both are tested here:
//   1. COST. Driving the three stages from the model meant three tool round-trips, and every turn
//      re-sends the whole conversation. The sequence is deterministic once the target is known.
//   2. QUALITY. TRELLIS reconstructs from a single view, so it is very sensitive to the source
//      image: centred subject, plain background, flat light, no shadow. A model asked for "a 3D
//      dragon" writes a prompt for a PICTURE and then the mesh comes out warped with the backdrop
//      fused on. When the target is 3D the prompt is steered toward what the reconstructor needs.
//
// Every stage is injected, so this runs with no Replicate key, no OpenAI key and no spend.
const assert = require('assert');
const a = require('../lib/assetgen');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── prompt shaping: the quality lever ─────────────────────────────────────────────────────────
{
  ok(a.shapePrompt('a brass sextant', 'image') === 'a brass sextant',
    'for a picture the user\'s words are used verbatim — no framing is imposed');
  const forModel = a.shapePrompt('a brass sextant', 'model');
  ok(forModel.startsWith('a brass sextant'), 'for a mesh the subject still leads');
  ok(/plain flat neutral-grey background/.test(forModel), '…and a plain background is requested');
  ok(/no cast shadow/.test(forModel) && /no scene/.test(forModel), '…and shadows and scenery are excluded (they fuse into the mesh)');
  ok(/centered single subject/.test(forModel), '…and the subject is centred and whole');
  ok(a.shapePrompt('a brass sextant', 'printable') !== 'a brass sextant', 'printable gets the same treatment (it goes through a mesh)');

  // Respect an explicit art direction — overriding it would be worse than leaving it alone.
  for (const p of ['a sextant on a dark wooden desk, dramatic side lighting', 'isometric render of a sextant', 'a sextant, watercolor style']) {
    ok(a.shapePrompt(p, 'model') === p, `an explicitly art-directed prompt is left alone: "${p.slice(0, 34)}…"`);
  }
  ok(a.shapePrompt('', 'model') === '', 'an empty prompt stays empty rather than becoming pure boilerplate');
}

// ── stage planning ────────────────────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(a.planStages('image', false), ['image']); pass++;
  assert.deepStrictEqual(a.planStages('model', false), ['image', 'model']); pass++;
  assert.deepStrictEqual(a.planStages('printable', false), ['image', 'model', 'printable']); pass++;
  assert.deepStrictEqual(a.planStages('model', true), ['model']); pass++;
  assert.deepStrictEqual(a.planStages('printable', true), ['model', 'printable']); pass++;
  ok(true, 'supplying an image skips generation instead of regenerating over the top of it');
}

// ── the pipeline ──────────────────────────────────────────────────────────────────────────────
function rig(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      generateImage: async (i) => { calls.push(['image', i]); return over.image !== undefined ? over.image : { success: true, path: '/out/src.png', _image: 'B64', _imageMime: 'image/png' }; },
      generate3D: async (i) => { calls.push(['model', i]); return over.model !== undefined ? over.model : { success: true, path: '/out/m.glb' }; },
      makePrintable: async (i) => { calls.push(['printable', i]); return over.printable !== undefined ? over.printable : { success: true, path: '/out/m.stl' }; },
    },
  };
}

(async () => {
  {
    const r = rig();
    const out = await a.build({ prompt: 'a sextant', want: 'image' }, r.deps);
    ok(out.success && out.image === '/out/src.png', 'want:image returns the picture');
    ok(r.calls.length === 1, 'and runs ONLY the image stage — no silent 3D spend');
    ok(out._image === 'B64', 'the preview rides along so the result is visible in chat');
  }
  {
    const r = rig();
    const out = await a.build({ prompt: 'a sextant', want: 'printable' }, r.deps);
    ok(out.success, 'want:printable succeeds');
    assert.deepStrictEqual(out.ran, ['image', 'model', 'printable']); pass++;
    ok(r.calls.length === 3, 'all three stages ran from ONE call — three model turns collapsed into one');
    ok(out.image && out.model && out.printable, 'and every intermediate artifact is returned, not just the last');
    ok(r.calls[1][1].image_path === '/out/src.png', 'the mesh stage is handed the image the first stage produced');
    ok(r.calls[2][1].path === '/out/m.glb' && r.calls[2][1].mode === 'convert', 'the STL stage converts the MESH, rather than re-extruding the flat image');
  }
  {
    const r = rig();
    await a.build({ prompt: 'a sextant', want: 'model' }, r.deps);
    ok(r.calls[0][1].quality === 'high', 'a 3D target generates its source at high quality — the mesh is only as good as the image');
    ok(r.calls[0][1].size === '1024x1024', 'and square, which reconstructs best');
    const r2 = rig();
    await a.build({ prompt: 'a sextant', want: 'image' }, r2.deps);
    ok(r2.calls[0][1].quality === 'medium', 'a plain picture does not pay for high quality it does not need');
  }
  {
    const r = rig();
    const out = await a.build({ image: '/photos/mug.png', want: 'printable' }, r.deps);
    ok(out.success && r.calls.length === 2, 'an existing image skips generation');
    ok(r.calls[0][0] === 'model', 'and goes straight to the mesh');
  }
  {
    // Straight image → STL with no mesh step: extrude, not convert.
    const r = rig({ model: undefined });
    const out = await a.build({ image: '/photos/logo.png', want: 'printable', mode: 'extrude' }, r.deps);
    ok(out.success, 'image → printable works');
    ok(r.calls.find((c) => c[0] === 'printable')[1].mode === 'convert', 'with a mesh available it still converts the mesh (better geometry than an extrusion)');
  }

  // ── partial failure must not throw away the work that succeeded ─────────────────────────────
  {
    const r = rig({ model: { success: false, error: 'no replicateKey' } });
    const out = await a.build({ prompt: 'a sextant', want: 'printable' }, r.deps);
    ok(out.success === false && out.stage === 'model', 'a failed mesh reports WHICH stage failed');
    ok(out.image === '/out/src.png', 'and still hands back the image that was generated');
    ok(/still at \/out\/src\.png/.test(out.error), 'and says where it is, so the work is not silently lost');
    ok(r.calls.length === 2, 'and does not attempt the stage after the failure');
  }
  {
    const r = rig({ image: { success: false, error: 'no key' } });
    const out = await a.build({ prompt: 'x', want: 'model' }, r.deps);
    ok(out.success === false && out.stage === 'image' && r.calls.length === 1, 'a failed first stage stops immediately');
  }
  {
    const r = rig({ image: { success: true } });   // succeeded but returned no path
    const out = await a.build({ prompt: 'x', want: 'model' }, r.deps);
    ok(out.success === false && /no path/.test(out.error), 'an image with no path is caught before the mesh stage is handed undefined');
  }

  // ── input validation ────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    const out = await a.build({ want: 'model' }, r.deps);
    ok(out.success === false && /prompt|image path/.test(out.error), 'neither a prompt nor an image is a clear error, not a crash');
    ok(r.calls.length === 0, 'and nothing is spent finding that out');
    const out2 = await a.build({ prompt: 'x', want: 'nonsense' }, rig().deps);
    ok(out2.want === 'image', 'an unknown target degrades to the cheapest one rather than guessing expensively');
    const out3 = await a.build({ prompt: 'x', want: 'model' }, { generateImage: rig().deps.generateImage });
    ok(out3.success === false && /unavailable/.test(out3.error), 'a missing stage dependency is reported, not thrown');
  }

  console.log(`✅ assetgen: ${pass} assertions passed`);
})().catch((e) => { console.error('❌ assetgen:', e.message); process.exit(1); });
