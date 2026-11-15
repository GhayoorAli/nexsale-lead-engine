/**
 * airtable.js – helpers for the Airtable REST API: batches of 10, formula building,
 * flattening records. Free-plan friendly (CLAUDE.md: batches of 10 per call).
 */
const BATCH = 10;

function chunk(list, size) {
  const n = size || BATCH;
  const out = [];
  for (let i = 0; i < (list || []).length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function clean(fields) {
  const out = {};
  Object.keys(fields || {}).forEach((k) => {
    if (fields[k] !== undefined) out[k] = fields[k];
  });
  return out;
}

/** -> [{records:[{fields}]}] one item per HTTP call */
function createBatches(fieldsList) {
  return chunk((fieldsList || []).map((f) => ({ fields: clean(f) }))).map((records) => ({ records, typecast: true }));
}

/** updates: [{id, fields}] -> [{records:[{id, fields}]}] */
function updateBatches(updates) {
  return chunk((updates || []).filter((u) => u && u.id).map((u) => ({ id: u.id, fields: clean(u.fields) }))).map((records) => ({ records, typecast: true }));
}

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function eq(field, value) {
  if (typeof value === 'number' || typeof value === 'boolean') return `{${field}}=${value === true ? 'TRUE()' : value === false ? 'FALSE()' : value}`;
  return `{${field}}='${esc(value)}'`;
}

function and(...parts) {
  const p = parts.filter(Boolean);
  return p.length === 1 ? p[0] : `AND(${p.join(',')})`;
}

function or(...parts) {
  const p = parts.filter(Boolean);
  return p.length === 1 ? p[0] : `OR(${p.join(',')})`;
}

/** Airtable record -> flat object with id */
function flat(record) {
  if (!record) return null;
  return Object.assign({ id: record.id, createdTime: record.createdTime }, record.fields || {});
}

function flatList(response) {
  return ((response && response.records) || []).map(flat);
}

/** n8n items from a (paginated) list node -> flat records */
function fromItems(items) {
  // With pagination on, n8n's HTTP node retries and then passes the error body on instead of failing.
  // A failed read must never look like an empty table (e.g. an "empty" Blocklist), so fail here.
  (items || []).forEach((i) => {
    const e = i && i.json && i.json.error;
    if (e) throw new Error('Airtable read failed after retries: ' + (typeof e === 'string' ? e : e.message || e.type || JSON.stringify(e)).slice(0, 200));
  });
  return flatList({ records: (items || []).flatMap((i) => (i && i.json && i.json.records) || []) });
}

/** OR() over ids for a text field, e.g. lead_record_id */
function inIds(field, ids) {
  const list = Array.from(new Set((ids || []).filter(Boolean)));
  if (!list.length) return "{" + field + "}='__none__'";
  return or(...list.map((id) => eq(field, id)));
}

const airtableApi = { fromItems, inIds, BATCH, chunk, createBatches, updateBatches, eq, and, or, esc, flat, flatList, clean };
if (typeof module !== 'undefined' && module.exports) module.exports = airtableApi;
