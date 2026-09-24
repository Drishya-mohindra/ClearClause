import { describe, expect, it } from 'vitest';
import { parseBlocks } from '@/components/features/generated-text';

/**
 * The renderer turns markdown into React elements rather than HTML. These
 * tests pin the parsing; the safety property itself is structural -- the
 * component never calls `dangerouslySetInnerHTML`, so anything the parser
 * leaves as text is escaped by React.
 */
describe('parseBlocks', () => {
  it('recognises headings, lists and paragraphs', () => {
    const blocks = parseBlocks(
      [
        '## Money',
        '',
        'Rent is $2,400 a month.',
        '',
        '- Due on the 1st',
        '- Late after the 3rd',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.type)).toEqual(['h2', 'p', 'ul']);
    expect(blocks[2]?.lines).toEqual(['Due on the 1st', 'Late after the 3rd']);
  });

  it('groups consecutive list items into one list', () => {
    const blocks = parseBlocks('1. First\n2. Second\n3. Third');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('ol');
    expect(blocks[0]?.lines).toHaveLength(3);
  });

  it('treats raw HTML as ordinary text rather than markup', () => {
    const blocks = parseBlocks('<script>alert(1)</script> and <img src=x onerror=y>');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('p');
    // It stays a plain text line; React escapes it at render time.
    expect(blocks[0]?.lines[0]).toContain('<script>alert(1)</script>');
  });

  it('handles empty and whitespace-only input', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\n\n   \n')).toEqual([]);
  });

  it('joins a wrapped paragraph back into one block', () => {
    const blocks = parseBlocks('This sentence\nwraps across\nthree lines.');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toHaveLength(3);
  });
});
