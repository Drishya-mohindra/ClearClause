import { describe, expect, it } from 'vitest';
import {
  citedSources,
  createCitationResolver,
  extractCitations,
  filterCitationStream,
  stripUnresolvedCitations,
} from '@/lib/citations';
import { createStoredDocument } from '@/lib/ingest';
import { findChunkContaining, groundQuote } from '@/lib/analysis/grounding';

const DOCUMENT = createStoredDocument({
  name: 'lease.txt',
  kind: 'text',
  text: [
    '2. RENT',
    '',
    'Monthly rent is two thousand four hundred dollars ($2,400), due in advance on the first day of each month.',
    '',
    '9. EARLY TERMINATION',
    '',
    'Tenant may terminate this Lease early by giving sixty days written notice and paying a fee equal to two months rent.',
  ].join('\n'),
});

const resolve = createCitationResolver([DOCUMENT]);
const firstChunkId = DOCUMENT.chunks[0]?.id ?? '';

async function collect(source: AsyncIterable<string>): Promise<string> {
  let output = '';
  for await (const part of source) output += part;
  return output;
}

async function* emit(parts: string[]): AsyncIterable<string> {
  for (const part of parts) yield part;
}

describe('createCitationResolver', () => {
  it('resolves a real chunk id to its section and snippet', () => {
    const citation = resolve(firstChunkId);

    expect(citation).not.toBeNull();
    expect(citation?.documentName).toBe('lease.txt');
    expect(citation?.section).toBe('2. RENT');
    expect(citation?.snippet).toContain('$2,400');
  });

  it('returns null for an id the model invented', () => {
    expect(resolve('doc_fake#c99')).toBeNull();
    expect(resolve('not-an-id')).toBeNull();
  });
});

describe('extractCitations', () => {
  it('collects valid ids once each, in order of first use', () => {
    const text = `Rent is $2,400 [${firstChunkId}]. It is due monthly [${firstChunkId}].`;
    expect(extractCitations(text, resolve)).toHaveLength(1);
  });

  it('ignores ids that do not resolve', () => {
    expect(extractCitations('Fabricated [doc_zz#c01] claim.', resolve)).toHaveLength(0);
  });
});

describe('stripUnresolvedCitations', () => {
  it('keeps valid citations and removes invented ones', () => {
    const text = `Real [${firstChunkId}] and fake [doc_zz#c07].`;
    const result = stripUnresolvedCitations(text, resolve);

    expect(result).toContain(`[${firstChunkId}]`);
    expect(result).not.toContain('doc_zz#c07');
  });
});

describe('filterCitationStream', () => {
  it('strips an invented citation split across two deltas', async () => {
    // The whole point of buffering: per-delta filtering would miss this.
    const result = await collect(
      filterCitationStream(emit(['Fabricated claim [doc_z', 'z#c07] here.']), resolve),
    );

    expect(result).toBe('Fabricated claim  here.');
    expect(result).not.toContain('doc_zz');
  });

  it('preserves a valid citation split across deltas', async () => {
    const half = Math.floor(firstChunkId.length / 2);
    const result = await collect(
      filterCitationStream(
        emit([
          'Rent is due [',
          firstChunkId.slice(0, half),
          firstChunkId.slice(half),
          '] monthly.',
        ]),
        resolve,
      ),
    );

    expect(result).toBe(`Rent is due [${firstChunkId}] monthly.`);
  });

  it('releases a bracket that never closes instead of swallowing it', async () => {
    const trailing = `an unclosed bracket [${'x'.repeat(100)}`;
    const result = await collect(filterCitationStream(emit([trailing]), resolve));

    expect(result).toBe(trailing);
  });

  it('passes text with no citations through unchanged', async () => {
    const result = await collect(filterCitationStream(emit(['plain ', 'text']), resolve));
    expect(result).toBe('plain text');
  });
});

describe('citedSources', () => {
  it('narrows a full source list to the ones actually cited', () => {
    const all = DOCUMENT.chunks.map((chunk) => resolve(chunk.id)).filter((c) => c !== null);
    const cited = citedSources(`Only the first clause [${firstChunkId}].`, all);

    expect(all.length).toBeGreaterThan(cited.length);
    expect(cited[0]?.chunkId).toBe(firstChunkId);
  });
});

describe('grounding', () => {
  it('locates a chunk from a verbatim quote', () => {
    expect(findChunkContaining('due in advance on the first day of each month', DOCUMENT)).toBe(
      firstChunkId,
    );
  });

  it('ignores case and spacing differences in the quote', () => {
    expect(findChunkContaining('DUE   IN ADVANCE on the FIRST day', DOCUMENT)).toBe(firstChunkId);
  });

  it('refuses to match a quote too short to be distinctive', () => {
    expect(findChunkContaining('rent', DOCUMENT)).toBeNull();
  });

  it('returns null for a quote that is not in the document', () => {
    expect(findChunkContaining('the tenant shall paint the walls annually', DOCUMENT)).toBeNull();
  });

  it('recovers a citation when the model cites the wrong chunk id', () => {
    const result = groundQuote(
      'doc_wrong#c42',
      'due in advance on the first day of each month',
      DOCUMENT,
      resolve,
    );

    expect(result.via).toBe('quote-match');
    expect(result.citation?.chunkId).toBe(firstChunkId);
  });

  it('prefers the model id when it is valid', () => {
    const result = groundQuote(firstChunkId, 'anything at all', DOCUMENT, resolve);
    expect(result.via).toBe('chunk-id');
  });

  it('reports no grounding when neither the id nor the quote checks out', () => {
    const result = groundQuote('doc_wrong#c42', 'invented clause text here', DOCUMENT, resolve);

    expect(result.via).toBe('none');
    expect(result.citation).toBeNull();
  });
});
