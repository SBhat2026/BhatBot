#!/usr/bin/env node
'use strict';
// Tests lib/attach.js — the pure file-type routing that drives mediaFileToBlocks (drag-drop / attach).
// Guards that images/video/pdf/text/other each take the right ingestion path (vision / frames /
// document block / inlined content / tool-pointer). Pure — runs in node, in verify.
const { classifyExt, IMG_EXT, TEXT_EXT } = require('../lib/attach');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

ok(classifyExt('.png') === 'image' && classifyExt('.JPG') === 'image' && classifyExt('.heic') === 'image', 'image: png/JPG(caps)/heic → image');
ok(classifyExt('.mov') === 'video' && classifyExt('.mp4') === 'video', 'video: mov/mp4 → video');
ok(classifyExt('.pdf') === 'pdf' && classifyExt('.PDF') === 'pdf', 'pdf: pdf/PDF → pdf (native document block)');
ok(classifyExt('.csv') === 'text' && classifyExt('.tsv') === 'text', 'text: csv/tsv → text (inlined)');
ok(classifyExt('.py') === 'text' && classifyExt('.json') === 'text' && classifyExt('.md') === 'text', 'text: code/json/md → text');
ok(classifyExt('.yaml') === 'text' && classifyExt('.sql') === 'text' && classifyExt('.log') === 'text', 'text: config/sql/log → text');
ok(classifyExt('.xlsx') === 'file' && classifyExt('.docx') === 'file' && classifyExt('.zip') === 'file', 'file: office/zip → file (tool pointer)');
ok(classifyExt('') === 'file' && classifyExt(null) === 'file' && classifyExt('.unknown') === 'file', 'file: empty/null/unknown → file (safe default)');
ok(classifyExt('png') === 'file', 'classify: needs the leading dot (path.extname form) — bare "png" is not matched');

// sanity: the ext lists are non-trivial and disjoint on the key types
ok(IMG_EXT.includes('.webp') && !TEXT_EXT.includes('.png'), 'lists: webp is image, png is not text (no overlap on images)');
ok(TEXT_EXT.includes('.csv') && !IMG_EXT.includes('.csv'), 'lists: csv is text, not image');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
