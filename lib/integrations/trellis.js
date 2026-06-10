'use strict';
// Trellis 3D integration (Phase 5). Text/image → 3D mesh via PiAPI's Trellis endpoint
// (~$0.04/gen → ~250 gens within the $10/mo budget). Submits a job, polls, downloads the
// mesh to the workspace's artifacts/. Wired as the Creative Agent's `trellis` adapter.
// Config: trellisApiKey (PiAPI key). See ARCHITECTURE.md §5.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://api.piapi.ai/api/v1';
function cfg() { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')); } catch { return {}; } }

// task: { goal, image_url?, artifactsDir }. Returns { success, artifacts:[meshPath] } | { error }.
async function generate(task) {
  const c = cfg();
  const key = c.trellisApiKey;
  if (!key) return { error: 'no trellisApiKey in ~/.bhatbot/config.json (get one at piapi.ai)' };
  const H = { 'x-api-key': key, 'Content-Type': 'application/json' };
  const input = task.image_url ? { image: task.image_url } : { prompt: task.goal };

  const sub = await fetch(`${BASE}/task`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'Qubico/trellis', task_type: task.image_url ? 'image-to-3d' : 'text-to-3d', input }) });
  if (!sub.ok) return { error: `trellis submit ${sub.status}: ${(await sub.text()).slice(0, 200)}` };
  const taskId = (await sub.json()).data?.task_id;
  if (!taskId) return { error: 'trellis: no task_id returned' };

  // Poll up to ~3 min
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pr = await fetch(`${BASE}/task/${taskId}`, { headers: H });
    if (!pr.ok) continue;
    const d = (await pr.json()).data || {};
    if (d.status === 'completed' || d.status === 'success') {
      const url = d.output?.model_file || d.output?.mesh || d.output?.glb || (d.output?.model_urls && Object.values(d.output.model_urls)[0]);
      if (!url) return { error: 'trellis completed but no mesh url', raw: d.output };
      const dir = task.artifactsDir || path.join(os.homedir(), '.bhatbot', 'generated');
      fs.mkdirSync(dir, { recursive: true });
      const ext = (url.split('?')[0].match(/\.(glb|obj|ply|fbx)$/i) || [, 'glb'])[1];
      const out = path.join(dir, `trellis-${taskId}.${ext}`);
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync(out, buf);
      return { success: true, artifacts: [out], facts: { mesh_export: true, format: ext, source: task.image_url ? 'image' : 'text' } };
    }
    if (d.status === 'failed' || d.error) return { error: 'trellis failed: ' + JSON.stringify(d.error || d.status) };
  }
  return { error: 'trellis timed out (job still running) task_id=' + taskId };
}

module.exports = { generate };
