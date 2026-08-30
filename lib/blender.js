'use strict';
// ── BLENDER — build, animate and export 3D models by driving Blender headless ─────────────────────
//
// BhatBot already had two ways to get a mesh, and both are reconstructors: `generate_3d` (TRELLIS)
// guesses geometry from a single picture, and `make_printable` extrudes a heightfield. Neither can
// make a thing that was DESIGNED — parametric, clean topology, named parts, a modifier stack, a
// rig, a 60-frame animation. Blender can, and it takes Python. So this is the third path: the model
// writes bpy, and everything around the bpy is code.
//
// WHY A HARNESS AND NOT JUST "RUN THIS SCRIPT". Left to itself the model spends a tool call writing
// a script, another discovering the object didn't render, another fixing the camera, another
// exporting. Each round trip re-sends the whole conversation. The parts that never vary — a
// deterministic empty scene, units, a camera framed on whatever was actually built, lights, a
// preview after every step, export, triangle counts — are the same every single time, so they live
// here and run once. What the model contributes is the part only it can: the modelling itself.
//
// STEPS ARE THE UNIT. The script is split on `#--step: <name>` markers. Each chunk is timed,
// rendered, and reported separately, which is what makes the Studio window a build log rather than a
// spinner — and, more usefully, means a failure names the step that broke instead of a line number
// in a script nobody kept.
//
// ── WHAT THE AUDIT IS AND IS NOT ────────────────────────────────────────────────────────────────
// `auditScript` is a GUARDRAIL, not a sandbox. Blender's bundled Python is a full interpreter with
// full filesystem access; anything determined to get out, gets out. What the allow-list actually
// buys is that a model reaching for `subprocess` or `open()` out of habit — which it will, because
// most bpy on the internet writes files — fails loudly at the door instead of half-succeeding
// somewhere in the user's home directory.
//
// The real boundaries are the three below it, and those are structural:
//   • the child gets SAFE_ENV_KEYS only. The vault bridges OPENAI_API_KEY and GEMINI_API_KEY into
//     process.env at boot (main.js syncResolvedSecretsToEnv), so spawning with `{...process.env}` —
//     which is what lib/resolve.js does today — hands every resolved secret to model-authored code.
//   • `--factory-startup`, so the user's own addons and startup scripts cannot execute or interfere.
//   • every path the harness writes is inside one per-job directory under ~/.bhatbot/blender.
//
// PURE where it matters: auditScript / splitSteps / opsToPython / harnessSource / parseEvent have no
// fs, no spawn and no timers, so the whole plan is testable with Blender absent.

const path = require('path');

const MARKER = '@@BB ';
const STEP_RE = /^[ \t]*#\s*--\s*step\s*:?\s*(.*)$/gim;

// Modules a modelling script legitimately needs. Everything else is a mistake or an escape.
const ALLOWED_IMPORTS = new Set([
  'bpy', 'bmesh', 'mathutils', 'math', 'random', 'colorsys', 'itertools', 'functools', 'json',
]);

// Constructs that either bypass the import allow-list or reach outside the job directory.
const FORBIDDEN = [
  { re: /\b__import__\s*\(/, why: '__import__() bypasses the import allow-list' },
  { re: /\b(?:eval|exec|compile)\s*\(/, why: 'eval/exec/compile can assemble any of the blocked calls at runtime' },
  { re: /\bopen\s*\(/, why: 'the harness owns every file read and write — return objects in the scene and it exports them' },
  { re: /\b(?:getattr|setattr|globals|locals|vars)\s*\(/, why: 'attribute indirection can reach modules the allow-list blocks' },
  { re: /bpy\.ops\.wm\.(?:url_open|save_as_mainfile|save_mainfile|open_mainfile|read_homefile|read_factory_settings)/, why: 'the harness owns the scene lifecycle and saves the .blend itself' },
  { re: /bpy\.utils\.(?:execfile|register_module)/, why: 'loads code from disk' },
  { re: /bpy\.app\.handlers/, why: 'a handler outlives the step that registered it, so a failure lands somewhere unattributable' },
];

/**
 * Check a model-authored bpy script against the allow-list.
 * @returns {{ok: boolean, reasons: string[]}} — reasons are phrased as instructions, because the
 *          model reads them and rewrites the script from them.
 */
function auditScript(src) {
  const text = String(src || '');
  const reasons = [];
  for (const { re, why } of FORBIDDEN) {
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
    if (m) reasons.push(`\`${m[0]}\` is not allowed — ${why}.`);
  }
  // Imports: parse them rather than blocking names, so a new stdlib module is refused by default.
  const importRe = /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import|import[ \t]+([^\n#]+))/gm;
  let im;
  while ((im = importRe.exec(text))) {
    const mods = im[1] ? [im[1]] : String(im[2]).split(',');
    for (const raw of mods) {
      const root = String(raw).trim().split(/[ .]/)[0];
      if (!root) continue;
      if (!ALLOWED_IMPORTS.has(root)) {
        reasons.push(`\`import ${root}\` is not allowed — only ${[...ALLOWED_IMPORTS].join(', ')} are available.`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * Split a script into named steps on `#--step: name` markers.
 * A script with no markers is one step, so the marker is an optimisation and never a requirement.
 */
function splitSteps(script) {
  const src = String(script || '');
  const marks = [];
  STEP_RE.lastIndex = 0;
  let m;
  while ((m = STEP_RE.exec(src))) marks.push({ at: m.index, end: STEP_RE.lastIndex, name: (m[1] || '').trim() });
  if (!marks.length) {
    const code = src.trim();
    return code ? [{ name: 'build', code }] : [];
  }
  const steps = [];
  const preamble = src.slice(0, marks[0].at).trim();
  if (preamble) steps.push({ name: 'setup', code: preamble });
  for (let i = 0; i < marks.length; i++) {
    const code = src.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : src.length).trim();
    if (code) steps.push({ name: marks[i].name || `step ${steps.length + 1}`, code });
  }
  return steps;
}

// ── DECLARATIVE PATH ────────────────────────────────────────────────────────────────────────────
// The common asks — a few primitives, a modifier, a spin — do not need a model to write Python. This
// covers them with no code generation at all, which means no audit, no syntax risk, and a shape the
// UI can show before anything runs.

const PRIMITIVES = {
  cube: 'bpy.ops.mesh.primitive_cube_add(size=%S%, location=%L%)',
  sphere: 'bpy.ops.mesh.primitive_uv_sphere_add(radius=%S%, location=%L%)',
  cylinder: 'bpy.ops.mesh.primitive_cylinder_add(radius=%S%, location=%L%)',
  cone: 'bpy.ops.mesh.primitive_cone_add(radius1=%S%, location=%L%)',
  torus: 'bpy.ops.mesh.primitive_torus_add(major_radius=%S%, location=%L%)',
  plane: 'bpy.ops.mesh.primitive_plane_add(size=%S%, location=%L%)',
  monkey: 'bpy.ops.mesh.primitive_monkey_add(size=%S%, location=%L%)',
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const vec3 = (v, d = [0, 0, 0]) => {
  const a = Array.isArray(v) ? v : d;
  return `(${num(a[0], 0)}, ${num(a[1], 0)}, ${num(a[2], 0)})`;
};
const pyStr = (s) => JSON.stringify(String(s == null ? '' : s));

/** Turn a declarative op list into steps. Unknown ops are reported, never silently skipped. */
function opsToPython(ops) {
  const steps = [];
  const errors = [];
  for (const [i, opRaw] of (Array.isArray(ops) ? ops : []).entries()) {
    const op = opRaw || {};
    const kind = String(op.op || '').toLowerCase();
    const label = op.name ? String(op.name) : `${kind || 'op'} ${i + 1}`;
    if (PRIMITIVES[kind]) {
      const line = PRIMITIVES[kind].replace('%S%', String(num(op.size, 2))).replace('%L%', vec3(op.location));
      const body = [line, 'obj = bpy.context.active_object', `obj.name = ${pyStr(op.name || kind)}`];
      if (op.scale) body.push(`obj.scale = ${vec3(op.scale, [1, 1, 1])}`);
      if (op.rotation) body.push(`obj.rotation_euler = ${vec3(op.rotation)}`);
      if (op.color) body.push(`_paint(obj, ${vec3(op.color, [0.8, 0.8, 0.8])})`);
      steps.push({ name: label, code: body.join('\n') });
    } else if (kind === 'modifier') {
      const type = String(op.type || 'SUBSURF').toUpperCase();
      const body = [
        `obj = bpy.data.objects.get(${pyStr(op.target || '')}) or bpy.context.active_object`,
        `mod = obj.modifiers.new(name=${pyStr(type.toLowerCase())}, type=${pyStr(type)})`,
      ];
      for (const [k, v] of Object.entries(op.settings || {})) {
        body.push(`if hasattr(mod, ${pyStr(k)}): mod.${k} = ${typeof v === 'string' ? pyStr(v) : num(v, 0)}`);
      }
      steps.push({ name: label, code: body.join('\n') });
    } else if (kind === 'spin' || kind === 'orbit') {
      // The animation everyone actually asks for: turn the thing so you can see all of it.
      const frames = Math.max(2, num(op.frames, 60));
      steps.push({
        name: label,
        code: [
          `obj = bpy.data.objects.get(${pyStr(op.target || '')}) or bpy.context.active_object`,
          'obj.rotation_euler = (0, 0, 0)',
          'obj.keyframe_insert(data_path="rotation_euler", frame=1)',
          'obj.rotation_euler = (0, 0, 6.283185307179586)',
          `obj.keyframe_insert(data_path="rotation_euler", frame=${frames})`,
          'for fc in obj.animation_data.action.fcurves:',
          '    for kp in fc.keyframe_points: kp.interpolation = "LINEAR"',
          `_frames(${frames})`,
        ].join('\n'),
      });
    } else {
      errors.push(`unknown op "${op.op}" (have: ${Object.keys(PRIMITIVES).join(', ')}, modifier, spin)`);
    }
  }
  return { steps, errors };
}

// ── THE HARNESS ─────────────────────────────────────────────────────────────────────────────────
// Trusted code: it runs the untrusted steps, so it is the one place allowed to touch os/open.

function harnessSource() {
  return `# BhatBot Blender harness — generated, do not edit by hand.
import bpy, sys, os, json, time, math, traceback

_argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
with open(_argv[0]) as _f:
    JOB = json.load(_f)
OUT = JOB['out']

def emit(k, **kw):
    kw['k'] = k
    sys.stdout.write(${JSON.stringify(MARKER)} + json.dumps(kw) + '\\n')
    sys.stdout.flush()

# ── deterministic scene ──────────────────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = 'METRIC'
sc.render.resolution_x = JOB['preview']['w']
sc.render.resolution_y = JOB['preview']['h']
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
sc.render.film_transparent = False

world = bpy.data.worlds.new('W'); sc.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.04, 0.06, 0.09, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 1.0

_cam_data = bpy.data.cameras.new('Cam')
_cam = bpy.data.objects.new('Cam', _cam_data)
sc.collection.objects.link(_cam); sc.camera = _cam

def _light(name, loc, energy, color):
    d = bpy.data.lights.new(name, type='AREA'); d.energy = energy; d.size = 6.0; d.color = color
    o = bpy.data.objects.new(name, d); o.location = loc
    sc.collection.objects.link(o)
    o.rotation_euler = (math.radians(50), 0, math.radians(35))
    return o

_light('Key', (5, -5, 7), 900, (1.0, 0.98, 0.95))
_light('Rim', (-6, 4, 4), 400, (0.55, 0.78, 1.0))

# Helpers the declarative path emits calls to. Defined here so generated code stays short.
def _paint(obj, rgb):
    m = bpy.data.materials.new('M_' + obj.name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    if bsdf: bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1)
    obj.data.materials.append(m)

def _frames(n):
    sc.frame_start = 1
    sc.frame_end = max(1, int(n))

_HELPERS = {'_paint': _paint, '_frames': _frames}

# ── camera framing ───────────────────────────────────────────────────────────────────────────────
# Framed on what was ACTUALLY built, re-measured before every preview. A fixed camera is why most
# generated Blender scripts render an empty grey square: the object is off-frame, not missing.
from mathutils import Vector

def frame_all():
    pts = []
    for ob in sc.objects:
        if ob.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'}: continue
        for c in ob.bound_box:
            pts.append(ob.matrix_world @ Vector((c[0], c[1], c[2])))
    if not pts:
        _cam.location = (6, -6, 4); _cam.rotation_euler = (math.radians(64), 0, math.radians(45))
        return False
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    cx = (min(xs) + max(xs)) / 2.0; cy = (min(ys) + max(ys)) / 2.0; cz = (min(zs) + max(zs)) / 2.0
    radius = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 0.6) * 0.5
    dist = radius * 3.4 + 1.0
    _cam.location = (cx + dist * 0.62, cy - dist * 0.72, cz + dist * 0.52)
    d = ((_cam.location[0] - cx) ** 2 + (_cam.location[1] - cy) ** 2 + (_cam.location[2] - cz) ** 2) ** 0.5
    _cam.rotation_euler = (
        math.acos((_cam.location[2] - cz) / max(d, 1e-6)),
        0.0,
        math.atan2(_cam.location[1] - cy, _cam.location[0] - cx) + math.pi / 2,
    )
    return True

# ── render ───────────────────────────────────────────────────────────────────────────────────────
# EEVEE needs a GPU context, which a --background process does not always have; Cycles never does.
# Rather than guess per platform, PROBE once: try the fast one, keep whichever answered, and say so.
_engine = {'name': None}
_order = [JOB['engine']] if JOB.get('engine') else ['BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES']

def render_to(filepath):
    sc.render.filepath = filepath
    tried, last = [], ''
    for eng in ([_engine['name']] if _engine['name'] else _order):
        try:
            sc.render.engine = eng
        except Exception as ex:
            tried.append(eng); last = str(ex); continue
        try:
            if eng == 'CYCLES':
                sc.cycles.samples = JOB['preview'].get('samples', 24)
                sc.cycles.use_denoising = False
            bpy.ops.render.render(write_still=True)
            if _engine['name'] != eng:
                _engine['name'] = eng
                emit('engine', engine=eng, tried=tried)
            return filepath if os.path.exists(filepath) else None
        except Exception as ex:
            tried.append(eng); last = str(ex)
    emit('note', text='preview render unavailable: ' + last[:180])
    return None

def preview(tag):
    if not JOB.get('previews', True): return None
    frame_all()
    p = render_to(os.path.join(OUT, 'preview_%s.png' % tag))
    if p: emit('preview', tag=str(tag), path=p)
    return p

# ── stats ────────────────────────────────────────────────────────────────────────────────────────
def stats():
    dg = bpy.context.evaluated_depsgraph_get()
    objs = tris = verts = 0
    for ob in list(sc.objects):
        if ob.type != 'MESH': continue
        objs += 1
        try:
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            me.calc_loop_triangles()
            tris += len(me.loop_triangles); verts += len(me.vertices)
            ev.to_mesh_clear()
        except Exception:
            pass
    return objs, tris, verts

# ── run the steps ────────────────────────────────────────────────────────────────────────────────
emit('ready', blender='.'.join(str(x) for x in bpy.app.version), steps=len(JOB['steps']))

# The allow-list, enforced at RUNTIME and not only by the text audit — an \`import\` statement compiles
# to an \`__import__\` call, so replacing that one builtin is what actually holds the line. Everything
# a modelling script needs still resolves; subprocess, socket and urllib raise at the import.
_BUILTINS = dict(vars(__builtins__)) if not isinstance(__builtins__, dict) else dict(__builtins__)
_real_import = _BUILTINS['__import__']
_ALLOWED = set(JOB.get('allowed_imports') or [])

def _guarded_import(name, *a, **kw):
    root = str(name).split('.')[0]
    if root not in _ALLOWED:
        raise ImportError("BhatBot: '%s' is not available inside a build step (allowed: %s)"
                          % (root, ', '.join(sorted(_ALLOWED))))
    return _real_import(name, *a, **kw)

for _gone in ('open', 'eval', 'exec', 'compile', 'input', 'breakpoint'):
    _BUILTINS.pop(_gone, None)
_BUILTINS['__import__'] = _guarded_import

G = {'bpy': bpy, 'math': math, '__builtins__': _BUILTINS}
G.update(_HELPERS)
failed = None
for i, st in enumerate(JOB['steps']):
    emit('step', i=i, n=len(JOB['steps']), name=st['name'], status='run')
    t0 = time.time()
    try:
        exec(compile(st['code'], '<step %d: %s>' % (i + 1, st['name']), 'exec'), G)
        ms = int((time.time() - t0) * 1000)
        emit('step', i=i, n=len(JOB['steps']), name=st['name'], status='ok', ms=ms)
    except Exception:
        ms = int((time.time() - t0) * 1000)
        tb = traceback.format_exc().strip().split('\\n')
        emit('step', i=i, n=len(JOB['steps']), name=st['name'], status='fail', ms=ms,
             error=' / '.join(tb[-3:])[:400])
        failed = st['name']
        break
    preview(str(i))

o, t, v = stats()
emit('stats', objects=o, tris=t, verts=v, frame_start=sc.frame_start, frame_end=sc.frame_end)

final = preview('final')
if final: emit('final_preview', path=final)

# ── export ───────────────────────────────────────────────────────────────────────────────────────
# Exports run even after a failed step: a half-built object you can look at beats nothing at all.
if o == 0:
    emit('note', text='no mesh objects in the scene — nothing to export')
else:
    for fmt in JOB.get('formats', ['glb']):
        p = os.path.join(OUT, JOB['name'] + ('.glb' if fmt == 'glb' else '.' + fmt))
        try:
            if fmt == 'glb':
                bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', export_animations=True)
            elif fmt == 'stl':
                try: bpy.ops.wm.stl_export(filepath=p)
                except AttributeError: bpy.ops.export_mesh.stl(filepath=p)
            elif fmt == 'obj':
                try: bpy.ops.wm.obj_export(filepath=p)
                except AttributeError: bpy.ops.export_scene.obj(filepath=p)
            else:
                emit('note', text='unknown export format ' + fmt); continue
            emit('export', format=fmt, path=p, bytes=os.path.getsize(p))
        except Exception as ex:
            emit('note', text='export %s failed: %s' % (fmt, str(ex)[:160]))

try:
    blend = os.path.join(OUT, JOB['name'] + '.blend')
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    emit('blend', path=blend)
except Exception as ex:
    emit('note', text='could not save .blend: ' + str(ex)[:160])

emit('done', ok=(failed is None), failed=failed)
`;
}

// ── EVENT PARSING ───────────────────────────────────────────────────────────────────────────────

/** One stdout line → an event, or null if it isn't ours (Blender is chatty on stdout). */
function parseEvent(line) {
  const s = String(line || '');
  const i = s.indexOf(MARKER);
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i + MARKER.length)); } catch { return null; }
}

/**
 * Fold the event stream into the result the tool returns. Separated from the spawn so a recorded
 * stream can be replayed in a test with no Blender present.
 */
function summarize(events) {
  const out = { steps: [], exports: [], notes: [], previews: [] };
  for (const e of events || []) {
    if (!e || !e.k) continue;
    if (e.k === 'ready') { out.blender = e.blender; }
    else if (e.k === 'engine') { out.engine = e.engine; if ((e.tried || []).length) out.engineFellBackFrom = e.tried; }
    else if (e.k === 'step' && e.status !== 'run') out.steps.push({ name: e.name, ok: e.status === 'ok', ms: e.ms, error: e.error });
    else if (e.k === 'preview') out.previews.push(e.path);
    else if (e.k === 'final_preview') out.preview = e.path;
    else if (e.k === 'stats') { out.objects = e.objects; out.tris = e.tris; out.verts = e.verts; out.frames = Math.max(0, (e.frame_end || 0) - (e.frame_start || 0) + 1); }
    else if (e.k === 'export') out.exports.push({ format: e.format, path: e.path, bytes: e.bytes });
    else if (e.k === 'blend') out.blend = e.path;
    else if (e.k === 'note') out.notes.push(e.text);
    else if (e.k === 'done') { out.ok = !!e.ok; out.failedStep = e.failed || null; }
  }
  return out;
}

/** Where Blender is. Explicit override first, then the standard macOS bundle, then PATH. */
const MAC_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
function resolveBlender(env = process.env, exists = require('fs').existsSync) {
  if (env.BHATBOT_BLENDER_BIN && exists(env.BHATBOT_BLENDER_BIN)) return env.BHATBOT_BLENDER_BIN;
  if (exists(MAC_BLENDER)) return MAC_BLENDER;
  return 'blender';
}

/**
 * Build the job: audit, plan the steps, and describe the child process. Pure — returns the argv and
 * files to write rather than doing either, so a test can assert the whole plan.
 */
function planJob(spec = {}, { jobDir, name = 'model' } = {}) {
  const reasons = [];
  let steps = [];
  if (Array.isArray(spec.ops) && spec.ops.length) {
    const r = opsToPython(spec.ops);
    steps = r.steps;
    reasons.push(...r.errors);
  }
  if (spec.script) {
    const audit = auditScript(spec.script);
    if (!audit.ok) reasons.push(...audit.reasons);
    else steps = steps.concat(splitSteps(spec.script));
  }
  if (!steps.length && !reasons.length) reasons.push('nothing to build — pass `script` (bpy Python) or `ops` (declarative primitives).');
  const preview = {
    w: Math.max(160, Math.min(1280, num(spec.preview_width, 512))),
    h: Math.max(120, Math.min(1280, num(spec.preview_height, 384))),
    samples: Math.max(4, Math.min(128, num(spec.samples, 24))),
  };
  const formats = (Array.isArray(spec.formats) && spec.formats.length ? spec.formats : ['glb'])
    .map((f) => String(f).toLowerCase()).filter((f) => ['glb', 'stl', 'obj'].includes(f));
  return {
    ok: reasons.length === 0,
    reasons,
    job: {
      out: jobDir, name, steps, preview, formats,
      previews: spec.previews !== false,
      engine: spec.engine || null,
      allowed_imports: [...ALLOWED_IMPORTS],
    },
  };
}

// ── RUNNER ──────────────────────────────────────────────────────────────────────────────────────

/** A name that is safe to put in a path. Everything downstream builds filenames out of this. */
function safeName(s) {
  const n = String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return n || 'model';
}

/**
 * Run a build.
 *
 * @param {object} spec   { script?, ops?, name?, formats?, preview_width?, preview_height?,
 *                          samples?, previews?, engine? }
 * @param {object} opts   { workspace?, onEvent?, timeoutMs?, stamp?, bin? }
 * @returns {Promise<object>} summarize() output plus { success, jobDir, script, log }
 */
async function run(spec = {}, opts = {}) {
  const fs = require('fs');
  const os = require('os');
  const { spawn } = require('child_process');
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  const bin = opts.bin || resolveBlender();
  const name = safeName(spec.name || 'model');
  const root = opts.workspace || path.join(os.homedir(), '.bhatbot', 'blender');
  const jobDir = path.join(root, `${name}-${opts.stamp || Date.now()}`);

  const plan = planJob(spec, { jobDir, name });
  if (!plan.ok) return { success: false, error: plan.reasons.join(' '), reasons: plan.reasons };

  try { fs.mkdirSync(jobDir, { recursive: true }); }
  catch (e) { return { success: false, error: `could not create the build directory: ${e.message}` }; }

  const jobPath = path.join(jobDir, 'job.json');
  const harnessPath = path.join(jobDir, 'harness.py');
  const scriptPath = path.join(jobDir, 'script.py');
  const readable = plan.job.steps.map((s) => `#--step: ${s.name}\n${s.code}`).join('\n\n');
  try {
    fs.writeFileSync(jobPath, JSON.stringify(plan.job));
    fs.writeFileSync(harnessPath, harnessSource());
    fs.writeFileSync(scriptPath, readable);
  } catch (e) { return { success: false, error: `could not write the build files: ${e.message}` }; }

  // The child gets the same allow-listed environment a third-party MCP plugin gets, and for the same
  // reason: it runs code we did not write. One list, one owner — see lib/mcphub.js.
  let env;
  try { env = require('./mcphub').pluginEnv({ name: 'blender' }); }
  catch { env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' }; }

  const events = [];
  const log = [];
  const push = (e) => { events.push(e); try { onEvent(e); } catch {} };
  push({ k: 'start', name, jobDir, script: scriptPath, steps: plan.job.steps.map((s) => s.name) });

  const argv = ['--background', '--factory-startup', '--python', harnessPath, '--', jobPath];
  const started = Date.now();

  const result = await new Promise((resolve) => {
    let child;
    try { child = spawn(bin, argv, { env, cwd: jobDir }); }
    catch (e) { return resolve({ spawnError: e.message }); }

    let buf = '';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ timedOut: true });
    }, Math.max(5000, opts.timeoutMs || 240000));

    const line = (raw) => {
      const t = raw.replace(/\r$/, '');
      const ev = parseEvent(t);
      if (ev) push(ev);
      else if (t.trim()) { log.push(t.slice(0, 300)); if (log.length > 400) log.shift(); }
    };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => {
      for (const t of d.toString().split('\n')) if (t.trim()) { log.push(t.slice(0, 300)); if (log.length > 400) log.shift(); }
    });
    child.on('error', (e) => finish({ spawnError: e.message }));
    child.on('close', (code) => { if (buf.trim()) line(buf); finish({ code }); });
  });

  const out = summarize(events);
  out.jobDir = jobDir;
  out.script = scriptPath;
  out.ms = Date.now() - started;

  if (result.spawnError) {
    return { ...out, success: false,
      error: `could not launch Blender (${bin}): ${result.spawnError}. Install Blender, or set BHATBOT_BLENDER_BIN to its executable.` };
  }
  if (result.timedOut) {
    return { ...out, success: false, error: `Blender did not finish within ${Math.round((opts.timeoutMs || 240000) / 1000)}s — the build was killed.`, log: log.slice(-12) };
  }
  // A non-zero exit with no `done` event means Blender died before the harness ran (a bad install, a
  // missing GPU driver). Surface the tail of its output, since that is the only evidence there is.
  if (out.ok == null) {
    return { ...out, success: false, error: `Blender exited (code ${result.code}) without completing the build.`, log: log.slice(-12) };
  }
  const failed = out.steps.find((s) => !s.ok);
  return {
    ...out,
    success: !!out.ok,
    error: failed ? `step "${failed.name}" failed: ${failed.error}` : undefined,
    log: out.ok ? undefined : log.slice(-12),
  };
}

module.exports = {
  auditScript, splitSteps, opsToPython, harnessSource, parseEvent, summarize, planJob,
  resolveBlender, safeName, run,
  ALLOWED_IMPORTS, FORBIDDEN, PRIMITIVES, MARKER, MAC_BLENDER,
};
