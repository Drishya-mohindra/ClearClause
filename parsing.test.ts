import { describe, expect, it } from 'vitest';
import { detectKind, extractDocument, TextParser } from '@/lib/parsing';
import { AppError } from '@/lib/security/errors';
import { createStoredDocument } from '@/lib/ingest';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

describe('detectKind', () => {
  it('identifies a PDF by its magic bytes, whatever it is named', () => {
    expect(detectKind(bytes('%PDF-1.7 ...'), 'text/plain', 'lease.txt')).toBe('pdf');
  });

  it('identifies a DOCX by its zip header plus a docx signal', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x20]);
    expect(detectKind(zip, 'application/octet-stream', 'contract.docx')).toBe('docx');
  });

  it('rejects a zip that is not a Word document', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x20]);
    expect(() => detectKind(zip, 'application/zip', 'photos.zip')).toThrow(AppError);
  });

  it('rejects binary content masquerading as text', () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    expect(() => detectKind(binary, 'text/plain', 'notes.txt')).toThrow(/readable document/i);
  });

  it('accepts plain text', () => {
    expect(detectKind(bytes('1. TERM\n\nThis agreement...'), 'text/plain', 'a.txt')).toBe('text');
  });
});

describe('TextParser', () => {
  const parser = new TextParser();

  it('claims text and markdown by extension or MIME type', () => {
    expect(parser.supports('text/plain', 'a.txt')).toBe(true);
    expect(parser.supports('application/octet-stream', 'notes.md')).toBe(true);
    expect(parser.supports('application/pdf', 'a.pdf')).toBe(false);
  });

  it('normalises as it parses', async () => {
    const result = await parser.parse(bytes('1. TERM\r\n\r\n\r\n\r\nThe   term   is one year.'));

    expect(result.kind).toBe('text');
    expect(result.text).toBe('1. TERM\n\nThe term is one year.');
    expect(result.pageCount).toBeNull();
  });

  it('rejects an empty file with a client-safe message', async () => {
    await expect(parser.parse(bytes('   '))).rejects.toThrow(/empty/i);
  });
});

describe('extractDocument', () => {
  it('routes by sniffed content rather than by the declared type', async () => {
    const result = await extractDocument(
      bytes('1. TERM\n\nThe term is one year and may be renewed.'),
      'application/pdf', // a lie
      'contract.pdf',
    );

    expect(result.kind).toBe('text');
    expect(result.text).toContain('The term is one year');
  });
});

describe('createStoredDocument', () => {
  const body = `1. TERM\n\n${'The agreement continues for one year. '.repeat(10)}`;

  it('produces a chunked, citable document', () => {
    const document = createStoredDocument({ name: 'lease.txt', text: body, kind: 'text' });

    expect(document.id).toMatch(/^doc_[0-9a-f]{12}$/);
    expect(document.chunks.length).toBeGreaterThan(0);
    expect(document.chunkCount).toBe(document.chunks.length);
    expect(document.wordCount).toBeGreaterThan(50);
    // Chunk ids must parse unambiguously as `documentId#cNN`.
    expect(document.chunks[0]?.id.startsWith(`${document.id}#c`)).toBe(true);
  });

  it('sanitises the name it echoes back', () => {
    const document = createStoredDocument({
      name: '../../etc/passwd',
      text: body,
      kind: 'text',
    });
    expect(document.name).toBe('passwd');
  });

  it('gives the same text the same id, so re-ingesting keeps citations valid', () => {
    const a = createStoredDocument({ name: 'a.txt', text: body, kind: 'text' });
    const b = createStoredDocument({ name: 'b.txt', text: body, kind: 'text' });

    // Content-addressed: the client can re-send a document the server has
    // forgotten and every chunk id the reader is looking at still resolves.
    expect(a.id).toBe(b.id);
    expect(a.chunks.map((chunk) => chunk.id)).toEqual(b.chunks.map((chunk) => chunk.id));
  });

  it('gives different text different ids', () => {
    const a = createStoredDocument({ name: 'a', text: body, kind: 'text' });
    const b = createStoredDocument({ name: 'a', text: `${body} One extra clause.`, kind: 'text' });

    expect(a.id).not.toBe(b.id);
  });

  it('ignores formatting-only differences when deriving the id', () => {
    const a = createStoredDocument({ name: 'a', text: body, kind: 'text' });
    const b = createStoredDocument({ name: 'a', text: body.replace(/ /g, '  '), kind: 'text' });

    // The id is derived after normalisation, so re-uploading the same document
    // from a different exporter does not create a duplicate.
    expect(a.id).toBe(b.id);
  });

  it('rejects input too short to be a document', () => {
    expect(() => createStoredDocument({ name: 'a', text: 'too short', kind: 'text' })).toThrow(
      /too little text/i,
    );
  });

  it('rejects input beyond the size ceiling', () => {
    expect(() =>
      createStoredDocument({ name: 'a', text: 'word '.repeat(200_000), kind: 'text' }),
    ).toThrow(/too long/i);
  });
});
