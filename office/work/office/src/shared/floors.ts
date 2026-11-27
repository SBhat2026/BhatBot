// The building: every project is a floor you ride the elevator to. Shared by the server (which
// assigns each floor its look) and the client (which paints it).

import type { CloneProgress } from './protocol.js';

/** The most floors a building has. */
export const MAX_FLOORS = 16;

/** How a floor looks: its walls, their trim, and its planks. */
export interface FloorPalette {
  name: string;
  wall: string;
  trim: string;
  floor: string;
  floorAlt: string;
  /** The gaps between planks. */
  seam: string;
}

/** The first is the office as it always looked; every new floor takes the next one nobody has. */
// BhatBot's palette (bhatbot/src/theme.css): warm paper + burgundy, day grey + teal, and the plum and
// indigo the accent passes through at dusk. Quiet on purpose — the agents are what should stand out.
export const FLOOR_PALETTES: FloorPalette[] = [
  { name: 'Paper', wall: '#f6f3ec', trim: '#7a2e3e', floor: '#e7e1d4', floorAlt: '#e0d9ca', seam: '#d0c7b4' },
  { name: 'Day', wall: '#eef2f5', trim: '#0b6e8c', floor: '#dbe2e7', floorAlt: '#d1d9df', seam: '#bcc7cf' },
  { name: 'Plum', wall: '#f2eef1', trim: '#6b4a78', floor: '#e2dce3', floorAlt: '#d9d2da', seam: '#c4bcc6' },
  { name: 'Indigo', wall: '#eef0f6', trim: '#4a5a92', floor: '#dcdfe9', floorAlt: '#d2d6e2', seam: '#bec3d2' },
  { name: 'Stone', wall: '#f1f0ec', trim: '#4a4740', floor: '#dddad2', floorAlt: '#d4d0c6', seam: '#c0bbaf' },
  { name: 'Ink', wall: '#eceff1', trim: '#12222c', floor: '#d5dade', floorAlt: '#ccd2d7', seam: '#b7bfc5' },
];

export function floorPalette(i: number): FloorPalette {
  return FLOOR_PALETTES[((i % FLOOR_PALETTES.length) + FLOOR_PALETTES.length) % FLOOR_PALETTES.length];
}

/**
 * `owner/repo` from what someone typed or pasted: owner/repo, a github.com URL (https, ssh or
 * git@), with or without .git. Undefined for anything else, so it can never become a CLI option,
 * a path or another host.
 */
export function normalizeRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.trim();
  if (s.length > 200) return undefined;
  s = s.replace(/^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?github\.com[/:]/i, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  // A URL may go on past the repository (…/owner/repo/issues/12).
  if (parts.length < 2) return undefined;
  const [owner, repo] = parts;
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner)) return undefined;
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return undefined;
  return `${owner}/${repo}`;
}

export function sameRepo(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** What a floor's clone is doing: "Downloading 64%". */
export function cloneStep(p: CloneProgress | undefined): string {
  return `${p?.step ?? 'Cloning'}${p?.percent !== undefined ? ` ${p.percent}%` : '…'}`;
}

/** A floor's clone in a few words, for the floor lists: "⏳ Downloading 64%". */
export function cloneLabel(p: CloneProgress | undefined): string {
  return `⏳ ${cloneStep(p)}`;
}
