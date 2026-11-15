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

/** Decide create vs update (PATCH) for an object. */
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

const crmApi = { DEAL_STAGES, CLOSING_STATUSES, isClosing, closedLostReason, splitName, contactSearch, companySearch, dealSearch, contactProps, companyProps, dealProps, dealName, firstResultId, upsertPlan, noteProps };
if (typeof module !== 'undefined' && module.exports) module.exports = crmApi;
