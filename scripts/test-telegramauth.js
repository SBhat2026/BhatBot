#!/usr/bin/env node
'use strict';
// Unit tests for lib/telegramauth.js: no trust-on-first-use, owner chat only.
//   node scripts/test-telegramauth.js
const { authorize } = require('../lib/telegramauth');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

const msg = (id, type = 'private') => ({ chat: { id, type } });
ok(authorize(msg(111), {}).reason === 'unconfigured', 'no telegramChatId → refuse (no first-sender authorization)');
ok(authorize(msg(111), { telegramChatId: '' }).ok === false, 'empty telegramChatId → refuse');
ok(authorize(msg(111), { telegramChatId: '111' }).ok === true, 'owner chat id (number vs string) → ok');
ok(authorize(msg(222), { telegramChatId: '111' }).reason === 'foreign-chat', 'other chat → ignored');
ok(authorize(msg(111, 'group'), { telegramChatId: '111' }).reason === 'not-private', 'group chat with matching id → ignored');
ok(authorize({}, { telegramChatId: '111' }).ok === false, 'malformed message → refuse');
ok(authorize(msg(222), {}).chatId === '222', 'reports the sender id so the owner can configure it');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
