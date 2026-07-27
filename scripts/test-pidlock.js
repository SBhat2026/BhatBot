#!/usr/bin/env node
'use strict';
// Tests for lib/pidlock.js — the single-instance lock that stops the Electron app and the headless
// SYNAPSE worker from both running the cycle against one graph and one $1 spend ledger.
// The assertion that matters most: a STALE pidfile (owner SIGKILLed, or a power cut) must not lock
// the worker out forever. "Nothing ever runs again, silently" is precisely the failure this whole
// effort exists to fix — a naive pidfile would have reintroduced it. Wired into `npm run verify`.
//   node scripts/test-pidlock.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-pidlock-'));
process.env.HOME = TMP;
const lock = require('../lib/pidlock');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const NAME = 'test-worker';

ok(lock.alive(NAME) === false, 'alive: false when no pidfile exists');
ok(lock.read(NAME) === null, 'read: null when no pidfile exists');

const a = lock.acquire(NAME);
ok(a.ok === true, 'acquire: succeeds on a free lock');
ok(fs.existsSync(lock.pidfilePath(NAME)), 'acquire: writes the pidfile');
ok(lock.read(NAME).pid === process.pid, 'acquire: records our pid');
ok(typeof lock.read(NAME).startedAt === 'number', 'acquire: records a start time');
ok(lock.alive(NAME) === true, 'alive: true while we hold it');

const b = lock.acquire(NAME);
ok(b.ok === false && b.heldBy.pid === process.pid, 'acquire: a second acquire is refused and names the holder');

// THE IMPORTANT ONE. Point the file at a pid that cannot exist, as a SIGKILL or a power cut would
// leave it. A file-existence check would deadlock here forever; a liveness check reclaims it.
fs.writeFileSync(lock.pidfilePath(NAME), JSON.stringify({ pid: 999999, startedAt: Date.now() }));
ok(lock.alive(NAME) === false, 'alive: a STALE pidfile (dead owner) reads as not-alive');
const c = lock.acquire(NAME);
ok(c.ok === true && lock.read(NAME).pid === process.pid, 'acquire: reclaims a stale lock instead of deadlocking forever');

// A malformed file must not throw — it should behave exactly like no lock at all.
fs.writeFileSync(lock.pidfilePath(NAME), 'not json at all');
ok(lock.read(NAME) === null, 'read: a corrupt pidfile → null, no throw');
ok(lock.alive(NAME) === false, 'alive: a corrupt pidfile → not-alive');
ok(lock.acquire(NAME).ok === true, 'acquire: a corrupt pidfile is reclaimable');

// Release must be owner-only — never clobber a lock another live process holds.
fs.writeFileSync(lock.pidfilePath(NAME), JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() }));
ok(lock.release(NAME) === false, 'release: refuses to delete a pidfile we do not own');
ok(fs.existsSync(lock.pidfilePath(NAME)), 'release: the other holder\'s file survives');

fs.writeFileSync(lock.pidfilePath(NAME), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
ok(lock.release(NAME) === true, 'release: removes our own pidfile');
ok(!fs.existsSync(lock.pidfilePath(NAME)), 'release: the pidfile is gone');
ok(lock.release(NAME) === false, 'release: releasing twice is harmless');

// Distinct names are independent locks (app-side vs worker-side, or future workers).
lock.acquire('lock-a');
ok(lock.alive('lock-a') === true && lock.alive('lock-b') === false, 'locks: names are independent');
ok(lock.pidfilePath('lock-a') !== lock.pidfilePath('lock-b'), 'locks: distinct names → distinct files');
ok(lock.pidfilePath('x').startsWith(path.join(TMP, '.bhatbot')), 'pidfilePath: lives under ~/.bhatbot');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
