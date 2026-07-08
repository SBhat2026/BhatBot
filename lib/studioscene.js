'use strict';
// Deterministic Three.js SCENE ASSEMBLY for build_project's multi-part artifact. The SKELETON
// (renderer, camera, lights, orbit controls, spec-sheet, animation loop) is fixed here — it is NEVER
// model-generated, so the scene ALWAYS renders. The model only writes one geometry function per
// subsystem; `stitch()` drops those into the skeleton. Pure + requireable → unit-testable headless.

const SKELETON = `<!doctype html><html><head><meta charset="utf8"><title>__TITLE__</title>
<style>html,body{margin:0;height:100%;background:#0a0e14;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
#c{width:100%;height:100%;display:block}
#spec{position:fixed;top:14px;left:14px;max-width:320px;background:rgba(10,16,22,.82);border:1px solid #1d6e86;border-radius:12px;padding:14px 16px;color:#cfe8f2;font-size:13px;line-height:1.5;backdrop-filter:blur(8px)}
#spec h1{margin:0 0 8px;font-size:15px;color:#7fe3ff;letter-spacing:.02em}#spec .row{display:flex;justify-content:space-between;gap:14px;padding:2px 0;border-bottom:1px solid rgba(127,212,232,.1)}#spec .k{color:#8fb8c8}#spec .v{color:#eaf6fb;text-align:right}
#hint{position:fixed;bottom:12px;left:14px;color:#5b7187;font-size:11px}</style>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>
</head><body><canvas id="c"></canvas><div id="spec">__SPECSHEET__</div><div id="hint">drag to orbit · scroll to zoom</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const SPECS = __SPECSJSON__;
const renderer = new THREE.WebGLRenderer({canvas:document.getElementById('c'),antialias:true});
renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
const scene = new THREE.Scene();scene.background=new THREE.Color(0x0a0e14);
const camera = new THREE.PerspectiveCamera(50,innerWidth/innerHeight,0.1,2000);camera.position.set(3.2,2.2,5.2);
const controls = new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.target.set(0,1,0);
scene.add(new THREE.HemisphereLight(0xbfe3ff,0x223,0.9));
const key=new THREE.DirectionalLight(0xffffff,1.1);key.position.set(5,8,6);scene.add(key);
const rim=new THREE.DirectionalLight(0x7fd4e8,0.6);rim.position.set(-6,3,-4);scene.add(rim);
const grid=new THREE.GridHelper(20,20,0x1d6e86,0x122);grid.position.y=0;scene.add(grid);
const group = new THREE.Group();scene.add(group);
/*__PARTS__*/
/*__CALLS__*/
try{const box=new THREE.Box3().setFromObject(group);if(!box.isEmpty()){const c=box.getCenter(new THREE.Vector3());const s=box.getSize(new THREE.Vector3());controls.target.copy(c);const r=Math.max(s.x,s.y,s.z)||3;camera.position.set(c.x+r*1.1,c.y+r*0.8,c.z+r*1.6);}}catch(e){}
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
(function loop(){requestAnimationFrame(loop);group.rotation.y+=0.0016;controls.update();renderer.render(scene,camera);})();
</script></body></html>`;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function specSheetHtml(goal, spec, physics) {
  const rows = [];
  const s = spec && typeof spec === 'object' ? spec : {};
  for (const k of Object.keys(s).slice(0, 14)) rows.push(`<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(String(s[k]).slice(0, 40))}</span></div>`);
  if (physics && physics.summary) {
    for (const line of String(physics.summary).split('\n').slice(0, 8)) {
      const m = line.match(/^(.*?)[:=]\s*(.+)$/);
      if (m) rows.push(`<div class="row"><span class="k">${esc(m[1].trim().slice(0, 28))}</span><span class="v">${esc(m[2].trim().slice(0, 40))}</span></div>`);
    }
  }
  return `<h1>${esc(String(goal).slice(0, 50))}</h1>${rows.join('') || '<div class="row"><span class="k">spec</span><span class="v">—</span></div>'}`;
}

// Pull the notes most relevant to one lane out of the integrated build (keeps each part-gen focused).
function laneNotes(buildNotes, role) {
  const txt = String(buildNotes || '');
  const re = new RegExp('###[^\\n]*' + String(role).replace(/[-_]/g, '[\\s-_]*') + '[\\s\\S]*?(?=\\n###|$)', 'i');
  const m = txt.match(re);
  return (m ? m[0] : txt).slice(0, 2600);
}

// Stitch the model-written part functions into the skeleton → a complete, renderable HTML document.
function stitch(goal, spec, physics, parts) {
  const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
  const calls = list.map((_, i) => `try{part_${i}(THREE,scene,group,SPECS);}catch(e){console.warn('part ${i}',e);}`).join('\n');
  return SKELETON
    .replace('__TITLE__', esc(goal).slice(0, 60))
    .replace('__SPECSHEET__', specSheetHtml(goal, spec, physics))
    .replace('__SPECSJSON__', JSON.stringify(spec || {}))
    .replace('/*__PARTS__*/', list.join('\n\n'))
    .replace('/*__CALLS__*/', calls);
}

module.exports = { SKELETON, esc, specSheetHtml, laneNotes, stitch };
