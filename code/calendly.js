/**
 * calendly.js – Module 7b: parse Calendly webhook payloads (invitee.created / invitee.canceled).
 * Idempotent: the same event URI twice produces one meeting.
 */
function parseCalendly(body) {
  const b = (body && (body.body || body)) || {};
  const p = b.payload || {};
  const event = b.event || '';
  const scheduled = p.scheduled_event || {};
  return {
    event,
    email: String(p.email || '').toLowerCase(),
    name: p.name || '',
    invitee_uri: p.uri || '',
    event_uri: scheduled.uri || p.event || '',
    calendly_event_id: String(scheduled.uri || p.event || p.uri || '').split('/').filter(Boolean).pop() || '',
    start_time: scheduled.start_time || p.start_time || null,
    end_time: scheduled.end_time || null,
    cancel_reason: (p.cancellation && p.cancellation.reason) || '',
    utm_content: (p.tracking && p.tracking.utm_content) || '',
    // answers to the booking form's questions (e.g. object size, contract end) go into the meeting brief
    questions: (Array.isArray(p.questions_and_answers) ? p.questions_and_answers : [])
      .filter((q) => q && q.question && q.answer).map((q) => ({ question: String(q.question), answer: String(q.answer) })),
    valid: (event === 'invitee.created' || event === 'invitee.canceled') && !!p.email,
  };
}

/** decide what to do given existing Meetings with the same calendly_event_id */
function meetingAction(parsed, existingMeetings) {
  const existing = (existingMeetings || []).find((m) => m.calendly_event_id === parsed.calendly_event_id);
  if (parsed.event === 'invitee.created') return existing ? { action: 'skip', reason: 'duplicate webhook', meeting: existing } : { action: 'create' };
  if (parsed.event === 'invitee.canceled') return existing ? (existing.status === 'Cancelled' ? { action: 'skip', reason: 'already cancelled', meeting: existing } : { action: 'cancel', meeting: existing }) : { action: 'skip', reason: 'unknown meeting' };
  return { action: 'skip', reason: 'unsupported event ' + parsed.event };
}

/** Booking link that tells the webhook which lead booked (Calendly passes utm_content back). */
function bookingLink(link, leadRecordId) {
  if (!link) return '';
  return link + (link.includes('?') ? '&' : '?') + 'utm_source=nexsale&utm_content=' + encodeURIComponent(leadRecordId || '');
}

/** Calendly-Webhook-Signature: "t=<ts>,v1=<hmac_sha256(key, t + '.' + body)>" */
function verifyCalendlySignature(opts) {
  const { signingKey, header, rawBody, crypto } = opts || {};
  const now = opts && opts.now !== undefined ? opts.now : Math.floor(Date.now() / 1000);
  if (!signingKey) return { ok: true, skipped: true };
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.trim().split('=')));
  if (!parts.t || !parts.v1) return { ok: false, reason: 'missing signature' };
  if (Math.abs(now - Number(parts.t)) > 180) return { ok: false, reason: 'signature too old' };
  const expected = crypto.createHmac('sha256', signingKey).update(parts.t + '.' + (rawBody || '')).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts.v1));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/**
 * Free Calendly plan (no webhooks): turn polled API data into the same payloads a webhook would send,
 * so 07b_calendly handles both the same way. Only invitees created/changed within `windowMinutes` are
 * forwarded; 07b's duplicate check makes overlapping polls harmless.
 * events: GET /scheduled_events collection; inviteesByEvent: { <event uri>: GET /invitees collection }
 */
function pollToPayloads(events, inviteesByEvent, now, windowMinutes) {
  const t = new Date(now || Date.now()).getTime();
  const since = t - (windowMinutes || 30) * 60000;
  const out = [];
  (events || []).forEach((ev) => {
    ((inviteesByEvent || {})[ev.uri] || []).forEach((inv) => {
      const canceled = inv.status === 'canceled' || ev.status === 'canceled';
      const changedAt = new Date(canceled ? inv.updated_at || inv.created_at : inv.created_at).getTime();
      if (!(changedAt >= since)) return;
      out.push({
        event: canceled ? 'invitee.canceled' : 'invitee.created',
        source: 'calendly-poll',
        payload: {
          email: inv.email, name: inv.name, uri: inv.uri, status: inv.status, tracking: inv.tracking || {}, questions_and_answers: inv.questions_and_answers || [],
          cancellation: inv.cancellation || undefined,
          scheduled_event: { uri: ev.uri, name: ev.name, start_time: ev.start_time, end_time: ev.end_time },
        },
      });
    });
  });
  return out;
}

const calendlyApi = { parseCalendly, meetingAction, bookingLink, verifyCalendlySignature, pollToPayloads };
if (typeof module !== 'undefined' && module.exports) module.exports = calendlyApi;
