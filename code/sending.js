/**
 * sending.js – Module 6: which leads are due, what to send, and the state after a send.
 * Uses schedule.js and guard.js (passed in) so it runs in Jest and in n8n.
 */
const SENDABLE = ['Approved', 'Contacted'];
const STOPPED = ['Replied', 'Interested', 'Later', 'Not interested', 'Unsubscribed', 'Bounced', 'Meeting booked', 'Meeting held', 'No-show', 'Needs review'];

function linkId(v) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Emails per campaign per day. Real mode: the campaign's daily_limit (default 40) protects the sender's reputation.
 * DEMO_MODE: days are minutes and every email goes to the test inbox only, so the limit is sized to the whole sequence
 * (leads × 4) – otherwise a 25-lead demo stopped after 40 emails (live, 2026-11-15).
 */
function dailyLimit(campaign, leadCount, demoMode) {
  const base = Number(campaign && campaign.daily_limit) || 40;
  return demoMode ? Math.max(base, (Number(leadCount) || 0) * 4) : base;
}

/**
 * Send order: every lead gets email 1 before any follow-up goes out, and within each group the email that has been due
 * the longest goes first. Live bug: the order was the Airtable list order, so follow-ups of early leads overtook a first
 * email that had been due since launch (Helpling), until the daily limit stopped everything.
 */
function sendOrder(a, b) {
  const s1 = Number(a.step) === 1 ? 0 : 1;
  const s2 = Number(b.step) === 1 ? 0 : 1;
  if (s1 !== s2) return s1 - s2;
  const t = new Date(a.lead.next_send_at).getTime() - new Date(b.lead.next_send_at).getTime();
  return t || String(a.lead.id).localeCompare(String(b.lead.id));
}

/**
 * ctx: {leads, campaigns, emails, blocklist, sentTodayByCampaign, replies, now, isBlocked, maxPerRun, demoMode}
 * returns {due:[{lead, email, prevEmail, campaign}], skipped:[{leadId, reason}]}
 */
function selectDue(ctx) {
  const now = new Date(ctx.now || Date.now());
  const live = {};
  (ctx.campaigns || []).forEach((c) => {
    if (c.status === 'Live') live[c.id] = c;
  });
  const repliedLeads = new Set((ctx.replies || []).map((r) => linkId(r.lead)));
  const sentToday = Object.assign({}, ctx.sentTodayByCampaign || {});
  // every lead with a sequence in the campaign (also those already finished) – sizes the test-mode limit
  const seqLeads = {};
  (ctx.emails || []).forEach((e) => { const cid = e.campaign_record_id; if (!cid) return; (seqLeads[cid] = seqLeads[cid] || new Set()).add(linkId(e.lead) || e.lead_record_id); });
  const leadsPerCampaign = Object.fromEntries(Object.entries(seqLeads).map(([k, v]) => [k, v.size]));
  const candidates = [];
  const skipped = [];
  (ctx.leads || []).forEach((l) => {
    const cid = linkId(l.campaign) || l.campaign_record_id;
    const campaign = live[cid];
    if (!campaign) return;
    if (!SENDABLE.includes(l.status)) return;
    if (l.sequence_finished) return;
    const step = Number(l.sequence_step) || 0;
    if (step < 1 || step > 4) return;
    if (!l.next_send_at || new Date(l.next_send_at) > now) return;
    if (repliedLeads.has(l.id)) {
      skipped.push({ leadId: l.id, reason: 'lead has replied' });
      return;
    }
    if (ctx.isBlocked(l.email, ctx.blocklist)) {
      skipped.push({ leadId: l.id, reason: 'on blocklist' });
      return;
    }
    const emails = (ctx.emails || []).filter((e) => linkId(e.lead) === l.id || e.lead_record_id === l.id);
    const email = emails.find((e) => Number(e.step) === step && e.status === 'Approved');
    if (!email) {
      skipped.push({ leadId: l.id, reason: 'no approved email for step ' + step });
      return;
    }
    const prevEmail = emails.filter((e) => e.status === 'Sent').sort((a, b) => Number(b.step) - Number(a.step))[0] || null;
    candidates.push({ lead: l, email, prevEmail, campaign, cid, step });
  });
  candidates.sort(sendOrder);
  const due = [];
  candidates.forEach((c) => {
    if (ctx.maxPerRun && due.length >= ctx.maxPerRun) {
      skipped.push({ leadId: c.lead.id, reason: 'per-run cap reached (next tick)' });
      return;
    }
    if ((sentToday[c.cid] || 0) >= dailyLimit(c.campaign, leadsPerCampaign[c.cid], ctx.demoMode)) {
      skipped.push({ leadId: c.lead.id, reason: 'daily limit reached' });
      return;
    }
    sentToday[c.cid] = (sentToday[c.cid] || 0) + 1;
    due.push({ lead: c.lead, email: c.email, prevEmail: c.prevEmail, campaign: c.campaign });
  });
  return { due, skipped };
}

/** The message handed to the guard and the send sub-workflow. */
function buildMessage(item, cfg, client) {
  const { lead, email, prevEmail } = item;
  const useB = lead.subject_variant === 'B' && email.subject_b;
  const bare = (x) => String(x || '').trim().replace(/^(\s*(\[TEST\]|Re:|AW:)\s*)+/i, '').trim();
  const subject = Number(email.step) === 1
    ? bare(useB ? email.subject_b : email.subject)
    : 'Re: ' + bare(prevEmail ? prevEmail.subject_sent || prevEmail.subject : email.subject);
  return {
    to: lead.email,
    from: cfg.senderEmail,
    fromName: (client && client.sender_name) || '',
    subject,
    body: email.body,
    threadId: prevEmail ? prevEmail.thread_id : '',
    inReplyTo: prevEmail ? prevEmail.rfc_message_id || '' : '',
    leadId: lead.id,
    emailId: email.id,
    step: Number(email.step),
    purpose: 'outreach',
  };
}

/** Updates after a successful send. firstSentAt = step-1 sent_at (or now for step 1). */
function afterSend(item, sendResult, now, sched, opts) {
  const step = Number(item.email.step);
  const firstSentAt = step === 1 ? now : item.lead.first_sent_at || now;
  const nextStep = step + 1;
  const leadFields = { status: 'Contacted', sequence_step: nextStep > 4 ? 4 : nextStep, first_sent_at: firstSentAt };
  if (step >= 4) {
    leadFields.sequence_finished = true;
    leadFields.next_send_at = null;
  } else {
    leadFields.next_send_at = sched.sendAtForStep(firstSentAt, nextStep, opts).toISOString();
  }
  return {
    lead: { id: item.lead.id, fields: leadFields },
    email: {
      id: item.email.id,
      fields: {
        status: 'Sent',
        sent_at: new Date(now).toISOString(),
        gmail_message_id: sendResult.id || '',
        thread_id: sendResult.threadId || '',
        subject_sent: sendResult.subject || '',
      },
    },
  };
}

/** Daily safety check: Bounced / sent today; above 3% pauses the campaign. */
function bounceCheck(sentToday, bouncedToday, threshold) {
  const t = threshold === undefined ? 0.03 : threshold;
  const rate = sentToday > 0 ? bouncedToday / sentToday : 0;
  return { rate: Math.round(rate * 10000) / 10000, pause: sentToday > 0 && rate > t };
}

const sendingApi = { SENDABLE, STOPPED, selectDue, sendOrder, dailyLimit, buildMessage, afterSend, bounceCheck, linkId };
if (typeof module !== 'undefined' && module.exports) module.exports = sendingApi;
