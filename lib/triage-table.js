'use strict';
// ── TRIAGE TABLES — the data half of lib/triage.js ────────────────────────────────────────────────
// Kept separate from the engine so the tables can be edited (a new colleague, a new newsletter)
// without touching classification logic, and so the engine's tests can inject fixtures instead of
// depending on this file's real contents.
//
// ═══ THE DEFINITION OF "IMPORTANT" ═══════════════════════════════════════════════════════════════
// Six principles. They are ordered, and the order is the whole design:
//
// 1. NOTHING IS NOISE BECAUSE IT CAME FROM A BUSINESS.
//    The intuitive rule — "a real person, no company in the address, signs off with a name" —
//    describes the primary account well and is actively WRONG for everything that matters most.
//    The three genuinely urgent mails sitting unactioned in the inbox (Manus data deletion by Aug 23,
//    Google Cloud trial ended, Claude API disabled for credits) are all `no-reply@` business senders.
//    So the person-test PROMOTES and never demotes. A business address is not evidence of anything.
//
// 2. SECURITY, MONEY, AND DEADLINES OUTRANK PEOPLE.
//    R1 runs before the VIP table. A 2FA code or an account-deletion notice matters more than a
//    friendly note, and it matters on a clock. These are surfaced immediately and NEVER auto-touched.
//
// 3. RECIPROCITY IS THE STRONGEST AVAILABLE SIGNAL.
//    "I have replied in this thread" and "I have ever emailed this address" are behavioural facts,
//    not guesses. They beat every keyword heuristic, and they are self-maintaining: the sent-history
//    index refreshes nightly, so anyone newly corresponded with is automatically promoted.
//
// 4. GMAIL'S `IMPORTANT` LABEL IS NEVER AN INPUT.
//    It covers 74% of the primary inbox (4,466 messages) and flags Strava badges and Chase card
//    marketing. A signal with no discriminating power is worse than no signal — it launders noise
//    into importance. We still WRITE Gmail labels so the UI stays coherent; we never read that one.
//
// 5. ARCHIVING REQUIRES POSITIVE EVIDENCE, NOT ABSENCE OF INTEREST.
//    A message is archived only if it BOTH carries List-Unsubscribe (machine-checkable proof of bulk
//    mail) AND matches a known noise sender. Unmatched mail is left alone. The default action is
//    always "do nothing" — the cost of wrongly archiving a real message is far higher than the cost
//    of leaving a newsletter in the inbox one more day.
//
// 6. IRREVERSIBLE ACTIONS ARE NOT AVAILABLE.
//    Never delete, never send, never mark spam. The OAuth scope is `gmail.modify`, which structurally
//    excludes sending — that is deliberate and must stay. Archive and mark-read are both reversible,
//    and every one is logged with its prior labels so it can be undone exactly.
//
// Sibling-address discipline: several senders run transactional and marketing mail from DIFFERENT
// addresses on the SAME domain. `service@paypal.com` is R1; `noreply@news.paypal.com` is noise.
// Therefore senders are matched by EXACT ADDRESS, never by domain, anywhere it could demote.

// ── R1: security / money / deadline. Exact addresses only. ───────────────────────────────────────
const SECURITY_SENDERS = new Set([
  'no-reply@accounts.google.com', 'noreply-accounts@google.com', 'accounts-noreply@google.com',
  'no.reply.alerts@chase.com',                 // transactional Chase — NOT chase@mcmap.chase.com
  'service@paypal.com',                        // transactional PayPal — NOT noreply@news.paypal.com
  'no-reply@accounts.apple.com', 'appleid@id.apple.com',
  'security@mail.instagram.com', 'security@facebookmail.com',
  'support@github.com',
]);

// Subject patterns that make a message urgent regardless of who sent it. These are the deadline and
// account-loss cases — the ones with an actual clock on them.
const URGENT_SUBJECT = /\b(action required|action needed|urgent|immediate action|final notice|expir(?:es|ing|ed)\s+(?:today|tomorrow|soon|in \d+)|account will be (?:deleted|closed|suspended)|will be permanently deleted|access is turned off|payment (?:failed|declined)|card (?:declined|expired)|suspended|unusual sign.?in|new sign.?in|verify your (?:identity|account)|security alert|password (?:reset|changed)|2fa|two.factor|verification code|out of credits|credits? (?:have )?run out|trial (?:has )?ended|data will be)\b/i;

// GitHub sends both security mail and a firehose of notifications — split by subject, not address.
const GITHUB_SECURITY = /\b(oauth|ssh key|deploy key|new sign.?in|security|vulnerab|dependabot alert|token)\b/i;

// ── R2/R3: PEOPLE. Derived from real sent-mail analysis, tiered by how they decay. ───────────────
const PEOPLE = {
  // Family — always important, never decays.
  family: [
    'pramodviswanath2@gmail.com', 'viswanath.pramod@gmail.com',
    'pramodv@illinois.edu', 'pramodv@princeton.edu',          // father — Prof. Pramod Viswanath
    'sumapbhat2@gmail.com', 'sumabhat@princeton.edu',          // mother — Prof. Suma Bhat
  ],
  // Active research collaborators. The Eigen/Adaptyv thread is live and frequent (Jul 30, 31,
  // Aug 3, Aug 8) — treat as top-tier current work.
  research: [
    'akaz@princeton.edu',                                      // Alkin Kaz — bioRxiv co-author
    'sanjay.sane@gmail.com', 'sane@ncbs.res.in',               // Prof. Sanjay Sane — NCBS
    'phil.burgess@eigenlabs.org', 'soubhik@eigenlabs.org',
    'matt.curtis@eigenlabs.org', 'gautham@eigenlabs.org',
    'gijs@adaptyvbio.com', 'tudor@adaptyvbio.com',
  ],
  mentorsFamilyFriends: [
    'chekuri@gmail.com',                                       // "Chandra Uncle" — Prof. Chandra Chekuri
    'rahultchekuri@gmail.com', 'romit.rc@gmail.com', 'croy@illinois.edu',
  ],
  school: [
    'thomasfillippone@princetonk12.org', 'idaniarodriguez@princetonk12.org',
    'jamessmirk@princetonk12.org', 'young@countrysideschool.org',
    'rutherbr@u4sd.org', 'feddersen@countrysideschool.org',
  ],
  peers: [
    'fwedmid@princetonk12.org', 'finn.wedmid@gmail.com',
    'ribhavvallishayee@gmail.com', 'ziyang.ling@gmail.com',
    'amithvarambally@gmail.com', 'eleanornayden@gmail.com',
  ],
  // DECAYING TIER. He matriculated to Princeton Class of 2030, so admissions contacts are ending
  // their relevance while @princeton.edu traffic grows. Still important, but the engine applies
  // ADMISSIONS_DECAY_DAYS of no-contact before it stops promoting them.
  admissions: [
    'uaoffice@princeton.edu', 'eokelly@princeton.edu', 'admissiondean@princeton.edu',
    'shirleywang99@gmail.com', 'map@psatellite.com',
  ],
};
const ADMISSIONS_DECAY_DAYS = 90;

// Institutional domains where a personally-addressed message is important. A .edu carrying
// List-Unsubscribe is a mass newsletter (mitdaily@mit.edu) and drops to routine — handled in the
// engine, because the exception is what makes this rule safe.
const INSTITUTION_DOMAINS = new Set([
  'princeton.edu', 'princetonk12.org', 'u4sd.org', 'countrysideschool.org',
  'ncbs.res.in', 'eigenlabs.org', 'adaptyvbio.com', 'illinois.edu',
]);

// Subject keywords that promote an otherwise-ambiguous message. His actual active work.
const PROJECT_KEYWORDS = [
  'nexus', 'fable', 'prism', 'bhatbot', 'bhatball', 'biorxiv', 'alphafold', 'esm-2', 'esm2',
  'protein function', 'protein design', 'adaptyv', 'eigen', 'isef', 'research symposium',
  'princeton', 'uricase', 'rfdiffusion', 'proteinmpnn', 'boltz', 'pmhc',
];

// ── R4: ROUTINE — transactional. Mark read, KEEP in inbox (reference material). ──────────────────
const ROUTINE_SENDERS = new Set([
  'invoice+statements@mail.anthropic.com', 'receipts@openrouter.ai',
  'notifications@link.com', 'no-reply@prolific.com', 'no-reply@outlier.ai',
  'rei@notices.rei.com', 'hello@drinklmnt.com', 'noreply@veezi.com',
]);
const ROUTINE_DOMAINS = new Set(['stripe.com', 'squareup.com']);

// ── R5: NOISE — mark read AND archive. Requires List-Unsubscribe as well (engine-enforced). ──────
const NOISE_SENDERS = new Set([
  // Editorial / newsletters — named as unimportant.
  'nytdirect@nytimes.com', 'theathletic@e1.theathletic.com', 'quanta@simonsfoundation.org',
  'team@mail.cerebralvalley.ai', 'mitdaily@mit.edu', 'birbs@kurzgesagt.org',
  // Retail / promo.
  'hello@vuori.com', 'merrell@email.merrell.com', 'support@tracksmith.com',
  'yo@banditrunning.com', 'funhogs@na.patagonia.com', 'info@runningwarehouse.com',
  'hello@mondorobotics.com', 'noreply@mailer.frontier.co.uk', 'email@e.godaddy.com',
  'hello@m.higgsfield.ai',
  // Product marketing.
  'welcome@supabase.com', 'community@qodo.ai', 'em@em1.cloudflare.com',
  'teamtwilio@team.twilio.com', 'google-maps-platform-noreply@google.com',
  'no-reply@email.slackhq.com', 'no-reply@slack.com', 'community@sketchfab.com',
  'noreply@tm.openai.com', 'noreply@email.openai.com', 'googlecloud@google.com',
  // Marketing arms of financial services — siblings of R1 addresses. Exact-match matters here.
  'chase@mcmap.chase.com', 'noreply@news.paypal.com',
  // Social noise — very high volume.
  'no-reply@strava.com', 'mail@update.strava.com', 'invitations@linkedin.com',
  'no-reply@alerts.spotify.com', 'noreply@order.eventbrite.com', 'xbox@e.xbox.com',
  // Surveys.
  'cvs@express.medallia.com', 'info@respondent.io',
]);
const NOISE_DOMAINS = new Set(['fleetfeet.com', 'e.xbox.com']);

// Senders Siddhant rescued from the archive. The learning loop writes here; nothing is ever
// auto-archived from this set again. Permanent, and deliberately un-decaying.
const NEVER_ARCHIVE = new Set([]);

const flatPeople = () => Object.values(PEOPLE).flat();

module.exports = {
  SECURITY_SENDERS, URGENT_SUBJECT, GITHUB_SECURITY,
  PEOPLE, flatPeople, ADMISSIONS_DECAY_DAYS, INSTITUTION_DOMAINS, PROJECT_KEYWORDS,
  ROUTINE_SENDERS, ROUTINE_DOMAINS,
  NOISE_SENDERS, NOISE_DOMAINS, NEVER_ARCHIVE,
};
