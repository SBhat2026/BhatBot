# Cloudflare Tunnel — replacing Tailscale Funnel

Two ways to expose BhatBot over Cloudflare instead of Tailscale.

## Quick tunnel — zero setup, works right now
No account, no domain. Gives a random `https://<random>.trycloudflare.com` URL that **changes
every run** — fine now that the app's server URL is editable (long-press the screen → paste it).

```bash
bash ~/bhatbot/scripts/serve-cloudflare.sh
```
It prints the URL; set the app's host to it (long-press → Save). Done — you're off Tailscale.

## Named tunnel — STABLE custom hostname (recommended once you have a domain)
This is the real Tailscale-Funnel replacement: a permanent URL like
`https://bhatbot.yourdomain.com`, so you never re-paste. Needs a domain on your Cloudflare
account (you already use Cloudflare for Workers — just add a domain/zone if you don't have one).

One-time setup (the login + DNS steps are interactive, so run them yourself):

```bash
# 1. Authenticate cloudflared with your Cloudflare account (opens a browser).
cloudflared tunnel login

# 2. Create a named tunnel (writes credentials to ~/.cloudflared/<UUID>.json).
cloudflared tunnel create bhatbot

# 3. Route a hostname on your domain to it (creates the DNS record).
cloudflared tunnel route dns bhatbot bhatbot.yourdomain.com

# 4. Write ~/.cloudflared/config.yml:
#    tunnel: bhatbot
#    credentials-file: /Users/siddhantbhat/.cloudflared/<UUID>.json
#    ingress:
#      - hostname: bhatbot.yourdomain.com
#        service: http://localhost:8788
#      - service: http_status:404
```

Then run it (the serve script keeps the Mac awake + starts the app too):

```bash
BHATBOT_CF_TUNNEL=bhatbot bash ~/bhatbot/scripts/serve-cloudflare.sh
```

Finally, point the app once: long-press the screen → set **host** to
`https://bhatbot.yourdomain.com` → Save. It's now permanent and Tailscale-free.

## Notes
- The Mac must still be awake for either tunnel (that's Phase 2 — the always-on cloud backend).
- The app already falls back to its bundled UI when the Mac is unreachable, so it still opens.
- Keep the secret token in the URL path; the tunnel only changes the hostname, not the auth.
