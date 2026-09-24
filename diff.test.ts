import { describe, expect, it } from 'vitest';
import {
  changedDiffs,
  diffDocuments,
  inlineDiff,
  normalizeForCompare,
  segmentClauses,
  similarity,
} from '@/lib/diff/clause-diff';

const VERSION_A = [
  '3. PAYMENT',
  '',
  'Company shall pay undisputed amounts within forty-five (45) days after receipt of an invoice.',
  '',
  'Contractor shall bear its own expenses.',
  '',
  '10. LIABILITY',
  '',
  'Total liability shall not exceed the fees paid in the three months preceding the claim.',
].join('\n');

const VERSION_B = [
  '3. PAYMENT',
  '',
  'Company shall pay undisputed amounts within seventy-five (75) days after receipt of an invoice.',
  '',
  'Contractor shall bear its own expenses.',
  '',
  '10. LIABILITY',
  '',
  'Total liability shall not exceed one thousand dollars ($1,000).',
  '',
  'Contractor shall maintain insurance of at least two million dollars.',
].join('\n');

describe('segmentClauses', () => {
  it('splits into clauses and attaches the governing heading', () => {
    const clauses = segmentClauses(VERSION_A);

    expect(clauses).toHaveLength(3);
    expect(clauses[0]?.section).toBe('3. PAYMENT');
    expect(clauses[2]?.section).toBe('10. LIABILITY');
  });

  it('numbers clauses in document order', () => {
    segmentClauses(VERSION_A).forEach((clause, index) => {
      expect(clause.index).toBe(index);
    });
  });
});

describe('normalizeForCompare', () => {
  it('ignores case, smart quotes and whitespace', () => {
    expect(normalizeForCompare('The  Party’s Duty')).toBe("the party's duty");
  });
});

describe('similarity', () => {
  it('is 1 for identical text and 0 for unrelated text', () => {
    expect(similarity('the party shall pay the fee', 'the party shall pay the fee')).toBe(1);
    expect(similarity('the party shall pay the fee', 'insurance certificates are due')).toBe(0);
  });

  it('is high for an edited version of the same clause', () => {
    const score = similarity(
      'company shall pay undisputed amounts within forty-five days after receipt',
      'company shall pay undisputed amounts within seventy-five days after receipt',
    );
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1);
  });
});

describe('inlineDiff', () => {
  it('marks only the words that changed', () => {
    const tokens = inlineDiff('pay within forty-five days', 'pay within seventy-five days');

    expect(tokens.filter((token) => token.type === 'removed')[0]?.value).toBe('forty-five');
    expect(tokens.filter((token) => token.type === 'added')[0]?.value).toBe('seventy-five');
    expect(tokens.some((token) => token.type === 'equal' && token.value.includes('pay'))).toBe(
      true,
    );
  });

  it('reconstructs both inputs from the token stream', () => {
    const left = 'the tenant shall pay rent monthly';
    const right = 'the tenant shall pay rent quarterly in advance';
    const tokens = inlineDiff(left, right);

    const rebuildLeft = tokens
      .filter((token) => token.type !== 'added')
      .map((token) => token.value)
      .join(' ');
    const rebuildRight = tokens
      .filter((token) => token.type !== 'removed')
      .map((token) => token.value)
      .join(' ');

    expect(rebuildLeft).toBe(left);
    expect(rebuildRight).toBe(right);
  });

  it('handles an empty side', () => {
    expect(inlineDiff('', 'brand new clause')).toEqual([
      { type: 'added', value: 'brand new clause' },
    ]);
    expect(inlineDiff('old clause', '')).toEqual([{ type: 'removed', value: 'old clause' }]);
  });
});

describe('diffDocuments', () => {
  it('classifies each clause as unchanged, modified or added', () => {
    const result = diffDocuments(VERSION_A, VERSION_B);

    expect(result.stats.unchanged).toBe(1); // the expenses clause
    expect(result.stats.modified).toBe(2); // payment days and liability cap
    expect(result.stats.added).toBe(1); // the new insurance clause
    expect(result.stats.removed).toBe(0);
  });

  it('pairs an edited clause with its counterpart rather than reporting add + remove', () => {
    const result = diffDocuments(VERSION_A, VERSION_B);
    const payment = result.diffs.find((diff) => diff.leftText?.includes('forty-five'));

    expect(payment?.type).toBe('modified');
    expect(payment?.rightText).toContain('seventy-five');
    expect(payment?.similarity).toBeGreaterThan(0.4);
  });

  it('pairs a clause whose tail was rewritten, not just one that was tweaked', () => {
    // A liability cap rewritten from "3 months of fees" to "$1,000" keeps only
    // its opening words. Reporting it as an unrelated deletion plus an
    // unrelated addition would bury the most consequential kind of change.
    const result = diffDocuments(VERSION_A, VERSION_B);
    const cap = result.diffs.find((diff) => diff.leftText?.includes('three months'));

    expect(cap?.type).toBe('modified');
    expect(cap?.rightText).toContain('one thousand dollars');
  });

  it('does not pair unrelated clauses that merely share legal boilerplate', () => {
    const left = '5. NOTICES\n\nThe party shall provide written notice to the other party.';
    const right = '9. INSURANCE\n\nThe party shall maintain insurance with a reputable insurer.';
    const result = diffDocuments(left, right);

    expect(result.stats.modified).toBe(0);
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(1);
  });

  it('reports no changes for an identical document', () => {
    const result = diffDocuments(VERSION_A, VERSION_A);

    expect(changedDiffs(result)).toHaveLength(0);
    expect(result.stats.unchanged).toBe(3);
  });

  it('treats a whitespace-only edit as unchanged', () => {
    const reformatted = VERSION_A.replace(/ /g, '  ');
    const result = diffDocuments(VERSION_A, reformatted);

    expect(changedDiffs(result)).toHaveLength(0);
  });

  it('reports a wholly new document as added and removed, never modified', () => {
    const result = diffDocuments(VERSION_A, 'Entirely unrelated text about bicycle maintenance.');

    expect(result.stats.modified).toBe(0);
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(3);
  });

  it('gives every diff a unique id', () => {
    const result = diffDocuments(VERSION_A, VERSION_B);
    const ids = result.diffs.map((diff) => diff.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles empty documents on either side', () => {
    expect(diffDocuments('', '').diffs).toHaveLength(0);
    expect(diffDocuments('', VERSION_B).stats.added).toBe(4);
    expect(diffDocuments(VERSION_A, '').stats.removed).toBe(3);
  });
});
