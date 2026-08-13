'use strict';
// ── FILE TOOLS — conversion, resizing, PDF surgery ───────────────────────────────────────────────
// Prompted by thetoolbus.ai (a ~140-tool web utility belt). Two findings shaped what this became:
//
//   1. MOST OF IT IS ALREADY ON THE MACHINE. sips (built into macOS), ffmpeg, PIL and pypdf cover
//      image conversion/resize/compression and PDF merge/split/rotate/extract outright. Driving a
//      website to do what `sips` does in 40ms would be slower, offline-fragile, and would upload his
//      files for no reason.
//   2. THETOOLBUS CANNOT BE AUTOMATED. Every page returns HTTP 403 to a scripted request, including
//      with a real browser User-Agent — it sits behind bot protection. Getting a scraper through
//      that means defeating a bot check, which is off the table. So the remote path here does NOT
//      pretend to automate it: for the few things we genuinely cannot do locally, we open the right
//      ToolBus page in his real browser and reveal the file, so he finishes it in two clicks.
//
// The result is local-first by architecture rather than by preference. `capabilities()` reports
// honestly what this machine can and cannot do, so the agent never promises an operation it lacks.
//
// Pure + DI (exec/spawn injected). See scripts/test-filetools.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PY = process.env.BHATBOT_PYTHON || 'python3';

// What each op needs, and where it runs.
const OPS = {
  // ---- image (sips: built into macOS, no install) ----
  image_convert: { kind: 'image', needs: 'sips', desc: 'convert between png/jpeg/tiff/heic/gif/bmp' },
  image_resize: { kind: 'image', needs: 'sips', desc: 'resize to a max dimension' },
  image_compress: { kind: 'image', needs: 'sips', desc: 'reduce JPEG quality / file size' },
  image_rotate: { kind: 'image', needs: 'sips', desc: 'rotate by 90/180/270' },
  image_info: { kind: 'image', needs: 'sips', desc: 'dimensions, format, colour profile' },
  // ---- pdf (pypdf) ----
  pdf_merge: { kind: 'pdf', needs: 'pypdf', desc: 'merge several PDFs into one' },
  pdf_split: { kind: 'pdf', needs: 'pypdf', desc: 'split into single-page files' },
  pdf_extract: { kind: 'pdf', needs: 'pypdf', desc: 'extract a page range' },
  pdf_rotate: { kind: 'pdf', needs: 'pypdf', desc: 'rotate pages' },
  pdf_text: { kind: 'pdf', needs: 'pypdf', desc: 'extract embedded text (not OCR)' },
  pdf_info: { kind: 'pdf', needs: 'pypdf', desc: 'page count, metadata, encryption' },
  pdf_to_images: { kind: 'pdf', needs: 'sips', desc: 'render pages to PNG' },
  // Needs PIL *with JPEG support*, not merely importable PIL. This machine's Pillow has no libjpeg,
  // so `Image.save(...pdf)` raises KeyError:'JPEG' at runtime — a capability probe that only checked
  // `import PIL` would cheerfully promise an operation that always fails.
  images_to_pdf: { kind: 'pdf', needs: 'PILpdf', desc: 'combine images into one PDF' },
  // ---- media (ffmpeg) ----
  media_convert: { kind: 'media', needs: 'ffmpeg', desc: 'convert audio/video containers + codecs' },
  media_info: { kind: 'media', needs: 'ffmpeg', desc: 'duration, streams, codecs' },
  audio_extract: { kind: 'media', needs: 'ffmpeg', desc: 'pull the audio track out of a video' },
  // ---- things this machine cannot do locally (see capabilities()) ----
  remove_background: { kind: 'image', needs: 'rembg', desc: 'cut the subject out of a photo', remote: 'image' },
  ocr: { kind: 'pdf', needs: 'tesseract', desc: 'read text out of a scan or photo', remote: 'converter' },
  vectorize: { kind: 'image', needs: 'potrace', desc: 'raster → SVG', remote: 'image' },
};

// ToolBus landing pages for the ops we cannot run locally. Opened in the real browser — never scraped.
const TOOLBUS = {
  image: 'https://www.thetoolbus.ai/free-tools/image',
  converter: 'https://www.thetoolbus.ai/free-tools/converter',
  pdf: 'https://www.thetoolbus.ai/free-tools/pdf',
};

function run(cmd, args, { timeout = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err && err.message || '') });
    });
  });
}
const has = async (cmd) => (await run('which', [cmd], { timeout: 5000 })).ok;
async function hasPy(mod) {
  const r = await run(PY, ['-c', `import ${mod}`], { timeout: 15000 });
  return r.ok;
}

let _caps = null;
async function capabilities({ refresh = false } = {}) {
  if (_caps && !refresh) return _caps;
  const [sips, ffmpeg, tesseract, potrace, magick] = await Promise.all(
    ['sips', 'ffmpeg', 'tesseract', 'potrace', 'magick'].map(has));
  const [pypdf, PIL, rembg] = await Promise.all(['pypdf', 'PIL', 'rembg'].map(hasPy));
  // Probe the ACTUAL operation, not the import: Pillow builds without libjpeg import fine and then
  // fail on PDF save. Capability probes have to test the thing they promise.
  const PILpdf = PIL && (await run(PY, ['-c',
    'import tempfile,os;from PIL import Image;p=os.path.join(tempfile.gettempdir(),"_bhcap.pdf");Image.new("RGB",(4,4)).save(p);os.remove(p)'],
    { timeout: 20000 })).ok;
  _caps = { sips, ffmpeg, tesseract, potrace, magick, pypdf, PIL, PILpdf, rembg };
  return _caps;
}

async function opAvailable(op) {
  const spec = OPS[op];
  if (!spec) return { ok: false, error: 'unknown operation: ' + op };
  const caps = await capabilities();
  if (caps[spec.needs]) return { ok: true };
  return {
    ok: false, missing: spec.needs, remote: spec.remote || null,
    error: `${op} needs ${spec.needs}, which is not installed on this machine.`,
  };
}

function outPath(input, suffix, ext) {
  const d = path.dirname(input), b = path.basename(input, path.extname(input));
  return path.join(d, `${b}${suffix}${ext || path.extname(input)}`);
}
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// ── the operations ───────────────────────────────────────────────────────────────────────────────
async function execute(op, input = {}) {
  const avail = await opAvailable(op);
  if (!avail.ok) {
    return {
      success: false, error: avail.error, missing: avail.missing,
      // Honest next steps rather than a dead end.
      suggestion: avail.missing === 'rembg' ? 'Install locally with: pip install rembg  (keeps the image on this machine)'
        : avail.missing === 'tesseract' ? 'Install locally with: brew install tesseract'
        : avail.missing === 'potrace' ? 'Install locally with: brew install potrace'
        : undefined,
      toolbusUrl: avail.remote ? TOOLBUS[avail.remote] : undefined,
    };
  }
  const src = input.path ? path.resolve(String(input.path)) : null;
  if (src && !exists(src) && !['pdf_merge', 'images_to_pdf'].includes(op)) {
    return { success: false, error: 'file not found: ' + src };
  }

  switch (op) {
    case 'image_info': {
      const r = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', '-g', 'space', src]);
      const g = (k) => (new RegExp(k + ':\\s*(\\S+)').exec(r.stdout) || [])[1];
      return { success: r.ok, width: +g('pixelWidth') || null, height: +g('pixelHeight') || null, format: g('format'), space: g('space'), bytes: (fs.statSync(src) || {}).size };
    }
    case 'image_convert': {
      const fmt = String(input.format || 'png').toLowerCase().replace('jpg', 'jpeg');
      const out = input.out || outPath(src, '', '.' + (fmt === 'jpeg' ? 'jpg' : fmt));
      const r = await run('sips', ['-s', 'format', fmt, src, '--out', out]);
      return r.ok && exists(out) ? { success: true, out, format: fmt } : { success: false, error: r.stderr.trim() || 'convert failed' };
    }
    case 'image_resize': {
      const max = Number(input.maxDimension) || 1024;
      const out = input.out || outPath(src, `-${max}`);
      const r = await run('sips', ['-Z', String(max), src, '--out', out]);
      return r.ok && exists(out) ? { success: true, out, maxDimension: max } : { success: false, error: r.stderr.trim() || 'resize failed' };
    }
    case 'image_rotate': {
      const deg = [90, 180, 270].includes(Number(input.degrees)) ? Number(input.degrees) : 90;
      const out = input.out || outPath(src, `-rot${deg}`);
      const r = await run('sips', ['-r', String(deg), src, '--out', out]);
      return r.ok && exists(out) ? { success: true, out, degrees: deg } : { success: false, error: r.stderr.trim() || 'rotate failed' };
    }
    case 'image_compress': {
      // sips expresses JPEG quality as a named level, not a number.
      const q = Number(input.quality);
      const level = q >= 85 ? 'best' : q >= 65 ? 'high' : q >= 45 ? 'normal' : 'low';
      const out = input.out || outPath(src, '-compressed', '.jpg');
      const r = await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', level, src, '--out', out]);
      if (!r.ok || !exists(out)) return { success: false, error: r.stderr.trim() || 'compress failed' };
      const before = fs.statSync(src).size, after = fs.statSync(out).size;
      return { success: true, out, level, before, after, saved: `${Math.max(0, Math.round((1 - after / before) * 100))}%` };
    }
    case 'pdf_info': case 'pdf_text': case 'pdf_merge': case 'pdf_split': case 'pdf_extract':
    case 'pdf_rotate': case 'images_to_pdf':
      return pdfOp(op, input, src);
    case 'pdf_to_images': {
      const out = input.out || path.join(path.dirname(src), path.basename(src, '.pdf') + '-pages');
      fs.mkdirSync(out, { recursive: true });
      const r = await run('sips', ['-s', 'format', 'png', src, '--out', out]);
      const made = (() => { try { return fs.readdirSync(out); } catch { return []; } })();
      return r.ok || made.length ? { success: true, out, files: made.slice(0, 50), count: made.length } : { success: false, error: r.stderr.trim() || 'render failed' };
    }
    case 'media_info': {
      const r = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', src], { timeout: 60000 });
      if (!r.ok) return { success: false, error: r.stderr.trim() || 'ffprobe failed' };
      try {
        const j = JSON.parse(r.stdout);
        return { success: true, duration: +(j.format || {}).duration || null, bitrate: +(j.format || {}).bit_rate || null,
          streams: (j.streams || []).map((s) => ({ type: s.codec_type, codec: s.codec_name, w: s.width, h: s.height })) };
      } catch { return { success: false, error: 'could not parse ffprobe output' }; }
    }
    case 'media_convert': {
      const fmt = String(input.format || 'mp4').toLowerCase();
      const out = input.out || outPath(src, '', '.' + fmt);
      const r = await run('ffmpeg', ['-y', '-i', src, out], { timeout: 600000 });
      return exists(out) ? { success: true, out, format: fmt } : { success: false, error: (r.stderr || '').split('\n').slice(-4).join(' ').trim() || 'convert failed' };
    }
    case 'audio_extract': {
      const fmt = String(input.format || 'mp3').toLowerCase();
      const out = input.out || outPath(src, '-audio', '.' + fmt);
      const r = await run('ffmpeg', ['-y', '-i', src, '-vn', out], { timeout: 600000 });
      return exists(out) ? { success: true, out, format: fmt } : { success: false, error: (r.stderr || '').split('\n').slice(-4).join(' ').trim() || 'extract failed' };
    }
    case 'remove_background': {
      const out = input.out || outPath(src, '-nobg', '.png');
      const r = await run(PY, ['-c',
        'import sys;from rembg import remove;open(sys.argv[2],"wb").write(remove(open(sys.argv[1],"rb").read()))',
        src, out], { timeout: 300000 });
      return exists(out) ? { success: true, out } : { success: false, error: r.stderr.trim().split('\n').slice(-2).join(' ') || 'rembg failed' };
    }
    case 'ocr': {
      const out = input.out || outPath(src, '-ocr', '.txt');
      const r = await run('tesseract', [src, out.replace(/\.txt$/, '')], { timeout: 300000 });
      return exists(out) ? { success: true, out, text: fs.readFileSync(out, 'utf8').slice(0, 4000) } : { success: false, error: r.stderr.trim() || 'ocr failed' };
    }
    case 'vectorize': {
      const out = input.out || outPath(src, '', '.svg');
      const pbm = outPath(src, '-tmp', '.pbm');
      await run('sips', ['-s', 'format', 'bmp', src, '--out', pbm]);
      const r = await run('potrace', ['-s', pbm, '-o', out], { timeout: 120000 });
      try { fs.unlinkSync(pbm); } catch {}
      return exists(out) ? { success: true, out } : { success: false, error: r.stderr.trim() || 'vectorize failed' };
    }
    default:
      return { success: false, error: 'unknown operation: ' + op };
  }
}

// pypdf work runs as one inline Python program per op — keeps PDF logic in the library that owns it
// instead of reimplementing page trees in JS.
async function pdfOp(op, input, src) {
  const py = {
    pdf_info: `
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
md = {k[1:] if k.startswith('/') else k: str(v) for k, v in (r.metadata or {}).items()}
print(json.dumps({"pages": len(r.pages), "encrypted": r.is_encrypted, "metadata": md}))`,
    pdf_text: `
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
t = "\\n".join((p.extract_text() or "") for p in r.pages)
print(json.dumps({"pages": len(r.pages), "chars": len(t), "text": t[:12000]}))`,
    pdf_merge: `
import sys, json
from pypdf import PdfWriter
out = sys.argv[1]; w = PdfWriter()
for f in sys.argv[2:]: w.append(f)
w.write(out); w.close()
print(json.dumps({"out": out, "merged": len(sys.argv) - 2}))`,
    pdf_split: `
import sys, json, os
from pypdf import PdfReader, PdfWriter
src, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
r = PdfReader(src); made = []
base = os.path.splitext(os.path.basename(src))[0]
for i, pg in enumerate(r.pages, 1):
    w = PdfWriter(); w.add_page(pg)
    p = os.path.join(outdir, f"{base}-p{i}.pdf")
    w.write(p); w.close(); made.append(os.path.basename(p))
print(json.dumps({"out": outdir, "count": len(made), "files": made[:50]}))`,
    pdf_extract: `
import sys, json
from pypdf import PdfReader, PdfWriter
src, out, a, b = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
r = PdfReader(src); w = PdfWriter()
for i in range(max(1, a) - 1, min(b, len(r.pages))): w.add_page(r.pages[i])
w.write(out); w.close()
print(json.dumps({"out": out, "pages": f"{a}-{b}"}))`,
    pdf_rotate: `
import sys, json
from pypdf import PdfReader, PdfWriter
src, out, deg = sys.argv[1], sys.argv[2], int(sys.argv[3])
r = PdfReader(src); w = PdfWriter()
for p in r.pages: p.rotate(deg); w.add_page(p)
w.write(out); w.close()
print(json.dumps({"out": out, "degrees": deg}))`,
    images_to_pdf: `
import sys, json
from PIL import Image
out = sys.argv[1]; srcs = sys.argv[2:]
ims = [Image.open(s).convert("RGB") for s in srcs]
ims[0].save(out, save_all=True, append_images=ims[1:])
print(json.dumps({"out": out, "images": len(srcs)}))`,
  }[op];
  if (!py) return { success: false, error: 'unsupported pdf op: ' + op };

  let args;
  if (op === 'pdf_merge') {
    const files = (input.paths || []).map((p) => path.resolve(p));
    if (files.length < 2) return { success: false, error: 'pdf_merge needs at least 2 paths' };
    const missing = files.filter((f) => !exists(f));
    if (missing.length) return { success: false, error: 'not found: ' + missing.join(', ') };
    args = [input.out || path.join(path.dirname(files[0]), 'merged.pdf'), ...files];
  } else if (op === 'images_to_pdf') {
    const files = (input.paths || []).map((p) => path.resolve(p));
    if (!files.length) return { success: false, error: 'images_to_pdf needs paths[]' };
    args = [input.out || path.join(path.dirname(files[0]), 'images.pdf'), ...files];
  } else if (op === 'pdf_split') {
    args = [src, input.out || path.join(path.dirname(src), path.basename(src, '.pdf') + '-pages')];
  } else if (op === 'pdf_extract') {
    args = [src, input.out || outPath(src, `-p${input.from || 1}-${input.to || 1}`), String(input.from || 1), String(input.to || input.from || 1)];
  } else if (op === 'pdf_rotate') {
    args = [src, input.out || outPath(src, '-rot'), String(input.degrees || 90)];
  } else {
    args = [src];
  }

  const r = await run(PY, ['-c', py, ...args], { timeout: 300000 });
  if (!r.ok) return { success: false, error: (r.stderr || '').trim().split('\n').slice(-2).join(' ') || 'pdf op failed' };
  try { return { success: true, ...JSON.parse(r.stdout.trim()) }; }
  catch { return { success: true, raw: r.stdout.trim().slice(0, 2000) }; }
}

// For an op this machine can't do: which ToolBus page would help, and why we aren't automating it.
function toolbusFallback(op) {
  const spec = OPS[op];
  if (!spec || !spec.remote) return null;
  return {
    url: TOOLBUS[spec.remote],
    note: 'thetoolbus.ai is behind bot protection (every page returns 403 to an automated request), so BhatBot opens it in your browser rather than driving it. Drop the file in and the tool runs client-side.',
  };
}

module.exports = { execute, capabilities, opAvailable, toolbusFallback, OPS, TOOLBUS, outPath };
