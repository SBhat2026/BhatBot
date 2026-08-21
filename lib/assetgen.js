'use strict';
// ── ASSET STUDIO — one call for the whole 2D → 3D → printable chain ──────────────────────────────
//
// The three stages already existed as three tools (generate_image, generate_3d, make_printable) and
// the model had to drive them in sequence: generate an image, read back the path, call TRELLIS, read
// back the GLB, call the mesh converter. Three tool round-trips means three model turns, and every
// turn re-sends the entire conversation — so producing one printable object cost several full
// context replays plus the schemas of all three tools. The work is deterministic once the goal is
// known, so it belongs in code. Same argument as lib/visualbuild.js.
//
// It also FIXES A QUALITY PROBLEM, which is the more interesting half. TRELLIS reconstructs geometry
// from a single view, so it is extremely sensitive to the source image: a centred subject, plain
// background, even lighting and no shadow gives a clean mesh, while a scene, a gradient backdrop or
// a dramatic rim light gives a warped one with the background fused onto the model. The model asking
// for "a 3D dragon" writes a prompt for a PICTURE, not for a reconstruction source, and then blames
// TRELLIS for the result. When the target is 3D, the prompt is rewritten toward what the
// reconstructor actually needs — which costs nothing and is the single biggest quality lever here.
//
// PURE: every stage is injected, so the pipeline is testable with no Replicate key, no OpenAI key
// and no spend.

// Phrases that make a single-view reconstruction behave. Appended (not substituted) so the user's
// own description still leads.
const RECON_STYLE = 'centered single subject, entire object fully visible, plain flat neutral-grey background, '
  + 'even diffuse studio lighting, no cast shadow, no ground plane, no scene, no text, no watermark, '
  + 'three-quarter view, sharp focus, photographic clarity';

// Cues that the user has ALREADY specified a look we should not overwrite.
const HAS_STYLE = /\b(background|lighting|lit|shadow|scene|angle|view|render|style|photo|painting|sketch|isometric)\b/i;

/**
 * Shape a prompt for its target. For `image` the user's words are used as-is; for a reconstruction
 * source the framing constraints are appended unless the user already dictated a look.
 */
function shapePrompt(prompt, want) {
  const p = String(prompt || '').trim();
  if (!p) return p;
  if (want === 'image') return p;
  if (HAS_STYLE.test(p)) return p;      // they described a look on purpose — respect it
  return `${p}. ${RECON_STYLE}`;
}

/** What stages a target needs. `printable` implies a mesh, which implies an image if none is given. */
function planStages(want, hasImage) {
  const stages = [];
  if (!hasImage) stages.push('image');
  if (want === 'model' || want === 'printable') stages.push('model');
  if (want === 'printable') stages.push('printable');
  return stages;
}

const WANTS = ['image', 'model', 'printable'];

/**
 * Run the pipeline.
 *
 * @param {object} spec { prompt?, image?, want='image', quality?, size?, provider?, texture_size?,
 *                        mode?, height_mm?, width_mm?, filename? }
 * @param {object} deps { generateImage, generate3D, makePrintable, log? }  each async → tool result
 * @returns {Promise<{success, want, stages, image?, model?, printable?, _image?, _imageMime?, error?}>}
 */
async function build(spec = {}, deps = {}) {
  const { generateImage, generate3D, makePrintable, log = () => {} } = deps;
  const want = WANTS.includes(spec.want) ? spec.want : 'image';
  const hasImage = !!spec.image;
  if (!hasImage && !String(spec.prompt || '').trim()) {
    return { success: false, error: 'give me either a prompt to generate from, or an image path to build on' };
  }
  const stages = planStages(want, hasImage);
  const out = { success: true, want, stages, ran: [] };

  // ── 1. the 2D image ─────────────────────────────────────────────────────────────────────────
  let imagePath = spec.image || null;
  if (!hasImage) {
    if (typeof generateImage !== 'function') return { success: false, error: 'image generation is unavailable' };
    const prompt = shapePrompt(spec.prompt, want);
    if (prompt !== spec.prompt) log(`[asset] prompt shaped for reconstruction: +${RECON_STYLE.slice(0, 40)}…`);
    const img = await generateImage({
      prompt,
      quality: spec.quality || (want === 'image' ? 'medium' : 'high'),   // a mesh is only as good as its source
      size: spec.size || '1024x1024',                                    // square reconstructs best
      provider: spec.provider,
      filename: spec.filename ? spec.filename + '_src' : undefined,
    });
    if (!img || img.success === false) return { success: false, stage: 'image', error: (img && img.error) || 'image generation failed' };
    imagePath = img.path || img.file || img.image_path || null;
    out.image = imagePath;
    out.prompt_used = prompt;
    out.ran.push('image');
    if (img._image) { out._image = img._image; out._imageMime = img._imageMime || 'image/png'; }
    if (want === 'image') return out;
    if (!imagePath) return { success: false, stage: 'image', error: 'image generated but no path was returned, so the mesh stage has nothing to read' };
  }

  // ── 2. the mesh ─────────────────────────────────────────────────────────────────────────────
  if (want === 'model' || want === 'printable') {
    if (typeof generate3D !== 'function') return { ...out, success: false, stage: 'model', error: '3D generation is unavailable' };
    const m = await generate3D({ image_path: imagePath, texture_size: spec.texture_size || 1024, filename: spec.filename });
    if (!m || m.success === false) {
      // A failed mesh still leaves a usable image — say so instead of reporting a total failure.
      return { ...out, success: false, stage: 'model', image: imagePath,
        error: ((m && m.error) || '3D reconstruction failed') + (out.image ? ` (the source image is still at ${out.image})` : '') };
    }
    out.model = m.path || m.file || m.glb || null;
    out.ran.push('model');
    if (!out._image && m._image) { out._image = m._image; out._imageMime = m._imageMime || 'image/png'; }
    if (want === 'model') return out;
  }

  // ── 3. printable ────────────────────────────────────────────────────────────────────────────
  if (want === 'printable') {
    if (typeof makePrintable !== 'function') return { ...out, success: false, stage: 'printable', error: 'mesh conversion is unavailable' };
    // From a GLB → convert; straight from an image with no mesh step → extrude/relief.
    const fromModel = !!out.model;
    const p = await makePrintable({
      path: fromModel ? out.model : imagePath,
      mode: fromModel ? 'convert' : (spec.mode || 'extrude'),
      height_mm: spec.height_mm,
      width_mm: spec.width_mm,
    });
    if (!p || p.success === false) {
      return { ...out, success: false, stage: 'printable', error: ((p && p.error) || 'STL conversion failed') };
    }
    out.printable = p.path || p.stl || null;
    out.ran.push('printable');
  }
  return out;
}

module.exports = { build, shapePrompt, planStages, RECON_STYLE, HAS_STYLE, WANTS };
