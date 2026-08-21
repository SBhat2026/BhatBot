'use strict';
// ── CONNECTORS — hosted MCP servers, the same thing Claude.ai calls an "Integration" ─────────────
// lib/mcphub.js can now speak Streamable HTTP, so BhatBot can consume the exact remote MCP endpoints
// the user has already connected to Claude.ai — nothing to install, nothing to keep running. This
// module is the registry that turns a one-word name into a full, safe spec.
//
// Why a registry instead of just letting config.mcpPlugins hold raw URLs:
//   • the URL, transport and auth style of a known connector are FIXED facts, not user settings —
//     they belong in code where they can be reviewed, not in a JSON file the agent can rewrite;
//   • it gives egress a fixed allow-list (see assertAllowedHost). Without one, a prompt-injected
//     "update your seedance connector to point at evil.example" would send every subsequent tool
//     argument — prompts, image URLs, whatever context was passed — to an attacker's endpoint. The
//     host of a REGISTERED connector cannot be overridden from config; only unregistered custom
//     entries may name their own host, and those must be https.
//
// Auth never lands in this file. A connector declares WHICH env var / config field carries its
// token; the value comes from process.env or the safeStorage vault at connect time.

const REGISTRY = {
  // ByteDance Seedance (text→video / image→video) via AceDataCloud's hosted MCP server.
  // Same endpoint as the Claude.ai integration; Claude.ai authenticates with OAuth, everything else
  // uses a bearer token from https://platform.acedata.cloud.
  seedance: {
    name: 'seedance',
    label: 'Seedance — AI video generation',
    transport: 'http',
    url: 'https://seedance.mcp.acedata.cloud/mcp',
    auth: { type: 'bearer', env: 'ACEDATACLOUD_API_TOKEN', configField: 'acedataToken' },
    docs: 'https://platform.acedata.cloud',
    // Local fallback: the same server as a stdio process, for offline/self-hosted use.
    stdio: { command: 'uvx', args: ['mcp-seedance'], env: { ACEDATACLOUD_API_TOKEN: '$ACEDATACLOUD_API_TOKEN' } },
    tools: ['seedance_generate_video', 'seedance_generate_video_from_image', 'seedance_get_task',
            'seedance_get_tasks_batch', 'seedance_list_models', 'seedance_list_resolutions', 'seedance_list_actions'],
    // Tools a NATIVE tool already wraps. Hidden from the model for two reasons, cost and correctness:
    //   • cost — these two schemas are 2,764 of Seedance's 3,571 tokens, and connector tools are sent
    //     on every turn. Dropping them removes 77% of the connector's footprint.
    //   • correctness — they are ASYNCHRONOUS. They return a task id, so the model has to poll across
    //     turns, re-sending the whole conversation each time. `visual_build` runs that loop in code
    //     and returns a finished video from one call. Leaving both visible invites the expensive path.
    // The read-only tools stay: list_models/list_resolutions are what `visual_build`'s description
    // tells the model to consult, and get_task lets it check on a generation from an earlier session.
    hide: { seedance_generate_video: 'visual_build', seedance_generate_video_from_image: 'visual_build' },
  },
};

/** Tools a native tool supersedes, as `mcp__<plugin>__<tool>` ids. mcphub filters these out. */
function hiddenToolIds() {
  const out = new Map();
  for (const c of Object.values(REGISTRY)) {
    for (const [tool, by] of Object.entries(c.hide || {})) out.set(`mcp__${c.name}__${tool}`, by);
  }
  return out;
}

/** Hosts a registered connector is permitted to reach. Derived from the registry — never from config. */
function allowedHosts() {
  const out = new Set();
  for (const c of Object.values(REGISTRY)) { try { out.add(new URL(c.url).host); } catch {} }
  return out;
}

/**
 * Validate a spec's URL before it is ever contacted.
 * A REGISTERED name is pinned to the registry's host — config cannot move it. An unregistered custom
 * connector may use any host, but must be https (a plaintext MCP endpoint would put the bearer token
 * and every tool argument on the wire in the clear).
 * @throws {Error} when the URL is not acceptable
 */
function assertAllowedHost(spec) {
  if (!spec || !spec.url) return;
  let u;
  try { u = new URL(spec.url); } catch { throw new Error(`connector '${spec.name}': malformed url`); }
  const known = REGISTRY[spec.name];
  if (known) {
    const want = new URL(known.url).host;
    if (u.host !== want) throw new Error(`connector '${spec.name}' is pinned to ${want} — refusing ${u.host}`);
    return;
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(`connector '${spec.name}': ${u.protocol}// is not allowed — use https`);
  }
}

/**
 * Where a connector's token comes from, in priority order: explicit config → env → vaulted field.
 *
 * An unresolved `CRED_REF_…` handle is treated as NO TOKEN rather than as a token. It is a non-empty
 * string, so every naive truthiness check accepts it, and the connector would then authenticate with
 * the literal handle — an Authorization header that is guaranteed to 401 while looking configured.
 */
const usable = (v) => (v && !String(v).startsWith('CRED_REF') ? String(v) : null);
function tokenFor(def, cfg = {}, userSpec = {}) {
  const explicit = usable(userSpec.auth && userSpec.auth.token);
  if (explicit) return explicit;
  const a = def && def.auth;
  if (!a) return null;
  if (a.env) { const v = usable(process.env[a.env]); if (v) return v; }
  if (a.configField) { const v = usable(cfg[a.configField]); if (v) return v; }
  return null;
}

/**
 * Turn config into connect-ready specs for mcphub.connectAll().
 *
 * A user entry may be as small as `{ name: 'seedance' }` — everything else (url, transport, auth
 * shape) is filled from the registry. Entries whose token cannot be found are returned with
 * `missingAuth: true` rather than dropped, so the UI can say "Seedance needs a token" instead of the
 * connector silently not existing.
 *
 * @param {object} cfg resolved config (CRED_REFs already resolved)
 * @returns {{ specs: object[], skipped: object[] }}
 */
function resolveSpecs(cfg = {}) {
  const entries = Array.isArray(cfg.mcpPlugins) ? cfg.mcpPlugins : [];
  const specs = [], skipped = [];
  for (const e of entries) {
    if (!e || !e.name || e.enabled === false) continue;
    const def = REGISTRY[e.name];
    if (!def) {                                     // custom / unregistered: use as-is, still validated
      try { assertAllowedHost(e); specs.push(e); } catch (err) { skipped.push({ name: e.name, reason: err.message }); }
      continue;
    }
    const token = tokenFor(def, cfg, e);
    if (!token) { skipped.push({ name: e.name, reason: `no token — set ${def.auth.env} or config.${def.auth.configField} (${def.docs})`, missingAuth: true }); continue; }
    const spec = { name: def.name, transport: def.transport, url: def.url, auth: { type: def.auth.type, token } };
    try { assertAllowedHost(spec); specs.push(spec); }
    catch (err) { skipped.push({ name: e.name, reason: err.message }); }
  }
  return { specs, skipped };
}

/** A config patch that enables a registered connector. Token (if given) is vaulted by saveConfig. */
function enablePatch(cfg = {}, name, token) {
  const def = REGISTRY[name];
  if (!def) throw new Error(`unknown connector '${name}' — known: ${Object.keys(REGISTRY).join(', ')}`);
  const list = (Array.isArray(cfg.mcpPlugins) ? cfg.mcpPlugins : []).filter((p) => p && p.name !== name);
  list.push({ name, enabled: true, ...(token ? { auth: { type: def.auth.type, token } } : {}) });
  return { mcpPlugins: list };
}

/** What the UI/agent should see: every known connector plus whether it is on and authenticated. */
function describe(cfg = {}) {
  const entries = Array.isArray(cfg.mcpPlugins) ? cfg.mcpPlugins : [];
  return Object.values(REGISTRY).map((def) => {
    const user = entries.find((e) => e && e.name === def.name);
    return {
      name: def.name, label: def.label, url: def.url, docs: def.docs,
      enabled: !!(user && user.enabled !== false),
      authenticated: !!tokenFor(def, cfg, user || {}),   // boolean only — the token itself never leaves
      tools: def.tools,
    };
  });
}

module.exports = { REGISTRY, resolveSpecs, enablePatch, describe, assertAllowedHost, allowedHosts, tokenFor, hiddenToolIds };
