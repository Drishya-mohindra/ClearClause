import type { LlmProvider, LlmRequest, LlmStructuredRequest } from '@/lib/llm/types';
import type { StoredDocument, StreamEvent } from '@/types';
import { setServicesForTesting } from '@/lib/container';
import { InMemoryDocumentStore } from '@/lib/store/document-store';
import { InMemoryRateLimiter } from '@/lib/security/rate-limit';
import { InMemoryVectorStore } from '@/lib/rag/vector-store';
import { HashingEmbeddingProvider } from '@/lib/rag/embeddings';
import { HybridRetriever } from '@/lib/rag/retriever';

/** LLM double that returns whatever a test tells it to, and records its input. */
export class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly requests: Array<LlmRequest | LlmStructuredRequest> = [];

  constructor(
    private chunks: string[] = ['hello'],
    private structured: unknown = {},
  ) {}

  /** Script the reply after setup, when ids from a seeded document are known. */
  setResponse(chunks: string[]): this {
    this.chunks = chunks;
    return this;
  }

  setStructured(value: unknown): this {
    this.structured = value;
    return this;
  }

  async *streamText(request: LlmRequest): AsyncIterable<string> {
    this.requests.push(request);
    for (const chunk of this.chunks) yield chunk;
  }

  async generateStructured(request: LlmStructuredRequest): Promise<unknown> {
    this.requests.push(request);
    return this.structured;
  }

  /** The user-turn content of the most recent call, for assertions. */
  lastUserContent(): string {
    const last = this.requests.at(-1);
    return last?.messages.at(-1)?.content ?? '';
  }
}

/** LLM double that always fails, for exercising the error paths. */
export class FailingLlm implements LlmProvider {
  readonly name = 'failing';

  constructor(private readonly error: Error = new Error('upstream exploded')) {}

  // eslint-disable-next-line require-yield -- the generator throws before yielding.
  async *streamText(): AsyncIterable<string> {
    throw this.error;
  }

  async generateStructured(): Promise<unknown> {
    throw this.error;
  }
}

export interface TestServices {
  llm: LlmProvider;
  documents: InMemoryDocumentStore;
}

/**
 * Wire a fresh object graph for one test. Route handlers resolve their
 * collaborators through the container, so this is the only seam a test needs
 * -- no network, no environment variables, no module mocking.
 */
export function installTestServices(llm: LlmProvider): TestServices {
  const documents = new InMemoryDocumentStore();
  const vectorStore = new InMemoryVectorStore();
  const embeddings = new HashingEmbeddingProvider();

  setServicesForTesting({
    llm,
    documents,
    vectorStore,
    embeddings,
    retriever: new HybridRetriever(vectorStore, embeddings),
    // A generous limit so tests do not trip over each other.
    rateLimiter: new InMemoryRateLimiter(),
  });

  return { llm, documents };
}

export function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: JSON.stringify(body),
  });
}

export function multipartRequest(url: string, file: File): Request {
  const form = new FormData();
  form.append('file', file);
  return new Request(url, {
    method: 'POST',
    headers: { 'x-forwarded-for': randomIp() },
    body: form,
  });
}

/** Each request gets its own rate-limit bucket unless a test wants otherwise. */
function randomIp(): string {
  return `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

/** Parse an SSE response body into its events. */
export async function readStream(response: Response): Promise<StreamEvent[]> {
  const body = await response.text();

  return body
    .split('\n\n')
    .map((frame) => frame.replace(/^data: /, '').trim())
    .filter((payload) => payload.length > 0)
    .map((payload) => JSON.parse(payload) as StreamEvent);
}

/** Concatenated text of every delta event. */
export function streamText(events: StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');
}

export const SAMPLE_CONTRACT = [
  '2. TERM AND TERMINATION',
  '',
  'Company may terminate this Agreement at any time upon seven (7) days written notice.',
  '',
  '3. FEES AND PAYMENT',
  '',
  'Company shall pay undisputed amounts within forty-five (45) days after receipt of an invoice.',
  '',
  '9. INDEMNIFICATION',
  '',
  'Contractor shall defend, indemnify and hold harmless Company against any and all claims.',
].join('\n');

export async function seedDocument(
  store: InMemoryDocumentStore,
  text: string = SAMPLE_CONTRACT,
): Promise<StoredDocument> {
  const { createStoredDocument } = await import('@/lib/ingest');
  const document = createStoredDocument({ name: 'contract.txt', text, kind: 'text' });
  await store.put(document);
  return document;
}
