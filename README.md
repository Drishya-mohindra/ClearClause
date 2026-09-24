# ClearClause

A GenAI legal-document assistant for people who are not lawyers. Upload a
contract and get a plain-language summary, flagged clauses, grounded answers
with citations back to the source text, a clause-level comparison of two
versions, and a checklist of what to actually do next.

Every AI-generated output carries a persistent disclaimer, and the assistant
refuses to give jurisdiction-specific legal conclusions.

> **This is informational assistance, not legal advice.** It is not a law firm.
> Its output may be incomplete or wrong, and it cannot tell you how the law
> applies to your situation. For decisions that matter, talk to a lawyer
> licensed where you are.

---

## The five things it does

| Feature      | What it gives the reader                                                                          | How it is grounded                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Simplify** | A briefing with fixed headings: what it is, your obligations, theirs, money, dates, what to watch | Every claim cites the clause it came from; the source list shows the clause text       |
| **Risk**     | Flagged clauses with a severity and a "why this matters" note in plain words                      | Each finding's quote is traced back to a real chunk, or the finding is dropped         |
| **Ask**      | Answers to questions about the document, with inline citations                                    | Hybrid retrieval; the model sees only the retrieved excerpts and must cite excerpt ids |
| **Compare**  | Which clauses changed between two versions, and which changes are material                        | Diff computed locally and deterministically; the model only judges materiality         |
| **Act**      | A checklist, key dates, and specific questions to bring to a lawyer                               | Reuses the risk findings; every item links to its clause                               |

---

## Quick start

```bash
npm install
cp .env.example .env.local     # add your ANTHROPIC_API_KEY
npm run dev
```

Open <http://localhost:3000>. Three sample documents are bundled, so you can
try every feature without uploading anything.

**No API key?** Set `USE_MOCK_LLM=true` in `.env.local`. The app runs against a
deterministic fake model — the UI, streaming, retrieval and citation plumbing
all work, the prose is just placeholder text.

### Scripts

```bash
npm run dev          # development server
npm run build        # production build
npm run test         # unit + integration tests (no network required)
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format       # Prettier
npm run ci           # format:check + lint + typecheck + test
```

---

## Deploying to Vercel

Push the repo and import it. The only required setting is `ANTHROPIC_API_KEY`;
everything else has a working default.

**For anything beyond a demo, also attach a Vercel KV store** and set
`KV_REST_API_URL` and `KV_REST_API_TOKEN`. Without it, parsed documents live in
the memory of whichever serverless instance handled the upload. The client
compensates automatically — see [Documents and serverless](#documents-and-serverless)
— but KV removes the round trip entirely and is the right answer in production.

### Environment variables

| Variable                       | Required | Default                     | Purpose                                             |
| ------------------------------ | -------- | --------------------------- | --------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | yes\*    | —                           | Server-side only. Never prefix with `NEXT_PUBLIC_`. |
| `ANTHROPIC_MODEL`              | no       | `claude-sonnet-5`           | Main reasoning model                                |
| `ANTHROPIC_FAST_MODEL`         | no       | `claude-haiku-4-5-20251001` | Cheaper model for short sub-tasks                   |
| `EMBEDDING_PROVIDER`           | no       | `hashing`                   | `hashing` (local, no dependency) or `voyage`        |
| `VOYAGE_API_KEY`               | no       | —                           | Required only when `EMBEDDING_PROVIDER=voyage`      |
| `KV_REST_API_URL/TOKEN`        | no       | —                           | Durable document store + shared rate limiting       |
| `UPSTASH_REDIS_REST_URL/TOKEN` | no       | —                           | Accepted as an alternative to the `KV_*` pair       |
| `MAX_UPLOAD_BYTES`             | no       | `8388608` (8 MB)            | Upload ceiling                                      |
| `RATE_LIMIT_PER_MINUTE`        | no       | `20`                        | Per-IP budget, divided by each route's cost weight  |
| `USE_MOCK_LLM`                 | no       | `false`                     | Run against a deterministic fake model              |

\* unless `USE_MOCK_LLM=true`.

---

## How it works

```
                      BROWSER
  ┌──────────────────────────────────────────────────┐
  │  Workspace (one screen, five tabs)               │
  │  • owns document list + reading level            │
  │  • caches risk findings, reused by the Act tab   │
  │  • remembers how each document was loaded, and   │
  │    re-sends it if the server has forgotten it    │
  └───────────────────────┬──────────────────────────┘
                          │ fetch / SSE
  ════════════════════════╪═══════════════════ trust boundary
                          ▼
                    ROUTE HANDLERS  (app/api/*)
  ┌──────────────────────────────────────────────────┐
  │  guard()      rate limit  →  Zod validation      │
  │  toErrorResponse()  client-safe errors only      │
  └───────────────────────┬──────────────────────────┘
                          ▼
                     getServices()   ← the only place
                   (lib/container.ts)  concrete classes
                          │            are chosen
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   DocumentStore     LlmProvider      HybridRetriever
   in-memory | KV    Anthropic|Mock   VectorStore + EmbeddingProvider
```

### Ingestion (once per document)

```
 upload / paste
      │
      ▼
 magic-byte sniff ──► PdfParser | DocxParser | TextParser
      │                         (lib/parsing)
      ▼
 normalizeText()  strip control + zero-width chars, collapse whitespace
      │
      ▼
 createStoredDocument()   id = sha256(text)[0..12]   ← content-addressed
      │
      ▼
 chunkDocument()   section-aware, never merges across a heading
      │                                     ids: doc_ab12cd34#c07
      ▼
 DocumentStore.put()        client receives METADATA ONLY
```

### Answering a question

```
 question
    │
    ▼
 HybridRetriever ──┬─ dense: hashed embeddings, cosine
                   └─ lexical: BM25
                        │
                        ▼  reciprocal-rank fusion + neighbour expansion
                   top excerpts
                        │
                        ▼
 buildAskRequest()   system = rules only  ·  user = fenced <excerpt> blocks
                        │                    (neutralizeInjection applied)
                        ▼
 Claude (streamed) ──► filterCitationStream() ──► SSE ──► browser
                        drops any [id] that is not a real chunk
```

### Comparing two versions

The alignment is computed **locally**, not by the model:

```
 doc A ─┐
        ├─ segmentClauses() ─► LCS on identical clauses  (anchors)
 doc B ─┘                       │
                                ▼
                  greedy pairing of the gaps by similarity
                  (trigram Jaccard ∪ discounted unigram Dice,
                   with a lower bar inside a shared section)
                                │
                                ▼
                  added / removed / modified / unchanged
                                │
                       only the CHANGED pairs ──► Claude
                                                  ("which of these matter?")
```

So token cost scales with the size of the change, not the size of the contract,
and the structural diff the reader sees is reproducible rather than generated.

---

## Design decisions worth explaining

### Documents and serverless

Parsed documents have to outlive the request that created them, but a
serverless platform will not promise that the instance holding a document is
the one that serves the next request.

Three things make this work without requiring any infrastructure:

1. **Document ids are content-addressed** — `doc_` plus the first 12 hex
   characters of the SHA-256 of the normalised text. Re-ingesting the same
   bytes produces the same id and the same chunk ids.
2. **The service graph lives on `globalThis`**, not in a module-level variable,
   because Next.js gives each route handler its own module registry. Without
   this, a document uploaded through `/api/documents` is invisible to
   `/api/ask`.
3. **The client remembers how each document was loaded** and, on a
   `document_expired` response, re-sends it and replays the request once. Thanks
   to (1), every citation already on screen stays valid.

Setting `KV_REST_API_URL`/`KV_REST_API_TOKEN` swaps in a durable store and the
recovery path stops being exercised.

### Why the default embeddings are local

Anthropic does not ship an embeddings endpoint, and requiring a second vendor
to run the app raises the barrier to trying it. The default
`HashingEmbeddingProvider` is a deterministic hashed bag-of-words with
sub-linear term frequency and bigrams — no network, no key, no cold start. For
a single contract of a few hundred chunks, fused with BM25, it retrieves well.
Set `EMBEDDING_PROVIDER=voyage` when semantic paraphrase matching matters; the
`EmbeddingProvider` interface is the only thing either implementation touches.

### Why retrieval is hybrid

Legal questions lean on precise terms — "indemnify", "30 days", "Section 8",
"$2,400" — which pure embeddings blur. BM25 catches those; embeddings catch
topical paraphrase. The two rankings are fused by reciprocal rank rather than
by score, so cosine and BM25 never have to be calibrated against each other.
The tokenizer normalises money so `$2,400`, `2,400`and`2400` are one token:
amounts are among the most-searched terms in a contract.

---

## Security

| Concern                | Mitigation                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prompt injection**   | Document text is fenced in `<excerpt>`/`<document_text>` tags and passed through `neutralizeInjection`, which defuses forged closing tags and role headers. The system prompt states that fenced content is data, never instructions. Instructions and document text never share a message. |
| **Hallucinated cites** | The model may only cite ids it was given. `filterCitationStream` buffers across stream deltas and removes any bracketed id that does not resolve to a real chunk. Risk findings whose quote cannot be located in the document are dropped rather than shown with a broken reference.        |
| **XSS**                | Model output is parsed into React elements by a small markdown subset renderer. There is no `dangerouslySetInnerHTML` anywhere in the codebase, and DOCX is extracted as raw text rather than HTML.                                                                                         |
| **File uploads**       | Size checked against `content-length` and again against the real size; the parser is chosen by magic bytes, not by the declared MIME type or extension; a zip without a positive DOCX signal is rejected; filenames are stripped of paths and unsafe characters.                            |
| **Input validation**   | Every request body is parsed with Zod. Data echoed back by the client (such as risk findings reused by the Act tab) is re-validated and re-scoped to the document under analysis.                                                                                                           |
| **Error leakage**      | Only `AppError` messages reach the client. Everything else becomes a generic message; the detail is logged server-side without document content. Mid-stream failures arrive as an SSE `error` event, since the status code is long gone.                                                    |
| **Rate limiting**      | Per-IP fixed window, weighted per route so an expensive full-document analysis costs more of the budget than a question. Backed by KV when configured.                                                                                                                                      |
| **Secrets**            | `ANTHROPIC_API_KEY` is read only through `lib/config/env.ts` and used only in server modules. Nothing is prefixed `NEXT_PUBLIC_`.                                                                                                                                                           |
| **Headers**            | CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy`, and `frame-ancestors 'none'`.                                                                                                                                                    |

---

## Accessibility

Targets WCAG 2.1 AA.

- **Keyboard** — every control is reachable and operable; a skip link is the
  first tab stop; Radix primitives provide correct roving focus for tabs,
  accordion, select and radio groups.
- **Focus** — a visible `:focus-visible` ring on every interactive element, in
  both themes.
- **Contrast** — colours are declared as tokens in `app/globals.css`; every
  foreground/background pair clears 4.5:1 for body text.
- **Not colour alone** — severity always renders its label as text; diffs use
  `<ins>`/`<del>` so the change is carried semantically.
- **Screen readers** — streamed answers sit in a polite live region with
  `aria-busy`; decorative icons are `aria-hidden`; errors use `role="alert"`.
- **Motion** — `prefers-reduced-motion` disables every animation.
- **Zoom and touch** — pinch-zoom is never blocked, controls meet the 44px
  touch target, and the layout works from 320px up.
- **Reading level** — the Simple/Standard/Detailed toggle changes how the
  assistant writes, which is the main accessibility lever in the product.

---

## Testing

```bash
npm run test
```

162 tests, no network access required. The suite covers parsing and content
sniffing, chunking, the diff engine, retrieval and ranking, prompt
construction, injection neutralisation, citation filtering, grounding recovery,
and integration tests that drive the real route handlers with a scripted LLM
double — asserting that citations resolve, that invented ones are stripped
(including when split across stream deltas), that errors do not leak upstream
detail, and that the rate limiter engages.

The LLM is the only thing replaced. Route handlers take their collaborators
from `getServices()`, so a test swaps the graph rather than mocking modules.

---

## Project layout

```
app/
  api/                 route handlers, one per feature
  layout.tsx           shell, disclaimer banner, theme
  page.tsx             the workspace
components/
  features/            one component per feature + citation/disclaimer pieces
  ui/                  Radix-backed primitives
lib/
  analysis/            risk, compare and act services + grounding verification
  api/                 request schemas and the per-route guard
  client/              browser-side API client, streaming hook, source registry
  config/              validated environment
  diff/                deterministic clause alignment and word-level diff
  llm/                 LlmProvider interface + Anthropic and mock implementations
  parsing/             PDF / DOCX / text parsers behind one interface
  prompts/             every prompt in the app, as pure functions
  rag/                 chunking, embeddings, vector store, hybrid retriever
  security/            sanitisation, errors, rate limiting
  store/               document store (in-memory / KV) and the KV client
samples/               three seed documents
tests/                 unit + integration tests
types/                 shared domain types
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the reasoning behind the module
boundaries and the extension points.

---

## Known limitations

- **Scanned PDFs** are rejected with a clear message. There is no OCR; a
  scanned contract has no text layer to extract.
- **The in-memory store is per-instance.** The client's re-send path covers it,
  but configure KV for production.
- **Risk analysis batches the document** and merges findings. A risk that only
  emerges from two clauses 80 pages apart may be missed; the Ask tab is the
  tool for that.
- **English only.** Chunking heuristics, the stop-word list and the prompts all
  assume English-language documents.
- **No persistence between sessions.** Documents expire after an hour and are
  never used for training.
