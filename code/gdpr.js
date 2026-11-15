/**
 * gdpr.js – Workflow 12: delete a lead with its emails, replies, meetings and tasks;
 * keep only a Blocklist entry so the address is never contacted again.
 */
function linkOf(v) {
  return Array.isArray(v) ? v[0] : v;
}

function deletionPlan(email, data) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return { ok: false, error: 'valid email required' };
  const leads = (data.leads || []).filter((l) => String(l.email || '').toLowerCase() === e);
  const ids = new Set(leads.map((l) => l.id));
  const byLead = (rows) => (rows || []).filter((r) => ids.has(linkOf(r.lead))).map((r) => r.id);
  const alreadyBlocked = (data.blocklist || []).some((b) => String(b.value || '').toLowerCase() === e);
  return {
    ok: true,
    email: e,
    delete: {
      Leads: leads.map((l) => l.id),
      Emails: byLead(data.emails),
      Replies: byLead(data.replies),
      Meetings: byLead(data.meetings),
      Tasks: byLead(data.tasks),
      Logs: byLead(data.logs),
    },
    blocklist: alreadyBlocked ? null : { value: e, reason: 'GDPR deletion request', added_at: new Date().toISOString() },
  };
}

const gdprApi = { deletionPlan };
if (typeof module !== 'undefined' && module.exports) module.exports = gdprApi;
