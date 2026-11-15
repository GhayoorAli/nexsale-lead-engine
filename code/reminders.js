/**
 * reminders.js – Module 7c (hourly): 24 h reminder emails and "held or no-show?" checks.
 */
function dueReminders(meetings, now) {
  const t = new Date(now || Date.now()).getTime();
  const reminders = [];
  const heldChecks = [];
  (meetings || []).forEach((m) => {
    if (!m.start_time) return;
    const start = new Date(m.start_time).getTime();
    if (m.status === 'Booked' && !m.reminder_sent_at && start - t <= 24 * 3600000 && start > t) reminders.push(m);
    if ((m.status === 'Booked' || m.status === 'Reminded') && !m.held_check_sent_at && t >= start + 15 * 60000) heldChecks.push(m);
  });
  return { reminders, heldChecks };
}

function reminderEmail(meeting, lead, client, berlinTime, ve) {
  const text = `ich freue mich auf unser Gespräch am ${berlinTime}. Falls etwas dazwischenkommt, können Sie den Termin über den Link in der Calendly-Bestätigung verschieben.`;
  const body = ve
    ? ve.ensureFrame(text, { contactName: lead.contact_name, contactSalutation: lead.contact_salutation, signature: ve.buildSignature(client || {}) })
    : `Guten Tag ${lead.contact_name || ''},\n\n${text}\n\nMit freundlichen Grüßen\n\n${(client && client.sender_name) || 'Ihr Nexsale-Team'}`.replace(/Tag \s*,/, 'Tag,');
  return { to: lead.email, subject: 'Erinnerung: unser Termin morgen', body, purpose: 'reminder' };
}

function formatBerlin(iso) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso)) + ' Uhr';
}

const remindersApi = { dueReminders, reminderEmail, formatBerlin };
if (typeof module !== 'undefined' && module.exports) module.exports = remindersApi;
