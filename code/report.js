/**
 * report.js – Module 8 metrics: funnel, rates, costs and the per-client guarantee tracker.
 */
function linkOf(v) {
  return Array.isArray(v) ? v[0] : v;
}

const CONTACTED_OR_LATER = ['Contacted', 'Replied', 'Interested', 'Later', 'Not interested', 'Unsubscribed', 'Bounced', 'Meeting booked', 'Meeting held', 'No-show'];
const POSITIVE = ['Interested', 'Meeting booked', 'Meeting held', 'No-show'];
const MEETING = ['Meeting booked', 'Meeting held', 'No-show'];

function within(dateStr, from, to) {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  return (!from || t >= new Date(from).getTime()) && (!to || t < new Date(to).getTime());
}

function round(n, d) {
  const f = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(n * f) / f;
}

/** data: {campaigns, leads, emails, replies, meetings}; period: {from, to} (optional) */
function campaignMetrics(campaign, data, period) {
  period = period || {};
  const leads = (data.leads || []).filter((l) => linkOf(l.campaign) === campaign.id || l.campaign_record_id === campaign.id);
  const leadIds = new Set(leads.map((l) => l.id));
  const inPeriod = (d) => !period.from || within(d, period.from, period.to);
  const emails = (data.emails || []).filter((e) => leadIds.has(linkOf(e.lead)) && e.status === 'Sent' && inPeriod(e.sent_at));
  const replies = (data.replies || []).filter((r) => leadIds.has(linkOf(r.lead)) && inPeriod(r.received_at));
  const meetings = (data.meetings || []).filter((m) => leadIds.has(linkOf(m.lead)) && m.status !== 'Cancelled' && inPeriod(m.start_time || m.created_at));
  const sourced = leads.filter((l) => inPeriod(l.sourced_at)).length;
  const enriched = leads.filter((l) => l.status !== 'New' && l.status !== 'Rejected' && inPeriod(l.sourced_at)).length;
  const contactedLeads = new Set(emails.map((e) => linkOf(e.lead))).size;
  const repliedLeads = new Set(replies.filter((r) => r.category !== 'Bounce').map((r) => linkOf(r.lead))).size;
  // positive = wants to talk or asks a concrete question before agreeing (both are real interest, not auto-replies)
  const positive = replies.filter((r) => r.category === 'Interested' || r.category === 'Question').length;
  const held = meetings.filter((m) => m.status === 'Held').length;
  const cost = (Number(campaign.google_api_cost_eur) || 0) + (Number(campaign.ai_cost_eur) || 0);
  return {
    campaign_id: campaign.id,
    name: campaign.name,
    client: linkOf(campaign.client) || null,
    leads_sourced: sourced,
    enriched,
    enriched_pct: sourced ? round((enriched / sourced) * 100, 1) : 0,
    emails_sent: emails.length,
    contacted: contactedLeads,
    replied: repliedLeads,
    reply_rate_pct: contactedLeads ? round((repliedLeads / contactedLeads) * 100, 1) : 0,
    positive_replies: positive,
    meetings_booked: meetings.length,
    meetings_held: held,
    cost_eur: round(cost, 4),
    cost_per_lead_eur: sourced ? round(cost / sourced, 4) : 0,
    cost_per_meeting_eur: meetings.length ? round(cost / meetings.length, 4) : null,
    funnel: { sourced, enriched, contacted: contactedLeads, replied: repliedLeads, interested: positive, meeting_booked: meetings.length },
  };
}

function monthStart(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Positive replies and meetings this month vs. the client's targets. */
function guaranteeTracker(client, data, now) {
  const from = monthStart(now || Date.now());
  const camps = (data.campaigns || []).filter((c) => linkOf(c.client) === client.id);
  let positive = 0;
  let meetings = 0;
  camps.forEach((c) => {
    const m = campaignMetrics(c, data, { from });
    positive += m.positive_replies;
    meetings += m.meetings_booked;
  });
  const tp = Number(client.target_positive_replies) || 20;
  const tm = Number(client.target_meetings) || 4;
  return {
    client_id: client.id,
    name: client.name,
    positive_replies: positive,
    target_positive_replies: tp,
    positive_pct: round(Math.min(100, (positive / tp) * 100), 1),
    meetings,
    target_meetings: tm,
    meetings_pct: round(Math.min(100, (meetings / tm) * 100), 1),
  };
}

function progressBar(pct) {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

function weeklyFacts(data, now) {
  const to = new Date(now || Date.now());
  const from = new Date(to.getTime() - 7 * 86400000);
  return (data.campaigns || [])
    .filter((c) => ['Live', 'Paused', 'Completed', 'Ready'].includes(c.status))
    .map((c) => campaignMetrics(c, data, { from: from.toISOString(), to: to.toISOString() }));
}

const reportApi = { campaignMetrics, guaranteeTracker, progressBar, weeklyFacts, monthStart, POSITIVE, MEETING, CONTACTED_OR_LATER };
if (typeof module !== 'undefined' && module.exports) module.exports = reportApi;
