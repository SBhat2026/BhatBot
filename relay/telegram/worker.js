// Forwards https://<worker>/bot<id>:<secret>/<method> → https://api.telegram.org/bot<id>:<secret>/<method>
// only when <id> is the allowed bot. Bodies (including multipart uploads) and query strings pass
// through unchanged; nothing is logged or stored.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // /probe?url=… — "can the internet reach BhatBot's own webhook?", asked from Cloudflare's edge,
    // because the Mac cannot answer that about itself. Only his tailnet's names (and example.com, the
    // prober's control) may be fetched, GET only, and only the first 2 KB comes back — so this is a
    // reachability check, not a proxy anyone could use.
    if (url.pathname === '/probe') {
      let t; try { t = new URL(url.searchParams.get('url') || ''); } catch { return new Response('bad url', { status: 400 }); }
      const allowed = t.protocol === 'https:' && (/\.ts\.net$/.test(t.hostname) || t.hostname === 'example.com');
      if (!allowed) return new Response('not allowed', { status: 403 });
      try {
        const r = await fetch(t.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
        const body = (await r.text()).slice(0, 2048);
        // The Tailscale funnel edge answers for every *.ts.net name — 530 (and 502-504) means IT could
        // not reach a node, which is exactly "unreachable". Anything else, even a 404, is the app.
        if (r.status === 530 || (r.status >= 502 && r.status <= 504) || (r.status >= 520 && r.status <= 527)) {
          return new Response(`error code: 522 — origin unreachable (edge said ${r.status})`, { status: 502, headers: { 'x-origin-status': String(r.status) } });
        }
        return new Response(body, { status: 200, headers: { 'x-origin-status': String(r.status) } });
      } catch (e) { return new Response('error code: 522 — origin unreachable', { status: 502 }); }
    }
    const m = /^\/bot(\d+):[A-Za-z0-9_-]{20,}\//.exec(url.pathname);
    if (!m || !env.ALLOWED_BOT_ID || m[1] !== String(env.ALLOWED_BOT_ID).trim()) return new Response('not found', { status: 404 });
    const upstream = 'https://api.telegram.org' + url.pathname + url.search;
    const headers = new Headers(req.headers);
    for (const h of ['host', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) headers.delete(h);
    const res = await fetch(upstream, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual' });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
};
