import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS, extractText } from '../../src/client/extractText.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-extract-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The smallest .docx Word and mammoth accept: one document part, one paragraph per line. */
async function makeDocx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  const paragraphs = lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A one-page PDF with a single line of text, xref offsets computed so pdf.js needs no repair. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function write(name: string, content: Buffer | string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe('extractText', () => {
  it('reads the text of a .docx', async () => {
    const path = await write('reglement.docx', await makeDocx(['Règlement EPS', 'Tenue de sport obligatoire.']));

    const result = await extractText(path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(result.text).toContain('Règlement EPS');
    expect(result.text).toContain('Tenue de sport obligatoire.');
    expect(result.truncated).toBe(false);
  });

  it('reads the text of a PDF', async () => {
    const path = await write('bulletin.pdf', makePdf('Moyenne generale 15.2'));

    const result = await extractText(path, 'application/pdf');

    expect(result.text).toContain('Moyenne generale 15.2');
  });

  it('reads plain text as is, and strips HTML', async () => {
    const txt = await write('notes.txt', 'Rendez-vous lundi');
    const html = await write('page.html', '<p>Sortie &amp; visite</p>');

    expect((await extractText(txt, 'text/plain')).text).toBe('Rendez-vous lundi');
    expect((await extractText(html, 'text/html')).text).toBe('Sortie & visite');
  });

  it('says why when the format has no text to extract', async () => {
    const path = await write('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await extractText(path, 'image/png');

    expect(result.text).toBeNull();
    expect(result.unavailableReason).toContain('image/png');
  });

  it('reports a corrupt file instead of throwing, so the download itself still succeeds', async () => {
    const path = await write('broken.docx', 'not a zip at all');

    const result = await extractText(path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(result.text).toBeNull();
    expect(result.unavailableReason).toBeTruthy();
  });

  it('caps very long text and says so', async () => {
    const path = await write('long.txt', 'a'.repeat(MAX_TEXT_CHARS + 10));

    const result = await extractText(path, 'text/plain');

    expect(result.text).toHaveLength(MAX_TEXT_CHARS);
    expect(result.truncated).toBe(true);
  });
});
