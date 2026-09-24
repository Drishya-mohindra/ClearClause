/**
 * Shared domain types. These are the contract between the server (route
 * handlers + `lib/`) and the browser, so they intentionally contain no
 * framework or vendor types.
 */

/** How plainly the assistant should write. Drives prompt construction only. */
export type ReadingLevel = 'simple' | 'standard' | 'detailed';

export const READING_LEVELS: readonly ReadingLevel[] = ['simple', 'standard', 'detailed'] as const;

/** A contiguous, retrievable slice of a document. */
export interface DocumentChunk {
  /** Stable, human-quotable id used for citations, e.g. `d1#c07`. */
  id: string;
  documentId: string;
  /** Zero-based position of the chunk within the document. */
  index: number;
  /** Best-effort heading the chunk sits under, e.g. "8. Limitation of Liability". */
  section: string;
  text: string;
  /** Character offsets into the document's normalised full text. */
  startChar: number;
  endChar: number;
}

/** Metadata about a stored document, safe to send to the client. */
export interface DocumentSummary {
  id: string;
  name: string;
  /** Detected source format. */
  kind: 'pdf' | 'docx' | 'text';
  wordCount: number;
  chunkCount: number;
  pageCount: number | null;
  createdAt: number;
  /** True when the document came from the bundled sample set. */
  isSample: boolean;
}

/** A stored document plus its extracted text and chunks. */
export interface StoredDocument extends DocumentSummary {
  text: string;
  chunks: DocumentChunk[];
}

/** A pointer from generated text back to the clause it came from. */
export interface Citation {
  chunkId: string;
  documentId: string;
  documentName: string;
  section: string;
  /** Short verbatim excerpt, used for the citation popover. */
  snippet: string;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITIES: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;

export type RiskCategory =
  | 'obligation'
  | 'liability'
  | 'deadline'
  | 'payment'
  | 'termination'
  | 'confidentiality'
  | 'ip'
  | 'dispute'
  | 'auto-renewal'
  | 'inconsistency'
  | 'other';

/** One flagged clause with the reasoning a non-lawyer needs. */
export interface RiskFinding {
  id: string;
  title: string;
  category: RiskCategory;
  severity: Severity;
  /** Verbatim (or near-verbatim) text from the document. */
  clauseQuote: string;
  /** Plain-language explanation of the practical consequence. */
  whyItMatters: string;
  /** A concrete question the reader could put to a lawyer or counterparty. */
  suggestedQuestion: string;
  citation: Citation | null;
}

/** Word-level change inside a modified clause pair. */
export interface InlineDiffToken {
  value: string;
  type: 'equal' | 'added' | 'removed';
}

export type ClauseChangeType = 'added' | 'removed' | 'modified' | 'unchanged';

/** One aligned clause pair produced by the deterministic diff engine. */
export interface ClauseDiff {
  id: string;
  type: ClauseChangeType;
  leftSection: string | null;
  rightSection: string | null;
  leftText: string | null;
  rightText: string | null;
  /** 0–1 textual similarity for `modified` pairs. */
  similarity: number;
  inline: InlineDiffToken[];
}

/** LLM materiality judgement layered on top of a `ClauseDiff`. */
export interface MaterialChange {
  diffId: string;
  heading: string;
  severity: Severity;
  /** Who the change favours, in plain language. */
  impact: string;
  whyItMatters: string;
}

export interface ComparisonResult {
  diffs: ClauseDiff[];
  stats: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  materialChanges: MaterialChange[];
}

export interface ChecklistItem {
  id: string;
  task: string;
  /** Plain-language due date or trigger, e.g. "30 days before renewal". */
  due: string;
  owner: 'you' | 'other-party' | 'both';
  severity: Severity;
  citation: Citation | null;
}

export interface LawyerQuestion {
  id: string;
  question: string;
  /** Why this question is worth a lawyer's time. */
  rationale: string;
  citation: Citation | null;
}

export interface ActionPlan {
  headline: string;
  checklist: ChecklistItem[];
  questionsForLawyer: LawyerQuestion[];
  keyDates: Array<{ id: string; label: string; when: string; citation: Citation | null }>;
}

/** Envelope for every streamed endpoint. See `lib/stream.ts`. */
export type StreamEvent =
  | { type: 'meta'; sources: Citation[] }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Shape of every error body returned by the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Present only for validation failures. */
    details?: Array<{ path: string; message: string }>;
  };
}
