/**
 * inbox.js – Module 7a: every new mail in the sender inbox → one payload for 07_replies.
 * Live bug (2026-11-15): two mails in the same minute (two Calendly notifications) crashed the hand-over
 * ("Paired item data … unavailable"), and with it every mail of that poll – two lead replies in one minute would have
 * been lost. Now all mails of a poll are mapped here, one payload each, independent of n8n's item pairing.
 */
function toReplyPayloads(mails) {
  const seen = new Set();
  return (mails || []).map((m) => (m && m.json ? m.json : m)).filter((j) => {
    if (!j || !j.id || seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  }).map((j) => ({ id: j.id, threadId: j.threadId, from: j.from, to: j.to, subject: j.subject, text: j.text, date: j.date, headers: j.headers }));
}

const inboxApi = { toReplyPayloads };
if (typeof module !== 'undefined' && module.exports) module.exports = inboxApi;
