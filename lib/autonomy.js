'use strict';
// ── AUTONOMY — what BhatBot may do without asking, and what it may never do ──────────────────────
//
// Siddhant's rule, 2026-11-12:
//   "Complete access to all apps and browsers in my computer, aside from financial and confidential
//    information … any standard deletions and sending can be made without asking unless they're
//    important or nonstandard actions. I want BhatBot to be able to learn 'standard' actions on the
//    go and add it to its brain. So it should be fully autonomous in general for most actions after
//    a couple weeks."
//
// Before this, the gate was a switch. `autonomousMode` (on by default) auto-approved every mutating
// tool, and nothing was ever refused by TARGET: the same code path that archived a newsletter would
// have typed into a bank's login form, because the question it asked was "is this tool dangerous",
// never "what is it pointed at". A switch can only be too tight or too loose. This is three answers:
//
//   FORBID   the target is financial or confidential. No approval changes this — there is no flag,
//            and asking would defeat the point, because the failure being prevented is BhatBot
//            being talked into it.
//   ASK      the action sends, deletes or commits something, and is either IMPORTANT (wide blast
//            radius, hard to undo, a high-care account) or simply not yet known to be routine.
//   ALLOW    everything else — including a send or a delete that he has approved before.
//
// "STANDARD" IS LEARNED, NOT LISTED. Every outward action reduces to a coarse SIGNATURE — what kind
// of act, through which tool, at what sort of target (`send:mail:princeton.edu`,
// `delete:calendar:personal:solo`). The first time a signature appears it is non-standard and he is
// asked. Each yes is remembered; after `standardAfter` yeses with no refusal it is standard and stops
// asking. A refusal is remembered harder than an approval, because being wrong about a "no" is the
// expensive direction. And once a whole CLASS of action has a track record — enough distinct
// signatures approved, over enough days, with no recent refusal — new signatures in that class are
// trusted too. That is the "couple of weeks" ramp: it is earned per class, by evidence, rather than
// granted by a date.
//
// IMPORTANT never becomes standard. Routine and important are different axes: he may delete calendar
// events every day and still want to be asked before one with forty attendees goes.
//
// Pure apart from the injected store: classification and decision take no clock and do no I/O, so
// every rule here is testable and every verdict explains itself in `reasons`.

// ── FORBIDDEN TARGETS ────────────────────────────────────────────────────────────────────────────
// Hosts. Named institutions first, then shapes — a bank BhatBot has never heard of still has "bank"
// in its hostname, and missing it because it was not on a list is the unsafe direction.
const FIN_HOSTS = /(^|\.)(chase|bankofamerica|bofa|wellsfargo|citi|citibank|capitalone|usbank|pnc|tdbank|truist|ally|discover|americanexpress|amex|synchrony|barclays|hsbc|santander|navyfederal|usaa|sofi|chime|schwab|fidelity|vanguard|etrade|robinhood|webull|tdameritrade|merrilledge|interactivebrokers|ibkr|wealthfront|betterment|coinbase|binance|kraken|gemini|crypto|metamask|paypal|venmo|zellepay|cash|wise|revolut|squareup|plaid|mint|intuit|turbotax|hrblock|creditkarma|experian|equifax|transunion|irs|studentaid|nelnet|navient|tigerpay)\.(com|gov|org|co|us|app|io|net)$/i;
// Shapes, for the institution nobody listed. Deliberately NOT "invest", "finance" or "treasury": those
// are news and coursework at least as often as they are accounts, and he asked for everything EXCEPT
// his financial information — a markets page is not that.
const FIN_HOST_SHAPE = /(^|[.-])(bank|banking|creditunion|brokerage|securities|wallet|payroll|mortgage|loans?)([.-]|$)/i;
// A label that ENDS in "bank" (firstbank.com, mybank.co) — minus the words that only sound like one.
const BANK_LABEL = /(^|\.)([a-z0-9-]*bank)\.(com|org|net|co|us)$/i;
const NOT_A_BANK = /^(food|data|blood|power|seed|sperm|world|piggy|river|west|left|right|south|north|east|burbank|sandbank|snowbank|fog|cloud|gene|test|job|talent|brain|image|photo|question|word|time|river)bank$|^(burbank|databank|foodbank)$/i;
// One financial console that lives on an otherwise ordinary developer domain.
const FIN_EXACT_HOSTS = /^(dashboard\.stripe\.com|pay\.google\.com|wallet\.google\.com|payments\.google\.com)$/i;
// Paths on ANY site: paying is a financial act wherever it happens.
const FIN_PATH = /\/(checkout|payment|payments|pay|billing|purchase|order\/confirm|cart\/checkout|subscribe\/pay|wallet|bank-?accounts?|cards?\/add|add-?card)(\/|\?|$)/i;
const FIN_APPS = /^(wallet|quicken|turbotax|robinhood|coinbase|venmo|paypal|cash app|chase|bank of america|wells fargo|schwab|fidelity|mint|ynab|copilot money|monarch money)$/i;
// Confidential by nature: where secrets and identity live.
const CONF_APPS = /^(keychain access|passwords|1password( \d)?|bitwarden|lastpass|dashlane|keepassxc|strongbox|enpass|authy|google authenticator|ticket viewer)$/i;
const CONF_PATHS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.kube|Keychains|\.password-store)(\/|$)|\.(kdbx|pem|p12|pfx|keychain(-db)?|asc)$|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$|(^|\/)(Login Data|Cookies|Web Data)$|\/Library\/(Keychains|Cookies)\//i;
// HIS RECORDS, not the subject. A folder called "ECO 362 Financial Investments" is coursework and a
// directory called `w2/` is week two; matching on the topic would lock a student out of his own
// notes. These are the shapes personal financial documents actually take.
const FIN_PATHS = /(^|\/)(taxes|tax[ _-]?returns?|bank[ _-]?statements?|finances|pay[ _-]?stubs?|brokerage[ _-]?statements?)(\/|$)|(^|\/)[^/]*(tax[ _-]?return|bank[ _-]?statement|pay[ _-]?stub|form[ _-]?(w-?2|1099|1040)|\b(w-?2|1099(-[a-z]+)?|1040)[ _-]?(20)?\d{2}\b)[^/]*\.(pdf|png|jpe?g|heic|csv|xlsx?)$/i;
const FIN_SECRET_NAMES = /\b(bank|chase|wells ?fargo|schwab|fidelity|vanguard|robinhood|coinbase|paypal|venmo|credit ?card|debit|routing|brokerage|irs|tax|ssn|social security)\b/i;

// ── WHAT COUNTS AS AN ACT ────────────────────────────────────────────────────────────────────────
// Words on a button that commit something. Deliberately the verbs, not the nouns.
const COMMIT_VERB = /\b(send|submit|post|publish|share|reply|forward|delete|remove|discard|trash|erase|unsubscribe|cancel (?:subscription|order|membership)|confirm|approve|accept|decline|rsvp|sign|book|reserve|schedule|invite)\b/i;
// Unambiguous only. "Subscribe" is a YouTube button, "withdraw" is what a student does to a course,
// "transfer" moves files — a word that is a payment one time in five would block the other four.
const PAY_VERB = /\b(buy(?: now| it now)?|purchase|pay(?: now| with [a-z ]+)?|place (?:your |the )?order|checkout|check out|complete (?:purchase|order)|add (?:a )?(?:card|payment method)|donate)\b/i;
const SEND_SCRIPT = /\b(send|reply|forward)\b/i;
const DELETE_SCRIPT = /\b(delete|remove|move .* to (?:the )?trash|empty trash|erase)\b/i;
const SCRATCH = /(^|\/)(tmp|private\/tmp|var\/folders|node_modules|dist|build|out|target|\.cache|\.next|__pycache__|\.pytest_cache|DerivedData|\.Trash)(\/|$)|\/\.bhatbot\/(tmp|bench|cache)\//;
const MESSAGING_APPS = /^(mail|messages|imessage|slack|discord|whatsapp|telegram|signal|microsoft teams|outlook|spark|superhuman)$/i;

const DEFAULTS = {
  standardAfter: 2,            // yeses before a signature stops asking
  denyHoldDays: 30,            // a refusal keeps a signature asking for this long
  classTrustSignatures: 5,     // distinct standard signatures before a whole class is trusted…
  classTrustDays: 14,          // …and how long the class must have been in use ("a couple of weeks")
  manyRecipients: 5,
  manyItems: 20,
};

const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase(); } catch { return ''; } };
const pathOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).pathname; } catch { return ''; } };
const baseDomain = (h) => String(h || '').split('.').slice(-2).join('.');
const norm = (s) => String(s || '').trim();

/** Everything a tool call is pointed AT, gathered from wherever each tool keeps it. */
function targets(tool, input = {}, ctx = {}) {
  const urls = [], apps = [], paths = [], names = [];
  const push = (arr, v) => { if (v && typeof v === 'string') arr.push(v); };
  push(urls, input.url); push(urls, input.host);
  // A click or a keystroke has no URL of its own: it lands on whatever page is in front. Without the
  // page's address, "click #submit" on a bank is indistinguishable from "click #submit" anywhere.
  if (/^(browser|vision_click|browser_devtools|smart_login)$/.test(tool)) push(urls, ctx.pageUrl);
  push(apps, input.app);
  for (const m of String(input.script || '').matchAll(/tell\s+application\s+"([^"]+)"/gi)) apps.push(m[1]);
  for (const m of String(input.script || '').matchAll(/https?:\/\/[^\s"')]+/gi)) urls.push(m[0]);
  push(paths, input.path); push(paths, input.out); push(paths, input.cwd);
  if (Array.isArray(input.paths)) for (const p of input.paths) push(paths, p);
  if (tool === 'run_shell') {
    for (const m of String(input.command || '').matchAll(/(?:~|\/)[^\s"';|&<>]+/g)) paths.push(m[0]);
    // And QUOTED arguments, whole. The pattern above stops at the first space, so
    // `sqlite3 "/…/Chrome/Default/Login Data"` yielded a path ending in "Login" and the saved-password
    // database walked straight past the check that exists for it.
    for (const m of String(input.command || '').matchAll(/"([^"]+)"|'([^']+)'/g)) { const q = m[1] || m[2]; if (/[\/~]/.test(q)) paths.push(q); }
    for (const m of String(input.command || '').matchAll(/https?:\/\/[^\s"')]+/gi)) urls.push(m[0]);
  }
  push(names, input.service); push(names, input.item); push(names, input.account);
  return { urls, apps, paths, names };
}

/**
 * forbidden(tool, input, ctx) → { blocked, why } — financial or confidential targets.
 * `ctx.confidential` is his own list: { hosts:[], apps:[], paths:[], words:[] }.
 */
function forbidden(tool, input = {}, ctx = {}) {
  const t = targets(tool, input, ctx);
  const mine = ctx.confidential || {};
  const lc = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).toLowerCase()).filter(Boolean);
  const myHosts = lc(mine.hosts), myApps = lc(mine.apps), myPaths = lc(mine.paths), myWords = lc(mine.words);

  for (const u of t.urls) {
    const h = hostOf(u), p = pathOf(u);
    if (!h) continue;
    if (FIN_HOSTS.test(h) || FIN_HOSTS.test(baseDomain(h))) return { blocked: true, kind: 'financial', why: `${baseDomain(h)} is a financial site` };
    if (FIN_EXACT_HOSTS.test(h)) return { blocked: true, kind: 'financial', why: `${h} is a payments console` };
    if (FIN_HOST_SHAPE.test(h)) return { blocked: true, kind: 'financial', why: `${h} looks like a financial site` };
    const bl = BANK_LABEL.exec(h);
    if (bl && !NOT_A_BANK.test(bl[2])) return { blocked: true, kind: 'financial', why: `${h} looks like a bank` };
    if (FIN_PATH.test(p)) return { blocked: true, kind: 'financial', why: `${h}${p} is a payment or billing page` };
    if (myHosts.some((x) => h === x || h.endsWith('.' + x))) return { blocked: true, kind: 'confidential', why: `${h} is on your confidential list` };
  }
  for (const a of t.apps) {
    const n = norm(a).replace(/\.app$/i, '');
    if (FIN_APPS.test(n)) return { blocked: true, kind: 'financial', why: `${n} is a financial app` };
    if (CONF_APPS.test(n)) return { blocked: true, kind: 'confidential', why: `${n} holds passwords or keys` };
    if (myApps.includes(n.toLowerCase())) return { blocked: true, kind: 'confidential', why: `${n} is on your confidential list` };
  }
  for (const p of t.paths) {
    if (CONF_PATHS.test(p)) return { blocked: true, kind: 'confidential', why: `${p} is where keys and credentials live` };
    if (FIN_PATHS.test(p)) return { blocked: true, kind: 'financial', why: `${p} looks like financial records` };
    const pl = p.toLowerCase();
    if (myPaths.some((x) => pl.includes(x))) return { blocked: true, kind: 'confidential', why: `${p} is on your confidential list` };
  }
  // A stored secret FOR a financial service is financial even though the tool is only a lookup.
  if (/^(keychain_lookup|onepassword_lookup|smart_login|manage_logins)$/.test(tool)) {
    for (const n of t.names) if (FIN_SECRET_NAMES.test(n)) return { blocked: true, kind: 'financial', why: `"${n}" is a financial credential` };
  }
  // Paying, anywhere. A buy button on an ordinary shop is still a purchase. Judged on what is being
  // CLICKED — never on text being typed, which is content: "where to buy a monitor" in a search box
  // is a question, and blocking it would make the browser useless for shopping research he asked for.
  const clickish = (tool === 'browser' && norm(input.action) === 'click') || tool === 'vision_click';
  if (clickish) {
    const on = [tool === 'browser' ? input.text : '', input.selector, input.target].map(norm).join(' ');
    if (PAY_VERB.test(on)) return { blocked: true, kind: 'financial', why: 'that is a purchase or a payment' };
  }
  if (myWords.length) {
    const blob = JSON.stringify(input).toLowerCase();
    const hit = myWords.find((w) => blob.includes(w));
    if (hit) return { blocked: true, kind: 'confidential', why: `it mentions "${hit}", which is on your confidential list` };
  }
  return { blocked: false };
}

/**
 * classify(tool, input, ctx) → null for something that is not an outward act, else
 *   { cls: 'send'|'delete'|'commit', signature, important, reasons, label }
 * The signature is COARSE on purpose: fine enough that "email to my advisor" and "email to a
 * stranger" differ, coarse enough that the hundredth newsletter deletion is the same act as the first.
 */
function classify(tool, input = {}, ctx = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const reasons = [];
  const action = norm(input.action).toLowerCase();
  let cls = null, key = '', label = '';

  if (tool === 'calendar' && /^(create|update|delete)$/.test(action)) {
    const n = Array.isArray(input.attendees) ? input.attendees.length : 0;
    cls = action === 'delete' ? 'delete' : (n ? 'send' : null);   // an event with guests sends invitations
    if (!cls) return null;                                        // a private event on his own calendar is just a note
    key = `calendar:${norm(input.account) || 'primary'}:${n ? 'guests' : 'solo'}`;
    label = `${action} a calendar event${n ? ` (${n} guest${n === 1 ? '' : 's'})` : ''}`;
    if (n >= o.manyRecipients) reasons.push(`it involves ${n} other people`);
  } else if (tool === 'system_control' && action === 'applescript') {
    const script = String(input.script || '');
    const app = ((/tell\s+application\s+"([^"]+)"/i.exec(script) || [])[1] || norm(input.app) || 'an app');
    if (MESSAGING_APPS.test(app) && SEND_SCRIPT.test(script)) { cls = 'send'; label = `send through ${app}`; }
    else if (DELETE_SCRIPT.test(script)) { cls = 'delete'; label = `delete in ${app}`; }
    else return null;
    const to = [...script.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)].map((m) => m[1].toLowerCase());
    key = `${app.toLowerCase()}:${to.length ? [...new Set(to.map(baseDomain))].sort().slice(0, 2).join('+') : 'any'}`;
    if (to.length >= o.manyRecipients) reasons.push(`it goes to ${to.length} people`);
    if (/\bempty trash\b/i.test(script)) reasons.push('emptying the trash cannot be undone');
  } else if ((tool === 'browser' && action === 'click') || tool === 'vision_click') {
    // Clicks only. Typing is content — "send me the file" typed into a chat box has not sent
    // anything; the click (or the Return it cannot see) is what commits. A send made by pressing
    // Return is therefore invisible here, which is a real limit and is stated rather than papered over.
    const said = [tool === 'browser' ? input.text : '', input.selector, input.target].map(norm).join(' ');
    const m = COMMIT_VERB.exec(said);
    if (!m) return null;
    const verb = m[1].toLowerCase().split(' ')[0];
    cls = /delete|remove|discard|trash|erase|unsubscribe|cancel/.test(verb) ? 'delete' : /send|reply|forward|post|publish|share|invite/.test(verb) ? 'send' : 'commit';
    const h = baseDomain(hostOf(ctx.pageUrl || input.url || '')) || 'page';
    key = `web:${h}:${verb}`;
    label = `${verb} on ${h}`;
  } else if (tool === 'run_shell') {
    const c = String(input.command || '');
    if (!/(^|[\s;&|(])(rm|rmdir|trash|unlink|shred)\s/.test(c)) return null;
    const p = (c.match(/(?:~|\/)[^\s"';|&<>]+/) || [''])[0];
    // Scratch space is not somebody's data. Build output, caches and temp files are deleted as a
    // matter of course, and asking about `rm -rf node_modules` would train him to click yes.
    // Checked per argument, because a relative `node_modules` has no slash for a path pattern to find.
    const args = c.split(/\s+/).filter((a) => a && !a.startsWith('-') && !/^(rm|rmdir|trash|unlink|shred|sudo)$/.test(a));
    if (args.length && args.every((a) => SCRATCH.test(a.replace(/^["']|["']$/g, '')))) return null;
    cls = 'delete';
    const home = String(ctx.home || '');
    const rel = (home && p.startsWith(home + '/')) ? p.slice(home.length + 1) : p.replace(/^~\//, '').replace(/^\//, '');
    const seg = rel.split('/').filter(Boolean);
    const ext = (/\.([a-z0-9]{1,6})$/i.exec(seg[seg.length - 1] || '') || [])[1];
    // By folder, and one level deeper when there is one: deleting in ~/Downloads and deleting in
    // ~/Documents/thesis are different habits, and "somewhere under home" would make them one.
    key = `files:${seg.length <= 2 ? `${seg[0] || 'cwd'}/*${ext ? '.' + ext.toLowerCase() : ''}` : `${seg[0]}/${seg[1]}`}`;
    label = `delete files under ${p || 'the working directory'}`;
    if (/\s-[a-zA-Z]*[rR]/.test(c)) reasons.push('it deletes a whole directory tree');
    if (/\*/.test(c) && !/\*\.(tmp|log|bak|dmg|zip|pyc|o)\b/.test(c)) reasons.push('it deletes by wildcard');
  } else if (tool === 'manage_logins' && action === 'delete') {
    cls = 'delete'; key = 'logins'; label = `forget the saved login for ${norm(input.host) || 'a site'}`;
    reasons.push('a saved login cannot be recovered once forgotten');
  } else if (tool === 'drive' && action === 'create') {
    return null;                                                  // creating his own file shares nothing
  } else {
    return null;
  }

  // A high-care account is important whatever the act: that is what marking it meant.
  const acct = norm(input.account).toLowerCase();
  if (acct && (ctx.highCare || []).some((a) => String(a).toLowerCase() === acct || acct.includes(String(a).toLowerCase()))) reasons.push(`${acct} is marked high-care`);
  const count = Number(input.count || (Array.isArray(input.ids) ? input.ids.length : 0)) || 0;
  if (count >= o.manyItems) reasons.push(`it affects ${count} items at once`);

  return { cls, signature: `${cls}:${key}`, important: reasons.length > 0, reasons, label };
}

// ── THE BRAIN'S MEMORY OF WHAT IS ROUTINE ────────────────────────────────────────────────────────
/**
 * createAutonomy({ load, save, now, opts }) → { decide, learn, summary, classify, forbidden }
 * `load()`/`save(state)` persist one JSON object. State: { since, sigs: { [signature]: { cls, yes, no, firstAt, lastAt, lastNoAt, label } } }.
 */
function createAutonomy(deps = {}) {
  const o = { ...DEFAULTS, ...(deps.opts || {}) };
  const now = deps.now || (() => Date.now());
  const DAY = 86400000;
  let state = null;
  const read = () => {
    if (state) return state;
    let s = null; try { s = deps.load ? deps.load() : null; } catch { s = null; }
    state = (s && typeof s === 'object' && s.sigs) ? s : { since: now(), sigs: {} };
    return state;
  };
  const write = () => { try { if (deps.save) deps.save(state); } catch {} };

  const isStandard = (r) => !!r && r.yes >= o.standardAfter && !(r.lastNoAt && now() - r.lastNoAt < o.denyHoldDays * DAY);
  function classTrusted(cls) {
    const s = read();
    const rows = Object.values(s.sigs).filter((r) => r.cls === cls);
    if (rows.filter(isStandard).length < o.classTrustSignatures) return false;
    const first = Math.min(...rows.map((r) => r.firstAt || now()));
    if (now() - first < o.classTrustDays * DAY) return false;
    // One recent refusal anywhere in the class means the pattern is not as settled as it looked.
    return !rows.some((r) => r.lastNoAt && now() - r.lastNoAt < o.classTrustDays * DAY);
  }

  /** decide(tool, input, ctx) → { verdict:'allow'|'ask'|'forbid', reasons, signature?, label?, why } */
  function decide(tool, input, ctx = {}) {
    const f = forbidden(tool, input, ctx);
    if (f.blocked) return { verdict: 'forbid', kind: f.kind, why: f.why, reasons: [f.why] };
    const c = classify(tool, input, ctx, o);
    if (!c) return { verdict: 'allow', reasons: [], why: 'not an outward action' };
    if (c.important) return { verdict: 'ask', signature: c.signature, label: c.label, cls: c.cls, important: true, reasons: c.reasons, why: `important: ${c.reasons[0]}` };
    const r = read().sigs[c.signature];
    if (r && r.lastNoAt && now() - r.lastNoAt < o.denyHoldDays * DAY) {
      return { verdict: 'ask', signature: c.signature, label: c.label, cls: c.cls, reasons: ['you said no to this recently'], why: 'you said no to this recently' };
    }
    if (isStandard(r)) return { verdict: 'allow', signature: c.signature, label: c.label, cls: c.cls, reasons: [`standard — you have approved this ${r.yes} times`], why: 'standard' };
    if (classTrusted(c.cls)) return { verdict: 'allow', signature: c.signature, label: c.label, cls: c.cls, reasons: [`a new kind of ${c.cls}, but you have a settled track record with ${c.cls}s`], why: 'class trusted' };
    const seen = r ? r.yes : 0;
    return { verdict: 'ask', signature: c.signature, label: c.label, cls: c.cls,
      reasons: [seen ? `not routine yet — approved ${seen} of ${o.standardAfter} times` : 'I have not done this before'],
      why: seen ? 'not routine yet' : 'first time' };
  }

  /** learn(decision, approved) — remember the answer. Important acts are recorded but never promoted. */
  function learn(d, approved) {
    if (!d || !d.signature) return;
    const s = read();
    const r = s.sigs[d.signature] || (s.sigs[d.signature] = { cls: d.cls, yes: 0, no: 0, firstAt: now(), label: d.label || '' });
    r.lastAt = now();
    if (approved) { if (!d.important) r.yes++; }
    else { r.no++; r.lastNoAt = now(); r.yes = 0; }             // a no undoes the streak: it has to be re-earned
    write();
  }

  /** What it has learned, for the brain view and the weekly digest. */
  function summary() {
    const s = read();
    const rows = Object.entries(s.sigs).map(([signature, r]) => ({ signature, ...r, standard: isStandard(r) }));
    const classes = [...new Set(rows.map((r) => r.cls))];
    return {
      since: s.since, days: Math.floor((now() - s.since) / DAY),
      standard: rows.filter((r) => r.standard).map((r) => ({ signature: r.signature, label: r.label, approved: r.yes })),
      learning: rows.filter((r) => !r.standard && r.yes > 0).map((r) => ({ signature: r.signature, label: r.label, approved: r.yes, of: o.standardAfter })),
      refused: rows.filter((r) => r.no > 0).map((r) => ({ signature: r.signature, label: r.label, refused: r.no })),
      trustedClasses: classes.filter(classTrusted),
    };
  }

  return { decide, learn, summary, classify: (t, i, c) => classify(t, i, c, o), forbidden };
}

module.exports = { createAutonomy, forbidden, classify, targets, DEFAULTS, FIN_HOSTS, FIN_PATH, PAY_VERB, COMMIT_VERB };
