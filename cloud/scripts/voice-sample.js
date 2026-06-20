'use strict';
// Render BEFORE vs AFTER voice samples so the humanization is audible side by side.
//   BEFORE = the prior settings (stability 0.45 / similarity 0.85 / style 0.50), plain script.
//   AFTER  = the J.A.R.V.I.S. guide humanization (stability 0.40 / similarity 0.90 / style 0.20,
//            speaker boost on) + a cadence-steered script (ellipses/commas → natural pauses).
// Saves both to ~/.bhatbot/voice-samples/ for A/B listening. Run: `node scripts/voice-sample.js`.
const fs = require('fs');
const path = require('path');

// Load cloud/.env (same vars the server uses) without a dotenv dependency.
try {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^\s*([\w.]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const KEY = process.env.ELEVENLABS_API_KEY || '';
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'EzDG2x1uAnCqbzN9Q0wA';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
const OUT = path.join(process.env.HOME, '.bhatbot', 'voice-samples');

const SCRIPT_BEFORE = 'Good evening. I am BhatBot, your personal assistant. All systems are online and functioning within normal parameters. How may I help you today?';
// Guide §4: ellipses for thoughtful pauses, commas for breath, light dry wit — steers human cadence.
const SCRIPT_AFTER = 'Good evening, sir... I am BhatBot, your personal assistant. I’ve run the diagnostics, and — well — every system is online, functioning within normal parameters. How may I be of service today?';

async function render(name, settings, text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: settings }),
  });
  if (!r.ok) { console.error(`✗ ${name} failed: ${r.status} ${(await r.text()).slice(0, 200)}`); return false; }
  const buf = Buffer.from(await r.arrayBuffer());
  const f = path.join(OUT, name);
  fs.writeFileSync(f, buf);
  console.log(`✓ ${name}  (${buf.length} bytes)  → ${f}`);
  return true;
}

(async () => {
  if (!KEY) { console.error('✗ no ELEVENLABS_API_KEY (set it in cloud/.env)'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`voice=${VOICE} model=${MODEL}`);
  await render('before.mp3', { stability: 0.45, similarity_boost: 0.85, style: 0.5, use_speaker_boost: true }, SCRIPT_BEFORE);
  await render('after.mp3', { stability: 0.40, similarity_boost: 0.90, style: 0.20, use_speaker_boost: true }, SCRIPT_AFTER);
  console.log(`done → ${OUT}`);
})();
