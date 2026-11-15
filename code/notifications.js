/**
 * notifications.js – internal emails to the team (never to prospects): "Campaign ready" in a professional layout.
 * Plain text + HTML (inline styles only, as email clients need). In DEMO_MODE the guard sends them to the sender only.
 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The message part of a stored email: without the legal footer (it is the same on every email). */
function withoutFooter(body) {
  const b = String(body || '');
  const i = b.indexOf('\n-- \n');
  return (i >= 0 ? b.slice(0, i) : b).trim();
}

/**
 * c: { name, client, sender, leadCount, avgScore, avgQuality, flagged, rejected, samples:[{company, score, quality, subject, body}], controlUrl }
 * returns { subject, body, html }
 */
function campaignReadyEmail(c) {
  const o = c || {};
  const samples = (o.samples || []).slice(0, 3);
  const facts = [
    ['Client', o.client || '–'], ['Absender', o.sender || '–'], ['Freigegebene Leads', o.leadCount || 0],
    ['Ø Lead-Score', o.avgScore || 0], ['Ø E-Mail-Qualität', o.avgQuality || 0],
    ['Zur Prüfung zurückgehalten', o.flagged || 0], ['Bei der Recherche aussortiert', o.rejected || 0],
  ];
  const subject = 'Kampagne bereit: ' + (o.name || '');
  const line = '────────────────────────────────────────';
  const text = ['Guten Tag,', '',
    'die Kampagne "' + (o.name || '') + '" ist bereit zum Start.', '',
    ...facts.map(([k, v]) => k + ': ' + v), '',
    samples.length ? 'Beispiele (Erst-E-Mail):' : '',
    ...samples.flatMap((s, i) => [line, (i + 1) + '. ' + s.company + ' (Score ' + s.score + ', Qualität ' + s.quality + ')', 'Betreff: ' + s.subject, '', withoutFooter(s.body), '']),
    line, '',
    'Nächster Schritt: Kampagne prüfen und mit "Approve and launch" starten – in Slack #leads oder im Control Center' + (o.controlUrl ? ':\n' + o.controlUrl : '.'),
    '', 'Nexsale Lead Engine'].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');

  const td = 'padding:6px 0;border-bottom:1px solid #ececea;font:14px/1.4 Arial,Helvetica,sans-serif;';
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e3e2de;border-radius:10px;">
<tr><td style="padding:22px 26px 6px;font:13px Arial,Helvetica,sans-serif;color:#6a6a64;">Nexsale Lead Engine</td></tr>
<tr><td style="padding:0 26px 10px;font:bold 21px/1.3 Arial,Helvetica,sans-serif;color:#1b1b1a;">Kampagne bereit: ${esc(o.name)}</td></tr>
<tr><td style="padding:0 26px 16px;font:14px/1.5 Arial,Helvetica,sans-serif;color:#1b1b1a;">Die E-Mails sind geschrieben und geprüft. Bitte kurz ansehen und starten.</td></tr>
<tr><td style="padding:0 26px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${facts.map(([k, v]) => `<tr><td style="${td}color:#6a6a64;">${esc(k)}</td><td style="${td}color:#1b1b1a;font-weight:bold;text-align:right;">${esc(v)}</td></tr>`).join('')}
</table></td></tr>
${samples.length ? `<tr><td style="padding:18px 26px 6px;font:bold 15px Arial,Helvetica,sans-serif;color:#1b1b1a;">Beispiele (Erst-E-Mail)</td></tr>` : ''}
${samples.map((s, i) => `<tr><td style="padding:6px 26px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e2de;border-radius:8px;">
<tr><td style="padding:10px 14px;background:#f7f7f5;border-bottom:1px solid #e3e2de;font:13px/1.4 Arial,Helvetica,sans-serif;color:#1b1b1a;">
<b>${i + 1}. ${esc(s.company)}</b> &nbsp;<span style="color:#6a6a64;">Score ${esc(s.score)} · Qualität ${esc(s.quality)}</span><br>
<span style="color:#6a6a64;">Betreff:</span> ${esc(s.subject)}</td></tr>
<tr><td style="padding:12px 14px;font:14px/1.55 Arial,Helvetica,sans-serif;color:#1b1b1a;white-space:pre-wrap;">${esc(withoutFooter(s.body))}</td></tr>
</table></td></tr>`).join('')}
<tr><td style="padding:14px 26px 6px;font:14px/1.5 Arial,Helvetica,sans-serif;color:#1b1b1a;">Starten Sie die Kampagne mit <b>Approve and launch</b> in Slack #leads oder im Control Center.</td></tr>
${o.controlUrl ? `<tr><td style="padding:8px 26px 24px;"><a href="${esc(o.controlUrl)}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font:bold 14px Arial,Helvetica,sans-serif;padding:10px 18px;border-radius:7px;">Im Control Center öffnen</a></td></tr>` : '<tr><td style="padding:0 0 18px;"></td></tr>'}
</table>
<div style="font:12px Arial,Helvetica,sans-serif;color:#8a8a84;padding:12px;">Interne Benachrichtigung – geht nur an das Team, nie an Interessenten.</div>
</td></tr></table></body></html>`;
  return { subject, body: text, html };
}

const notificationsApi = { campaignReadyEmail, withoutFooter, esc };
if (typeof module !== 'undefined' && module.exports) module.exports = notificationsApi;
