/** Module 5 – campaign launch (click 3 lands here) and Module 6 – sending and follow-ups. */
const { Workflow, CFG } = require('../n8n_builder');

function campaignLaunch() {
  const w = new Workflow('05_campaign_launch', 'Nexsale 05 – Campaign launch (pre-launch checks)', { description: 'Status Launch → 5 checks → Live (or back to Ready with the reasons in Slack).' });
  w.webhook('Launch webhook', 'campaign-launch');
  w.at(0, 1);
  w.schedule('Every 5 minutes', { field: 'minutes', minutesInterval: 5 });
  w.at(1, 0);
  w.config();
  w.atList('Campaigns to launch', 'Campaigns', "\"{status}='Launch'\"", { maxRecords: 1, maxPages: 1, notes: 'Set to Launch by the Slack button (Module 11) or an Airtable Interface button' });
  w.code('Pick campaign', ['airtable'], `
const c = M.airtable.fromItems($('Campaigns to launch').all())[0];
return c ? [{ json: { campaign: c } }] : [];`);
  w.atList('Campaign leads', 'Leads', "\"{campaign_record_id}='\" + $('Pick campaign').first().json.campaign.id + \"'\"");
  w.atList('Campaign emails', 'Emails', "\"{campaign_record_id}='\" + $('Pick campaign').first().json.campaign.id + \"'\"");
  w.atList('Blocklist', 'Blocklist', null);
  w.atList('Live campaigns', 'Campaigns', "\"{status}='Live'\"");
  w.atList('Contacted leads', 'Leads', "\"{status}='Contacted'\"");
  w.ifTrue('Mock?', CFG('mock'));
  w.at(9, 1);
  w.http('Gmail profile (mock)', { method: 'GET', url: `={{ ${CFG('gmailUrl')} }}/users/me/profile`, neverError: true, fullResponse: true, continueOnFail: true });
  w.at(9, -1);
  w.http('Gmail profile', { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', credential: 'gmailOAuth2', credentialName: 'Gmail sender', neverError: true, fullResponse: true, continueOnFail: true,
    notes: 'Check 5: the Gmail credential works (profile call, no email sent)' });
  w.at(10, 0);
  w.code('Pre-launch checks', ['airtable', 'launchChecks', 'guard'], `
const cfg = $('Config').first().json.cfg;
const c = $('Pick campaign').first().json.campaign;
const live = new Set(M.airtable.fromItems($('Live campaigns').all()).filter((x) => x.id !== c.id).map((x) => x.id));
const contactedDomains = M.airtable.fromItems($('Contacted leads').all()).filter((l) => live.has(l.campaign_record_id)).map((l) => l.domain);
const g = $input.first().json;
const gmailOk = Number(g.statusCode) === 200 && !!(g.body && g.body.emailAddress);
const r = M.launchChecks.runPrelaunchChecks({
  campaign: c, leads: M.airtable.fromItems($('Campaign leads').all()), emails: M.airtable.fromItems($('Campaign emails').all()),
  blocklist: M.airtable.fromItems($('Blocklist').all()), otherLiveContactedDomains: contactedDomains, gmailOk,
  gmailError: gmailOk ? '' : 'Gmail profile check returned ' + (g.statusCode || g.error && g.error.message || 'an error'),
  testMode: !!cfg.testLeadLimit || cfg.demoMode, isBlocked: M.guard.isBlocked,
});
return [{ json: { ok: r.ok, failures: r.failures, approvedIds: r.approvedLeads.map((l) => l.id), campaign: c } }];`);
  w.ifTrue('All checks pass?', '$json.ok');
  w.code('Launch plan', ['launchChecks', 'schedule', 'airtable'], `
const cfg = $('Config').first().json.cfg;
const r = $('Pre-launch checks').first().json;
const leads = M.airtable.fromItems($('Campaign leads').all()).filter((l) => r.approvedIds.includes(l.id));
const slot = M.schedule.nextSendSlot(new Date(), { demoMode: cfg.demoMode }).toISOString();
const plan = M.launchChecks.buildLaunchPlan(leads, slot, r.campaign);
return M.airtable.updateBatches(plan).map((b) => ({ json: Object.assign(b, { slot, count: leads.length }) }));`);
  w.atWrite('Schedule first emails', 'Leads', 'PATCH');
  w.code('Campaign Live', [], `
const r = $('Pre-launch checks').first().json;
const p = $('Launch plan').first().json;
return [{ json: { records: [{ id: r.campaign.id, fields: { status: 'Live', launched_at: new Date().toISOString(), launch_failures: null } }],
  slack: { ref: r.campaign.id, text: ':white_check_mark: Campaign *' + r.campaign.name + '* is live: ' + p.count + ' leads, first emails go out ' + (new Date(p.slot) - Date.now() < 3600000 ? 'today' : 'at ' + p.slot) + '.' } } }];`);
  w.atWrite('Set Live', 'Campaigns', 'PATCH');
  w.code('Live message', [], `return [{ json: $('Campaign Live').first().json.slack }];`);
  w.execWorkflow('Post Live', '15_slack_notify');
  w.kick('Start sending', 'sending-run');
  w.at(12, 2);
  w.code('Failed checks', ['launchChecks'], `
const r = $('Pre-launch checks').first().json;
return [{ json: { records: [{ id: r.campaign.id, fields: { status: 'Ready', launch_failures: r.failures.map((f) => f.check + ': ' + f.detail + ' (' + f.count + ')').join('\\n') } }],
  slack: { ref: r.campaign.id, text: M.launchChecks.failureText(r.campaign.name, r.failures) } } }];`);
  w.atWrite('Back to Ready', 'Campaigns', 'PATCH');
  w.code('Failure message', [], `return [{ json: $('Failed checks').first().json.slack }];`);
  w.execWorkflow('Post failures', '15_slack_notify');

  w.connect('Launch webhook', 'Config');
  w.connect('Every 5 minutes', 'Config');
  w.chain('Config', 'Campaigns to launch', 'Pick campaign', 'Campaign leads', 'Campaign emails', 'Blocklist', 'Live campaigns', 'Contacted leads', 'Mock?');
  w.connect('Mock?', 'Gmail profile (mock)', 0);
  w.connect('Mock?', 'Gmail profile', 1);
  w.connect('Gmail profile (mock)', 'Pre-launch checks');
  w.connect('Gmail profile', 'Pre-launch checks');
  w.connect('Pre-launch checks', 'All checks pass?');
  w.connect('All checks pass?', 'Launch plan', 0);
  w.connect('All checks pass?', 'Failed checks', 1);
  w.chain('Launch plan', 'Schedule first emails', 'Campaign Live', 'Set Live', 'Live message', 'Post Live', 'Start sending');
  w.chain('Failed checks', 'Back to Ready', 'Failure message', 'Post failures');
  return w;
}

function sending() {
  const w = new Workflow('06_sending', 'Nexsale 06 – Sending and follow-ups', { description: 'Mon–Fri 08:00–17:00 every 15 min (DEMO_MODE: every minute, days = minutes). One email at a time, guarded.' });
  w.schedule('Every 15 min (business hours)', { field: 'cronExpression', expression: '*/15 8-16 * * 1-5' });
  w.at(0, 1);
  w.schedule('Every minute (demo mode)', { field: 'cronExpression', expression: '* * * * *' });
  w.at(0, 2);
  w.webhook('Run now', 'sending-run');
  w.at(1, 0);
  w.config();
  w.ifTrue('Bounce check?', "$('Daily 17:30').isExecuted || $('Bounce check now').isExecuted");
  w.code('Gate', ['schedule'], `
const cfg = $('Config').first().json.cfg;
const demoTick = $('Every minute (demo mode)').isExecuted;
const realTick = $('Every 15 min (business hours)').isExecuted;
const hook = !demoTick && !realTick;
if (demoTick && !(cfg.demoMode && cfg.demoTicker)) return [];  // the demo ticker runs only in DEMO_MODE
if (realTick && cfg.demoMode) return [];                       // the business-hours ticker is idle in DEMO_MODE
if (hook && cfg.demoMode && cfg.demoTicker) return [];         // ticker active: a webhook run would overlap it
if (!cfg.demoMode && !M.schedule.isSendWindow(new Date())) return [];
return [{ json: { run: true } }];`, { notes: 'Real mode: Mon–Fri 08:00–17:00 Berlin only. DEMO_MODE: every minute.' });
  w.atList('Live campaigns', 'Campaigns', "\"{status}='Live'\"");
  w.code('Any live?', ['airtable'], `
const camps = M.airtable.fromItems($('Live campaigns').all());
return camps.length ? [{ json: { ids: camps.map((c) => c.id) } }] : [];`);
  w.atList('Sendable leads', 'Leads', "\"AND(OR({status}='Approved',{status}='Contacted'),NOT({sequence_finished}))\"");
  w.atList('Emails of live campaigns', 'Emails', "'OR(' + $('Any live?').first().json.ids.map((id) => \"{campaign_record_id}='\" + id + \"'\").join(',') + ')'");
  w.atList('Replies', 'Replies', null, { maxPages: 3 });
  w.atList('Blocklist', 'Blocklist', null);
  w.atList('Clients', 'Clients', null);
  w.code('Select due emails', ['airtable', 'sending', 'guard', 'schedule'], `
const cfg = $('Config').first().json.cfg;
const now = new Date();
const today = M.schedule.berlinDate(now);
const campaigns = M.airtable.fromItems($('Live campaigns').all());
const emails = M.airtable.fromItems($('Emails of live campaigns').all());
const sentToday = {};
emails.filter((e) => e.status === 'Sent' && e.sent_at && M.schedule.berlinDate(e.sent_at) === today).forEach((e) => { sentToday[e.campaign_record_id] = (sentToday[e.campaign_record_id] || 0) + 1; });
const r = M.sending.selectDue({
  leads: M.airtable.fromItems($('Sendable leads').all()), campaigns, emails, replies: M.airtable.fromItems($('Replies').all()),
  blocklist: M.airtable.fromItems($('Blocklist').all()), sentTodayByCampaign: sentToday, now, isBlocked: M.guard.isBlocked, maxPerRun: cfg.maxSendsPerRun, demoMode: cfg.demoMode,
});
const clients = M.airtable.fromItems($('Clients').all());
return r.due.map((d) => {
  const client = clients.find((k) => k.id === d.campaign.client_record_id) || clients[0];
  const msg = M.sending.buildMessage(d, cfg, client);
  return { json: { ref: d.email.id, msg: Object.assign({ ref: d.email.id }, msg), item: d, delay: M.schedule.randomDelaySeconds(cfg) } };
});`);
  w.loop('One at a time', 1);
  w.at(14, 1);
  w.atGet('Re-read email', 'Emails', "$json.ref");
  w.ifTrue('Still unsent?', "$json.fields && $json.fields.status === 'Approved'");
  w.code('Message', [], `return [{ json: $('One at a time').first().json.msg }];`);
  w.execWorkflow('Send (guarded)', '13_send_email', { alwaysOutputData: false });
  w.code('After send', ['sending', 'schedule'], `
const cfg = $('Config').first().json.cfg;
const cur = $('One at a time').first().json;
const res = $input.first().json;
if (!res.ok) throw new Error('send failed for email ' + cur.ref);
const u = M.sending.afterSend(cur.item, res, new Date().toISOString(), M.schedule, { demoMode: cfg.demoMode });
u.email.fields.sent_to = res.sent_to;
u.email.fields.original_to = res.original_to;
return [{ json: { email: u.email, lead: u.lead, delay: Math.max(1, cur.delay) } }];`);
  w.atWrite('Save email as Sent', 'Emails', 'PATCH', { body: '{ records: [$json.email], typecast: true }' });
  w.atWrite('Advance lead', 'Leads', 'PATCH', { body: "{ records: [$('After send').first().json.lead], typecast: true }" });
  w.wait('Pause between sends', "$('After send').first().json.delay");
  w.at(15, 0);
  w.code('Done', [], `return [{ json: { sent: $('One at a time').all().length } }];`);

  // daily bounce safety check (17:30)
  w.at(0, 4);
  w.schedule('Daily 17:30', { field: 'cronExpression', expression: '30 17 * * *' });
  w.at(0, 5);
  w.webhook('Bounce check now', 'bounce-check');
  w.at(3, 4);
  w.atList('Live campaigns (bounce)', 'Campaigns', "\"{status}='Live'\"");
  w.atList('Bounced leads', 'Leads', "\"{status}='Bounced'\"");
  w.atList('Sent emails', 'Emails', "\"{status}='Sent'\"");
  w.code('Bounce rate', ['airtable', 'sending', 'schedule'], `
const today = M.schedule.berlinDate(new Date());
const camps = M.airtable.fromItems($('Live campaigns (bounce)').all());
const emails = M.airtable.fromItems($('Sent emails').all()).filter((e) => e.sent_at && M.schedule.berlinDate(e.sent_at) === today);
const leads = M.airtable.fromItems($('Bounced leads').all()).filter((l) => l.bounced_at && M.schedule.berlinDate(l.bounced_at) === today);
const out = [];
camps.forEach((c) => {
  const sent = emails.filter((e) => e.campaign_record_id === c.id).length;
  const bounced = leads.filter((l) => l.campaign_record_id === c.id).length;
  const r = M.sending.bounceCheck(sent, bounced);
  if (r.pause) out.push({ json: { records: [{ id: c.id, fields: { status: 'Paused' } }], slack: { ref: c.id, text: ':warning: Campaign *' + c.name + '* paused: bounce rate ' + (r.rate * 100).toFixed(1) + '% today (' + bounced + '/' + sent + '), limit 3%' } } });
});
return out;`);
  w.atWrite('Pause campaign', 'Campaigns', 'PATCH');
  w.code('Pause message', [], `return $('Bounce rate').all().map((i) => ({ json: i.json.slack }));`);
  w.execWorkflow('Alert Slack', '15_slack_notify');

  w.connect('Every 15 min (business hours)', 'Config');
  w.connect('Every minute (demo mode)', 'Config');
  w.connect('Run now', 'Config');
  w.connect('Daily 17:30', 'Config');
  w.connect('Bounce check now', 'Config');
  w.connect('Config', 'Bounce check?');
  w.connect('Bounce check?', 'Live campaigns (bounce)', 0);
  w.connect('Bounce check?', 'Gate', 1);
  w.chain('Gate', 'Live campaigns', 'Any live?', 'Sendable leads', 'Emails of live campaigns', 'Replies', 'Blocklist', 'Clients', 'Select due emails', 'One at a time');
  w.connect('One at a time', 'Done', 0);
  w.connect('One at a time', 'Re-read email', 1);
  w.connect('Re-read email', 'Still unsent?');
  w.connect('Still unsent?', 'Message', 0);
  w.connect('Still unsent?', 'One at a time', 1);
  w.chain('Message', 'Send (guarded)', 'After send', 'Save email as Sent', 'Advance lead', 'Pause between sends', 'One at a time');
  w.chain('Live campaigns (bounce)', 'Bounced leads', 'Sent emails', 'Bounce rate', 'Pause campaign', 'Pause message', 'Alert Slack');
  return w;
}

module.exports = [campaignLaunch, sending];
