/**
 * mime.js – builds the base64url RFC 822 message for the Gmail API messages.send call.
 * Threading: In-Reply-To/References headers plus the Gmail threadId keep steps 2–4 in one thread.
 */
function encodeHeader(v) {
  const s = String(v || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function wrap76(b64) {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

function buildRawEmail(m) {
  if (!m || !m.to) throw new Error('buildRawEmail: "to" is required');
  const headers = [
    'From: ' + (m.fromName ? `${encodeHeader(m.fromName)} <${m.from}>` : m.from || ''),
    'To: ' + m.to,
    'Subject: ' + encodeHeader(m.subject || ''),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (m.inReplyTo) {
    headers.push('In-Reply-To: ' + m.inReplyTo);
    headers.push('References: ' + (m.references || m.inReplyTo));
  }
  if (m.listUnsubscribe) headers.push('List-Unsubscribe: ' + m.listUnsubscribe);
  const body = wrap76(Buffer.from(String(m.body || ''), 'utf8').toString('base64'));
  const raw = headers.join('\r\n') + '\r\n\r\n' + body;
  return base64url(raw);
}

function decodeRawEmail(raw) {
  const s = Buffer.from(String(raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const [head, ...rest] = s.split('\r\n\r\n');
  const headers = {};
  head.split('\r\n').forEach((l) => {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
  });
  const decodeWord = (v) => String(v || '').replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (m, b) => Buffer.from(b, 'base64').toString('utf8'));
  return {
    headers,
    subject: decodeWord(headers.subject),
    to: headers.to,
    body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8'),
  };
}

const mimeApi = { encodeHeader, base64url, buildRawEmail, decodeRawEmail };
if (typeof module !== 'undefined' && module.exports) module.exports = mimeApi;
