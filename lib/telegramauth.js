'use strict';
// Telegram sender authorization. Pure, so the rule is testable without the bot.
//
// The bridge used to authorize whichever chat messaged first (trust-on-first-use): anyone who found a
// fresh bot's username before its owner did became the owner, with a shell behind it. Authorization is
// now explicit: config.telegramChatId must already be set (the owner's own numeric chat id), and only a
// private chat with exactly that id is served. Everyone else is ignored; an unconfigured bridge says so
// once in the log, with the id to put in config, and never replies to the stranger.
//
//   authorize(msg, cfg) → { ok:true } | { ok:false, reason:'unconfigured'|'foreign-chat'|'not-private', chatId }
function authorize(msg, cfg = {}) {
  const chat = (msg && msg.chat) || {};
  const chatId = chat.id == null ? '' : String(chat.id);
  if (!cfg.telegramChatId) return { ok: false, reason: 'unconfigured', chatId };
  if (chat.type && chat.type !== 'private') return { ok: false, reason: 'not-private', chatId };
  if (chatId !== String(cfg.telegramChatId)) return { ok: false, reason: 'foreign-chat', chatId };
  return { ok: true, chatId };
}
module.exports = { authorize };
