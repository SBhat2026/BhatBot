# BhatBot logo brief (for Claude Design)

Paste this whole file into Claude Design. It describes the product, the look the logo has to sit in,
and every place the logo will be applied, with exact sizes.

## What BhatBot is

A personal AI agent that runs on one person's Mac and stays reachable from their phone. It talks
(a voice like a butler, not a console), works through tasks with a small team of sub-agents shown
walking around a 3D office, keeps a "second brain" graph of projects and memories, and, when
something needs its owner, writes to them or phones them. It is calm, competent and discreet, and it
works for one person.

Personality words: **composed · precise · warm · a little old-world**. Not: playful, robotic, cute,
neon-sci-fi, a chat bubble, a robot head, a brain icon.

## The look it lives in (current UI, 25 Nov 2026)

- **Grounds:** cool paper `#EEF2F5` (day), warm paper `#F6F3EC` (idle/standby), near-black
  `#090D13` (night). Surfaces lift off the ground with soft shadows rather than outlines.
- **Accent colour follows the sun:** pure **burgundy `#7A2E3E`** at midday, blending continuously
  through plum and indigo to **teal-blue `#0B6E8C`** at midnight (lighter versions on the dark
  ground: `#D9728A` → `#2FA8C8`). So the logo must work in **both** burgundy and teal-blue, and
  ideally in a single neutral ink. Don't make the mark depend on either hue.
- **The orb:** the centre of the app is a glossy sphere (light core, saturated middle, dark rim)
  that is the agent's "face". It glows more when a more powerful model is thinking. The logo
  can echo the orb, but should be a flat mark, not a rendered sphere.
- **Type:** JetBrains Mono for chrome and labels, spaced out in capitals (the wordmark today is just
  `BHATBOT` in mono, letter-spaced ~0.3em). Newsreader (a serif) for anything the agent *says*.
  System sans for buttons.
- **Current app icon** (`build/icon.png`, to be replaced): dark starfield, concentric dashed rings,
  a glowing cyan disc with "SB". It belongs to the old cyan HUD theme and reads as generic sci-fi.

## Deliverables and where each goes

| Use | Size / format | Ground | Notes |
|---|---|---|---|
| macOS app + Dock icon | 1024×1024 PNG (→ `build/icon.png`); macOS squircle safe area | Light or dark, your call | Must read at 32 px in the Dock and at 16 px in Finder lists |
| Title-bar mark beside the `BHATBOT` wordmark | SVG, square, drawn for 14–18 px | Transparent, single colour via `currentColor` | Sits left of the mono wordmark; it will be tinted by the live accent |
| Phone web app (home-screen icon) | 512×512 and 192×192 PNG (→ `cloud/public/icon-512.png`, `icon-192.png`), full-bleed, no transparency | Solid | iOS rounds the corners itself; keep the mark inside the central 80% |
| Favicon | SVG + 32×32 PNG | Transparent | Same mark as the title bar |
| GitHub README header | 1280×320 SVG or PNG, mark + wordmark | Light, with a dark-mode variant | Wordmark in JetBrains Mono capitals, letter-spaced |
| Social preview (GitHub repo card) | 1280×640 PNG | Either | Mark, wordmark, one-line tagline |

## Constraints

- One mark, recognisable in one colour at 16 px. Detail that only survives at 512 px is decoration.
- Works in burgundy, teal-blue, near-black ink, and white-on-dark.
- No initials-in-a-circle (that is the current icon's problem), no robot, no brain, no speech bubble,
  no sparkles. No letterform that reads as another brand.
- An idea that fits: the orb as a simple disc with a single offset arc or ring (a rim catching light, or
  an orbit), suggesting something attentive that is always on. Treat this as a direction, not a spec.

## Tagline options (README/social only)

- "A personal agent that knows when to call."
- "Works while you do. Calls when it matters."

## After the logo comes back

Hand Claude Code the SVG mark and the PNG exports. It will:

- replace `build/icon.png` and the cloud icons;
- add the title-bar SVG next to `#brand` in `src/index.html`, tinted with `currentColor` so it
  follows the day/night accent;
- add a favicon to the HTML pages;
- add the README header;
- rebuild the app.
