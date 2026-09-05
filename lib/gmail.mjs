/**
 * Gmail: send the check-ins, and read replies on tracked threads only.
 *
 * Two rules from the spec, both load-bearing:
 *   - Never scan the whole inbox, never match on subject lines. We read only the
 *     gmail_thread_id values we ourselves recorded in mail_threads.
 *   - Store raw_reply first, parse second. A parse failure must never lose text.
 *
 * A Gmail reply quotes the message it answers. Left in, the parser reads our own
 * questions back as if they were answers, so quoted text is stripped before the
 * body ever reaches the model.
 */
import { google } from 'googleapis';
import './env.mjs';

export function getGmail() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 2047 encoded-word, required for a Hebrew Subject header. */
const encodeSubject = (s) =>
  /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

/**
 * Send a plain-text UTF-8 message. Returns { id, threadId }.
 * `inReplyTo` threads the message onto an existing conversation.
 */
export async function sendMail({ to, subject, body, threadId, inReplyTo }) {
  const gmail = getGmail();
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }
  const raw = b64url(headers.join('\r\n') + '\r\n\r\n' + body);
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: threadId ? { raw, threadId } : { raw },
  });
  return { id: res.data.id, threadId: res.data.threadId };
}

/** The RFC822 Message-ID of a sent message, needed to thread the reply. */
export async function getMessageIdHeader(messageId) {
  const gmail = getGmail();
  const res = await gmail.users.messages.get({
    userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['Message-ID'],
  });
  const h = res.data.payload?.headers?.find((x) => x.name.toLowerCase() === 'message-id');
  return h?.value ?? null;
}

function decodePart(part) {
  if (!part?.body?.data) return '';
  return Buffer.from(part.body.data, 'base64').toString('utf8');
}

/** Depth-first search for the first text/plain part, falling back to text/html. */
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain') return decodePart(payload);
  for (const p of payload.parts || []) {
    const found = extractBody(p);
    if (found) return found;
  }
  if (payload.mimeType === 'text/html') {
    return decodePart(payload).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  }
  return decodePart(payload);
}

/**
 * Strip the quoted original from a reply.
 *
 * Without this the parser sees our own six questions inside the reply and can
 * happily "extract" them as answers. Handles Gmail's Hebrew and English
 * attribution lines, `>` quoting, and the standard separators.
 */
export function stripQuoted(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(-{2,}|_{2,})\s*$/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^\s*ב.+ בתאריך .+ מאת .+:\s*$/.test(line)) break;
    if (/^\s*בתאריך .+ (כתב|כתבה)/.test(line)) break;
    if (/^\s*From:\s/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * New inbound messages on one tracked thread, from MY_EMAIL only.
 * `afterMessageId` is the id of our own outbound message; anything at or before
 * it in the thread is ours or older.
 */
export async function readThreadReplies(threadId, { from = process.env.MY_EMAIL } = {}) {
  const gmail = getGmail();
  const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const replies = [];
  for (const m of res.data.messages ?? []) {
    const headers = Object.fromEntries(
      (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );
    const sender = headers.from ?? '';
    if (from && !sender.toLowerCase().includes(from.toLowerCase())) continue;
    if ((m.labelIds ?? []).includes('SENT') && !(m.labelIds ?? []).includes('INBOX')) continue;
    const body = stripQuoted(extractBody(m.payload));
    if (!body) continue;
    replies.push({
      messageId: m.id,
      internalDate: new Date(Number(m.internalDate)).toISOString(),
      from: sender,
      body,
    });
  }
  return replies;
}
