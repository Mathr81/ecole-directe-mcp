/**
 * Text extraction for downloaded documents.
 *
 * Over the HTTP transport the file lands on the server, where the model
 * calling the tool cannot read it — returning its path is useless to a
 * Claude.ai connector. What the model actually needs is the text, so the
 * common school formats are read here: PDF (bulletins, circulars), DOCX
 * (rules, handouts), plain text and HTML.
 *
 * Extraction never throws: a document that fails to parse is still a
 * successful download, so the failure is reported alongside it instead.
 */
import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import { stripHtml } from './mappers.js';

/** Roughly 25k tokens: enough for any circular or rule book, bounded for a bulletin-sized PDF dump. */
export const MAX_TEXT_CHARS = 100_000;

export interface ExtractedText {
  text: string | null;
  truncated: boolean;
  /** Why `text` is null — unsupported format or unreadable file. */
  unavailableReason?: string;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function readText(path: string, mimeType: string): Promise<string | null> {
  if (mimeType === 'application/pdf') {
    const { text } = await extractPdfText(new Uint8Array(await readFile(path)), { mergePages: true });
    return text;
  }
  if (mimeType === DOCX) {
    const { value } = await mammoth.extractRawText({ buffer: await readFile(path) });
    return value;
  }
  if (mimeType === 'text/html') return stripHtml(await readFile(path, 'utf8'));
  if (mimeType === 'text/plain' || mimeType === 'text/csv') return readFile(path, 'utf8');
  return null;
}

export async function extractText(path: string, mimeType: string): Promise<ExtractedText> {
  let text: string | null;
  try {
    text = await readText(path, mimeType);
  } catch (error) {
    return {
      text: null,
      truncated: false,
      unavailableReason: `Texte illisible : ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (text === null) {
    return {
      text: null,
      truncated: false,
      unavailableReason: `Pas d'extraction de texte pour le format ${mimeType}.`,
    };
  }
  // Word and pdf.js both leave runs of blank lines; they cost tokens and say nothing.
  const normalised = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalised.length > MAX_TEXT_CHARS
    ? { text: normalised.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text: normalised, truncated: false };
}
