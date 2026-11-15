#!/usr/bin/env node
/** Checks the cross-cutting rules on every workflow JSON in workflows/. */
const fs = require('fs');
const path = require('path');
const { IDS } = require('./n8n_builder');

const DIR = path.join(__dirname, '..', 'workflows');
const EXTERNAL = new Set(['n8n-nodes-base.httpRequest']);

function load() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, wf: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));
}

function parents(wf, name) {
  const out = [];
  Object.entries(wf.connections).forEach(([from, c]) => (c.main || []).forEach((outs) => (outs || []).forEach((t) => { if (t.node === name) out.push(from); })));
  return out;
}

function isEmailSend(node) {
  if (node.type === 'n8n-nodes-base.gmail' && (node.parameters.operation === 'send' || node.parameters.operation === 'reply' || !node.parameters.operation)) return true;
  if (node.type === 'n8n-nodes-base.emailSend') return true;
  return node.type === 'n8n-nodes-base.httpRequest' && /messages\/send/.test(String(node.parameters.url));
}

function lint(list) {
  const errors = [];
  const ids = new Set(Object.values(IDS));
  list.forEach(({ file, wf }) => {
    const stem = file.replace(/\.json$/, '');
    if (stem !== '00_error_handler' && wf.settings.errorWorkflow !== IDS['00_error_handler']) errors.push(`${file}: errorWorkflow is not 00_error_handler`);
    if (wf.settings.timezone !== 'Europe/Berlin') errors.push(`${file}: timezone is not Europe/Berlin`);
    if (wf.settings.executionOrder !== 'v1') errors.push(`${file}: executionOrder must be v1`);
    wf.nodes.forEach((n) => {
      if (EXTERNAL.has(n.type) && !(n.retryOnFail === true && n.maxTries === 3 && n.waitBetweenTries === 5000)) errors.push(`${file}: "${n.name}" has no retry on fail (3 × 5 s)`);
      if (n.type === 'n8n-nodes-base.executeWorkflow' && !ids.has(n.parameters.workflowId.value)) errors.push(`${file}: "${n.name}" calls an unknown workflow`);
      if (isEmailSend(n)) {
        if (stem !== '13_send_email') errors.push(`${file}: "${n.name}" sends email outside 13_send_email`);
        // the guard must be right before the send node (only the mock/real switch in between)
        const p = parents(wf, n.name);
        const ok = p.length === 1 && (wf.nodes.find((x) => x.name === p[0]).type === 'n8n-nodes-base.if' ? parents(wf, p[0]) : p).every((q) => /^Guard/.test(q));
        if (!ok) errors.push(`${file}: "${n.name}" is not directly preceded by the Guard node`);
      }
    });
    const guard = wf.nodes.find((n) => /^Guard/.test(n.name));
    if (stem === '13_send_email' && !(guard && /guardEmail\(/.test(guard.parameters.jsCode) && /isBlocked\(/.test(guard.parameters.jsCode))) errors.push(`${file}: Guard node must call guardEmail and isBlocked`);
  });
  return errors;
}

if (require.main === module) {
  const errors = lint(load());
  if (errors.length) {
    errors.forEach((e) => console.error(' - ' + e));
    process.exit(1);
  }
  console.log('Workflow lint passed.');
}

module.exports = { lint, load, isEmailSend, parents };
