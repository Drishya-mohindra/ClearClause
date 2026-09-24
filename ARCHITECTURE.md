# Architecture

Why the code is shaped the way it is, and where to change it.

---

## The one-sentence version

Route handlers do nothing but validate input and orchestrate; everything else
is a pure function or an interface implementation resolved through a single
container, so the parts that are hard to get right — grounding, injection
defence, diffing — can be tested directly without a network.

---

## Layers

```
app/api/*        transport    Zod validation, rate limiting, error shaping
lib/analysis/*   services     multi-step feature logic, verification
lib/prompts/*    pure         request builders + response schemas
lib/rag, diff    pure         chunking, retrieval, alignment
lib/llm, store   adapters     vendor and infrastructure behind interfaces
lib/container    wiring       the only module that names concrete classes
```

A dependency only ever points downward. `lib/prompts` knows nothing about
Anthropic; `lib/diff` knows nothing about HTTP; nothing outside
`lib/container.ts` constructs a provider.

### Why a container rather than direct imports

Route handlers call `getServices()`. That single seam is what makes an
integration test possible without module mocking, environment variables or a
network:

```ts
installTestServices(new ScriptedLlm(['...']));
const response = await askRoute(jsonRequest('/api/ask', { ... }));
```

The real retriever, the real citation filter, the real validation and the real
error shaping all run. Only the model is a double.

The graph is stored under a `Symbol.for` key on `globalThis` rather than in a
module-level variable. Next.js loads a separate module registry per route
handler and replaces it on every hot reload, so a plain module singleton gives
each route its own document store — and a document uploaded through
`/api/documents` is invisible to `/api/ask`.

---

## Interfaces and what they buy

| Interface           | Implementations                            | Swap it when                                   |
| ------------------- | ------------------------------------------ | ---------------------------------------------- |
| `LlmProvider`       | `AnthropicProvider`, `MockLlmProvider`     | Changing vendor, or testing                    |
| `DocumentParser`    | `PdfParser`, `DocxParser`, `TextParser`    | Adding a format (register it in `lib/parsing`) |
| `EmbeddingProvider` | `HashingEmbeddingProvider`, `Voyage…`      | Semantic recall matters more than zero setup   |
| `VectorStore`       | `InMemoryVectorStore`                      | Corpora outgrow an exhaustive scan             |
| `DocumentStore`     | `InMemoryDocumentStore`, `KvDocumentStore` | Moving from a demo to production               |
| `RateLimiter`       | `InMemoryRateLimiter`, `KvRateLimiter`     | More than one instance                         |

Each has exactly one consumer boundary, so an implementation can be added
without touching a route handler.

---

## Grounding: the part that matters

The product claim is that outputs are traceable to the document. Four
mechanisms enforce it, in order:

**1. Stable, quotable chunk ids.** Chunking happens once at ingestion. Ids are
`documentId#cNN`, short enough for a model to reproduce exactly and structured
enough to parse unambiguously — which is why document ids contain no `#`.

**2. Fenced, labelled excerpts.** The model only ever sees clause text inside
`<excerpt id="..." source="..." section="...">` blocks, in the user turn. The
system prompt — which never contains document text — states that fenced content
is untrusted data.

**3. Citation filtering on the way out.** `filterCitationStream` buffers across
stream deltas and removes any `[id]` that does not resolve to a chunk we
actually sent. Buffering is not optional: token boundaries fall wherever the
tokenizer puts them, so a citation routinely straddles two deltas and per-delta
filtering would miss it.

**4. Quote verification for structured output.** A risk finding names a
`chunkId` _and_ quotes the clause. `groundQuote` tries the id first; if it is
wrong, it searches the document for the quote (normalised for case and
spacing, falling back to the opening phrase). A finding that survives neither
check is discarded rather than displayed with a broken reference.

The client then narrows the source list to the clauses actually cited, and
renders the clause text — so a reader can check the answer rather than trust
it.

---

## Prompt injection

Document content is data. The boundary is enforced in three places:

1. **`normalizeText`** strips control characters and the zero-width and
   bidi-override characters used to hide instructions from a human reader.
2. **`neutralizeInjection`** rewrites forged closing fences (`</document_text>`)
   and role headers (`<system>`, `Assistant:`) into visually similar characters.
   The wording survives, so the assistant can still tell the reader that the
   document contains such text — it just no longer parses as a delimiter.
3. **Separation of turns.** Instructions live in the system prompt; document
   text lives in the user turn, inside a fence. They never mix.

`tests/prompts.test.ts` asserts each of these against a hostile sample
document.

---

## Cost and latency

The expensive resource is model tokens. Four decisions shape it:

- **Compare sends only what changed.** Alignment is computed locally; the model
  receives the differing clause pairs and judges materiality. A one-line change
  to a 90-page contract costs one small call.
- **Risk analysis batches.** Chunks are packed to roughly 32k characters per
  call and run two at a time, so a long document is two or three calls rather
  than one per clause. Batches are cut on chunk boundaries, so no clause is
  split across two analyses.
- **Act reuses the risk pass.** The client passes the findings it already has;
  the document is analysed once, not twice.
- **Embeddings are cached per document** in the retriever, keyed by provider,
  and embedded in batches. Re-indexing is idempotent, so every request can
  safely ensure the index exists.

Streaming is what keeps long generations inside serverless execution limits:
`Simplify` and `Ask` start sending bytes before the answer exists.

---

## Error handling

One rule: nothing reaches the client that was not written for a reader.

`AppError` carries a client-safe message and a status. Anything else — an SDK
error, a parse failure, a bug — becomes a generic message, with the detail
logged server-side and deliberately without document content. Zod failures
become 422s that name the failing field but never echo the value.

Streamed routes are the exception in form, not in substance: once headers are
sent a status code is unavailable, so failures travel as an SSE `error` event
and surface through the same client error path.

---

## Adding a feature

For a feature that streams prose (like Simplify):

1. Add a prompt builder in `lib/prompts/` — a pure function returning an
   `LlmRequest`. Include `CITATION_RULES` and build excerpts with
   `buildExcerpts`.
2. Add a route handler: `guard()`, `parseJsonBody()`, `requireDocument()`,
   then `streamToResponse()`.
3. Add a panel using `useStream()`, `GeneratedText`, `SourceList` and
   `OutputDisclaimer`.
4. Test the prompt builder directly; add a route test with `ScriptedLlm`.

For a feature returning structure (like Risk):

1. Put the JSON Schema and the matching Zod schema next to each other in the
   prompt module, so they cannot drift.
2. Put the multi-step logic in `lib/analysis/`, and verify every model-supplied
   reference with `groundQuote` before returning it.

---

## Deliberate limits

- **No database.** Documents are transient by design; a legal-document tool
  that quietly retains contracts is a liability, not a feature.
- **No auth.** Out of scope. Rate limiting is per-IP, which is the right
  granularity for an unauthenticated tool and the wrong one for a product.
- **No streaming for structured output.** The client needs the whole list
  before it can group and sort; batching bounds the latency instead.
- **A deliberately small markdown subset.** The renderer supports headings,
  lists, bold and citations. Anything else renders as text — which is the point:
  it cannot become markup.
