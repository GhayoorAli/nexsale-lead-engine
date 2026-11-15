#!/usr/bin/env node
/** Writes workflows/*.json from scripts/workflows/*.js (run: npm run build:workflows). */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'workflows');
const GROUPS = ['shared', 'sourcing', 'enrichment', 'emails', 'launch', 'replies', 'reporting', 'inbound', 'control'];

function buildAll() {
  const list = [];
  GROUPS.forEach((g) => {
    const p = path.join(__dirname, 'workflows', g + '.js');
    if (!fs.existsSync(p)) return;
    require(p).forEach((fn) => list.push(fn()));
  });
  return list;
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const wfs = buildAll();
  wfs.forEach((w) => console.log('wrote', path.relative(process.cwd(), w.write(OUT)), `(${w.nodes.length} nodes)`));
}

module.exports = { buildAll };
