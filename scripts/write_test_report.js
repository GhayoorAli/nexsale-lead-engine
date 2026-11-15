#!/usr/bin/env node
/** Called by `npm test`: refreshes docs/test_report.md (needs Python 3.11 from .venv or python3). */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const py = fs.existsSync(path.join(root, '.venv/bin/python')) ? path.join(root, '.venv/bin/python') : 'python3';
const r = spawnSync(py, [path.join(root, 'tests/report.py')], { stdio: 'inherit' });
process.exit(r.status || 0);
