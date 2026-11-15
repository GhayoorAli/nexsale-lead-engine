/**
 * parseAiJson.js – turns raw AI output into JSON. Never throws.
 * Accepts: plain JSON, JSON in ```json fences, JSON surrounded by text.
 */
function findBalanced(text, open, close) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAiJson(text) {
  if (text === null || text === undefined) return { ok: false, error: 'empty AI output' };
  if (typeof text === 'object') return { ok: true, data: text };
  const raw = String(text).trim();
  if (!raw) return { ok: false, error: 'empty AI output' };
  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const obj = findBalanced(raw, '{', '}');
  const arr = findBalanced(raw, '[', ']');
  // Prefer whichever structure starts first in the text.
  const oi = raw.indexOf('{');
  const ai = raw.indexOf('[');
  if (obj && arr) candidates.push(...(ai >= 0 && ai < oi ? [arr, obj] : [obj, arr]));
  else if (obj) candidates.push(obj);
  else if (arr) candidates.push(arr);
  for (const c of candidates) {
    try {
      return { ok: true, data: JSON.parse(c) };
    } catch (e) {
      /* try next */
    }
  }
  return { ok: false, error: 'AI output is not valid JSON: ' + raw.slice(0, 120) };
}

/** Pull the text out of an OpenAI or Anthropic response body. */
function extractAiText(response, provider) {
  if (!response || typeof response !== 'object') return '';
  if (provider === 'anthropic' || Array.isArray(response.content)) {
    return (response.content || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('');
  }
  const ch = response.choices && response.choices[0];
  return (ch && ch.message && ch.message.content) || '';
}

function extractUsage(response) {
  const u = (response && response.usage) || {};
  return {
    input: u.prompt_tokens || u.input_tokens || 0,
    output: u.completion_tokens || u.output_tokens || 0,
  };
}

const parseAiApi = { parseAiJson, extractAiText, extractUsage };
if (typeof module !== 'undefined' && module.exports) module.exports = parseAiApi;
