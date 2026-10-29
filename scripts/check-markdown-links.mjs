import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const excluded = new Set(['.git', 'node_modules', 'private-runtime', 'dist', '.astro', '.venv']);
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !excluded.has(entry.name)) walk(join(dir, entry.name));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(join(dir, entry.name));
  }
}
walk(join(root, 'docs'));
files.push(join(root, 'CLAUDE.md'));

const broken = [];
const inbound = new Set();
const edges = new Map();
for (const file of files) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const targets = [...line.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)].map(m => m[1] ?? m[2]);
    const definition = line.match(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/);
    if (definition) targets.push(definition[1] ?? definition[2]);
    for (const target of targets) {
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) continue;
      let path;
      try { path = decodeURIComponent(target.split('#')[0].split('?')[0]); }
      catch { broken.push(`${file.slice(root.length + 1)}:${i + 1}: invalid encoding: ${target}`); continue; }
      if (!path) continue;
      const absolute = resolve(dirname(file), path);
      if (!existsSync(absolute)) broken.push(`${file.slice(root.length + 1)}:${i + 1}: ${target}`);
      else if (statSync(absolute).isFile()) {
        inbound.add(absolute.toLowerCase());
        if (extname(absolute).toLowerCase() === '.md') {
          const from = file.toLowerCase();
          if (!edges.has(from)) edges.set(from, new Set());
          edges.get(from).add(absolute.toLowerCase());
        }
      }
    }
  }
}

const core = [
  'docs/ACTIVE-FEATURE.md', 'docs/PRD.md', 'docs/DECISIONS.md',
  'docs/ard/00-SHARED-CONTRACTS.md', 'docs/ard/ARD-V1-Working-Vertical-Slice.md',
  'docs/ard/ARD-V3-Semantic-Matching.md', 'docs/S4A-MATCHING.md',
  'src/match/evidence.ts', 'src/match/analyze.ts', 'src/match/pipeline.ts',
  'src/match/decide.ts', 'src/api/match-routes.ts',
  'tests/api/match-e2e.test.ts', 'tests/api/match-routes.test.ts',
  'web/src/pages/matches.astro', 'tests/e2e/offline/matches-ui.e2e.test.ts',
  'docs/sdlc/CI-TIERS.md', 'docs/qa/QA_SIGNOFF.md', 'docs/qa/GATE_A_REPORT.md',
  '.github/pull_request_template.md',
];
const orphaned = core.filter(path => existsSync(join(root, path)) && !inbound.has(join(root, path).toLowerCase()));
// Every Markdown file under docs/ must be reachable from docs/INDEX.md through local Markdown links.
const indexFile = join(root, 'docs', 'INDEX.md').toLowerCase();
const reached = new Set([indexFile]);
const queue = [indexFile];
while (queue.length) for (const next of edges.get(queue.shift()) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
const docsDir = join(root, 'docs').toLowerCase();
const unreachable = files.filter(f => f.toLowerCase().startsWith(docsDir) && !reached.has(f.toLowerCase())).map(f => f.slice(root.length + 1).replace(/\\/g, '/'));

console.log(`Checked ${files.length} Markdown files.`);
console.log(`Broken local links: ${broken.length}`);
for (const item of broken) console.log(`  ${item}`);
console.log(`Unlinked core references: ${orphaned.length}`);
for (const item of orphaned) console.log(`  ${item}`);
console.log(`Docs not reachable from docs/INDEX.md: ${unreachable.length}`);
for (const item of unreachable) console.log(`  ${item}`);
if (broken.length || orphaned.length || unreachable.length) process.exitCode = 1;
