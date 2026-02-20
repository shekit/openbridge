#!/usr/bin/env node

/**
 * Automated phase runner for OpenBridge.
 *
 * Reads feature-list.json, skips completed phases, and runs each remaining
 * phase in a fresh Claude Code session. Idempotent — safe to re-run after
 * a failure; completed phases are skipped automatically.
 *
 * Usage:
 *   node scripts/run-phases.mjs                  # uses project allowlist (unlisted tools auto-denied in -p mode)
 *   node scripts/run-phases.mjs --skip-permissions  # passes --dangerously-skip-permissions to Claude
 *   node scripts/run-phases.mjs --phase P2         # run only a specific phase
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, '..');
const FEATURE_LIST = resolve(PROJECT_DIR, 'feature-list.json');

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const skipPermissions = args.includes('--skip-permissions');
let phaseOnly = null;
if (args.includes('--phase')) {
  const idx = args.indexOf('--phase');
  phaseOnly = args[idx + 1];
  if (!phaseOnly || phaseOnly.startsWith('--')) {
    console.error('Error: --phase requires a phase ID (e.g., --phase P2)');
    process.exit(1);
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/run-phases.mjs [options]

Options:
  --skip-permissions   Pass --dangerously-skip-permissions to Claude Code
                       (gives unrestricted access for this machine — use with caution)
  --phase <id>         Run only a specific phase (e.g., --phase P2)
  --help, -h           Show this help message
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadFeatureList() {
  return JSON.parse(readFileSync(FEATURE_LIST, 'utf8'));
}

function phaseIsComplete(phase) {
  return phase.features.every((f) => f.status === 'passing');
}

function failingFeatures(phase) {
  return phase.features.filter((f) => f.status !== 'passing');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const featureList = loadFeatureList();
const phases = phaseOnly
  ? featureList.phases.filter((p) => p.id === phaseOnly)
  : featureList.phases;

if (phaseOnly && phases.length === 0) {
  console.error(`Phase ${phaseOnly} not found in feature-list.json`);
  process.exit(1);
}

for (const phase of phases) {
  // Re-read on each iteration so we see updates from the previous run
  const current = loadFeatureList();
  const currentPhase = current.phases.find((p) => p.id === phase.id);

  if (phaseIsComplete(currentPhase)) {
    console.log(`=== ${phase.id}: ${phase.name} — already complete, skipping ===`);
    continue;
  }

  console.log(`\n=== Starting ${phase.id}: ${phase.name} ===\n`);

  const prompt = [
    `Read CLAUDE.md and claude-progress.md to understand the project and current state.`,
    `Then work through phase ${phase.id} (${phase.name}).`,
    `Implement one feature at a time. After each feature:`,
    `  1. Run ./scripts/build.sh and ./scripts/test.sh to verify.`,
    `  2. Update feature-list.json to mark the feature as passing.`,
    `  3. Commit immediately with git (only the files you changed).`,
    `When all features in ${phase.id} are passing and committed, update claude-progress.md and stop.`,
  ].join(' ');

  const claudeArgs = [
    'claude',
    '-p',
    '--verbose',
  ];

  if (skipPermissions) {
    claudeArgs.push('--dangerously-skip-permissions');
  }

  claudeArgs.push(prompt);

  try {
    execFileSync(claudeArgs[0], claudeArgs.slice(1), {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`\n=== ${phase.id} failed (exit code ${err.status ?? 'unknown'}) ===`);
    console.error('Fix the issue and re-run this script. Completed phases will be skipped.');
    process.exit(1);
  }

  // Verify the phase actually completed
  const updated = loadFeatureList();
  const updatedPhase = updated.phases.find((p) => p.id === phase.id);
  const remaining = failingFeatures(updatedPhase);

  if (remaining.length > 0) {
    console.error(`\n=== ${phase.id} incomplete — ${remaining.length} feature(s) still failing ===`);
    console.error(remaining.map((f) => `  ${f.id}: ${f.description}`).join('\n'));
    console.error('\nRe-run this script to retry. Completed phases will be skipped.');
    process.exit(1);
  }

  console.log(`\n=== ${phase.id}: ${phase.name} — complete ===\n`);
}

console.log('\n=== All phases complete ===');
