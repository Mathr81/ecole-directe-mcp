/**
 * École Directe sends some text fields base64-encoded — message bodies,
 * homework and lesson contents — and the rest in plain text. Decoding is
 * therefore per field, never blanket: a short code such as "ESP2" is valid
 * base64 too, and decoding it produces garbage.
 */

function looksBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Rejects a decode that produced binary rather than text. Ignoring whitespace
 * (below) widens what counts as base64 enough that short plain text can fall
 * into it — "Test abcd" becomes the eight valid characters "Testabcd" — and
 * decoding that yields mojibake. A replacement character means the bytes
 * weren't valid UTF-8; control characters other than tab/CR/LF appear in no
 * subject, filename or HTML body we care about.
 */
function isPlausibleText(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(value);
}

/**
 * École Directe wraps base64 bodies MIME-style, with a line break roughly
 * every 76 characters — real messages came back with 16 and 2402 whitespace
 * characters respectively. That whitespace breaks both the charset regex and
 * the length-%-4 check, so a strict test concludes "not base64" and hands the
 * caller a still-encoded body; `stripHtml` then finds no tags to remove and
 * the message reaches the agent as raw base64, at full encoded size (194 KB
 * for one message that is 142 characters of actual text).
 */
export function decodeMaybeBase64(value: string | undefined): string {
  if (!value) return '';
  const compact = value.replace(/\s+/g, '');
  if (!looksBase64(compact)) return value;
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  return isPlausibleText(decoded) ? decoded : value;
}
