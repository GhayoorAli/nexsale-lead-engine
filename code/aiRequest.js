/**
 * aiRequest.js – builds the HTTP body for OpenAI or Anthropic, fills prompt templates
 * and estimates AI cost. Prompts live in prompts/*.md and use <<name>> placeholders.
 */
function fillTemplate(template, vars) {
  vars = vars || {};
  return String(template).replace(/<<\s*([a-zA-Z0-9_]+)\s*>>/g, (m, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Splits a prompt file into system and user parts at the "## User" heading. */
function splitPrompt(markdown) {
  const text = String(markdown || '');
  const idx = text.search(/^##\s+User\s*$/m);
  if (idx < 0) return { system: text.trim(), user: '' };
  const system = text.slice(0, idx).replace(/^##\s+System\s*$/m, '').trim();
  const user = text.slice(idx).replace(/^##\s+User\s*$/m, '').trim();
  return { system, user };
}

function buildAiRequest(opts) {
  const provider = opts.provider === 'anthropic' ? 'anthropic' : 'openai';
  const maxTokens = opts.maxTokens || 1500;
  if (provider === 'anthropic') {
    return {
      model: opts.model,
      max_tokens: maxTokens,
      temperature: opts.temperature === undefined ? 0.4 : opts.temperature,
      system: opts.system + '\nAntworte ausschließlich mit gültigem JSON.',
      messages: [{ role: 'user', content: opts.user }],
    };
  }
  return {
    model: opts.model,
    max_tokens: maxTokens,
    temperature: opts.temperature === undefined ? 0.4 : opts.temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  };
}

// EUR per 1M tokens (approximate list prices, converted at 0.92)
const AI_PRICES = {
  'gpt-4o-mini': { in: 0.138, out: 0.552 },
  default: { in: 0.92, out: 4.6 },
};

function estimateCostEur(model, usage) {
  const p = AI_PRICES[model] || AI_PRICES.default;
  const u = usage || {};
  const cost = ((u.input || 0) * p.in + (u.output || 0) * p.out) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

const aiRequestApi = { fillTemplate, splitPrompt, buildAiRequest, estimateCostEur, AI_PRICES };
if (typeof module !== 'undefined' && module.exports) module.exports = aiRequestApi;
