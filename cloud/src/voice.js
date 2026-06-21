'use strict';
// Voice I/O — both fully cloud-capable (just API calls): ElevenLabs TTS (Jarvis) + OpenAI
// Whisper STT. Lifted from the original server.js so it stays the same voice as the desktop.
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EzDG2x1uAnCqbzN9Q0wA';
// turbo_v2_5 is materially warmer/less synthetic than flash while staying low-latency enough for
// a live call (flash trades quality for the last ~100ms). Override with ELEVENLABS_MODEL.
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
const TTS_SPEED = Math.max(0.7, Math.min(1.2, parseFloat(process.env.TTS_SPEED) || 1.0));
// Voice character (all env-tunable so cadence/warmth can be dialed in without a redeploy).
// Defaults follow the J.A.R.V.I.S. humanization guide §3 — the target for a Bettany-style clone:
//  • stability 0.40  (35–45%): lowered so the AI adds emotional variance + natural intonation
//                    instead of a monotone, robotic read. Most impactful knob.
//  • similarity 0.90 (85–95%): high → stays true to the voice's signature (drop to ~0.80 if clinical).
//  • style 0.20      (15–25%): a subtle amount of "character" without a caricature.
//  • speaker boost on: keeps the richness/depth in the lower frequencies.
const EL_STABILITY = clamp01(process.env.EL_STABILITY, 0.40);
const EL_SIMILARITY = clamp01(process.env.EL_SIMILARITY, 0.90);
const EL_STYLE = clamp01(process.env.EL_STYLE, 0.20);
const EL_SPEAKER_BOOST = process.env.EL_SPEAKER_BOOST !== '0';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
function clamp01(v, d) { const n = parseFloat(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : d; }

// Strip leaked chain-of-thought / meta-narration before display OR speech (mirrors lib/pure.js).
function stripReasoning(text) {
  let s = String(text || '');
  s = s.replace(/<thinking\b[\s\S]*?<\/thinking>/gi, ' ').replace(/<think\b[\s\S]*?<\/think>/gi, ' ');
  s = s.replace(/<\/?(?:thinking|think|reasoning|scratchpad)\b[^>]*>/gi, ' ');
  s = s.replace(/<thinking\b[\s\S]*$/i, ' ').replace(/<think\b[\s\S]*$/i, ' ');
  s = s.replace(/^\s*(?:the user (?:is|wants|seems|said|just)|i (?:should|need to|will|am going to|notice|see that)|let me (?:think|reason|consider))\b[^\n.!?]*[.!?]?\s*/i, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

function normalizeForSpeech(input) {
  let s = stripReasoning(String(input || ''));
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*([-*•]|\d+\.)\s+/gm, '');
  s = s.replace(/(^|\s)((?:~|\.\.?)?\/(?:[\w.@%+-]+\/)+[\w.@%+-]*)/g, (_m, pre, p) => pre + (p.replace(/\/+$/, '').split('/').pop() || ''));
  s = s.replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,').replace(/\betc\.?/gi, 'etcetera').replace(/\bvs\.?/gi, 'versus');
  s = s.replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g, (_m, d, c) => { d = d.replace(/,/g, ''); return d + (d === '1' ? ' dollar' : ' dollars') + (c ? ' and ' + c + ' cents' : ''); });
  s = s.replace(/([A-Za-z0-9])\.(?=[A-Za-z])/g, '$1 dot ');   // domains/emails: gmail.com→"gmail dot com"; decimals (digit.digit) stay
  s = s.replace(/&/g, ' and ').replace(/%/g, ' percent').replace(/(\S)@(\S)/g, '$1 at $2').replace(/\s@\s/g, ' at ')
       .replace(/#(\d+)/g, 'number $1').replace(/#/g, ' hash ').replace(/\s\+\s/g, ' plus ')
       .replace(/([A-Za-z])\/([A-Za-z])/g, '$1 slash $2').replace(/°/g, ' degrees').replace(/\$(?=[A-Za-z])/g, '').replace(/[~^|<>*$]/g, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  return s || String(input || '').trim();
}

const DISCOURSE_LEAD = /^(right|so|well|now|look|listen|honestly|actually|alright|okay|ok|hmm|ah|oh|sure|of course|indeed|very well|certainly)\b[,]?\s+/i;
function humanizeCadence(input) {
  let s = String(input || '');
  if (!s || !/flash|turbo/i.test(EL_MODEL)) return s;
  s = s.replace(DISCOURSE_LEAD, (m) => m.replace(/[,\s]+$/, '') + '<break time="0.25s"/> ');
  s = s.replace(/\s*\.\.\.+\s*/g, ' <break time="0.45s"/> ');
  s = s.replace(/\s*[—–]\s*/g, ' <break time="0.25s"/> ').replace(/\s+-\s+/g, ' <break time="0.25s"/> ');
  let n = (s.match(/<break/g) || []).length; const MAX = 6;
  s = s.replace(/([.!?])\s+(?=[A-Z0-9])/g, (m, p) => (n++ < MAX ? p + ' <break time="0.3s"/> ' : m));
  let count = 0; s = s.replace(/<break[^>]*>/g, (t) => (++count > MAX ? '' : t));
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

async function tts(text, opts = {}) {
  const t = humanizeCadence(normalizeForSpeech(text));
  if (!t) return { error: 'empty' };
  if (!EL_KEY) return { error: 'no ELEVENLABS_API_KEY' };
  const speed = opts.speed != null ? Math.max(0.7, Math.min(1.2, Number(opts.speed))) : TTS_SPEED;
  // Strict ElevenLabs-only: ignore any client voice that isn't a real EL voice id (20-char
  // alnum). Phones/old installs send local Kokoro names like "bm_george" → those 404'd on EL
  // and produced silence. Anything not an EL id falls back to the canonical Jarvis voice.
  const voice = /^[A-Za-z0-9]{20}$/.test(opts.voice || '') ? opts.voice : EL_VOICE;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128&optimize_streaming_latency=2`, {
    method: 'POST', headers: { 'xi-api-key': EL_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: t, model_id: EL_MODEL, voice_settings: { stability: EL_STABILITY, similarity_boost: EL_SIMILARITY, style: EL_STYLE, use_speaker_boost: EL_SPEAKER_BOOST, speed } })
  });
  if (!r.ok) return { error: 'elevenlabs ' + r.status + ': ' + (await r.text()).slice(0, 160) };
  const buf = Buffer.from(await r.arrayBuffer());
  return { audio: buf.toString('base64'), mimeType: 'audio/mpeg', via: 'elevenlabs' };
}

async function stt(buf, mime) {
  if (!OPENAI_KEY) return { error: 'no OPENAI_API_KEY' };
  const ext = /wav/.test(mime) ? 'wav' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.' + ext);
  fd.append('model', 'gpt-4o-mini-transcribe');
  // Vocabulary biasing so uncommon names/emails aren't misheard (e.g. "Siddhant"→"Citadel").
  // Seed via STT_VOCAB env (comma-separated names/emails); brand words always included.
  const vocab = ['BhatBot', 'Jarvis', ...String(process.env.STT_VOCAB || '').split(',')].map((x) => x.trim()).filter(Boolean);
  if (vocab.length) fd.append('prompt', 'Expected names/identifiers (keep emails lowercase): ' + vocab.join(', ') + '.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + OPENAI_KEY }, body: fd });
  if (!r.ok) return { error: 'whisper ' + r.status + ': ' + (await r.text()).slice(0, 160) };
  const j = await r.json();
  return { text: (j.text || '').trim() };
}

module.exports = { tts, stt, normalizeForSpeech, humanizeCadence };
