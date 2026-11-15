/**
 * brief.js – the meeting brief the client gets when a meeting is booked (Nexsale's "Goldstandard": the client only talks
 * to prospects with real need, and knows who, what and why before the call). The AI writes the content from data we have;
 * this module builds its input and formats the result. Without a valid AI answer a factual brief is built from the data.
 */
function threadText(replies) {
  return (replies || []).filter((r) => r && r.body).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))
    .map((r) => '[' + String(r.received_at || '').slice(0, 10) + ', ' + (r.category || '?') + '] ' + String(r.body).replace(/\s+/g, ' ').slice(0, 600)).join('\n');
}

function qaText(questions) {
  return (questions || []).map((q) => q.question + ': ' + q.answer).join('\n');
}

/** vars for prompts/meeting_brief.md */
function briefVars(lead, replies, questions, when, client) {
  const l = lead || {};
  return {
    company_name: l.company_name || '', city: l.city || '', website: l.website || '', contact_name: l.contact_name || '', contact_role: l.contact_role || '',
    company_summary: l.company_summary || '(keine)', trigger: l.trigger || '(kein Anlass)', google_rating: l.google_rating || '-', review_count: l.review_count || 0,
    meeting_time: when || '', thread: threadText(replies) || '(keine Antworten gespeichert)', booking_answers: qaText(questions) || '(keine)',
    offer: (client && client.offer) || '',
  };
}

const list = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'string' && x.trim()) : []);

/** Slack/HubSpot text from the AI brief (or a factual fallback from the data) */
function formatBrief(data, lead, when, questions) {
  const l = lead || {};
  const d = data && typeof data === 'object' ? data : null;
  const lines = [];
  lines.push('*Meeting-Briefing: ' + (l.company_name || '') + '* · ' + (when || ''));
  lines.push('*Wer:* ' + [l.contact_name, l.contact_role].filter(Boolean).join(', ') + (l.website ? ' · ' + l.website : ''));
  if (d && d.about) lines.push('*Firma:* ' + d.about); else if (l.company_summary) lines.push('*Firma:* ' + l.company_summary);
  if (d && d.why_now) lines.push('*Warum jetzt:* ' + d.why_now); else if (l.trigger) lines.push('*Anlass:* ' + l.trigger);
  if (d && d.conversation) lines.push('*Bisheriger Austausch:* ' + d.conversation);
  const qa = qaText(questions);
  if (qa) lines.push('*Angaben bei der Buchung:*\n' + qa);
  const open = list(d && d.questions_to_ask).slice(0, 4);
  if (open.length) lines.push('*Im Gespräch klären:*\n' + open.map((q) => '• ' + q).join('\n'));
  return lines.join('\n');
}

const briefApi = { briefVars, formatBrief, threadText, qaText };
if (typeof module !== 'undefined' && module.exports) module.exports = briefApi;
