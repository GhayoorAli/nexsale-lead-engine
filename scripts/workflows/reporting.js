/** Module 8 – dashboard metrics (hourly) and the Monday 08:00 weekly report. */
const { Workflow } = require('../n8n_builder');

function reporting() {
  const w = new Workflow('08_reporting', 'Nexsale 08 – Dashboard metrics and weekly report', { description: 'Writes funnel, rates, costs and guarantee progress onto Campaigns/Clients (Airtable Interface reads them). Monday 08:00: AI summary to Slack + email.' });
  w.schedule('Every hour (metrics)', { field: 'hours', hoursInterval: 1 });
  w.at(0, 1);
  w.schedule('Monday 08:00 (weekly report)', { field: 'cronExpression', expression: '0 8 * * 1' });
  w.at(0, 2);
  w.webhook('Run now', 'reporting-run', { responseMode: 'responseNode' });
  w.at(1, 0);
  w.config();
  w.atList('Clients', 'Clients', null);
  w.atList('Campaigns', 'Campaigns', null);
  w.atList('Leads', 'Leads', null, { maxPages: 20 });
  w.atList('Emails', 'Emails', "\"{status}='Sent'\"", { maxPages: 20 });
  w.atList('Replies', 'Replies', null, { maxPages: 20 });
  w.atList('Meetings', 'Meetings', null, { maxPages: 20 });
  w.code('Metrics', ['airtable', 'report'], `
const data = {
  clients: M.airtable.fromItems($('Clients').all()), campaigns: M.airtable.fromItems($('Campaigns').all()), leads: M.airtable.fromItems($('Leads').all()),
  emails: M.airtable.fromItems($('Emails').all()), replies: M.airtable.fromItems($('Replies').all()), meetings: M.airtable.fromItems($('Meetings').all()),
};
const now = new Date();
const campaigns = data.campaigns.map((c) => M.report.campaignMetrics(c, data));
const guarantees = data.clients.map((k) => M.report.guaranteeTracker(k, data, now));
const weekly = M.report.weeklyFacts(data, now);
const hook = $('Run now').isExecuted ? ($('Run now').first().json.body || {}) : {};
const isWeekly = $('Monday 08:00 (weekly report)').isExecuted || hook.weekly === true;
return [{ json: { campaigns, guarantees, weekly, isWeekly, generated_at: now.toISOString() } }];`);
  w.code('Campaign fields', ['airtable'], `
const m = $('Metrics').first().json;
const ts = m.generated_at;
return M.airtable.updateBatches(m.campaigns.map((c) => ({ id: c.campaign_id, fields: {
  leads_sourced: c.leads_sourced, enriched_pct: c.enriched_pct, emails_sent: c.emails_sent, reply_rate_pct: c.reply_rate_pct, positive_replies: c.positive_replies,
  meetings_booked: c.meetings_booked, meetings_held: c.meetings_held, cost_per_lead_eur: c.cost_per_lead_eur, cost_per_meeting_eur: c.cost_per_meeting_eur, metrics_updated_at: ts,
} }))).map((b) => ({ json: b }));`, { alwaysOutputData: true });
  w.ifTrue('Any campaigns?', '($json.records || []).length > 0');
  w.atWrite('Write campaign metrics', 'Campaigns', 'PATCH');
  w.code('Client fields', ['airtable'], `
const m = $('Metrics').first().json;
return M.airtable.updateBatches(m.guarantees.map((g) => ({ id: g.client_id, fields: {
  positive_replies_month: g.positive_replies, meetings_month: g.meetings, positive_pct: g.positive_pct, meetings_pct: g.meetings_pct, metrics_updated_at: m.generated_at,
} }))).map((b) => ({ json: b }));`, { alwaysOutputData: true });
  w.ifTrue('Any clients?', '($json.records || []).length > 0');
  w.atWrite('Write client metrics', 'Clients', 'PATCH');
  w.code('Response', [], `return [{ json: $('Metrics').first().json }];`);
  w.respond('Respond (manual run)', "$('Metrics').first().json");
  w.ifTrue('Weekly report?', "$('Metrics').first().json.isWeekly");
  w.code('Report request', [], `
const m = $('Metrics').first().json;
const to = new Date(m.generated_at);
const from = new Date(to.getTime() - 7 * 86400000);
return [{ json: { ref: 'weekly', prompt_id: 'weekly_report', max_tokens: 500, vars: {
  period: from.toISOString().slice(0, 10) + ' bis ' + to.toISOString().slice(0, 10), facts: JSON.stringify(m.weekly.map((c) => { const x = Object.assign({}, c); delete x.funnel; return x; })),
  guarantees: JSON.stringify(m.guarantees) } } }];`);
  w.execWorkflow('AI: weekly summary', '14_ai_call');
  w.code('Report', ['report'], `
const m = $('Metrics').first().json;
const ai = $('AI: weekly summary').all().map((i) => i.json).find((x) => x && x.ref === 'weekly');
const totals = m.weekly.reduce((a, c) => ({ sent: a.sent + c.emails_sent, replied: a.replied + c.replied, positive: a.positive + c.positive_replies, meetings: a.meetings + c.meetings_booked }), { sent: 0, replied: 0, positive: 0, meetings: 0 });
const figures = 'Letzte 7 Tage: ' + totals.sent + ' E-Mails, ' + totals.replied + ' Antworten, ' + totals.positive + ' positiv, ' + totals.meetings + ' Termine.';
const bars = m.guarantees.map((g) => g.name + ': positive Antworten ' + M.report.progressBar(g.positive_pct) + ' (' + g.positive_replies + '/' + g.target_positive_replies + '), Termine ' + M.report.progressBar(g.meetings_pct) + ' (' + g.meetings + '/' + g.target_meetings + ')').join('\\n');
const summary = ai && ai.ok ? ai.data.summary : '(KI-Zusammenfassung nicht verfügbar)';
const text = ':bar_chart: *Wochenbericht*\\n' + figures + '\\n' + summary + '\\n' + bars;
const cfg = $('Config').first().json.cfg;
return [{ json: { slack: { ref: 'weekly', text }, email: { ref: 'weekly-' + m.generated_at.slice(0, 10), to: cfg.senderEmail || cfg.testProspectEmail, subject: 'Wochenbericht Outbound', body: text.replace(/[*:]bar_chart[*:]?/g, '').replace(/\\*/g, ''), purpose: 'internal' } } }];`);
  w.code('Slack report', [], `return [{ json: $('Report').first().json.slack }];`);
  w.execWorkflow('Post report', '15_slack_notify');
  w.code('Email report', [], `return [{ json: $('Report').first().json.email }];`);
  w.execWorkflow('Send report (guarded)', '13_send_email');

  w.connect('Every hour (metrics)', 'Config');
  w.connect('Monday 08:00 (weekly report)', 'Config');
  w.connect('Run now', 'Config');
  w.chain('Config', 'Clients', 'Campaigns', 'Leads', 'Emails', 'Replies', 'Meetings', 'Metrics', 'Campaign fields', 'Any campaigns?');
  w.connect('Any campaigns?', 'Write campaign metrics', 0);
  w.connect('Any campaigns?', 'Client fields', 1);
  w.connect('Write campaign metrics', 'Client fields');
  w.connect('Client fields', 'Any clients?');
  w.connect('Any clients?', 'Write client metrics', 0);
  w.connect('Any clients?', 'Response', 1);
  w.connect('Write client metrics', 'Response');
  w.connect('Response', 'Weekly report?');
  w.connect('Weekly report?', 'Report request', 0);
  w.connect('Weekly report?', 'Respond (manual run)', 1);
  w.chain('Report request', 'AI: weekly summary', 'Report', 'Slack report', 'Post report', 'Email report', 'Send report (guarded)');
  // manual webhook runs always get a response (also after the weekly report)
  w.connect('Send report (guarded)', 'Respond (manual run)');
  return w;
}

function dashboard() {
  const w = new Workflow('08b_dashboard', 'Nexsale 08b – Live dashboard', { description: 'GET /webhook/dashboard[?client=<id>]: guarantee (replies vs 20, meetings vs 4–5) with pace, KPIs, funnel, campaigns, A/B subject test, recent replies, upcoming meetings. Computed live from Airtable.' });
  w.webhook('Dashboard request', 'dashboard', { method: 'GET', responseMode: 'responseNode' });
  w.config();
  ['Clients', 'Campaigns', 'Leads', 'Emails', 'Replies', 'Meetings'].forEach((t) => w.atList(t, t, null, { maxPages: 20 }));
  w.code('Render dashboard', ['airtable', 'report', 'dashboard'], `
const q = $('Dashboard request').first().json.query || {};
const all = (n) => M.airtable.fromItems($(n).all());
return [{ json: { html: M.dashboard.renderDashboard({ clients: all('Clients'), campaigns: all('Campaigns'), leads: all('Leads'), emails: all('Emails'),
  replies: all('Replies'), meetings: all('Meetings'), clientId: String(q.client || '').replace(/[^A-Za-z0-9]/g, ''), now: new Date().toISOString() }) } }];`);
  w.respond('Show dashboard', '$json.html', { html: true });
  w.chain('Dashboard request', 'Config', 'Clients', 'Campaigns', 'Leads', 'Emails', 'Replies', 'Meetings', 'Render dashboard', 'Show dashboard');
  return w;
}

module.exports = [reporting, dashboard];
