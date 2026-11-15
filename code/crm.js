/**
 * crm.js – Module 10 HubSpot payloads (CRM v3). Idempotent: search first, then create or update.
 */
const DEAL_STAGES = {
  Interested: 'appointmentscheduled',
  'Meeting booked': 'appointmentscheduled',
  'Meeting held': 'qualifiedtobuy',
  'No-show': 'closedlost',
  // The lead withdrew after showing interest: the open deal is closed, never left hanging.
  'Not interested': 'closedlost',
  Unsubscribed: 'closedlost',
};

/** Statuses that close an existing deal. They never create a new one (only leads that already have a deal are synced). */
const CLOSING_STATUSES = ['Not interested', 'Unsubscribed'];

function isClosing(status) {
  return CLOSING_STATUSES.includes(status);
}

/** Readable reason for HubSpot's standard closed_lost_reason property. */
function closedLostReason(lead) {
  if (lead.status === 'Unsubscribed') return 'Lead hat sich nach Interesse abgemeldet (STOP)';
  if (lead.status === 'Not interested') return 'Lead hat nach Interesse abgesagt';
  if (lead.status === 'No-show') return 'Lead ist nicht zum Termin erschienen';
  return '';
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: '', lastname: '' };
  if (parts.length === 1) return { firstname: '', lastname: parts[0] };
  return { firstname: parts.slice(0, -1).join(' '), lastname: parts[parts.length - 1] };
}

function contactSearch(email) {
  return { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: String(email).toLowerCase() }] }], properties: ['email', 'firstname', 'lastname'], limit: 1 };
}

function companySearch(domain) {
  return { filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: String(domain).toLowerCase() }] }], properties: ['domain', 'name'], limit: 1 };
}

function dealSearch(dealName) {
  return { filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'EQ', value: dealName }] }], properties: ['dealname', 'dealstage'], limit: 1 };
}

/** Standard properties only (a fresh HubSpot portal rejects unknown custom properties).
 *  lifecyclestage is set on create only: HubSpot refuses to move it backwards on update. */
function contactProps(lead, opts) {
  opts = opts || {};
  const n = splitName(lead.contact_name);
  const properties = {
    email: String(lead.email || '').toLowerCase(),
    firstname: n.firstname,
    lastname: n.lastname,
    company: lead.company_name || '',
    phone: lead.phone || '',
    website: lead.website || '',
    hs_lead_status: isClosing(lead.status) ? 'UNQUALIFIED' : 'IN_PROGRESS',
  };
  if (opts.create) properties.lifecyclestage = 'lead';
  return { properties };
}

function companyProps(lead) {
  return { properties: { name: lead.company_name || lead.domain, domain: lead.domain || '', phone: lead.phone || '', city: lead.city || '' } };
}

function dealName(lead) {
  return `${lead.company_name || lead.domain} – Erstgespräch (lead ${lead.lead_id || lead.id})`;
}

function dealProps(lead, meeting, ownerId) {
  const props = {
    dealname: dealName(lead),
    pipeline: 'default',
    dealstage: DEAL_STAGES[lead.status] || DEAL_STAGES['Meeting booked'],
  };
  if (meeting && meeting.start_time) props.closedate = new Date(meeting.start_time).toISOString();
  const reason = closedLostReason(lead);
  if (reason) {
    props.closed_lost_reason = reason;
    if (isClosing(lead.status)) props.closedate = new Date().toISOString();
  }
  if (ownerId) props.hubspot_owner_id = String(ownerId);
  return { properties: props };
}

function firstResultId(searchResponse) {
  const r = searchResponse && Array.isArray(searchResponse.results) ? searchResponse.results[0] : null;
  return r ? String(r.id) : null;
}

/**
 * The id of an object after create/update. HubSpot answers 409 "Contact already exists. Existing ID: 925…" when another
 * run created the contact a moment earlier (live: two syncs 0.4 s apart; HubSpot's search had not indexed it yet):
 * that existing contact IS the one we want. Any other error is returned as `error` so the workflow fails loudly.
 */
function upsertId(response) {
  const r = response || {};
  if (r.id) return { id: String(r.id), conflict: false };
  const text = JSON.stringify(r);
  const m = text.match(/Existing ID:\s*(\d+)/i);
  if (m) return { id: m[1], conflict: true };
  return { id: null, conflict: false, error: text.slice(0, 300) };
}

/**
 * The company HubSpot itself attached to the contact. With the portal setting "Create and associate companies with
 * contacts" on, HubSpot creates a company from the email domain milliseconds after the contact (live: every synced
 * lead had two companies). That company is used instead of creating a second one.
 */
function associatedId(assocResponse) {
  const r = assocResponse && Array.isArray(assocResponse.results) ? assocResponse.results[0] : null;
  const id = r && (r.toObjectId || r.id);
  return id ? String(id) : null;
}

/** Prefer the id saved in Airtable after an earlier sync (no search, so no search-index delay); else the search hit. */
function knownId(stored, searchResponse, ...more) {
  const s = String(stored || '').trim();
  if (/^\d+$/.test(s)) return s;
  for (const m of more) { if (m) return String(m); } // e.g. the company HubSpot attached to the contact
  return firstResultId(searchResponse);
}

/**
 * Which leads a run syncs.
 * - Event-triggered run (webhook with the lead's record id): only that lead, so events for different leads never overlap.
 * - The 15-minute safety run: all pending leads, but not those changed in the last 3 minutes (the event run has them).
 */
function syncFormula(scheduled, leadId) {
  const base = "OR({status}='Interested',{status}='Meeting booked',{status}='Meeting held',{status}='No-show',AND(OR({status}='Not interested',{status}='Unsubscribed'),{hubspot_deal_id}!=''))";
  const parts = [base, '{crm_synced_status}!={status}'];
  const id = String(leadId || '');
  if (!scheduled && /^rec[A-Za-z0-9]{6,20}$/.test(id)) parts.unshift("RECORD_ID()='" + id + "'");
  if (scheduled) parts.push("IS_BEFORE(LAST_MODIFIED_TIME(),DATEADD(NOW(),-3,'minutes'))");
  return 'AND(' + parts.join(',') + ')';
}

/*
 * Per-lead lock, so two runs never sync the same lead at the same time (HubSpot does not block duplicate companies or
 * deals). A run writes its id into crm_lock, waits until every run started at the same moment has written too, reads the
 * leads again and continues only with those that still carry its own id (Airtable keeps the last write, so exactly one
 * run wins). A lock older than LOCK_TTL_MS is stale (crashed run) and may be taken over. A run that loses leaves the lead
 * to the winner; if the status changed meanwhile, crm_synced_status != status and the next run syncs it again.
 */
const LOCK_TTL_MS = 2 * 60 * 1000;

function lockFree(lead, runId, now) {
  const l = lead || {};
  if (!l.crm_lock || l.crm_lock === runId) return true;
  const at = new Date(l.crm_lock_at || 0).getTime();
  return !at || new Date(now).getTime() - at > LOCK_TTL_MS;
}

/** leads (flat) → {ids, records} to claim: only leads that are not locked by another live run. */
function lockClaim(leads, runId, now) {
  const free = (leads || []).filter((l) => l && l.id && lockFree(l, runId, now));
  return { ids: free.map((l) => l.id), records: free.map((l) => ({ id: l.id, fields: { crm_lock: runId, crm_lock_at: new Date(now).toISOString() } })) };
}

/** Raw Airtable records read back after the claim → only those this run holds. */
function lockedByMe(records, runId) {
  return (records || []).filter((r) => r && r.fields && r.fields.crm_lock === runId);
}

/** Decide create vs update (PATCH) for an object. *//** Decide create vs update (PATCH) for an object. */
function upsertPlan(existingId, objectType, props) {
  return existingId
    ? { method: 'PATCH', path: `/crm/v3/objects/${objectType}/${existingId}`, body: props }
    : { method: 'POST', path: `/crm/v3/objects/${objectType}`, body: props };
}

/** Note on the deal: source campaign, status change and the email thread summary. */
function noteProps(summary, timestamp, dealId) {
  const note = { properties: { hs_note_body: String(summary || '').slice(0, 5000), hs_timestamp: new Date(timestamp || Date.now()).toISOString() } };
  if (dealId) note.associations = [{ to: { id: String(dealId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }];
  return note;
}

const crmApi = { DEAL_STAGES, CLOSING_STATUSES, isClosing, closedLostReason, splitName, contactSearch, companySearch, dealSearch, contactProps, companyProps, dealProps, dealName, firstResultId, upsertPlan, upsertId, knownId, associatedId, syncFormula, LOCK_TTL_MS, lockFree, lockClaim, lockedByMe, noteProps };
if (typeof module !== 'undefined' && module.exports) module.exports = crmApi;
