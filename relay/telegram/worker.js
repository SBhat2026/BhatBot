// Forwards https://<worker>/bot<id>:<secret>/<method> → https://api.telegram.org/bot<id>:<secret>/<method>
// only when <id> is the allowed bot. Bodies (including multipart uploads) and query strings pass
// through unchanged; nothing is logged or stored.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = /^\/bot(\d+):[A-Za-z0-9_-]{20,}\//.exec(url.pathname);
    if (!m || !env.ALLOWED_BOT_ID || m[1] !== String(env.ALLOWED_BOT_ID).trim()) return new Response('not found', { status: 404 });
    const upstream = 'https://api.telegram.org' + url.pathname + url.search;
    const headers = new Headers(req.headers);
    for (const h of ['host', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) headers.delete(h);
    const res = await fetch(upstream, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual' });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
};
