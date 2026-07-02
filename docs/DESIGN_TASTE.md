# BhatBot — Design Taste (UI/UX generation rubric)

The standard BhatBot applies whenever it generates or reviews UI (studio_write SVG, HTML pages,
dashboards, the visual-critique loop). Distilled from the **UI/UX Pro Max** skill (installed at
`~/.claude/skills/ui-ux-pro-max` — query it with `--domain style|color|typography|ux|chart` for the
full 84 styles / 161 palettes / 57 font pairings / 99 UX rules) plus BhatBot's own aesthetic.

## Priority order (fix in this order — 1 is non-negotiable)

1. **Accessibility (CRITICAL).** Contrast ≥ 4.5:1 (large text 3:1). Visible focus rings (2–4px) —
   never remove them. `alt`/`aria-label` on meaningful images + icon-only buttons. Tab order = visual
   order. Sequential headings h1→h6. Never convey info by color alone (add icon/text). Respect
   `prefers-reduced-motion`.
2. **Touch & interaction (CRITICAL).** Targets ≥ 44×44px, ≥ 8px apart. Click/tap for primary actions
   (never hover-only). Disable + spinner on async buttons. `cursor: pointer` on clickables.
   `touch-action: manipulation` to kill the 300ms delay. Visible feedback on press.
3. **Performance.** WebP/AVIF + lazy-load non-critical images; declare width/height or `aspect-ratio`
   (CLS < 0.1). `font-display: swap`; preload only critical fonts. Inline above-the-fold CSS.
4. **Style selection.** Match the product type; be consistent. SVG icons, **never emoji as icons**.
   Don't mix flat + skeuomorphic randomly. Pick ONE style language (minimal / bento / glass / etc.)
   and hold it.
5. **Layout & responsive.** Mobile-first breakpoints; viewport meta; no horizontal scroll; no
   fixed-px container widths; never disable zoom.
6. **Typography & color.** Body ≥ 16px, line-height ~1.5. Semantic color tokens, not raw hex in
   components. Avoid gray-on-gray. A restrained palette (1 accent + neutrals) beats a rainbow.
7. **Animation.** 150–300ms, motion that conveys meaning (spatial continuity), never decorative-only;
   animate transform/opacity (not width/height); honor reduced-motion.
8. **Forms & feedback.** Visible labels (not placeholder-as-label); errors next to the field; helper
   text; progressive disclosure.
9. **Navigation.** Predictable back; bottom nav ≤ 5; deep-linkable.
10. **Charts & data.** Legends + tooltips; colorblind-safe; never color-alone to encode meaning;
    label legibility at target size; no chartjunk.

## BhatBot's own aesthetic (his taste, from the repo)

- **Restraint over decoration.** One accent color, monochrome everything else, hairline borders
  (`rgba(255,255,255,.08)`), no gradients on cards. Quiet instrument, not a cockpit.
- **Two registers:** `hud` (JARVIS — Orbitron/Rajdhani, cyan `#00c8ff`, corner brackets) for the
  desktop HUD; `zen` (near-black `#0a0a0c`, desaturated accent `#7fd4e8`, system type) for the
  voice-first layer. Pick the register that fits; don't blend them.
- **The content earns the pixels.** Every visual element must serve the conversation/data. When in
  doubt, remove it.
- **Web stack:** Next.js App Router + Tailwind (his stack). Server Components by default; compose
  utilities; extract a component when a pattern repeats.

## How to use it

- Before building a page/component: pick a style language + palette + font pairing (query the skill
  if unsure), then build to the priority list above.
- The visual-critique loop judges renders against THIS file (priorities 1–10 + his aesthetic) and the
  approved `exemplars/`. A priority-1/2 violation is a `severe` finding → revise before delivery.
