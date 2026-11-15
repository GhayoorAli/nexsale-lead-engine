/**
 * n8n_builder.js – small DSL that writes importable n8n 1.x workflow JSON.
 *
 * Why a generator: every Code node's logic lives in code/*.js (with Jest tests). The builder
 * embeds those exact modules into the Code nodes, so the workflow JSON can never drift from
 * the tested source. It also enforces the cross-cutting rules: Error Workflow on every
 * workflow, retry on fail (3 tries, 5 s) on every external call, Europe/Berlin timezone.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CODE_DIR = path.join(ROOT, 'code');
const PROMPT_DIR = path.join(ROOT, 'prompts');

// Placeholder IDs. setup/deploy_workflows.py maps them to the IDs n8n assigns on import.
const IDS = {
  '00_error_handler': 'NxsWf00ErrorHndl',
  '01_campaign_setup': 'NxsWf01CampSetup',
  '01b_campaign_status': 'NxsWf01bCmpStat0',
  '08b_dashboard': 'NxsWf08bDashbrd0',
  '16_control_center': 'NxsWf16CtrlCntr0',
  '02_lead_sourcing': 'NxsWf02LeadSourc',
  '03_enrichment': 'NxsWf03Enrichmnt',
  '04_ai_emails': 'NxsWf04AiEmails0',
  '05_campaign_launch': 'NxsWf05CampLaunc',
  '06_sending': 'NxsWf06Sending00',
  '07_replies': 'NxsWf07Replies00',
  '07a_gmail_inbox': 'NxsWf07aGmailInb',
  '07b_calendly': 'NxsWf07bCalendly',
  '07c_reminders': 'NxsWf07cReminder',
  '07d_calendly_poll': 'NxsWf07dCalPoll0',
  '08_reporting': 'NxsWf08Reporting',
  '09_inbound_leads': 'NxsWf09InboundLd',
  '10_crm_sync': 'NxsWf10CrmSync00',
  '11_slack_actions': 'NxsWf11SlackActn',
  '12_delete_lead': 'NxsWf12DeleteLd0',
  '13_send_email': 'NxsWf13SendEmail',
  '14_ai_call': 'NxsWf14AiCall000',
  '15_slack_notify': 'NxsWf15SlackNtfy',
};

function uuidFrom(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Wraps code/<name>.js in an IIFE so modules can be combined in one Code node. */
function embedModule(name) {
  const src = fs.readFileSync(path.join(CODE_DIR, name + '.js'), 'utf8');
  return `M.${name} = (function () {\n  const module = { exports: {} };\n${src}\n  return module.exports;\n})();\n`;
}

function loadPrompts() {
  const out = {};
  fs.readdirSync(PROMPT_DIR)
    .filter((f) => f.endsWith('.md'))
    .forEach((f) => (out[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(PROMPT_DIR, f), 'utf8')));
  return out;
}

const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
const CFG = (p) => `$('Config').first().json.cfg.${p}`;

class Workflow {
  constructor(file, name, opts) {
    opts = opts || {};
    this.file = file;
    this.id = IDS[file];
    this.name = name;
    this.nodes = [];
    this.connections = {};
    this.col = 0;
    this.row = 0;
    this.errorWorkflow = opts.errorWorkflow === false ? null : IDS['00_error_handler'];
    this.tags = opts.tags || [];
    this.description = opts.description || '';
  }

  add(name, type, typeVersion, parameters, extra) {
    if (this.nodes.find((n) => n.name === name)) throw new Error(`${this.file}: duplicate node name ${name}`);
    extra = extra || {};
    const pos = extra.position || [this.col * 240, this.row * 180];
    delete extra.position;
    const node = Object.assign({ id: uuidFrom(this.file + ':' + name), name, type, typeVersion, position: pos, parameters: parameters || {} }, extra);
    this.nodes.push(node);
    this.col += 1;
    return name;
  }

  /** start a new visual row (for side branches) */
  at(col, row) {
    this.col = col;
    this.row = row;
    return this;
  }

  connect(from, to, fromOut, toIn) {
    fromOut = fromOut || 0;
    toIn = toIn || 0;
    const c = (this.connections[from] = this.connections[from] || { main: [] });
    while (c.main.length <= fromOut) c.main.push([]);
    c.main[fromOut].push({ node: to, type: 'main', index: toIn });
    return to;
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
    return names[names.length - 1];
  }

  // ---------------------------------------------------------------- triggers
  webhook(name, pathName, opts) {
    opts = opts || {};
    return this.add(name, 'n8n-nodes-base.webhook', 2, {
      httpMethod: opts.method || 'POST',
      path: pathName,
      responseMode: opts.responseMode || 'onReceived',
      options: Object.assign({}, opts.rawBody ? { rawBody: true } : {}, opts.options || {}),
    }, { webhookId: uuidFrom(this.file + ':webhook:' + pathName) });
  }

  schedule(name, interval) {
    // interval: {field:'minutes', minutesInterval:5} | {field:'cronExpression', expression:'...'}
    return this.add(name, 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [interval] } });
  }

  subTrigger(name) {
    return this.add(name, 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
  }

  errorTrigger(name) {
    return this.add(name, 'n8n-nodes-base.errorTrigger', 1, {});
  }

  // ---------------------------------------------------------------- logic
  /** Code node. modules: names in code/ to embed; main: JS body (must return items). */
  code(name, modules, main, opts) {
    opts = opts || {};
    const prelude = modules && modules.length ? 'const M = {};\n' + modules.map(embedModule).join('\n') + '\n// ---- node logic ----\n' : '';
    const params = { jsCode: prelude + main.trim() + '\n' };
    if (opts.each) params.mode = 'runOnceForEachItem';
    const extra = {};
    if (opts.alwaysOutputData) extra.alwaysOutputData = true;
    if (opts.notes) extra.notes = opts.notes;
    return this.add(name, 'n8n-nodes-base.code', 2, params, extra);
  }

  config(name) {
    return this.code(name || 'Config', ['config'], `
const trigger = $input.all().map((i) => i.json);
// test stack only: schedules are switched off so tests drive every module through its webhook
const scheduled = trigger.length > 0 && trigger[0] && trigger[0]['Readable date'] !== undefined;
if (scheduled && String($env.DISABLE_SCHEDULES).toLowerCase() === 'true') return [];
return [{ json: { cfg: M.config.buildConfig($env), trigger, startedAt: new Date().toISOString() } }];`, { notes: 'Builds runtime config from env (no secrets in output).' });
  }

  ifTrue(name, expr) {
    return this.add(name, 'n8n-nodes-base.if', 2.2, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: uuidFrom(this.file + name), leftValue: `={{ ${expr} }}`, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    });
  }

  /** Switch on a string expression; outputs in the order of `values`. */
  switchOn(name, expr, values) {
    return this.add(name, 'n8n-nodes-base.switch', 3.2, {
      rules: {
        values: values.map((v) => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
            conditions: [{ id: uuidFrom(this.file + name + v), leftValue: `={{ ${expr} }}`, rightValue: v, operator: { type: 'string', operation: 'equals' } }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: v,
        })),
      },
      options: { fallbackOutput: 'none' },
    });
  }

  merge(name) {
    return this.add(name, 'n8n-nodes-base.merge', 3, {});
  }

  wait(name, secondsExpr) {
    return this.add(name, 'n8n-nodes-base.wait', 1.1, { resume: 'timeInterval', amount: `={{ ${secondsExpr} }}`, unit: 'seconds' }, { webhookId: uuidFrom(this.file + ':wait:' + name) });
  }

  loop(name, batchSize) {
    return this.add(name, 'n8n-nodes-base.splitInBatches', 3, { batchSize: batchSize || 1, options: {} });
  }

  respond(name, bodyExpr, opts) {
    opts = opts || {};
    const p = opts.html
      ? { respondWith: 'text', responseBody: `={{ ${bodyExpr} }}`, options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } }
      : { respondWith: 'json', responseBody: `={{ JSON.stringify(${bodyExpr}) }}`, options: {} };
    if (opts.code) p.options.responseCode = opts.code;
    return this.add(name, 'n8n-nodes-base.respondToWebhook', 1.1, p);
  }

  execWorkflow(name, target, opts) {
    opts = opts || {};
    const extra = { alwaysOutputData: opts.alwaysOutputData !== false };
    return this.add(name, 'n8n-nodes-base.executeWorkflow', 1.2, {
      workflowId: { __rl: true, value: IDS[target], mode: 'id', cachedResultName: target },
      mode: 'once',
      options: { waitForSubWorkflow: true },
    }, extra);
  }

  // ---------------------------------------------------------------- HTTP
  /**
   * HTTP Request node with retry on fail (3 × 5 s).
   * o: {method, url, headers:[[k,v]], query:[[k,v]], body (expression string), text, fullResponse, neverError,
   *     executeOnce, paginate:{...}, batch:{size, interval}, credential:{type, id?}, timeout}
   */
  http(name, o) {
    const params = { method: o.method || 'GET', url: o.url, options: {} };
    if (o.credential) {
      params.authentication = 'predefinedCredentialType';
      params.nodeCredentialType = o.credential;
    } else {
      params.authentication = 'none';
    }
    if (o.headers && o.headers.length) {
      params.sendHeaders = true;
      params.headerParameters = { parameters: o.headers.map(([n, v]) => ({ name: n, value: v })) };
    }
    if (o.query && o.query.length) {
      params.sendQuery = true;
      params.queryParameters = { parameters: o.query.map(([n, v]) => ({ name: n, value: v })) };
    }
    if (o.body) {
      params.sendBody = true;
      params.contentType = 'json';
      params.specifyBody = 'json';
      params.jsonBody = `={{ JSON.stringify(${o.body}) }}`;
    }
    const resp = {};
    if (o.fullResponse) resp.fullResponse = true;
    if (o.neverError) resp.neverError = true;
    if (o.text) resp.responseFormat = 'text';
    if (Object.keys(resp).length) params.options.response = { response: resp };
    params.options.timeout = o.timeout || 30000;
    if (o.batch) params.options.batching = { batch: { batchSize: o.batch.size, batchInterval: o.batch.interval } };
    if (o.paginate) params.options.pagination = { pagination: o.paginate };
    const extra = Object.assign({}, RETRY);
    if (o.executeOnce) extra.executeOnce = true;
    if (o.alwaysOutputData) extra.alwaysOutputData = true;
    if (o.continueOnFail) extra.onError = 'continueRegularOutput';
    if (o.credential) extra.credentials = { [o.credential]: { id: 'REPLACE_WITH_CREDENTIAL_ID', name: o.credentialName || o.credential } };
    if (o.notes) extra.notes = o.notes;
    return this.add(name, 'n8n-nodes-base.httpRequest', 4.2, params, extra);
  }

  // Airtable via REST (base URL switches to the mock when MOCK_EXTERNAL=true)
  atList(name, tableName, formulaExpr, opts) {
    opts = opts || {};
    const query = [['pageSize', '100']];
    if (formulaExpr) query.push(['filterByFormula', `={{ ${formulaExpr} }}`]);
    if (opts.maxRecords) query.push(['maxRecords', String(opts.maxRecords)]);
    if (opts.sort) {
      query.push(['sort[0][field]', opts.sort[0]]);
      query.push(['sort[0][direction]', opts.sort[1] || 'asc']);
    }
    return this.http(name, {
      method: 'GET',
      url: `={{ ${CFG('airtableUrl')} }}/${encodeURIComponent(tableName)}`,
      headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']],
      query,
      executeOnce: opts.each ? false : true,
      batch: { size: 4, interval: 1100 },
      paginate: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $response.body.offset }}' }] },
        paginationCompleteWhen: 'other',
        completeExpression: '={{ !$response.body.offset }}',
        limitPagesFetched: true,
        maxRequests: opts.maxPages || 10,
        requestInterval: 250,
      },
      notes: opts.notes || `Airtable: list ${tableName}`,
    });
  }

  atGet(name, tableName, idExpr) {
    return this.http(name, {
      method: 'GET',
      url: `={{ ${CFG('airtableUrl')} }}/${encodeURIComponent(tableName)}/{{ ${idExpr} }}`,
      headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']],
      notes: `Airtable: get ${tableName}`,
    });
  }

  /** create/update: input items are {records:[≤10]} batches (see code/airtable.js) */
  atWrite(name, tableName, method, opts) {
    opts = opts || {};
    return this.http(name, {
      method,
      url: `={{ ${CFG('airtableUrl')} }}/${encodeURIComponent(tableName)}`,
      headers: [['Authorization', '=Bearer {{ $env.AIRTABLE_PAT }}']],
      body: opts.body || '{ records: $json.records, typecast: true }',
      batch: { size: 1, interval: 220 },
      notes: `Airtable: ${method === 'POST' ? 'create' : 'update'} ${tableName} (batches of 10)`,
      executeOnce: opts.executeOnce,
    });
  }

  /** HTTP Basic login (CONTROL_USER / CONTROL_PASSWORD) in front of a page webhook: 'Login' → 'Logged in?' → 401 or onwards. */
  basicLogin(triggerName) {
    this.code('Login', ['controlCenter'], `
const crypto = require('crypto');
const req = $('${triggerName}').first().json;
const auth = M.controlCenter.checkAuth((req.headers || {}).authorization, $env.CONTROL_USER || 'admin', $env.CONTROL_PASSWORD || '', crypto);
return [{ json: { ok: auth.ok, reason: auth.reason, user: auth.user } }];`);
    this.ifTrue('Logged in?', '$json.ok');
    this.add('Ask for login', 'n8n-nodes-base.respondToWebhook', 1.1, {
      respondWith: 'text', responseBody: "={{ 'Login erforderlich: ' + $json.reason }}",
      options: { responseCode: 401, responseHeaders: { entries: [{ name: 'WWW-Authenticate', value: 'Basic realm="Nexsale Control Center", charset="UTF-8"' }, { name: 'Content-Type', value: 'text/plain; charset=utf-8' }] } },
    });
    this.connect('Logged in?', 'Ask for login', 1);
  }

  /** fire-and-forget call to another workflow's webhook (kick) */
  kick(name, webhookPath, bodyExpr) {
    return this.http(name, {
      method: 'POST',
      url: `={{ ${CFG('n8nInternalUrl')} }}/webhook/${webhookPath}`,
      body: bodyExpr || '{ kicked_by: $workflow.name }',
      executeOnce: true,
      timeout: 10000,
      continueOnFail: true,
      notes: `Starts ${webhookPath} right away (the schedule is the fallback)`,
    });
  }

  toJSON() {
    const settings = {
      executionOrder: 'v1',
      timezone: 'Europe/Berlin',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveManualExecutions: true,
      saveExecutionProgress: false,
      callerPolicy: 'workflowsFromSameOwner',
    };
    if (this.errorWorkflow) settings.errorWorkflow = this.errorWorkflow;
    return {
      id: this.id,
      name: this.name,
      active: false,
      versionId: uuidFrom(this.file + ':version'),
      nodes: this.nodes,
      connections: this.connections,
      settings,
      staticData: null,
      meta: { templateCredsSetupCompleted: false, nexsaleFile: this.file, description: this.description },
      pinData: {},
      tags: [],
    };
  }

  write(dir) {
    const p = path.join(dir, this.file + '.json');
    fs.writeFileSync(p, JSON.stringify(this.toJSON(), null, 2) + '\n');
    return p;
  }
}

module.exports = { Workflow, IDS, CFG, RETRY, embedModule, loadPrompts, uuidFrom };
