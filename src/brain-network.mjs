import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/jsm/controls/OrbitControls.js';

// Stable, bounded 3D positions independent of the 2D force simulation.
export function layoutNodes(nodes) {
  const kinds = [...new Set(nodes.map(n => n.type || 'memory'))].sort();
  const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  return nodes.map(n => {
    const k = kinds.indexOf(n.type || 'memory'), a = k / Math.max(1, kinds.length) * Math.PI * 2;
    const h = hash(n.id), u = (h % 10007) / 10007, v = (hash(n.id + ':v') % 10009) / 10009;
    const phi = Math.acos(2 * u - 1), theta = v * Math.PI * 2, radius = 24 + Math.cbrt((hash(n.id + ':r') % 1009) / 1009) * 92;
    return { ...n, position: [Math.cos(a) * 170 + radius * Math.sin(phi) * Math.cos(theta), (k % 2 ? 28 : -28) + radius * Math.cos(phi), Math.sin(a) * 170 + radius * Math.sin(phi) * Math.sin(theta)] };
  });
}

export function createNetwork(host, { colors, onHover, onSelect, isVisible }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); host.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1, 1, 5000);
  camera.position.set(390, 270, 740);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false;
  controls.minDistance = 80; controls.maxDistance = 1800;
  const group = new THREE.Group(); scene.add(group);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x526579, 2));
  const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(200, 300, 400); scene.add(key);
  let data = [], edges = [], nodesMesh, linkMesh, selectedMesh, labels = [], selected = null, hovered = -1, frame = 0, lastFrame = 0, pressure = false, dirty = true;
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.dispose?.(); o.geometry?.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { m?.map?.dispose(); m?.dispose(); } }
    for (const el of labels) el.remove(); labels = [];
  }
  function update(graph) {
    clear(); data = layoutNodes(graph.nodes || []); edges = graph.edges || []; selected = null;
    const lookup = new Map(data.map(n => [n.id, n]));
    const geometry = new THREE.SphereGeometry(1, 12, 8);
    const material = new THREE.MeshStandardMaterial({ roughness: .35, metalness: .12 });
    nodesMesh = new THREE.InstancedMesh(geometry, material, data.length);
    const matrix = new THREE.Matrix4(), color = new THREE.Color();
    const degree = new Map(); for (const e of edges) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
    data.forEach((n, i) => { const r = 2.4 + Math.min(5, Math.log2(1 + (degree.get(n.id) || 0))); matrix.makeScale(r, r, r); matrix.setPosition(...n.position); nodesMesh.setMatrixAt(i, matrix); color.set(colors[n.type] || '#8a94a6'); nodesMesh.setColorAt(i, color); });
    group.add(nodesMesh);
    const verts = [];
    for (const e of edges) { const a = lookup.get(e.from), b = lookup.get(e.to); if (a && b) verts.push(...a.position, ...b.position); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    linkMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x548a9a, transparent: true, opacity: .16, depthWrite: false })); group.add(linkMesh);
    selectedMesh = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x27c6c1, transparent: true, opacity: .9, depthWrite: false })); group.add(selectedMesh);
    // One quiet label per cluster; individual memories are named on hover or selection.
    const kinds = [...new Set(data.map(n => n.type))];
    kinds.forEach(kind => { const ns = data.filter(n => n.type === kind); const c = new THREE.Vector3(); ns.forEach(n => c.add(new THREE.Vector3(...n.position))); c.divideScalar(ns.length); c.y += 120;
      const el = document.createElement('span'); el.className = 'brain-cluster'; el.textContent = `${kind || 'memory'} · ${ns.length}`; el.style.borderColor = colors[kind] || '#8a94a6'; host.appendChild(el); el._position = c; labels.push(el); });
    dirty = true; draw();
  }
  function select(index) {
    selected = data[index] || null; const lookup = new Map(data.map(n => [n.id, n])), verts = [];
    if (selected) for (const e of edges) if (e.from === selected.id || e.to === selected.id) { const a = lookup.get(e.from), b = lookup.get(e.to); if (a && b) verts.push(...a.position, ...b.position); }
    selectedMesh.geometry.dispose(); selectedMesh.geometry = new THREE.BufferGeometry(); selectedMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    dirty = true; draw();
  }
  function pick(e) { if (!nodesMesh) return -1; const r = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX-r.left)/r.width*2-1, -(e.clientY-r.top)/r.height*2+1); ray.setFromCamera(pointer, camera); return ray.intersectObject(nodesMesh)[0]?.instanceId ?? -1; }
  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX,e.clientY]; });
  renderer.domElement.addEventListener('pointermove', e => { if (e.buttons) return; const i = pick(e); if (i !== hovered) { hovered = i; renderer.domElement.style.cursor = i < 0 ? 'grab' : 'pointer'; } onHover(data[i] || null, e.clientX, e.clientY); });
  renderer.domElement.addEventListener('pointerleave', () => onHover(null));
  renderer.domElement.addEventListener('pointerup', e => { if (down && Math.hypot(e.clientX-down[0],e.clientY-down[1])<5) { const i=pick(e); select(i); if (i>=0) onSelect(data[i]); } down=null; });
  function draw() {
    if (!isVisible() || document.hidden || !host.clientWidth || !host.clientHeight) return;
    renderer.render(scene,camera);
    labels.forEach(el => { const p=el._position.clone().project(camera); el.style.display=Math.abs(p.x)>1||Math.abs(p.y)>1||p.z>1?'none':''; el.style.left=((p.x+1)/2*host.clientWidth)+'px'; el.style.top=((-p.y+1)/2*host.clientHeight)+'px'; }); dirty=false;
  }
  controls.addEventListener('change', () => { dirty=true; draw(); });
  const resize = new ResizeObserver(() => { const w=host.clientWidth,h=host.clientHeight; if (!w||!h) return; renderer.setSize(w,h); camera.aspect=w/h; camera.updateProjectionMatrix(); dirty=true; draw(); }); resize.observe(host);
  function loop(t) { frame=requestAnimationFrame(loop); if (!isVisible()||document.hidden||pressure) return; if (dirty && t-lastFrame>33) { lastFrame=t; draw(); } } frame=requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => { dirty=true; draw(); });
  return { update, refresh: () => { dirty=true; draw(); }, setPressure: value => { pressure=value; renderer.setPixelRatio(value?1:Math.min(devicePixelRatio,1.5)); dirty=true; draw(); }, reset: () => { camera.position.set(390,270,740); controls.target.set(0,0,0); controls.update(); select(-1); }, dispose: () => { cancelAnimationFrame(frame); resize.disconnect(); controls.dispose(); clear(); renderer.dispose(); } };
}
