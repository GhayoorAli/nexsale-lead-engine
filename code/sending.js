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
 * ctx: {leads, campaigns, emails, blocklist, sentTodayByCampaign, replies, now, isBlocked}
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
  const due = [];
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
    if (ctx.maxPerRun && due.length >= ctx.maxPerRun) {
      skipped.push({ leadId: l.id, reason: 'per-run cap reached (next tick)' });
      return;
    }
    const limit = Number(campaign.daily_limit) || 40;
    if ((sentToday[cid] || 0) >= limit) {
      skipped.push({ leadId: l.id, reason: 'daily limit reached' });
      return;
    }
    const emails = (ctx.emails || []).filter((e) => linkId(e.lead) === l.id || e.lead_record_id === l.id);
    const email = emails.find((e) => Number(e.step) === step && e.status === 'Approved');
    if (!email) {
      skipped.push({ leadId: l.id, reason: 'no approved email for step ' + step });
      return;
    }
    const prevEmail = emails.filter((e) => e.status === 'Sent').sort((a, b) => Number(b.step) - Number(a.step))[0] || null;
    sentToday[cid] = (sentToday[cid] || 0) + 1;
    due.push({ lead: l, email, prevEmail, campaign });
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

const sendingApi = { SENDABLE, STOPPED, selectDue, buildMessage, afterSend, bounceCheck, linkId };
if (typeof module !== 'undefined' && module.exports) module.exports = sendingApi;
