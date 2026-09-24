import { describe, expect, it } from 'vitest';
import { chunkDocument, estimateTokens, isHeading, makeChunkId } from '@/lib/rag/chunk';

const CONTRACT = [
  '1. SERVICES',
  '',
  'The Contractor shall provide data engineering services as described in each statement of work.',
  '',
  'The Contractor shall perform the Services in a professional manner.',
  '',
  '2. TERM AND TERMINATION',
  '',
  'This Agreement begins on the Effective Date and continues for twelve months.',
  '',
  'Company may terminate on seven days notice.',
].join('\n');

describe('isHeading', () => {
  it('recognises the heading styles legal documents use', () => {
    expect(isHeading('1. SERVICES')).toBe(true);
    expect(isHeading('ARTICLE 5')).toBe(true);
    expect(isHeading('Section 8.2 Limitation of Liability')).toBe(true);
    expect(isHeading('LIMITATION OF LIABILITY')).toBe(true);
    expect(isHeading('4.3 Payment Terms')).toBe(true);
  });

  it('does not mistake prose for a heading', () => {
    expect(isHeading('The Contractor shall provide services in a professional manner.')).toBe(
      false,
    );
    expect(isHeading('')).toBe(false);
    expect(isHeading('a'.repeat(200))).toBe(false);
  });
});

describe('chunkDocument', () => {
  it('labels each chunk with the heading it sits under', () => {
    const chunks = chunkDocument('doc_test', CONTRACT);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.section).toBe('1. SERVICES');
    expect(chunks.at(-1)?.section).toBe('2. TERM AND TERMINATION');
  });

  it('never merges text across a section boundary', () => {
    const chunks = chunkDocument('doc_test', CONTRACT);

    for (const chunk of chunks) {
      const mentionsServices = chunk.text.includes('statement of work');
      const mentionsTerm = chunk.text.includes('seven days notice');
      expect(mentionsServices && mentionsTerm).toBe(false);
    }
  });

  it('produces stable, citable ids in document order', () => {
    const chunks = chunkDocument('doc_abc', CONTRACT);

    expect(chunks[0]?.id).toBe('doc_abc#c00');
    chunks.forEach((chunk, index) => {
      expect(chunk.id).toBe(makeChunkId('doc_abc', index));
      expect(chunk.index).toBe(index);
      expect(chunk.documentId).toBe('doc_abc');
    });
  });

  it('is deterministic', () => {
    expect(chunkDocument('doc_x', CONTRACT)).toEqual(chunkDocument('doc_x', CONTRACT));
  });

  it('keeps chunks near the target size for a long single section', () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index} states that the party shall perform its duties promptly.`,
    );
    const chunks = chunkDocument('doc_long', paragraphs.join('\n\n'));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1600);
    }
  });

  it('splits a single paragraph that exceeds the hard ceiling', () => {
    const giant = `${'The party shall indemnify the other party. '.repeat(120)}`;
    const chunks = chunkDocument('doc_giant', giant);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1700);
    }
  });

  it('returns nothing for empty input', () => {
    expect(chunkDocument('doc_empty', '')).toEqual([]);
    expect(chunkDocument('doc_empty', '   \n\n  ')).toEqual([]);
  });

  it('preserves the full text across chunks', () => {
    const chunks = chunkDocument('doc_test', CONTRACT);
    const combined = chunks.map((chunk) => chunk.text).join(' ');

    expect(combined).toContain('statement of work');
    expect(combined).toContain('seven days notice');
    expect(combined).toContain('professional manner');
  });
});

describe('estimateTokens', () => {
  it('scales with length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});
