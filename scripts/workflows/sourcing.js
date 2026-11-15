/** Module 1 (campaign setup form) and Module 2 (lead sourcing from Google Places). */
const { Workflow, CFG } = require('../n8n_builder');

function campaignSetup() {
  const w = new Workflow('01_campaign_setup', 'Nexsale 01 – Campaign setup (click 1)', { description: 'Form trigger: the first of three clicks. Creates the campaign and starts sourcing.' });
  w.add('Campaign form', 'n8n-nodes-base.formTrigger', 2.2, {
    formTitle: 'Neue Outbound-Kampagne',
    formDescription: 'Klick 1 von 3. Nach dem Absenden laufen Sourcing, Anreicherung und KI-E-Mails automatisch. Sie erhalten eine "Campaign ready"-Nachricht in Slack.',
    formFields: {
      values: [
        { fieldLabel: 'Campaign name', placeholder: 'Cleaning companies Berlin', requiredField: true },
        { fieldLabel: 'Client', placeholder: 'leer = Nexsale (eigene Akquise) · oder z. B. Real Service GmbH' },
        { fieldLabel: 'Industry (search term)', placeholder: 'Reinigungsunternehmen', requiredField: true },
        { fieldLabel: 'City', placeholder: 'Berlin', requiredField: true },
        { fieldLabel: 'Company size range', fieldType: 'dropdown', fieldOptions: { values: [{ option: '1-9' }, { option: '10-49' }, { option: '50-249' }, { option: '250+' }] }, requiredField: true },
        { fieldLabel: 'Target role', placeholder: 'Geschäftsführer', requiredField: true },
        { fieldLabel: 'Max leads', fieldType: 'number', placeholder: '100' },
      ],
    },
    responseMode: 'lastNode',
    options: { path: 'campaign-setup', appendAttribution: false },
  }, { webhookId: 'b6d1f6a2-0c0e-4f43-9d55-6b1e2a6c0001' });
  w.config();
  w.code('Validate form', ['campaign'], `
const form = $('Campaign form').first().json;
const cfg = $('Config').first().json.cfg;
const r = M.campaign.validateCampaignForm(form, { defaultMax: cfg.testLeadLimit || 100 });
return [{ json: r }];`);
  w.ifTrue('Valid?', '$json.ok');
  w.at(4, 1);
  w.add('Show errors', 'n8n-nodes-base.form', 1, { operation: 'completion', completionTitle: 'Bitte korrigieren',
    completionMessage: "={{ $('Validate form').first().json.errors.join(' · ') + '. Es wurde nichts gestartet. Gehen Sie im Browser zurück, passen Sie das Feld an und senden Sie erneut.' }}" });
  w.at(4, 0);
  w.atList('Load Clients', 'Clients', null);
  w.code('Build campaign', ['airtable'], `
const c = $('Validate form').first().json.campaign;
const clients = M.airtable.fromItems($('Load Clients').all());
// "Client" field: the client by name; empty → the default client (Nexsale itself for own outreach), else the first one
const client = clients.find((x) => c.client && String(x.name).toLowerCase() === c.client.toLowerCase())
  || (c.client ? null : (clients.find((x) => x.is_default) || clients[0]));
if (c.client && !client) throw new Error('Unknown client "' + c.client + '" – use the exact name from the Clients table');
if (!client) throw new Error('No client in the Clients table – run setup/seed_test_data.py or add one');
return [{ json: { records: [{ fields: {
  name: c.name, client: [client.id], client_record_id: client.id, industry: c.industry, city: c.city, company_size: c.company_size,
  target_role: c.target_role, max_leads: c.max_leads, status: 'Sourcing', daily_limit: 40, created_at: new Date().toISOString(),
  google_api_requests: 0, google_api_cost_eur: 0, ai_cost_eur: 0,
} }] } }];`);
  w.atWrite('Create campaign', 'Campaigns', 'POST');
  w.kick('Start sourcing', 'lead-sourcing', "{ campaign_record_id: $('Create campaign').first().json.records[0].id }");
  // lands on the live status page of this campaign (same origin as the form: n8n's WEBHOOK_URL is localhost)
  w.add('Confirmation page', 'n8n-nodes-base.form', 1, { operation: 'completion', respondWith: 'redirect',
    redirectUrl: `={{ ${CFG('n8nBaseUrl')} }}/webhook/campaign-status?id={{ $('Create campaign').first().json.records[0].id }}` });
  w.chain('Campaign form', 'Config', 'Validate form', 'Valid?');
  w.connect('Valid?', 'Load Clients', 0);
  w.connect('Valid?', 'Show errors', 1);
  w.chain('Load Clients', 'Build campaign', 'Create campaign', 'Start sourcing', 'Confirmation page');
  return w;
}

function leadSourcing() {
  const w = new Workflow('02_lead_sourcing', 'Nexsale 02 – Lead sourcing (Google Places)', { description: 'Max leads from the form decides the size: Google is searched page by page (20 per page) and stops as soon as enough companies are found. Max leads 10 = 1 request.' });
  w.webhook('Campaign webhook', 'lead-sourcing');
  w.config();
  w.atGet('Load campaign', 'Campaigns', "$('Campaign webhook').first().json.body.campaign_record_id");
  w.atList('Existing leads', 'Leads', null, { notes: 'For de-duplication by google_place_id and domain' });
  w.code('Search plan', ['campaign'], `
const cfg = $('Config').first().json.cfg;
const camp = $('Load campaign').first().json;
const plan = M.campaign.buildSearchPlan(camp.fields, cfg, camp.fields.max_leads);
return plan.requests.map((r) => ({ json: { request: r.request, pages: r.pages, needed: plan.needed } }));`);
  w.http('Google Places search', {
    method: 'POST', url: `={{ ${CFG('googlePlacesUrl')} }}/places:searchText`,
    headers: [['X-Goog-Api-Key', '={{ $env.GOOGLE_MAPS_API_KEY }}'], ['X-Goog-FieldMask', 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.types,places.businessStatus,places.googleMapsUri,nextPageToken']],
    body: '$json.request', batch: { size: 1, interval: 2000 },
    paginate: {
      paginationMode: 'updateAParameterInEachRequest',
      parameters: { parameters: [{ type: 'body', name: 'pageToken', value: '={{ $response.body.nextPageToken }}' }] },
      paginationCompleteWhen: 'other',
      completeExpression: '={{ !$response.body.nextPageToken || $pageCount >= $json.pages }}',
      limitPagesFetched: true, maxRequests: 3, requestInterval: 2000,
    },
    notes: 'Field mask stays on the Enterprise tier. Each search fetches only the pages it needs (Search plan → pages).',
  });
  w.code('Map places', ['mapPlaces', 'airtable'], `
const cfg = $('Config').first().json.cfg;
const camp = $('Load campaign').first().json;
const existing = M.airtable.fromItems($('Existing leads').all());
const responses = $input.all().map((i) => i.json);
const max = camp.fields.max_leads || cfg.testLeadLimit || 100; // the form number decides
const already = existing.filter((l) => l.campaign_record_id === camp.id).length; // a re-run tops up, never exceeds Max leads
const { leads, skipped } = M.mapPlaces.mapPlaces(responses, {
  campaignRecordId: camp.id, city: camp.fields.city, now: new Date().toISOString(), limit: Math.max(0, max - already),
  existing: { placeIds: existing.map((l) => l.google_place_id), domains: existing.map((l) => l.domain) },
});
const requests = responses.length;
const batches = M.airtable.createBatches(leads);
const summary = { campaign_record_id: camp.id, name: camp.fields.name, leads: leads.length, skipped, requests,
  cost_eur: Math.round(requests * cfg.googleCostPerRequestEur * 10000) / 10000,
  prev_requests: camp.fields.google_api_requests || 0, prev_cost: camp.fields.google_api_cost_eur || 0 };
return (batches.length ? batches : [{ records: [] }]).map((b) => ({ json: Object.assign({}, b, { summary }) }));`);
  w.ifTrue('Any leads?', '$json.records.length > 0');
  // upsert on google_place_id: a retried request (timeout after Airtable already saved it) updates instead of duplicating
  w.atWrite('Create leads', 'Leads', 'PATCH', { body: "{ performUpsert: { fieldsToMergeOn: ['google_place_id'] }, records: $json.records, typecast: true }" });
  w.at(6, 1);
  w.merge('Merge');
  w.code('Campaign update', ['airtable'], `
const s = $('Map places').first().json.summary;
return [{ json: { records: [{ id: s.campaign_record_id, fields: {
  google_api_requests: s.prev_requests + s.requests, google_api_cost_eur: Math.round((s.prev_cost + s.cost_eur) * 10000) / 10000, leads_sourced: s.leads,
} }], summary: s } }];`);
  w.atWrite('Update campaign', 'Campaigns', 'PATCH');
  w.code('Slack text', [], `
const s = $('Campaign update').first().json.summary;
const skipped = s.skipped.length ? ' – skipped ' + s.skipped.length + ' (' + s.skipped.map((x) => x.reason).join(', ') + ')' : '';
return [{ json: { ref: s.campaign_record_id, text: ':mag: ' + s.leads + ' leads sourced for *' + s.name + '* (' + s.requests + ' Google request' + (s.requests === 1 ? '' : 's') + ')' + skipped } }];`);
  w.execWorkflow('Post to Slack', '15_slack_notify');
  w.kick('Start enrichment', 'enrichment-run', "{ campaign_record_id: $('Map places').first().json.summary.campaign_record_id }");
  w.chain('Campaign webhook', 'Config', 'Load campaign', 'Existing leads', 'Search plan', 'Google Places search', 'Map places', 'Any leads?');
  w.connect('Any leads?', 'Create leads', 0);
  w.connect('Create leads', 'Merge', 0, 0);
  w.connect('Any leads?', 'Merge', 1, 1);
  w.chain('Merge', 'Campaign update', 'Update campaign', 'Slack text', 'Post to Slack', 'Start enrichment');
  return w;
}

function campaignStatus() {
  const w = new Workflow('01b_campaign_status', 'Nexsale 01b – Campaign status page', { description: 'GET /webhook/campaign-status?id=<campaign>: the page the form lands on after click 1. Live progress, refreshes itself until the campaign is Ready.' });
  w.webhook('Status request', 'campaign-status', { method: 'GET', responseMode: 'responseNode' });
  w.basicLogin('Status request');
  w.config();
  w.atList('Campaign', 'Campaigns', "($('Status request').first().json.query.id ? \"RECORD_ID()='\" + String($('Status request').first().json.query.id).replace(/[^A-Za-z0-9]/g, '') + \"'\" : 'TRUE()')",
    { maxRecords: 1, maxPages: 1, sort: ['created_at', 'desc'], notes: 'The campaign from ?id=, or the newest one' });
  w.atList('Campaign leads', 'Leads', "\"{campaign_record_id}='\" + String(($('Campaign').first().json.records || [{}])[0] ? ($('Campaign').first().json.records[0] || {}).id || '__none__' : '__none__') + \"'\"");
  w.code('Render page', ['statusPage', 'airtable'], `
const cfg = $('Config').first().json.cfg;
const campaign = M.airtable.fromItems($('Campaign').all())[0] || null;
const leads = M.airtable.fromItems($('Campaign leads').all());
const airtableUrl = cfg.airtableBaseId && !cfg.mock ? 'https://airtable.com/' + cfg.airtableBaseId : '';
const dashboardUrl = cfg.n8nBaseUrl + '/webhook/dashboard' + (campaign && campaign.client_record_id ? '?client=' + campaign.client_record_id : '');
return [{ json: { html: M.statusPage.renderStatusPage({ campaign, leads, airtableUrl, dashboardUrl, refreshSeconds: 5, notFound: !campaign }) } }];`);
  w.respond('Show page', "$json.html", { html: true });
  w.chain('Status request', 'Login', 'Logged in?');
  w.connect('Logged in?', 'Config', 0);
  w.chain('Config', 'Campaign', 'Campaign leads', 'Render page', 'Show page');
  return w;
}

module.exports = [campaignSetup, campaignStatus, leadSourcing];
