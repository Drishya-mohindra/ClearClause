import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ComparisonResult, RiskFinding, StoredDocument } from '@/types';
import { POST as documentsRoute } from '@/app/api/documents/route';
import { POST as risksRoute } from '@/app/api/risks/route';
import { POST as compareRoute } from '@/app/api/compare/route';
import { POST as actRoute } from '@/app/api/act/route';
import { resetServices } from '@/lib/container';
import type { InMemoryDocumentStore } from '@/lib/store/document-store';
import {
  FailingLlm,
  SAMPLE_CONTRACT,
  ScriptedLlm,
  installTestServices,
  jsonRequest,
  multipartRequest,
  seedDocument,
} from './helpers';

describe('POST /api/documents', () => {
  let store: InMemoryDocumentStore;

  beforeEach(() => {
    store = installTestServices(new ScriptedLlm()).documents as InMemoryDocumentStore;
  });

  afterEach(resetServices);

  it('accepts pasted text and returns metadata only', async () => {
    const response = await documentsRoute(
      jsonRequest('http://test/api/documents', { name: 'lease.txt', text: SAMPLE_CONTRACT }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { document: Record<string, unknown> };

    expect(body.document.name).toBe('lease.txt');
    expect(body.document.chunkCount).toBeGreaterThan(0);
    // Clause text must never ride along in the metadata response.
    expect(body.document).not.toHaveProperty('text');
    expect(body.document).not.toHaveProperty('chunks');
  });

  it('stores the document so other routes can find it', async () => {
    const response = await documentsRoute(
      jsonRequest('http://test/api/documents', { text: SAMPLE_CONTRACT }),
    );
    const { document } = (await response.json()) as { document: { id: string } };

    expect(await store.get(document.id)).not.toBeNull();
  });

  it('accepts an uploaded text file', async () => {
    const file = new File([SAMPLE_CONTRACT], 'agreement.txt', { type: 'text/plain' });
    const response = await documentsRoute(multipartRequest('http://test/api/documents', file));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { document: { name: string; kind: string } };
    expect(body.document.kind).toBe('text');
    expect(body.document.name).toBe('agreement.txt');
  });

  it('sanitises a filename carrying a path', async () => {
    const file = new File([SAMPLE_CONTRACT], '../../etc/passwd', { type: 'text/plain' });
    const response = await documentsRoute(multipartRequest('http://test/api/documents', file));

    const body = (await response.json()) as { document: { name: string } };
    expect(body.document.name).toBe('passwd');
  });

  it('rejects a file whose real type is not supported', async () => {
    // A PNG header renamed to .txt: sniffing must catch it.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const file = new File([png], 'notes.txt', { type: 'text/plain' });
    const response = await documentsRoute(multipartRequest('http://test/api/documents', file));

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('unsupported_type');
  });

  it('rejects an empty file', async () => {
    const file = new File([], 'empty.txt', { type: 'text/plain' });
    const response = await documentsRoute(multipartRequest('http://test/api/documents', file));

    expect(response.status).toBe(400);
  });

  it('rejects an upload with no file attached', async () => {
    const response = await documentsRoute(
      new Request('http://test/api/documents', { method: 'POST', body: new FormData() }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('missing_file');
  });

  it('rejects text too short to analyse', async () => {
    const response = await documentsRoute(
      jsonRequest('http://test/api/documents', { text: 'hello' }),
    );

    expect(response.status).toBe(422);
  });
});

describe('POST /api/risks', () => {
  let store: InMemoryDocumentStore;
  let document: StoredDocument;
  let llm: ScriptedLlm;

  beforeEach(async () => {
    llm = new ScriptedLlm();
    store = installTestServices(llm).documents as InMemoryDocumentStore;
    document = await seedDocument(store);
  });

  afterEach(resetServices);

  function finding(overrides: Record<string, unknown> = {}) {
    return {
      title: 'Uncapped indemnity',
      category: 'liability',
      severity: 'critical',
      clauseQuote: 'Contractor shall defend, indemnify and hold harmless Company',
      whyItMatters: 'You could owe more than the contract is worth.',
      suggestedQuestion: 'Can the indemnity be capped?',
      chunkId: document.chunks[0]?.id,
      ...overrides,
    };
  }

  it('returns grounded findings with a resolved citation', async () => {
    llm.setStructured({ findings: [finding({ chunkId: document.chunks.at(-1)?.id })] });

    const response = await risksRoute(
      jsonRequest('http://test/api/risks', { documentId: document.id }),
    );

    expect(response.status).toBe(200);
    const { findings } = (await response.json()) as { findings: RiskFinding[] };

    expect(findings).toHaveLength(1);
    expect(findings[0]?.citation).not.toBeNull();
    expect(findings[0]?.citation?.documentId).toBe(document.id);
    expect(findings[0]?.severity).toBe('critical');
  });

  it('drops a finding whose quote cannot be traced to the document', async () => {
    llm.setStructured({
      findings: [
        finding({
          chunkId: 'doc_fake#c99',
          clauseQuote: 'A clause that appears nowhere in this document at all, invented wholesale.',
        }),
      ],
    });

    const response = await risksRoute(
      jsonRequest('http://test/api/risks', { documentId: document.id }),
    );
    const { findings } = (await response.json()) as { findings: RiskFinding[] };

    // Ungrounded means not shown, rather than shown with a broken reference.
    expect(findings).toHaveLength(0);
  });

  it('recovers a finding whose chunk id is wrong but whose quote is real', async () => {
    llm.setStructured({ findings: [finding({ chunkId: 'doc_fake#c99' })] });

    const response = await risksRoute(
      jsonRequest('http://test/api/risks', { documentId: document.id }),
    );
    const { findings } = (await response.json()) as { findings: RiskFinding[] };

    expect(findings).toHaveLength(1);
    expect(findings[0]?.citation?.section).toContain('INDEMNIFICATION');
  });

  it('orders findings by severity', async () => {
    llm.setStructured({
      findings: [
        finding({ title: 'Low one', severity: 'low' }),
        finding({
          title: 'Critical one',
          severity: 'critical',
          category: 'payment',
          clauseQuote: 'Company shall pay undisputed amounts within forty-five (45) days',
        }),
      ],
    });

    const response = await risksRoute(
      jsonRequest('http://test/api/risks', { documentId: document.id }),
    );
    const { findings } = (await response.json()) as { findings: RiskFinding[] };

    expect(findings[0]?.severity).toBe('critical');
  });

  it('reports an upstream failure without leaking its message', async () => {
    // Swapping the LLM builds a fresh graph, so the document is re-seeded.
    store = installTestServices(new FailingLlm()).documents as InMemoryDocumentStore;
    await store.put(document);

    const response = await risksRoute(
      jsonRequest('http://test/api/risks', { documentId: document.id }),
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = (await response.json()) as ApiErrorBody;
    expect(JSON.stringify(body)).not.toContain('upstream exploded');
  });
});

describe('POST /api/compare', () => {
  let store: InMemoryDocumentStore;
  let llm: ScriptedLlm;

  beforeEach(() => {
    llm = new ScriptedLlm();
    store = installTestServices(llm).documents as InMemoryDocumentStore;
  });

  afterEach(resetServices);

  async function seedPair() {
    const left = await seedDocument(store, SAMPLE_CONTRACT);
    const right = await seedDocument(
      store,
      SAMPLE_CONTRACT.replace('forty-five (45) days', 'seventy-five (75) days'),
    );
    return { left, right };
  }

  it('returns a structural diff even when the model adds nothing', async () => {
    const { left, right } = await seedPair();
    llm.setStructured({ changes: [] });

    const response = await compareRoute(
      jsonRequest('http://test/api/compare', { leftId: left.id, rightId: right.id }),
    );

    expect(response.status).toBe(200);
    const { comparison } = (await response.json()) as { comparison: ComparisonResult };

    expect(comparison.stats.modified).toBe(1);
    expect(comparison.stats.unchanged).toBe(2);
    expect(comparison.materialChanges).toHaveLength(0);
  });

  it('sends only the changed clause pairs to the model', async () => {
    const { left, right } = await seedPair();

    await compareRoute(
      jsonRequest('http://test/api/compare', { leftId: left.id, rightId: right.id }),
    );

    const content = llm.lastUserContent();
    expect(content).toContain('forty-five');
    expect(content).toContain('seventy-five');
    // The unchanged clauses must not be paid for.
    expect(content).not.toContain('indemnify');
  });

  it('discards a material change naming a diff id that was never sent', async () => {
    const { left, right } = await seedPair();
    llm.setStructured({
      changes: [
        {
          diffId: 'diff-does-not-exist',
          heading: 'Invented',
          severity: 'high',
          impact: 'x',
          whyItMatters: 'y',
        },
      ],
    });

    const response = await compareRoute(
      jsonRequest('http://test/api/compare', { leftId: left.id, rightId: right.id }),
    );
    const { comparison } = (await response.json()) as { comparison: ComparisonResult };

    expect(comparison.materialChanges).toHaveLength(0);
  });

  it('rejects comparing a document with itself', async () => {
    const { left } = await seedPair();

    const response = await compareRoute(
      jsonRequest('http://test/api/compare', { leftId: left.id, rightId: left.id }),
    );

    expect(response.status).toBe(422);
  });
});

describe('POST /api/act', () => {
  let store: InMemoryDocumentStore;
  let document: StoredDocument;
  let llm: ScriptedLlm;

  beforeEach(async () => {
    llm = new ScriptedLlm();
    store = installTestServices(llm).documents as InMemoryDocumentStore;
    document = await seedDocument(store);

    llm.setStructured({
      headline: 'You carry most of the risk here.',
      checklist: [
        {
          task: 'Diary the 7-day termination notice.',
          due: 'Immediately',
          owner: 'you',
          severity: 'high',
          chunkId: document.chunks[0]?.id,
        },
      ],
      questionsForLawyer: [
        { question: 'Can the indemnity be capped?', rationale: 'It is unbounded.', chunkId: null },
      ],
      keyDates: [{ label: 'Payment due', when: '45 days after invoice', chunkId: null }],
    });
  });

  afterEach(resetServices);

  it('returns a checklist, dates and questions with resolved citations', async () => {
    const response = await actRoute(
      jsonRequest('http://test/api/act', { documentId: document.id }),
    );

    expect(response.status).toBe(200);
    const { plan } = (await response.json()) as {
      plan: { checklist: Array<{ citation: unknown }>; questionsForLawyer: unknown[] };
    };

    expect(plan.checklist[0]?.citation).not.toBeNull();
    expect(plan.questionsForLawyer).toHaveLength(1);
  });

  it('reuses risk findings from the client instead of re-analysing', async () => {
    const knownRisk: RiskFinding = {
      id: 'risk-1',
      title: 'Uncapped indemnity',
      category: 'liability',
      severity: 'critical',
      clauseQuote: 'Contractor shall defend, indemnify and hold harmless Company',
      whyItMatters: 'Unbounded exposure.',
      suggestedQuestion: 'Can it be capped?',
      citation: {
        chunkId: document.chunks[0]?.id ?? '',
        documentId: document.id,
        documentName: document.name,
        section: '9. INDEMNIFICATION',
        snippet: 'Contractor shall defend...',
      },
    };

    await actRoute(
      jsonRequest('http://test/api/act', { documentId: document.id, knownRisks: [knownRisk] }),
    );

    expect(llm.lastUserContent()).toContain('ALREADY-IDENTIFIED RISKS');
    expect(llm.lastUserContent()).toContain('Uncapped indemnity');
    // One call total: the risk pass is not repeated.
    expect(llm.requests).toHaveLength(1);
  });

  it('ignores risks that belong to a different document', async () => {
    const other = await seedDocument(store, SAMPLE_CONTRACT.replace('seven (7)', 'ten (10)'));
    const foreignRisk: RiskFinding = {
      id: 'risk-1',
      title: 'Belongs elsewhere',
      category: 'other',
      severity: 'low',
      clauseQuote: 'x',
      whyItMatters: 'y',
      suggestedQuestion: 'z',
      citation: {
        chunkId: other.chunks[0]?.id ?? '',
        documentId: other.id,
        documentName: other.name,
        section: 'S',
        snippet: 'x',
      },
    };

    await actRoute(
      jsonRequest('http://test/api/act', { documentId: document.id, knownRisks: [foreignRisk] }),
    );

    expect(llm.lastUserContent()).not.toContain('Belongs elsewhere');
  });

  it('rejects a malformed risk payload from the client', async () => {
    const response = await actRoute(
      jsonRequest('http://test/api/act', {
        documentId: document.id,
        knownRisks: [{ id: 'risk-1', severity: 'apocalyptic' }],
      }),
    );

    expect(response.status).toBe(422);
  });
});
