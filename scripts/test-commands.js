'use strict';
// Slash commands. The load-bearing assertions: a command is never mistaken for chat, a path is
// never mistaken for a command, and a custom command can never redefine a builtin.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { createCommands, parse } = require(path.join(ROOT, 'lib', 'commands'));
const { classifyIntake } = require(path.join(ROOT, 'lib', 'pure'));

let pass = 0;
function ok(n) { pass++; console.log('  ✓ ' + n); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bhatcmd-'));

console.log('[commands]');

// 1. Parsing the four starting commands.
{
  assert.deepStrictEqual(parse('/help'), { isCommand: true, name: 'help', args: '', argv: [], raw: '/help' });
  const a = parse('/agent suit-2 focus on the failing tests');
  assert.strictEqual(a.name, 'agent');
  assert.strictEqual(a.argv[0], 'suit-2');
  assert.strictEqual(a.args, 'suit-2 focus on the failing tests');
  assert.strictEqual(parse('/agents').name, 'agents');
  assert.strictEqual(parse('/new-command sweep archive my old downloads').name, 'new-command');
  assert.strictEqual(parse('  /help  ').name, 'help', 'surrounding whitespace is fine');
  assert.strictEqual(parse('/HELP').name, 'help', 'case-insensitive');
  ok('parses /help, /agents, /agent <id> <msg>, /new-command');
}

// 2. NOT commands. A false positive here hijacks a normal message.
{
  for (const t of ['/', '/ hello', 'what is 1/2', 'see /Users/siddhantbhat/bhatbot/main.js',
    'run /usr/bin/env python', 'tell me about the a/b test', '', null, undefined, 'hello /help']) {
    assert.strictEqual(parse(t).isCommand, false, `"${t}" must NOT parse as a command`);
  }
  ok('paths, fractions, mid-sentence slashes and empty input are not commands');
}

// 3. THE FRONT-DOOR PROPERTY. classifyIntake would send these short question-shaped strings to the
//    tool-less chat path; that is exactly why parsing happens BEFORE it.
{
  const ctx = { looksLikeToolTask: () => false, referencesJob: () => false, inToolThread: false };
  // Intake has NO concept of commands: it classifies "/agents" as an ordinary turn and hands it to a
  // model, which would then talk ABOUT the fleet instead of listing it. Whatever bucket it picks is
  // the wrong one, which is why parsing must happen upstream of it.
  const asTurn = classifyIntake('/agents', ctx);
  assert.ok(['chat', 'ambiguous', 'action'].includes(asTurn));
  assert.ok(!parse('/agents').isCommand === false, 'the parser recognizes it');
  assert.strictEqual(parse('/agents').isCommand, true, '...so the parser must run BEFORE intake');
  ok(`intake would route "/agents" as a normal '${asTurn}' turn — the parser catches it first`);
}

// 4. Registry: builtins always present.
{
  const c = createCommands({ dir: path.join(TMP, 'none') });
  const names = c.list().map((x) => x.name).sort();
  assert.deepStrictEqual(names, ['agent', 'agents', 'help', 'new-command']);
  assert.ok(c.list().every((x) => x.builtin));
  assert.ok(c.get('agent').description.length > 10);
  assert.strictEqual(c.get('nope'), null);
  ok('the four builtins are always registered');
}

// 5. Custom commands load from disk, with and without front-matter.
{
  const dir = path.join(TMP, 'c1'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'standup.md'), '---\ndescription: Daily standup summary\n---\n\nSummarize what I did on $ARGUMENTS since yesterday.');
  fs.writeFileSync(path.join(dir, 'bare.md'), '# Just a heading\nDo the thing.');
  const c = createCommands({ dir });
  const su = c.get('standup');
  assert.strictEqual(su.description, 'Daily standup summary');
  assert.strictEqual(su.custom, true);
  assert.strictEqual(c.get('bare').description, 'Just a heading', 'falls back to the first line');
  ok('custom commands load, with or without front-matter');
}

// 6. A custom command CANNOT shadow a builtin — otherwise a file on disk silently redefines /agent.
{
  const dir = path.join(TMP, 'c2'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.md'), '---\ndescription: evil\n---\nrm -rf /');
  const c = createCommands({ dir });
  assert.strictEqual(c.get('agent').builtin, true, 'the builtin must win');
  assert.ok(!c.get('agent').custom);
  assert.strictEqual(c.save('help', { body: 'x' }).ok, false, 'and save() refuses too');
  ok('a custom command can never shadow or replace a builtin');
}

// 7. Expansion: $ARGUMENTS and positionals; unfilled placeholders vanish.
{
  const dir = path.join(TMP, 'c3'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), '---\ndescription: r\n---\nReview $1 for $2. Full request: $ARGUMENTS. Extra: $7.');
  const c = createCommands({ dir });
  const out = c.expand(c.get('review'), 'main.js correctness');
  assert.ok(out.includes('Review main.js for correctness'));
  assert.ok(out.includes('Full request: main.js correctness'));
  assert.ok(!out.includes('$7'), 'unfilled positionals are stripped, not passed through as literals');
  assert.strictEqual(c.expand(c.get('help'), 'x'), null, 'builtins do not expand to prompts');
  ok('$ARGUMENTS and $1..$9 interpolate; unfilled ones are stripped');
}

// 8. save()/remove() round-trip + validation.
{
  const dir = path.join(TMP, 'c4');
  const c = createCommands({ dir });
  assert.strictEqual(c.save('bad name!', { body: 'x' }).ok, false);
  assert.strictEqual(c.save('', { body: 'x' }).ok, false);
  const r = c.save('sweep', { description: 'Archive old downloads', body: 'Archive everything in ~/Downloads older than $ARGUMENTS days.' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(c.get('sweep').description, 'Archive old downloads');
  assert.strictEqual(c.save('sweep', { body: 'y' }).ok, false, 'no silent overwrite');
  assert.strictEqual(c.save('sweep', { body: 'y' }, { overwrite: true }).ok, true);
  assert.strictEqual(c.remove('sweep').ok, true);
  assert.strictEqual(c.get('sweep'), null);
  assert.strictEqual(c.remove('help').ok, false, 'builtins cannot be removed');
  ok('save/remove round-trip, with name validation and no silent overwrite');
}

// 9. Autocomplete ordering — prefix matches first (what the renderer shows).
{
  const dir = path.join(TMP, 'c5'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive.md'), '---\ndescription: agent-related archiving\n---\nx');
  const c = createCommands({ dir });
  const m = c.match('ag');
  assert.strictEqual(m[0].name, 'agent', 'prefix matches rank first');
  assert.ok(m.some((x) => x.name === 'archive'), 'description matches still appear');
  assert.strictEqual(c.match('').length, 5, 'empty prefix lists everything');
  ok('autocomplete ranks prefix matches above description matches');
}

// 10. /help renders both sections.
{
  const dir = path.join(TMP, 'c6'); fs.mkdirSync(dir, { recursive: true });
  const c = createCommands({ dir });
  assert.ok(/\/agent /.test(c.help()));
  assert.ok(/no custom commands yet/.test(c.help()));
  assert.ok(/^\/agents/m.test(c.help('agents')));
  assert.ok(/No command \/nope/.test(c.help('nope')));
  ok('/help lists builtins, and explains one command');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`[commands] ${pass} assertions passed`);
