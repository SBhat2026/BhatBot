'use strict';
// conversationContinuity — terse follow-ups resolve against the previous subject; fresh topics don't.
const assert = require('assert');
const { conversationContinuity } = require('../lib/pure');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const H = (...turns) => turns.map(([role, content]) => ({ role, content }));

// Terse referential follow-up after a subject → directive names the subject.
let d = conversationContinuity(H(
  ['user', 'Tell me about the Uricase Challenge'],
  ['assistant', 'The Uricase Challenge is a de novo enzyme design target.'],
  ['user', 'what about the other one?']
));
ok(/CONTINUITY:/.test(d), 'referential follow-up → continuity directive');
ok(/Uricase/.test(d), 'directive names the prior subject');

// Pronoun-only short follow-up → directive.
d = conversationContinuity(H(
  ['user', 'Show me the FABLE deploy status'],
  ['assistant', 'FABLE is live on the Cloudflare Worker.'],
  ['user', 'is it working?']
));
ok(/CONTINUITY:/.test(d) && /FABLE/.test(d), 'pronoun-only follow-up resolves to FABLE');

// "do that" imperative follow-up → directive.
d = conversationContinuity(H(
  ['user', 'Can you render the Iron Man scene?'],
  ['assistant', 'I can render the Iron Man scene in Studio.'],
  ['user', 'do that']
));
ok(/CONTINUITY:/.test(d), '"do that" → continuity directive');

// Fresh, self-contained topic → NO directive.
d = conversationContinuity(H(
  ['user', 'What is the Uricase Challenge?'],
  ['assistant', 'A de novo enzyme design target.'],
  ['user', 'Open Spotify and play some jazz for me please']
));
ok(d === '', 'fresh self-contained request → no directive');

// Too little history → empty.
ok(conversationContinuity(H(['user', 'hey'])) === '', 'single turn → empty');
ok(conversationContinuity([]) === '', 'no history → empty');

// Handles array-block content (Anthropic message shape).
d = conversationContinuity([
  { role: 'user', content: [{ type: 'text', text: 'Explain the SYNAPSE second brain' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'SYNAPSE is the hybrid knowledge graph.' }] },
  { role: 'user', content: [{ type: 'text', text: 'why?' }] }
]);
ok(/CONTINUITY:/.test(d) && /SYNAPSE/.test(d), 'array-block content resolves subject');

console.log(`✅ conversation: ${n} assertions passed`);
