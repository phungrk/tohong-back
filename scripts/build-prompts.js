/**
 * Build script: sinh edge/lib/prompts.js từ edge/agents/*.md
 *
 * Workers không có filesystem nên persona + agent blocks phải được bundle
 * thành string constant lúc build. Sửa nội dung agent trong edge/agents/,
 * rồi chạy lại script này:
 *
 *   node edge/scripts/build-prompts.js
 *
 * Domain key phải khớp với DOMAIN_KEYWORDS trong edge/lib/router.js.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT = join(REPO_ROOT, 'lib', 'prompts.js');

// filename (trong agents/) -> domain key trong router.js
const AGENT_FILES = {
  budget: 'budget-agent.md',
  venue: 'venue-agent.md',
  vendor: 'vendor-agent.md',
  timeline: 'timeline-agent.md',
  guest: 'guest-agent.md',
  theme: 'theme-agent.md',
  customs: 'customs-agent.md',
};

/** Bỏ frontmatter YAML (--- ... ---) ở đầu file, trả phần body markdown. */
function stripFrontmatter(text) {
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const after = text.indexOf('\n', end + 1);
      return text.slice(after + 1).trim();
    }
  }
  return text.trim();
}

function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

const persona = read('agents/orchestrator.md').trim();

const blocks = {};
for (const [domain, file] of Object.entries(AGENT_FILES)) {
  blocks[domain] = stripFrontmatter(read(join('agents', file)));
}

const header = `/**
 * AUTO-GENERATED — KHÔNG sửa tay.
 * Nguồn: edge/agents/*.md
 * Sinh lại bằng: node edge/scripts/build-prompts.js
 */
`;

const body =
  header +
  '\nexport const ORCHESTRATOR_PERSONA = ' + JSON.stringify(persona) + ';\n' +
  '\nexport const AGENT_BLOCKS = ' + JSON.stringify(blocks, null, 2) + ';\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');

const sizes = Object.entries(blocks)
  .map(([d, b]) => `${d}=${b.length}`)
  .join(', ');
console.log(`✓ Wrote ${OUT}`);
console.log(`  persona=${persona.length} chars; blocks: ${sizes}`);
