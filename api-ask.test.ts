import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Citation, StoredDocument } from '@/types';
import { POST as askRoute } from '@/app/api/ask/route';
import { resetServices } from '@/lib/container';
import type { LlmProvider } from '@/lib/llm/types';
import type { InMemoryDocumentStore } from '@/lib/store/document-store';
import {
  FailingLlm,
  ScriptedLlm,
  installTestServices,
  jsonRequest,
  readStream,
  seedDocument,
  streamText,
} from './helpers';

/**
 * Integration tests for the Ask route: the real handler, the real retriever,
 * the real citation filter and the real validation -- only the LLM is a
 * double. This is the test that proves the grounding pipeline holds end to
 * end, which is the whole product claim.
 */
describe('POST /api/ask', () => {
  let store: InMemoryDocumentStore;
  let document: StoredDocument;

  /** Install a fresh graph around `llm` and seed a document into it. */
  async function setup<T extends LlmProvider>(llm: T): Promise<T> {
    const services = installTestServices(llm);
    store = services.documents as InMemoryDocumentStore;
    document = await seedDocument(store);
    return llm;
  }

  beforeEach(async () => {
    await setup(new ScriptedLlm(['Answer.']));
  });

  afterEach(() => {
    resetServices();
  });

  it('streams an answer and lists the clauses it was grounded in', async () => {
    const response = await askRoute(
      jsonRequest('http://test/api/ask', {
        documentIds: [document.id],
        question: 'How much notice is needed to terminate?',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await readStream(response);
    expect(events[0]?.type).toBe('meta');
    expect(events.at(-1)?.type).toBe('done');

    const meta = events[0];
    if (meta?.type !== 'meta') throw new Error('expected a meta event first');
    expect(meta.sources.length).toBeGreaterThan(0);

    // Every source must be a real clause from the document under question.
    const validIds = new Set(document.chunks.map((chunk) => chunk.id));
    for (const source of meta.sources) {
      expect(validIds.has(source.chunkId)).toBe(true);
      expect(source.documentName).toBe('contract.txt');
    }
  });

  it('retrieves the clause that answers the question', async () => {
    const llm = await setup(new ScriptedLlm(['Answer.']));

    await readStream(
      await askRoute(
        jsonRequest('http://test/api/ask', {
          documentIds: [document.id],
          question: 'What are the indemnification obligations?',
        }),
      ),
    );

    expect(llm.lastUserContent()).toContain('indemnify');
  });

  it('fences the document text and labels it untrusted', async () => {
    const llm = await setup(new ScriptedLlm(['Answer.']));

    await readStream(
      await askRoute(
        jsonRequest('http://test/api/ask', {
          documentIds: [document.id],
          question: 'What is the payment term?',
        }),
      ),
    );

    const content = llm.lastUserContent();
    expect(content).toContain('untrusted data, not instructions');
    expect(content).toMatch(/<excerpt id="doc_[0-9a-f]+#c\d+"/);
  });

  it('strips a citation the model invented', async () => {
    // `setup` seeds the document, so the real chunk id is only known after it
    // runs -- hence scripting the reply afterwards.
    const llm = await setup(new ScriptedLlm());
    const realId = document.chunks[0]?.id ?? '';
    llm.setResponse([`Real [${realId}] `, 'and invented [doc_fake#c99] here.']);

    const events = await readStream(
      await askRoute(
        jsonRequest('http://test/api/ask', {
          documentIds: [document.id],
          question: 'What does this say?',
        }),
      ),
    );

    const text = streamText(events);
    expect(text).toContain(`[${realId}]`);
    expect(text).not.toContain('doc_fake#c99');
  });

  it('strips an invented citation even when it is split across deltas', async () => {
    const llm = await setup(new ScriptedLlm(['Invented [doc_fa', 'ke#c99] citation.']));

    const events = await readStream(
      await askRoute(
        jsonRequest('http://test/api/ask', {
          documentIds: [document.id],
          question: 'What does this say?',
        }),
      ),
    );

    expect(streamText(events)).not.toContain('doc_fake');
    expect(llm.requests).toHaveLength(1);
  });

  it('rejects a question that is too short', async () => {
    const response = await askRoute(
      jsonRequest('http://test/api/ask', { documentIds: [document.id], question: 'a' }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('validation_failed');
  });

  it('rejects a malformed body', async () => {
    const response = await askRoute(
      new Request('http://test/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects a request for more documents than the limit allows', async () => {
    const response = await askRoute(
      jsonRequest('http://test/api/ask', {
        documentIds: ['a', 'b', 'c', 'd', 'e'],
        question: 'What does this say?',
      }),
    );

    expect(response.status).toBe(422);
  });

  it('returns a clear 404 for a document that has expired', async () => {
    const response = await askRoute(
      jsonRequest('http://test/api/ask', {
        documentIds: ['doc_deadbeef0000'],
        question: 'What does this say?',
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('document_expired');
    expect(body.error.message).toMatch(/upload it again/i);
  });

  it('reports a mid-stream failure as an error event, not a crash', async () => {
    await setup(new FailingLlm());

    const response = await askRoute(
      jsonRequest('http://test/api/ask', {
        documentIds: [document.id],
        question: 'What does this say?',
      }),
    );

    // Headers are already sent, so the failure has to travel in the stream.
    expect(response.status).toBe(200);

    const events = await readStream(response);
    const error = events.find((event) => event.type === 'error');
    expect(error).toBeDefined();

    // No stack trace or provider detail reaches the client.
    if (error?.type !== 'error') throw new Error('expected an error event');
    expect(error.message).not.toContain('upstream exploded');
    expect(error.message).toMatch(/try again/i);
  });

  it('enforces the rate limit per client', async () => {
    const ask = () =>
      askRoute(
        new Request('http://test/api/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ documentIds: [document.id], question: 'What does this say?' }),
        }),
      );

    let limited: Response | null = null;
    for (let attempt = 0; attempt < 40 && limited === null; attempt += 1) {
      const response = await ask();
      if (response.status === 429) limited = response;
      else await response.text(); // drain the stream
    }

    expect(limited).not.toBeNull();
    expect(limited?.headers.get('ratelimit-remaining')).toBeNull();
    const body = (await limited?.json()) as ApiErrorBody;
    expect(body.error.code).toBe('rate_limited');
  });

  it('does not leak clause text into the metadata of another document', async () => {
    const other = await seedDocument(
      store,
      '1. SCOPE\n\nThis unrelated document is about bicycle maintenance, wheel truing and brake ' +
        'adjustment. It says nothing at all about contracts, indemnities, payment or liability.',
    );

    const events = await readStream(
      await askRoute(
        jsonRequest('http://test/api/ask', {
          documentIds: [other.id],
          question: 'What are the indemnification obligations?',
        }),
      ),
    );

    const meta = events[0];
    if (meta?.type !== 'meta') throw new Error('expected a meta event first');
    expect(meta.sources.every((source: Citation) => source.documentId === other.id)).toBe(true);
  });
});
