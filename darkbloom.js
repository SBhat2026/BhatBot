'use strict';

// Darkbloom client — OpenAI-compatible. Real catalog models: gpt-oss-20b, gemma-4-26b.
// Cloud only on 16GB Macs (local serving needs ≥24GB). Consumer calls need wallet balance.
const DEFAULT_BASE = 'https://api.darkbloom.dev/v1';
const TIMEOUT_MS = 20000;

async function chat(messages, model, apiKey, systemPrompt, baseUrl) {
  const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  const res = await fetch(`${baseUrl || DEFAULT_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 4096, stream: false, messages: msgs }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Darkbloom ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { chat, DEFAULT_BASE, TIMEOUT_MS };
