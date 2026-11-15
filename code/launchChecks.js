/**
 * launchChecks.js – Module 5 pre-launch checks and the launch plan.
 */
function domainOf(email) {
  return String(email || '').split('@')[1] || '';
}

/**
 * ctx: {campaign, leads, emails, blocklist, otherLiveContactedDomains, gmailOk, testMode, isBlocked}
 * returns {ok, failures:[{check, count, detail}], approvedLeads}
 */
function runPrelaunchChecks(ctx) {
  const failures = [];
  const minLeads = ctx.testMode ? 5 : 20;
  const approved = (ctx.leads || []).filter((l) => l.status === 'Approved');
  if (approved.length < minLeads) failures.push({ check: `At least ${minLeads} Approved leads`, count: approved.length, detail: `${approved.length} approved` });
  const emailsByLead = {};
  (ctx.emails || []).forEach((e) => {
    const id = Array.isArray(e.lead) ? e.lead[0] : e.lead_record_id || e.lead;
    (emailsByLead[id] = emailsByLead[id] || []).push(e);
  });
  const badQuality = approved.filter((l) => {
    const es = emailsByLead[l.id] || [];
    // a sequence approved by a person in the Control Center (after editing) counts as passed (approved_by set)
    return es.length !== 4 || es.some((e) => !e.approved || (Number(e.quality_score) < 80 && !e.approved_by));
  });
  if (badQuality.length) failures.push({ check: 'Every sequence passed the AI quality check', count: badQuality.length, detail: badQuality.map((l) => l.company_name).join(', ') });
  const blocked = approved.filter((l) => ctx.isBlocked(l.email, ctx.blocklist) || ctx.isBlocked('x@' + (l.domain || domainOf(l.email)), ctx.blocklist));
  if (blocked.length) failures.push({ check: 'No lead on the Blocklist', count: blocked.length, detail: blocked.map((l) => l.email).join(', ') });
  const other = new Set((ctx.otherLiveContactedDomains || []).map((d) => String(d).toLowerCase()));
  const clash = approved.filter((l) => other.has(String(l.domain || domainOf(l.email)).toLowerCase()));
  if (clash.length) failures.push({ check: 'No lead contacted in another Live campaign', count: clash.length, detail: clash.map((l) => l.domain).join(', ') });
  if (!ctx.gmailOk) failures.push({ check: 'Gmail credential works', count: 1, detail: ctx.gmailError || 'Gmail profile check failed' });
  return { ok: failures.length === 0, failures, approvedLeads: approved };
}

/** sequence_step=1, next_send_at = next slot, subject A/B alternately. */
function buildLaunchPlan(approvedLeads, firstSlotIso, campaign) {
  return approvedLeads.map((l, i) => ({
    id: l.id,
    fields: {
      sequence_step: 1,
      next_send_at: firstSlotIso,
      subject_variant: i % 2 === 0 ? 'A' : 'B',
    },
  }));
}

function failureText(campaignName, failures) {
  return `:no_entry: Campaign *${campaignName}* was not launched. ${failures.length} check(s) failed:\n` +
    failures.map((f) => `• ${f.check} – ${f.detail} (${f.count})`).join('\n') + '\nStatus is back to Ready.';
}

const launchChecksApi = { runPrelaunchChecks, buildLaunchPlan, failureText };
if (typeof module !== 'undefined' && module.exports) module.exports = launchChecksApi;
