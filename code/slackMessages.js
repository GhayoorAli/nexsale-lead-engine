/**
 * slackMessages.js – Block Kit messages for #leads. Button values carry
 * "action|recordId" so Module 11 knows what to do.
 */
function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2900) } };
}

function button(text, actionId, value, style, url) {
  const b = { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value: String(value || '') };
  if (style) b.style = style;
  if (url) b.url = url;
  return b;
}

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function campaignReady(c) {
  const samples = (c.samples || []).slice(0, 3);
  const blocks = [
    section(`:rocket: *Campaign ready: ${c.name}*` + (c.client ? `\nFor *${c.client}* · sender ${c.sender || '–'}` : '') + `\n*${c.leadCount}* leads with approved sequences · average lead score *${c.avgScore}* · average email quality *${c.avgQuality}*` +
      (c.flagged ? `\n:warning: ${c.flagged} lead(s) left out (quality below 80 after one rewrite)` : '') +
      (c.rejected ? `\n${c.rejected} lead(s) rejected during enrichment` : '')),
  ];
  samples.forEach((s, i) => {
    blocks.push({ type: 'divider' });
    blocks.push(section(`*Sample ${i + 1}: ${s.company}* (score ${s.score}, quality ${s.quality})\n*Betreff:* ${s.subject}\n${trunc(s.body, 600)}`));
  });
  blocks.push({
    type: 'actions',
    elements: [
      button('Approve and launch', 'approve_launch', 'approve_launch|' + c.campaignRecordId, 'primary'),
      ...(c.listUrl ? [button('Open full list', 'open_list', 'open_list|' + c.campaignRecordId, null, c.listUrl)] : []),
    ],
  });
  return { text: `Campaign ready: ${c.name} (${c.leadCount} leads)`, blocks };
}

function interestedApproval(r) {
  return {
    text: `${r.kind || 'Interested'} reply from ${r.company} – approve the answer?`,
    blocks: [
      section(`:speech_balloon: *${r.kind || 'Interested'} reply* from *${r.company}* (${r.fromEmail}) · confidence ${r.confidence}\n>${trunc(r.replyBody, 500).replace(/\n/g, '\n>')}`),
      section(`*Suggested answer:*\n${trunc(r.suggestedReply, 1200)}`),
      {
        type: 'actions',
        elements: [
          button('Approve and send', 'reply_approve', 'reply_approve|' + r.replyRecordId, 'primary'),
          button('Edit', 'reply_edit', 'reply_edit|' + r.replyRecordId, null, r.editUrl || undefined),
          button('Reject', 'reply_reject', 'reply_reject|' + r.replyRecordId, 'danger'),
        ],
      },
    ],
  };
}

function sortReply(r) {
  const cats = [['Interested', 'sort_interested'], ['Later', 'sort_later'], ['Not interested', 'sort_not_interested'], ['Unsubscribe', 'sort_unsubscribe']];
  return {
    text: `Please sort this reply from ${r.company}`,
    blocks: [
      section(`:question: *Please sort this reply* from *${r.company}* (${r.fromEmail})\nAI guess: ${r.category || 'unclear'} (confidence ${r.confidence})\n>${trunc(r.replyBody, 800).replace(/\n/g, '\n>')}`),
      { type: 'actions', elements: cats.map(([label, id]) => button(label, id, id + '|' + r.replyRecordId)) },
    ],
  };
}

function inboundLead(l) {
  return {
    text: `New ${l.temperature} inbound lead: ${l.name} (${l.company})`,
    blocks: [
      section(`:telephone_receiver: *New ${String(l.temperature).toUpperCase()} inbound lead* – call by ${l.due}\n*${l.name}* · ${l.company} · ${l.phone || 'no phone'}\n${l.brief}`),
      {
        type: 'actions',
        elements: [button('Mark called', 'task_called', 'task_called|' + l.taskRecordId, 'primary'), button('Not reached', 'task_not_reached', 'task_not_reached|' + l.taskRecordId)],
      },
    ],
  };
}

function heldOrNoShow(m) {
  return {
    text: `Meeting with ${m.company}: held or no-show?`,
    blocks: [
      section(`:calendar: Meeting with *${m.company}* started at ${m.start}. Held or no-show?`),
      { type: 'actions', elements: [button('Held', 'meeting_held', 'meeting_held|' + m.meetingRecordId, 'primary'), button('No-show', 'meeting_noshow', 'meeting_noshow|' + m.meetingRecordId, 'danger')] },
    ],
  };
}

/** Replaces the buttons with "<Action> by <user> at <time>". */
function resolvedMessage(original, label, user, when) {
  const blocks = ((original && original.blocks) || []).filter((b) => b.type !== 'actions');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:white_check_mark: ${label} by ${user} at ${when}` }] });
  return { text: `${label} by ${user}`, blocks };
}

function parseActionValue(value) {
  const [action, recordId] = String(value || '').split('|');
  return { action, recordId };
}

const slackMessagesApi = { campaignReady, interestedApproval, sortReply, inboundLead, heldOrNoShow, resolvedMessage, parseActionValue, section };
if (typeof module !== 'undefined' && module.exports) module.exports = slackMessagesApi;
