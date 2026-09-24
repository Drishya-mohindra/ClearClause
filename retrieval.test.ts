import { beforeEach, describe, expect, it } from 'vitest';
import type { StoredDocument } from '@/types';
import { createStoredDocument } from '@/lib/ingest';
import {
  HashingEmbeddingProvider,
  cosineSimilarity,
  l2Normalize,
  tokenize,
} from '@/lib/rag/embeddings';
import { InMemoryVectorStore } from '@/lib/rag/vector-store';
import { HybridRetriever, bm25Search, reciprocalRankFusion } from '@/lib/rag/retriever';

const CONTRACT = [
  '2. TERM AND TERMINATION',
  '',
  'Company may terminate this Agreement at any time upon seven days written notice to Contractor.',
  '',
  '3. FEES AND PAYMENT',
  '',
  'Company shall pay undisputed amounts within forty-five days after receipt of an invoice.',
  '',
  '9. INDEMNIFICATION',
  '',
  'Contractor shall defend, indemnify and hold harmless Company against all claims and losses.',
  '',
  '11. INSURANCE',
  '',
  'Contractor shall maintain commercial general liability insurance of at least one million dollars.',
].join('\n');

function makeDocument(): StoredDocument {
  return createStoredDocument({ name: 'contract.txt', text: CONTRACT, kind: 'text' });
}

describe('tokenize', () => {
  it('lowercases, drops stop words and keeps figures', () => {
    expect(tokenize('The Company shall pay $2,400 within 45 days')).toEqual([
      'company',
      'pay',
      '2400',
      'within',
      '45',
      'days',
    ]);
  });

  it('normalises money so an amount is findable however it is written', () => {
    // All three spellings must produce the same token, or a reader searching
    // for the rent they were quoted will not find the clause that sets it.
    expect(tokenize('$2,400')).toEqual(['2400']);
    expect(tokenize('2,400')).toEqual(['2400']);
    expect(tokenize('2400')).toEqual(['2400']);
  });

  it('keeps percentages distinguishable from bare numbers', () => {
    expect(tokenize('a 7% increase')).toEqual(['7%', 'increase']);
  });
});

describe('HashingEmbeddingProvider', () => {
  const provider = new HashingEmbeddingProvider();

  it('is deterministic', async () => {
    const [a] = await provider.embed(['termination for convenience']);
    const [b] = await provider.embed(['termination for convenience']);
    expect(a).toEqual(b);
  });

  it('produces unit vectors of the declared size', async () => {
    const [vector] = await provider.embed(['indemnification and liability']);

    expect(vector).toHaveLength(provider.dimensions);
    const magnitude = Math.sqrt((vector ?? []).reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('scores related text above unrelated text', async () => {
    const [termination, notice, insurance] = await provider.embed([
      'company may terminate the agreement on seven days notice',
      'terminate the agreement with written notice to the contractor',
      'maintain commercial general liability insurance coverage',
    ]);

    const related = cosineSimilarity(termination ?? [], notice ?? []);
    const unrelated = cosineSimilarity(termination ?? [], insurance ?? []);
    expect(related).toBeGreaterThan(unrelated);
  });

  it('handles empty input without producing NaN', async () => {
    const [vector] = await provider.embed(['']);
    expect(vector?.every(Number.isFinite)).toBe(true);
  });
});

describe('l2Normalize', () => {
  it('leaves a zero vector alone instead of dividing by zero', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('bm25Search', () => {
  it('ranks the chunk containing the query terms first', () => {
    const document = makeDocument();
    const results = bm25Search('indemnify hold harmless', document.chunks, 3);

    expect(results[0]?.chunk.text).toContain('indemnify');
  });

  it('returns nothing when no term matches', () => {
    const document = makeDocument();
    expect(bm25Search('bicycle maintenance schedule', document.chunks, 3)).toHaveLength(0);
  });

  it('returns nothing for an empty corpus or an empty query', () => {
    expect(bm25Search('anything', [], 3)).toHaveLength(0);
    expect(bm25Search('', makeDocument().chunks, 3)).toHaveLength(0);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards a chunk that ranks well in both lists', () => {
    const chunk = (id: string) => ({
      id,
      documentId: 'doc_1',
      index: 0,
      section: 'S',
      text: id,
      startChar: 0,
      endChar: 1,
    });

    const fused = reciprocalRankFusion(
      [
        [
          { chunk: chunk('a'), score: 1 },
          { chunk: chunk('b'), score: 0.9 },
        ],
        [
          { chunk: chunk('b'), score: 1 },
          { chunk: chunk('c'), score: 0.8 },
        ],
      ],
      3,
    );

    expect(fused[0]?.chunk.id).toBe('b');
    expect(fused).toHaveLength(3);
  });
});

describe('HybridRetriever', () => {
  let retriever: HybridRetriever;
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
    retriever = new HybridRetriever(store, new HashingEmbeddingProvider());
  });

  it('retrieves the clause that answers the question', async () => {
    const document = makeDocument();
    const hits = await retriever.retrieve({
      query: 'how much notice to terminate?',
      documents: [document],
      topK: 3,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.chunk.text.includes('seven days'))).toBe(true);
  });

  it('indexes each document only once', async () => {
    const document = makeDocument();
    await retriever.indexDocument(document);
    await retriever.indexDocument(document);

    const records = await store.listByDocument(document.id);
    expect(records).toHaveLength(document.chunks.length);
  });

  it('returns nothing without documents or without a query', async () => {
    expect(await retriever.retrieve({ query: 'x', documents: [] })).toHaveLength(0);
    expect(await retriever.retrieve({ query: '  ', documents: [makeDocument()] })).toHaveLength(0);
  });

  it('only searches the documents it was given', async () => {
    const a = makeDocument();
    const b = createStoredDocument({
      name: 'other.txt',
      text:
        '1. SCOPE\n\nThis document concerns bicycle maintenance, wheel truing and brake adjustment. ' +
        'It has nothing whatever to do with contracts, indemnities, insurance or payment terms.',
      kind: 'text',
    });

    const hits = await retriever.retrieve({ query: 'indemnify', documents: [b], topK: 3 });
    expect(hits.every((hit) => hit.chunk.documentId === b.id)).toBe(true);
    expect(hits.every((hit) => hit.chunk.documentId !== a.id)).toBe(true);
  });
});
