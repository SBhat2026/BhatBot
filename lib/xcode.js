'use strict';
// ── XCODE — build, test and run his Apple projects ───────────────────────────────────────────────
//
// 2026-11-14: "have xcode access wired and ready to build". xcodebuild and simctl, driven from one
// tool: what is installed and ready (`status`), what a project contains (`list`), and `build` /
// `test` / `run` (build → install → launch in a simulator). Builds go to BhatBot's own DerivedData
// so they never disturb the copy Xcode.app uses, and code signing is off for simulator and generic
// device builds, which need none.
//
// Pure: argument lists and output parsing. main.js spawns the processes.

const path = require('path');
const crypto = require('crypto');

/** Find the thing to build in a folder: a workspace beats a project beats a Swift package. */
function findContainer(dir, readdir) {
  let ents = [];
  try { ents = readdir(dir); } catch { return null; }
  const ws = ents.find((e) => e.endsWith('.xcworkspace'));
  if (ws) return { kind: 'workspace', path: path.join(dir, ws) };
  const pj = ents.find((e) => e.endsWith('.xcodeproj'));
  if (pj) return { kind: 'project', path: path.join(dir, pj) };
  if (ents.includes('Package.swift')) return { kind: 'package', path: dir };
  return null;
}

function containerArgs(c) {
  if (!c) return [];
  if (c.kind === 'workspace') return ['-workspace', c.path];
  if (c.kind === 'project') return ['-project', c.path];
  return [];                                   // a package builds from its own directory
}

/** Pick a simulator: a booted iPhone, else the newest available iPhone, from `simctl list devices available -j`. */
function pickSimulator(json, want) {
  const devs = [];
  for (const [rt, list] of Object.entries((json && json.devices) || {})) {
    if (!/iOS/.test(rt)) continue;
    for (const d of list || []) if (d.isAvailable !== false) devs.push({ ...d, runtime: rt });
  }
  if (want) { const w = devs.find((d) => d.name.toLowerCase() === String(want).toLowerCase() || d.udid === want); if (w) return w; }
  const phones = devs.filter((d) => /iPhone/.test(d.name));
  return phones.find((d) => d.state === 'Booted') || phones.sort((a, b) => b.runtime.localeCompare(a.runtime) || b.name.localeCompare(a.name))[0] || devs[0] || null;
}

function destinationFor(target, sim) {
  if (target === 'mac') return 'platform=macOS';
  if (target === 'device') return 'generic/platform=iOS';
  return sim ? `platform=iOS Simulator,id=${sim.udid}` : 'generic/platform=iOS Simulator';
}

const derivedData = (home, container) => path.join(home, '.bhatbot', 'xcode', 'DerivedData',
  crypto.createHash('sha1').update(String(container && container.path)).digest('hex').slice(0, 10));

/** xcodebuild arguments for build/test. */
function buildArgs({ container, scheme, action = 'build', destination, configuration = 'Debug', derived }) {
  return [...containerArgs(container), ...(scheme ? ['-scheme', scheme] : []), '-configuration', configuration,
    '-destination', destination, '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', action];
}

/** The parts of an xcodebuild log worth reading: errors (deduplicated), warning count, verdict. */
function summarize(log) {
  const lines = String(log || '').split('\n');
  const errors = [...new Set(lines.filter((l) => /(^|\s)error:/.test(l) && !/^\s*note:/.test(l)).map((l) => l.trim()))].slice(0, 15);
  const warnings = lines.filter((l) => /(^|\s)warning:/.test(l)).length;
  const ok = /\*\* (BUILD|TEST) SUCCEEDED \*\*/.test(log);
  const failed = /\*\* (BUILD|TEST) FAILED \*\*/.test(log) || errors.length > 0;
  const tests = (/Executed (\d+) tests?, with (\d+) failures?/.exec(log) || []);
  return { ok: ok && !failed, errors, warnings, tests: tests[1] ? { ran: +tests[1], failed: +tests[2] } : undefined };
}

/** Where the built .app is: the products folder for the destination, first .app in it. */
function productsDir(derived, configuration, target) {
  const plat = target === 'mac' ? '' : target === 'device' ? '-iphoneos' : '-iphonesimulator';
  return path.join(derived, 'Build', 'Products', configuration + plat);
}

module.exports = { findContainer, containerArgs, pickSimulator, destinationFor, derivedData, buildArgs, summarize, productsDir };
