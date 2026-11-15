const crypto = require('crypto');
const CC = require('../controlCenter');

const now = '2026-11-15T12:00:00.000Z';
const data = () => ({
  clients: [{ id: 'cN', name: 'Nexsale GmbH', is_default: true, sender_name: 'David Gretschmann', offer: 'Neukunden', target_positive_replies: 20, target_meetings: 4 },
    { id: 'cR', name: 'Real Service GmbH', sender_name: 'Laura Schmidt', offer: 'Reinigung', target_positive_replies: 20, target_meetings: 4 }],
  campaigns: [{ id: 'k1', name: 'Reinigung Leipzig', client: ['cN'], client_record_id: 'cN', status: 'Ready', industry: 'Reinigungsunternehmen', city: 'Leipzig', created_at: '2026-11-14' },
    { id: 'k2', name: 'HV Berlin <b>', client: ['cR'], client_record_id: 'cR', status: 'Live', industry: 'Hausverwaltung', city: 'Berlin', created_at: '2026-11-15' }],
  leads: [{ id: 'L1', campaign: ['k1'], campaign_record_id: 'k1', status: 'Approved', company_name: 'Glanz <script>', contact_name: 'Max Muster', score: 70, quality_score: 90, email: 'info@glanz.de' },
    { id: 'L2', campaign: ['k2'], campaign_record_id: 'k2', status: 'Contacted', company_name: 'HV Pankow', contact_name: 'Petra Klein', contact_salutation: 'Frau', meeting_brief: 'Briefing Text' },
    { id: 'L3', campaign: ['k1'], campaign_record_id: 'k1', status: 'Rejected', company_name: 'Leer', reject_reason: 'no email found in Impressum' }],
  emails: [{ id: 'E1', lead: ['L1'], lead_record_id: 'L1', step: 1, subject: 'Betreff', body: 'Text 1', status: 'Approved' }, { id: 'E2', lead: ['L1'], lead_record_id: 'L1', step: 2, subject: 'B2', body: 'Text 2', status: 'Approved' },
    { id: 'E3', lead: ['L2'], lead_record_id: 'L2', step: 1, subject: 'S', body: 'x', status: 'Sent' }],
  replies: [{ id: 'R1', lead: ['L2'], lead_record_id: 'L2', category: 'Question', suggested_reply: 'Entwurf', body: 'Was kostet das?', received_at: '2026-11-15T10:00:00Z', ai_confidence: 0.9 },
    { id: 'R2', lead: ['L2'], lead_record_id: 'L2', category: 'Unclear', branch: 'Unsure', body: 'Wer sind Sie?', received_at: '2026-11-15T11:00:00Z' },
    { id: 'R3', lead: ['L2'], lead_record_id: 'L2', category: 'Interested', suggested_reply: 'X', reply_approved: true, body: 'Gern', received_at: '2026-11-14T11:00:00Z' }],
  meetings: [{ id: 'M1', lead: ['L2'], lead_record_id: 'L2', status: 'Booked', start_time: '2026-11-15T09:00:00Z' }, { id: 'M2', lead: ['L2'], lead_record_id: 'L2', status: 'Booked', start_time: '2026-11-20T09:00:00Z' }],
  tasks: [{ id: 'T1', type: 'Follow up referral', key: 'Referral · HV', status: 'Open', due_at: '2026-11-16T09:00:00Z', summary: 'Frau Klein' }],
  logs: [{ id: 'G1', level: 'error', workflow: '03_enrichment', message: 'Timeout', created_at: '2026-11-15T08:00:00Z' }],
});
const render = (page, params) => CC.renderPage({ page, params: params || {}, data: data(), cfg: { demoMode: true, allowlistCount: 2, aiModel: 'gpt-4o-mini' }, now, user: 'admin' });
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');

describe('login (HTTP Basic, constant-time)', () => {
  test('right user and password', () => expect(CC.checkAuth(basic('admin', 's3cret!'), 'admin', 's3cret!', crypto)).toMatchObject({ ok: true, user: 'admin' }));
  test('wrong password, wrong user, no header, broken header', () => {
    expect(CC.checkAuth(basic('admin', 'nope'), 'admin', 's3cret!', crypto).ok).toBe(false);
    expect(CC.checkAuth(basic('root', 's3cret!'), 'admin', 's3cret!', crypto).ok).toBe(false);
    expect(CC.checkAuth('', 'admin', 's3cret!', crypto).reason).toBe('login required');
    expect(CC.checkAuth('Bearer x', 'admin', 's3cret!', crypto).ok).toBe(false);
  });
  test('no password configured = locked for everyone', () => expect(CC.checkAuth(basic('admin', ''), 'admin', '', crypto)).toMatchObject({ ok: false, reason: 'CONTROL_PASSWORD is not set in .env' }));
  test('default user is admin; password may contain ":"', () => expect(CC.checkAuth(basic('admin', 'a:b'), '', 'a:b', crypto).ok).toBe(true));
});

describe('pages', () => {
  test('overview: to-do list, guarantee per client, test-mode banner', () => {
    const h = render('overview');
    expect(h).toMatch(/1 Antwort\(en\) zur Freigabe/);
    expect(h).toMatch(/1 unklare Antwort\(en\) zu sortieren/);
    expect(h).toMatch(/Bereit zum Start: <a href="\?p=campaign&amp;id=k1"|Bereit zum Start: <a href="\?p=campaign&id=k1"/);
    expect(h).toMatch(/1 Termin\(e\): stattgefunden oder No-show\?/);
    expect(h).toMatch(/1 offene Aufgabe/);
    expect(h).toMatch(/Testmodus: alle E-Mails nur an die Test-Inbox/);
    expect(h).toMatch(/Nexsale GmbH<\/b><div class="muted">Garantie/);
  });
  test('campaigns: buttons follow the status', () => {
    const h = render('campaigns');
    expect(h).toMatch(/value="campaign_launch"/); // k1 Ready
    expect(h).toMatch(/value="campaign_pause"/); // k2 Live
    expect(h).not.toMatch(/value="campaign_resume"/);
    expect(h).toMatch(/HV Berlin &lt;b&gt;/);
  });
  test('campaign: leads with reason, kpis, live status link', () => {
    const h = render('campaign', { id: 'k1' });
    expect(h).toMatch(/Glanz &lt;script&gt;/);
    expect(h).not.toMatch(/Glanz <script>/);
    expect(h).toMatch(/no email found in Impressum/);
    expect(h).toMatch(/\/webhook\/campaign-status\?id=k1/);
    expect(render('campaign', { id: 'nope' })).toMatch(/Kampagne nicht gefunden/);
  });
  test('lead: emails, rewrite only before launch, exclude', () => {
    const h = render('lead', { id: 'L1' });
    expect(h).toMatch(/E-Mail 1: Betreff/);
    expect(h).toMatch(/value="lead_rewrite"/);
    expect(h).toMatch(/value="lead_exclude"/);
    const h2 = render('lead', { id: 'L2' });
    expect(h2).not.toMatch(/value="lead_rewrite"/); // contacted in a live campaign
    expect(h2).toMatch(/Meeting-Briefing/);
    expect(render('lead', { id: 'x' })).toMatch(/Lead nicht gefunden/);
  });
  test('replies: approval with editable text, sorting, history', () => {
    const h = render('replies');
    expect(h).toMatch(/<textarea name="text">Entwurf<\/textarea>/);
    expect(h).toMatch(/value="reply_sort"/);
    expect(h).toMatch(/Wer sind Sie\?/);
    expect(h).not.toMatch(/name="id" value="R3"/); // already answered automatically
  });
  test('meetings: held/no-show only after the start time', () => {
    const h = render('meetings');
    expect((h.match(/value="meeting_held"/g) || []).length).toBe(1);
    expect(h).toMatch(/Briefing Text/);
  });
  test('meetings: "Termin absagen" only on upcoming booked meetings, with a confirm', () => {
    const h = render('meetings');
    expect((h.match(/value="meeting_cancel"/g) || []).length).toBe(1);
    expect(h).toMatch(/name="action" value="meeting_cancel"><input type="hidden" name="id" value="M2">/);
    expect(h).toMatch(/confirm\('Termin wirklich absagen\?/);
    expect(CC.cancellable({ status: 'Reminded', start_time: '2026-11-16T09:00:00Z' }, now)).toBe(true);
    expect(CC.cancellable({ status: 'Cancelled', start_time: '2026-11-16T09:00:00Z' }, now)).toBe(false);
    expect(CC.cancellable({ status: 'Booked', start_time: '2026-11-15T09:00:00Z' }, now)).toBe(false);
  });
  test('clients list and edit form; new client form', () => {
    expect(render('clients')).toMatch(/Nexsale GmbH<\/b><\/a> <span class="badge info">Standard/);
    const f = render('client', { id: 'cR' });
    expect(f).toMatch(/name="offer" required>Reinigung<\/textarea>/);
    expect(render('client', { id: 'new' })).toMatch(/Neuer Client/);
    expect(render('client', { id: 'x' })).toMatch(/Client nicht gefunden/);
  });
  test('new campaign: client dropdown with the default preselected', () => {
    const h = render('new-campaign');
    expect(h).toMatch(/<option value="Nexsale GmbH" selected>Nexsale GmbH \(Standard\)<\/option>/);
    expect(h).toMatch(/<option value="Real Service GmbH">/);
  });
  test('system: safety flags, tasks, errors; unknown page falls back to overview', () => {
    const h = render('system');
    expect(h).toMatch(/Testmodus \(DEMO_MODE\)<\/th><td><span class="badge good">an/);
    expect(h).toMatch(/Timeout/);
    expect(h).toMatch(/value="task_done"/);
    expect(render('does-not-exist')).toMatch(/<h1>Übersicht<\/h1>/);
    expect(CC.renderPage()).toMatch(/<h1>Übersicht<\/h1>/);
  });
  test('flash message after an action is escaped', () => {
    expect(render('overview', { msg: '<b>ok</b>' })).toMatch(/flash good">&lt;b&gt;ok&lt;\/b&gt;/);
    expect(render('overview', { msg: 'x', err: '1' })).toMatch(/flash bad/);
  });
});

describe('actions', () => {
  const plan = (form) => CC.planAction(form, data(), { user: 'admin', defaultMax: 10, now });
  test('client_save: new client, validation, unique name, single default', () => {
    const base = { action: 'client_save', id: '', name: 'Müller GmbH', sender_name: 'Tom', sender_company_footer: 'Müller GmbH · Berlin', offer: 'Reinigung', target_positive_replies: '20', target_meetings: '4' };
    const p = plan(base);
    expect(p.ops).toHaveLength(1);
    expect(p.ops[0]).toMatchObject({ kind: 'airtable', method: 'POST', table: 'Clients' });
    expect(p.ops[0].body.records[0].fields).toMatchObject({ name: 'Müller GmbH', target_positive_replies: 20, is_default: false, sender_phone: null });
    expect(plan(Object.assign({}, base, { offer: '' })).error).toMatch(/Bitte ausfüllen: Angebot/);
    expect(plan(Object.assign({}, base, { name: 'nexsale gmbh' })).error).toMatch(/schon einen Client/);
    expect(plan(Object.assign({}, base, { target_meetings: '2.5' })).error).toMatch(/ganze Zahlen/);
    expect(plan(Object.assign({}, base, { calendly_link: 'calendly.com/x' })).error).toMatch(/https:\/\//);
    const d = plan(Object.assign({}, base, { id: 'cR', is_default: '1', name: 'Real Service GmbH' }));
    expect(d.ops[0].body.records).toEqual([{ id: 'cN', fields: { is_default: false } }]);
    expect(d.ops[1]).toMatchObject({ method: 'PATCH', table: 'Clients' });
  });
  test('campaign_create: validated like the form, default client, then sourcing starts', () => {
    const p = plan({ action: 'campaign_create', name: 'Test', client: '', industry: 'Hausverwaltung', city: 'Berlin', company_size: '10-49', target_role: 'Objektbetreuung', max_leads: '' });
    expect(p.ops[0].body.records[0].fields).toMatchObject({ client_record_id: 'cN', max_leads: 10, status: 'Sourcing' });
    expect(p.after).toBe('campaign_created');
    const a = CC.afterAction(p, [{ records: [{ id: 'kNew' }] }]);
    expect(a.ops).toEqual([{ kind: 'kick', path: 'lead-sourcing', body: { campaign_record_id: 'kNew' } }]);
    expect(a.redirect).toMatch(/p=campaign&id=kNew/);
    expect(CC.afterAction(p, []).redirect).toMatch(/err=1/);
    expect(plan({ action: 'campaign_create', name: 'X', client: 'Real Service GmbH', industry: 'A', city: 'B', company_size: '10-49', target_role: 'C', max_leads: '12' }).ops[0].body.records[0].fields.client_record_id).toBe('cR');
    expect(plan({ action: 'campaign_create', name: 'X', client: 'Unbekannt', industry: 'A', city: 'B', company_size: '10-49', target_role: 'C' }).error).toMatch(/Unbekannter Client/);
    expect(plan({ action: 'campaign_create', name: '', industry: '', city: '' }).error).toMatch(/Kampagnenname fehlt/);
  });
  test('launch / pause / resume / stop follow the status rules', () => {
    expect(plan({ action: 'campaign_launch', id: 'k1' }).ops).toEqual([{ kind: 'kick', path: 'control-action', body: { action: 'approve_launch', recordId: 'k1', user: 'Control Center (admin)' } }]);
    expect(plan({ action: 'campaign_launch', id: 'k2' }).error).toMatch(/Nicht möglich bei Status "Live"/);
    expect(plan({ action: 'campaign_pause', id: 'k2' }).ops[0].body.records[0].fields.status).toBe('Paused');
    expect(plan({ action: 'campaign_resume', id: 'k2' }).error).toMatch(/Nicht möglich/);
    expect(plan({ action: 'campaign_stop', id: 'k2', back: 'campaigns' })).toMatchObject({ redirect: expect.stringMatching(/^\?p=campaigns/) });
    expect(plan({ action: 'campaign_stop', id: 'zz' }).error).toMatch(/nicht gefunden/);
  });
  test('lead_exclude stops sending; lead_rewrite deletes unsent emails and redrafts, only before launch', () => {
    const x = plan({ action: 'lead_exclude', id: 'L2' });
    expect(x.ops[0].body.records[0].fields).toMatchObject({ status: 'Rejected', next_send_at: null });
    const r = plan({ action: 'lead_rewrite', id: 'L1' });
    expect(r.ops[0]).toMatchObject({ kind: 'airtable', method: 'DELETE', table: 'Emails', query: 'records[]=E1&records[]=E2' });
    expect(r.ops[1].body.records[0].fields).toMatchObject({ status: 'Enriched', quality_score: null });
    expect(r.ops[2]).toEqual({ kind: 'kick', path: 'ai-emails-run', body: {} });
    expect(plan({ action: 'lead_rewrite', id: 'L2' }).error).toMatch(/vor dem Start/);
    expect(plan({ action: 'lead_exclude', id: 'zz' }).error).toMatch(/nicht gefunden/);
  });
  test('replies: approve (with edited text), reject, sort; never twice', () => {
    const a = plan({ action: 'reply_approve', id: 'R1', text: 'Neuer Text\r\n' });
    expect(a.ops[0].body.records[0].fields.suggested_reply).toBe('Neuer Text');
    expect(a.ops[1].body).toMatchObject({ action: 'reply_approve', recordId: 'R1' });
    expect(plan({ action: 'reply_approve', id: 'R1', text: 'Entwurf' }).ops).toHaveLength(1); // unchanged text: no PATCH
    expect(plan({ action: 'reply_approve', id: 'R1', text: '  ' }).error).toMatch(/nicht leer/);
    expect(plan({ action: 'reply_approve', id: 'R3', text: 'x' }).error).toMatch(/bereits bearbeitet/);
    expect(plan({ action: 'reply_reject', id: 'R1' }).ops[0].body.action).toBe('reply_reject');
    expect(plan({ action: 'reply_sort', id: 'R2', category: 'Later' }).ops[0].body.action).toBe('sort_later');
    expect(plan({ action: 'reply_sort', id: 'R2', category: 'Spam' }).error).toMatch(/Unbekannte Kategorie/);
  });
  test('meetings and tasks; unknown action', () => {
    expect(plan({ action: 'meeting_noshow', id: 'M1' }).ops[0].body.action).toBe('meeting_noshow');
    expect(plan({ action: 'task_done', id: 'T1' }).ops[0].body.action).toBe('task_called');
    expect(plan({ action: 'task_done', id: 'x' }).error).toMatch(/nicht gefunden/);
    expect(plan({ action: 'meeting_held', id: 'x' }).error).toMatch(/nicht gefunden/);
    expect(plan({ action: 'meeting_cancel', id: 'M2' }).ops).toEqual([expect.objectContaining({ kind: 'kick', path: 'control-action', body: expect.objectContaining({ action: 'meeting_cancel', recordId: 'M2' }) })]);
    expect(plan({ action: 'meeting_cancel', id: 'M1' }).error).toMatch(/nicht mehr abgesagt/); // already started
    expect(plan({ action: 'meeting_cancel', id: 'x' }).error).toMatch(/nicht gefunden/);
    expect(plan({ action: 'hack' }).error).toBe('Unbekannte Aktion');
    expect(CC.planAction().error).toBe('Unbekannte Aktion');
  });
});

test('no link opens a new tab (n8n sandboxes webhook pages; a new tab would inherit the sandbox)', () => {
  ['overview', 'campaigns', 'system', 'replies', 'meetings', 'clients', 'new-campaign'].forEach((p) => expect(render(p)).not.toMatch(/target="_blank"/));
  expect(render('campaign', { id: 'k1' })).not.toMatch(/_blank/);
  expect(render('lead', { id: 'L1' })).not.toMatch(/_blank/);
  expect(render('system')).toMatch(/<a href="\/">n8n \(Workflows, Ausführungen\)<\/a>/);
});

describe('editing emails by hand, approving a held lead, rewriting a campaign', () => {
  const VE = require('../validateEmails');
  const client = { id: 'cR', name: 'Real Service GmbH', sender_name: 'Laura Schmidt', sender_title: 'Vertrieb', sender_company: 'Real Service GmbH', sender_company_footer: 'Real Service GmbH · Berlin', offer: 'Reinigung', writing_notes: 'kurz' };
  const footer = VE.buildFooter(client);
  const mk = (text) => VE.appendFooter(VE.ensureFrame(text, { contactName: 'Petra Klein', contactSalutation: 'Frau', signature: VE.buildSignature(client), paragraphs: true }), footer);
  const good1 = 'Sie betreuen Wohnanlagen in Pankow.\n\nMein Name ist Laura Schmidt. Wir reinigen Treppenhäuser mit festen Teams.\n\nPasst Ihnen ein kurzes Telefonat?';
  const goodN = 'Kurzer Nachtrag zu meiner Nachricht.\n\nPasst Ihnen Dienstag oder Donnerstag?';
  const d2 = () => {
    const d = data();
    d.clients = [d.clients[0], client];
    d.campaigns[1] = Object.assign({}, d.campaigns[1], { status: 'Ready' });
    d.leads.push({ id: 'L9', campaign: ['k2'], campaign_record_id: 'k2', status: 'Needs review', company_name: 'HV Mitte', contact_name: 'Petra Klein', contact_salutation: 'Frau', needs_review_reason: 'quality 65' });
    [1, 2, 3, 4].forEach((n) => d.emails.push({ id: 'X' + n, lead: ['L9'], lead_record_id: 'L9', step: n, subject: n === 1 ? 'Reinigung für HV Mitte' : 'Re', body: mk(n === 1 ? good1 : goodN), status: 'Draft' }));
    return d;
  };
  const plan = (form, d) => CC.planAction(form, d || d2(), { user: 'admin', now });
  const page = (p, params, d) => CC.renderPage({ page: p, params, data: d || d2(), cfg: { demoMode: true }, now, user: 'admin' });

  test('lead page: each unsent email is editable (message text only), a held lead can be approved', () => {
    const h = page('lead', { id: 'L9' });
    expect((h.match(/value="email_save"/g) || []).length).toBe(4);
    expect(h).toMatch(/<textarea name="text" required>Sie betreuen Wohnanlagen in Pankow\./); // no salutation in the editor
    expect(h).not.toMatch(/<textarea name="text" required>Sehr geehrte/);
    expect(h).toMatch(/value="lead_approve"/);
    expect(h).toMatch(/Zurückgehalten: quality 65/);
    expect(page('lead', { id: 'L2' })).not.toMatch(/value="email_save"/); // sent / contacted lead in a live campaign: read only
  });

  test('email_save: framed with salutation, signature and footer, rules checked, saved', () => {
    const p = plan({ action: 'email_save', id: 'X2', subject: 'Re', text: 'Ein Gedanke noch zu Ihren Wohnanlagen in Mitte.\r\n\r\nWann passt Ihnen ein kurzes Gespräch?' });
    const f = p.ops[0].body.records[0].fields;
    expect(f.body).toMatch(/^Sehr geehrte Frau Klein,\n\nEin Gedanke noch/);
    expect(f.body).toMatch(/Mit freundlichen Grüßen\n\nLaura Schmidt\nVertrieb\nReal Service GmbH/);
    expect(f.body).toMatch(/Antworten Sie mit STOP/);
    expect(f.edited_by).toBe('Control Center (admin)');
    expect(p.redirect).toMatch(/E-Mail%202%20gespeichert/);
  });

  test('email_save refuses edits that break the rules – nothing is saved', () => {
    const bad = (form) => plan(Object.assign({ action: 'email_save', id: 'X1', subject: 'Reinigung für HV Mitte' }, form));
    expect(bad({ text: 'Wir sind ein zuverlässiger Partner für Firmen wie Ihre. Passt es?' }).error).toMatch(/filler phrase/);
    expect(bad({ text: 'Wir reinigen gut.' }).error).toMatch(/no question/);
    expect(bad({ text: Array(95).fill('Wort').join(' ') + '?' }).error).toMatch(/words/);
    expect(bad({ subject: 'Ein sehr langer Betreff für Sie hier', text: good1 }).error).toMatch(/subject has 7 words/);
    expect(bad({ text: 'Hast du Zeit?' }).error).toMatch(/informal/);
    expect(bad({ text: '' }).error).toMatch(/nicht leer/);
    expect(bad({ text: 'x' }).ops).toEqual([]);
    expect(plan({ action: 'email_save', id: 'E3', subject: 'S', text: 'x?' }).error).toMatch(/schon gesendet/);
    expect(plan({ action: 'email_save', id: 'nope' }).error).toMatch(/nicht gefunden/);
  });

  test('lead_approve: all 4 emails valid → emails Approved by a person, lead Approved; invalid → refused', () => {
    const p = plan({ action: 'lead_approve', id: 'L9' });
    expect(p.ops[0].body.records).toHaveLength(4);
    expect(p.ops[0].body.records[0].fields).toEqual({ status: 'Approved', approved: true, approved_by: 'Control Center (admin)' });
    expect(p.ops[1].body.records[0].fields).toEqual({ status: 'Approved', needs_review_reason: null });
    const d = d2();
    d.emails.find((e) => e.id === 'X3').body = mk('Wir sind umfassend aufgestellt. Passt es?');
    expect(plan({ action: 'lead_approve', id: 'L9' }, d).error).toMatch(/step 3: filler phrase "umfassend"/);
    expect(plan({ action: 'lead_approve', id: 'L1' }).error).toMatch(/Nur zurückgehaltene Leads/);
  });
  test('lead_approve in a campaign that is already live: email 1 is scheduled now (else it would never be sent)', () => {
    const d = d2();
    d.campaigns[1].status = 'Live';
    const p = plan({ action: 'lead_approve', id: 'L9' }, d);
    expect(p.ops[1].body.records[0].fields).toEqual({ status: 'Approved', needs_review_reason: null, sequence_step: 1, next_send_at: now, subject_variant: 'A' });
    expect(decodeURIComponent(p.redirect)).toMatch(/nächsten Versand/);
  });

  test('campaign_rewrite: deletes unsent emails of approved/held leads and redrafts them, only before launch', () => {
    const p = plan({ action: 'campaign_rewrite', id: 'k2' });
    const del = p.ops.filter((o) => o.method === 'DELETE');
    expect(del.map((o) => o.query).join('&')).toBe('records[]=X1&records[]=X2&records[]=X3&records[]=X4');
    const patch = p.ops.find((o) => o.table === 'Leads');
    expect(patch.body.records.map((r) => r.id)).toEqual(['L9']); // L2 is Contacted → untouched
    expect(p.ops[p.ops.length - 1]).toEqual({ kind: 'kick', path: 'ai-emails-run', body: {} });
    const d = d2();
    d.campaigns[1].status = 'Live';
    expect(plan({ action: 'campaign_rewrite', id: 'k2' }, d).error).toMatch(/vor dem Start/);
    expect(page('campaign', { id: 'k2' })).toMatch(/value="campaign_rewrite"/);
  });

  test('client form has the writing notes field', () => {
    expect(page('client', { id: 'cR' })).toMatch(/name="writing_notes"/);
    expect(plan({ action: 'client_save', id: 'cR', name: 'Real Service GmbH', sender_name: 'L', sender_company_footer: 'F', offer: 'O', writing_notes: ' immer kurz ' }).ops.pop().body.records[0].fields.writing_notes).toBe('immer kurz');
  });
});
