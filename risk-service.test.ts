import { describe, expect, it } from 'vitest';
import { batchChunks, mapWithConcurrency } from '@/lib/analysis/risk-service';
import { createStoredDocument } from '@/lib/ingest';

const LONG_DOCUMENT = createStoredDocument({
  name: 'long.txt',
  kind: 'text',
  text: Array.from(
    { length: 700 },
    (_, index) =>
      `${index + 1}. CLAUSE ${index}\n\nThe party shall perform obligation number ${index} promptly and without delay.`,
  ).join('\n\n'),
});

describe('batchChunks', () => {
  it('keeps a small document to a single call', () => {
    const chunks = LONG_DOCUMENT.chunks.slice(0, 3);
    expect(batchChunks(chunks)).toHaveLength(1);
  });

  it('splits a long document into a handful of calls, not one per chunk', () => {
    const batches = batchChunks(LONG_DOCUMENT.chunks);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.length).toBeLessThan(LONG_DOCUMENT.chunks.length / 5);
  });

  it('never splits a chunk across two batches, and loses none', () => {
    const batches = batchChunks(LONG_DOCUMENT.chunks, 4000);
    const flattened = batches.flat();

    expect(flattened).toHaveLength(LONG_DOCUMENT.chunks.length);
    expect(flattened.map((chunk) => chunk.id)).toEqual(
      LONG_DOCUMENT.chunks.map((chunk) => chunk.id),
    );
  });

  it('keeps each batch within its character budget where a chunk allows', () => {
    for (const batch of batchChunks(LONG_DOCUMENT.chunks, 4000)) {
      const size = batch.reduce((total, chunk) => total + chunk.text.length, 0);
      // A batch may exceed the budget only by its final chunk.
      const withoutLast = size - (batch.at(-1)?.text.length ?? 0);
      expect(withoutLast).toBeLessThanOrEqual(4000);
    }
  });

  it('handles an empty document', () => {
    expect(batchChunks([])).toEqual([]);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const results = await mapWithConcurrency([5, 1, 3], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 2;
    });

    expect(results).toEqual([10, 2, 6]);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return null;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 2, async () => 1)).toEqual([]);
  });
});
