/**
 * Semantic search using TF-IDF and cosine similarity.
 * Lightweight implementation with no external dependencies.
 */

import { createLogger } from "../utils/logging.js";
import type { Guide, MemoryFragment } from "./types.js";

const logger = createLogger("semantic");

// ============================================================
// Temporal Awareness
// ============================================================

interface TemporalIntent {
  readonly wantsCurrent: boolean;
  readonly targetYear: number | null;
}

const CURRENT_MARKERS = ["current", "latest", "now", "today", "recent", "new", "updated", "currently"] as const;
const FRESHNESS_MARKERS = ["updated", "current", "latest", "new", "v3", "v4", "v5", "revision", "important"] as const;
const TIEBREAK_MARKERS = ["updated", "current", "latest", "v2", "v3", "v4", "v5", "new", "revision"] as const;

function detectTemporalIntent(query: string): TemporalIntent {
  const lower = query.toLowerCase();
  const wantsCurrent = CURRENT_MARKERS.some((m) => lower.includes(m));
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  const targetYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
  return { wantsCurrent, targetYear };
}

function computeTemporalBoost(
  title: string,
  description: string,
  tags: readonly string[],
  content: string,
  intent: TemporalIntent,
  hasVersionConflict = false,
  queryNonTemporalTerms: readonly string[] = []
): number {
  const markerText = `${title} ${description} ${tags.join(" ")}`.toLowerCase();
  const allText = `${title} ${description} ${content} ${tags.join(" ")}`.toLowerCase();

  // Freshness markers in title/desc/tags
  const hasMarker = FRESHNESS_MARKERS.some((m) => markerText.includes(m));

  // Extract max year mentioned in content
  const yearMatches = allText.match(/\b(20\d{2})\b/g);
  let maxYear = 2020;
  if (yearMatches) {
    const years = yearMatches.map((y) => parseInt(y, 10));
    maxYear = Math.max(...years);
  }

  // Extract max version number
  const versionMatches = allText.match(/\bv(\d+)\b/g);
  let maxVersion = 0;
  if (versionMatches) {
    const versions = versionMatches.map((m) => parseInt(m.slice(1), 10));
    maxVersion = Math.max(...versions);
  }

  // Recency score: how recent is the content's year (0 = old, 1 = very recent)
  const yearRecency = Math.min((maxYear - 2020) / 6, 1);

  // Version score: higher version = more current
  const versionScore = Math.min(maxVersion / 3, 1);

  // Base freshness bias (always applied)
  let score = 0;
  if (hasMarker) score += 0.08;
  score += yearRecency * 0.03;
  score += versionScore * 0.02;

  if (intent.wantsCurrent) {
    // Strong boost for explicit temporal queries
    if (hasMarker) score += 0.3;
    score += yearRecency * 0.15;
    score += versionScore * 0.1;
  }

  if (intent.targetYear !== null) {
    const yearStr = String(intent.targetYear);
    const hasYear = content.toLowerCase().includes(yearStr) || markerText.includes(yearStr);

    if (hasYear) {
      score += 0.5;
      // Bonus for also matching non-temporal query terms
      const contentLower = content.toLowerCase();
      const matchedNonTemporal = queryNonTemporalTerms.filter((t) => contentLower.includes(t)).length;
      const coverage = queryNonTemporalTerms.length > 0 ? matchedNonTemporal / queryNonTemporalTerms.length : 0;
      score += coverage * 0.5;
    } else {
      // Strong penalty for not mentioning the queried year
      score -= 0.5;
    }
  }

  // Extra boost when version conflicts detected (similar titles in corpus)
  if (hasVersionConflict) {
    if (hasMarker) {
      score += 0.3;
    } else {
      // Demote non-marked versions when conflicts exist
      score -= 0.7;
    }
  }

  return score;
}

function computeFreshnessBias(title: string, description: string, tags: readonly string[]): number {
  const markerText = `${title} ${description} ${tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const marker of TIEBREAK_MARKERS) {
    if (markerText.includes(marker)) score += 0.002;
  }
  return score;
}

// ============================================================
// Co-occurrence / Spreading Activation
// ============================================================

const EXPANSION_TERMS_PER_QUERY = 3;
const EXPANSION_WEIGHT = 0.3; // Weight of expanded terms relative to original
const MIN_PMI = 0.8; // Minimum PMI threshold for association

interface CooccurrenceIndex {
  readonly associations: ReadonlyMap<string, ReadonlyMap<string, number>>; // term -> {associatedTerm: strength}
  readonly docFreq: ReadonlyMap<string, number>;
  readonly numDocs: number;
}

function buildCooccurrenceIndex(allDocs: readonly TokenizedDocument[]): CooccurrenceIndex {
  const numDocs = allDocs.length;
  const docFreq = new Map<string, number>();
  const cooccurrence = new Map<string, Map<string, number>>();

  // Build co-occurrence counts (document-level: two terms co-occur if they appear in the same doc)
  for (const doc of allDocs) {
    const uniqueTerms = [...new Set(doc.tokens)];
    for (let i = 0; i < uniqueTerms.length; i++) {
      const termA = uniqueTerms[i] ?? "";
      docFreq.set(termA, (docFreq.get(termA) ?? 0) + 1);

      for (let j = i + 1; j < uniqueTerms.length; j++) {
        const termB = uniqueTerms[j] ?? "";

        // A <-> B
        let mapA = cooccurrence.get(termA);
        if (!mapA) { mapA = new Map(); cooccurrence.set(termA, mapA); }
        mapA.set(termB, (mapA.get(termB) ?? 0) + 1);

        // B <-> A
        let mapB = cooccurrence.get(termB);
        if (!mapB) { mapB = new Map(); cooccurrence.set(termB, mapB); }
        mapB.set(termA, (mapB.get(termA) ?? 0) + 1);
      }
    }
  }

  // Convert raw co-occurrence counts to PMI (Pointwise Mutual Information)
  // PMI(A, B) = log(P(A,B) / (P(A) * P(B)))
  const associations = new Map<string, Map<string, number>>();
  for (const [termA, neighbors] of cooccurrence) {
    const freqA = docFreq.get(termA) ?? 1;
    const pA = freqA / numDocs;
    const assocs = new Map<string, number>();

    for (const [termB, coCount] of neighbors) {
      const freqB = docFreq.get(termB) ?? 1;
      const pB = freqB / numDocs;
      const pAB = coCount / numDocs;

      const pmi = Math.log(pAB / (pA * pB));
      if (pmi >= MIN_PMI && pmi < 10) { // Cap to avoid extreme values from rare terms
        assocs.set(termB, pmi);
      }
    }

    associations.set(termA, assocs);
  }

  return { associations, docFreq, numDocs };
}

function expandQueryWithCooccurrence(
  queryTokens: readonly string[],
  coIndex: CooccurrenceIndex
): Array<{ readonly token: string; readonly weight: number }> {
  const expanded: Array<{ readonly token: string; readonly weight: number }> = [];
  const seen = new Set<string>();

  // Add original query terms at full weight
  for (const token of queryTokens) {
    expanded.push({ token, weight: 1.0 });
    seen.add(token);
  }

  // Find associated terms for each query token
  const candidateScores = new Map<string, number>();

  for (const queryToken of queryTokens) {
    const assocs = coIndex.associations.get(queryToken);
    if (!assocs) continue;

    // Sort by PMI strength, take top-K
    const sorted = [...assocs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, EXPANSION_TERMS_PER_QUERY);

    for (const [term, strength] of sorted) {
      if (seen.has(term)) continue;
      // Normalize PMI to 0-1 range for weighting
      const normalizedStrength = Math.min(strength / 5, 1);
      const existing = candidateScores.get(term) ?? 0;
      candidateScores.set(term, Math.max(existing, normalizedStrength));
    }
  }

  // Add expansion terms sorted by score
  const sortedCandidates = [...candidateScores.entries()]
    .sort((a, b) => b[1] - a[1]);

  for (const [term, strength] of sortedCandidates) {
    expanded.push({ token: term, weight: EXPANSION_WEIGHT * strength });
    seen.add(term);
  }

  return expanded;
}

// ============================================================
// TF-IDF Engine
// ============================================================

/**
 * Tokenized document with term frequencies and field weights.
 */
export interface TokenizedDocument {
  readonly id: string;
  readonly tokens: readonly string[];
  readonly bigrams: readonly string[]; // Phrases of 2 words
  readonly termFreq: ReadonlyMap<string, number>;
  readonly totalTerms: number;
  // Field-specific boosts
  readonly titleTerms: readonly string[];
  readonly descriptionTerms: readonly string[];
}

/**
 * TF-IDF statistics for a corpus.
 */
export interface TfIdfStats {
  readonly docFreq: ReadonlyMap<string, number>;
  readonly numDocs: number;
}

/**
 * Search result with relevance score.
 */
export interface SearchResult<T> {
  readonly item: T;
  readonly relevance: number;
  readonly matchedTerms: readonly string[];
}

/**
 * Stop words to filter out.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "this",
  "but",
  "they",
  "have",
  "had",
  "what",
  "when",
  "where",
  "who",
  "which",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "just",
  "should",
  "now",
  "or",
  "if",
  "then",
  "else",
  "up",
  "out",
  "about",
  "into",
  "over",
  "after",
  "also",
  "use",
  "get",
  "make",
]);

/**
 * Tokenize text into terms.
 */
export function tokenize(text: string): readonly string[] {
  const clean = text
    .toLowerCase()
    .replace(/[^\w\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const tokens = clean.split(" ").filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return tokens;
}

/**
 * Calculate term frequency for a document.
 */
export function calculateTermFreq(tokens: readonly string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

/**
 * Extract bigrams (two-word phrases) from tokens.
 */
function extractBigrams(tokens: readonly string[]): readonly string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t1 = tokens[i] ?? "";
    const t2 = tokens[i + 1] ?? "";
    if (t1 && t2) {
      bigrams.push(`${t1}_${t2}`);
    }
  }
  return bigrams;
}

/**
 * Tokenize a document with field awareness.
 */
export function tokenizeDocument(id: string, text: string): TokenizedDocument {
  const tokens = tokenize(text);
  const bigrams = extractBigrams(tokens);
  const termFreq = calculateTermFreq([...tokens, ...bigrams]);

  // Try to extract title and description for field boosting
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const titleLine = lines[0] ?? "";
  const descLine = lines[1] ?? "";

  return {
    id,
    tokens,
    bigrams,
    termFreq,
    totalTerms: tokens.length,
    titleTerms: tokenize(titleLine),
    descriptionTerms: tokenize(descLine),
  };
}

/**
 * Calculate document frequency for a corpus.
 */
export function calculateDocFreq(docs: readonly TokenizedDocument[]): Map<string, number> {
  const docFreq = new Map<string, number>();

  for (const doc of docs) {
    const seen = new Set<string>();
    for (const token of doc.tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }
  }

  return docFreq;
}

/**
 * Calculate TF-IDF for a term in a document.
 */
export function calculateTfIdf(term: string, doc: TokenizedDocument, stats: TfIdfStats): number {
  const tf = doc.termFreq.get(term) ?? 0;
  if (tf === 0) {
    return 0;
  }

  // Normalized TF
  const normalizedTf = tf / doc.totalTerms;

  // IDF with log smoothing
  const df = stats.docFreq.get(term) ?? 1;
  const idf = Math.log(stats.numDocs / df);

  return normalizedTf * idf;
}

/**
 * Build TF-IDF vector for a document.
 */
export function buildVector(
  doc: TokenizedDocument,
  allTerms: readonly string[],
  stats: TfIdfStats
): Float64Array {
  const vector = new Float64Array(allTerms.length);
  for (let i = 0; i < allTerms.length; i++) {
    const term = allTerms[i] ?? "";
    vector[i] = calculateTfIdf(term, doc, stats);
  }
  return vector;
}

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dotProduct += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Find matching terms between query and document.
 */
export function findMatchedTerms(
  queryTokens: readonly string[],
  docTokens: readonly string[]
): readonly string[] {
  const docSet = new Set(docTokens);
  return queryTokens.filter((t) => docSet.has(t));
}

/**
 * Semantic search engine.
 */
export class SemanticSearch {
  private fragments = new Map<string, TokenizedDocument>();
  private guides = new Map<string, TokenizedDocument>();
  private allTerms: string[] = [];
  private docFreq: Map<string, number> = new Map();
  private cooccurrenceIndex: CooccurrenceIndex | null = null;
  private dirty = true;

  /**
   * Index memory fragments.
   */
  indexFragments(fragments: readonly MemoryFragment[]): void {
    this.fragments.clear();

    for (const frag of fragments) {
      const text = this.buildFragmentText(frag);
      const doc = tokenizeDocument(frag.id, text);
      this.fragments.set(frag.id, doc);
    }

    this.dirty = true;
    logger.debug(`Indexed ${fragments.length} fragments`);
  }

  /**
   * Add or update a single fragment incrementally.
   * More efficient than full reindex.
   */
  upsertFragment(fragment: MemoryFragment): void {
    const text = this.buildFragmentText(fragment);
    const doc = tokenizeDocument(fragment.id, text);
    const wasNew = !this.fragments.has(fragment.id);
    this.fragments.set(fragment.id, doc);

    if (wasNew) {
      this.dirty = true;
    }
    logger.debug(`Upserted fragment ${fragment.id}`);
  }

  /**
   * Remove a fragment from index.
   */
  removeFragment(fragmentId: string): void {
    if (this.fragments.delete(fragmentId)) {
      this.dirty = true;
      logger.debug(`Removed fragment ${fragmentId} from index`);
    }
  }

  /**
   * Index guides.
   */
  indexGuides(guides: readonly Guide[]): void {
    this.guides.clear();

    for (const guide of guides) {
      const text = this.buildGuideText(guide);
      const doc = tokenizeDocument(guide.id, text);
      this.guides.set(guide.id, doc);
    }

    this.dirty = true;
    logger.debug(`Indexed ${guides.length} guides`);
  }

  /**
   * Add or update a single guide incrementally.
   * More efficient than full reindex.
   */
  upsertGuide(guide: Guide): void {
    const text = this.buildGuideText(guide);
    const doc = tokenizeDocument(guide.id, text);
    const wasNew = !this.guides.has(guide.id);
    this.guides.set(guide.id, doc);

    if (wasNew) {
      this.dirty = true;
    }
    logger.debug(`Upserted guide ${guide.id}`);
  }

  /**
   * Remove a guide from index.
   */
  removeGuide(guideId: string): void {
    if (this.guides.delete(guideId)) {
      this.dirty = true;
      logger.debug(`Removed guide ${guideId} from index`);
    }
  }

  /**
   * Build searchable text from a fragment.
   * Format: title on line 1, description on line 2, then content.
   */
  private buildFragmentText(fragment: MemoryFragment): string {
    const parts = [
      fragment.title || "Untitled",
      fragment.description || "",
      fragment.fragment,
      ...fragment.tags,
    ];
    if (fragment.project) {
      parts.push(fragment.project);
    }
    return parts.filter(Boolean).join("\n");
  }

  /**
   * Build searchable text from a guide.
   * Format: name on line 1, description on line 2, then content.
   */
  private buildGuideText(guide: Guide): string {
    const parts = [
      guide.name,
      guide.description || "",
      ...guide.contexts,
      ...guide.learnings,
      guide.category,
    ];
    return parts.filter(Boolean).join("\n");
  }

  /**
   * Ensure the index is built.
   */
  private ensureIndex(): void {
    if (!this.dirty) {
      return;
    }

    // Combine all documents
    const allDocs = [...this.fragments.values(), ...this.guides.values()];

    // Calculate document frequency
    this.docFreq = calculateDocFreq(allDocs);

    // Build term list
    const termSet = new Set<string>();
    for (const doc of allDocs) {
      for (const token of doc.tokens) {
        termSet.add(token);
      }
    }
    this.allTerms = Array.from(termSet);

    // Build co-occurrence index for query expansion (spreading activation)
    this.cooccurrenceIndex = buildCooccurrenceIndex(allDocs);

    this.dirty = false;
    logger.debug(`Index built with ${this.allTerms.length} terms`);
  }

  /**
   * Search fragments with field-aware boosting.
   */
  searchFragments(
    query: string,
    fragments: readonly MemoryFragment[],
    limit = 10
  ): SearchResult<MemoryFragment>[] {
    this.ensureIndex();

    const queryDoc = tokenizeDocument("query", query);
    const stats: TfIdfStats = {
      docFreq: this.docFreq,
      numDocs: this.fragments.size + this.guides.size,
    };
    const temporalIntent = detectTemporalIntent(query);

    // Extract non-temporal query terms for year-specific matching
    const yearStr = temporalIntent.targetYear !== null ? String(temporalIntent.targetYear) : null;
    const queryNonTemporalTerms = queryDoc.tokens.filter((t) => t !== yearStr);

    // Detect version conflicts: groups of fragments with similar base titles
    const conflictIds = this.detectVersionConflicts(fragments);

    // First pass: score with original query using ONLY TF-IDF (no temporal boost)
    // to measure raw match quality for expansion decision
    let topRawScore = 0;
    for (const frag of fragments) {
      const doc = this.fragments.get(frag.id);
      if (!doc) continue;
      const rawScore = this.calculateFieldBoostedRelevance(queryDoc, doc, stats);
      if (rawScore > topRawScore) topRawScore = rawScore;
    }

    // Adaptive expansion: use expanded query only when raw TF-IDF matches are weak
    const useExpansion = this.cooccurrenceIndex && topRawScore < 0.5;
    const expandedQuery = useExpansion ? this.expandQueryDocument(queryDoc) : queryDoc;

    // Second pass with (possibly expanded) query
    const results = this.scoreFragments(expandedQuery, queryDoc, fragments, stats, temporalIntent, queryNonTemporalTerms, conflictIds);

    // Sort by relevance and limit
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  searchGuides(query: string, guides: readonly Guide[], limit = 10): SearchResult<Guide>[] {
    this.ensureIndex();

    const queryDoc = tokenizeDocument("query", query);
    const stats: TfIdfStats = {
      docFreq: this.docFreq,
      numDocs: this.fragments.size + this.guides.size,
    };
    const temporalIntent = detectTemporalIntent(query);

    // First pass to check match quality
    const firstPass = this.scoreGuides(queryDoc, queryDoc, guides, stats, temporalIntent);
    const topOriginalScore = firstPass.length > 0 ? firstPass[0].relevance : 0;

    const useExpansion = this.cooccurrenceIndex && topOriginalScore < 0.8;
    const expandedQuery = useExpansion ? this.expandQueryDocument(queryDoc) : queryDoc;

    const results = this.scoreGuides(expandedQuery, queryDoc, guides, stats, temporalIntent);

    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  /**
   * Score all fragments and return ranked results.
   */
  private scoreFragments(
    scoringDoc: TokenizedDocument,
    matchDoc: TokenizedDocument,
    fragments: readonly MemoryFragment[],
    stats: TfIdfStats,
    temporalIntent: TemporalIntent,
    queryNonTemporalTerms: readonly string[],
    conflictIds: ReadonlySet<string>
  ): Array<SearchResult<MemoryFragment>> {
    const results: Array<SearchResult<MemoryFragment>> = [];

    for (const frag of fragments) {
      const doc = this.fragments.get(frag.id);
      if (!doc) continue;

      const relevance = this.calculateFieldBoostedRelevance(scoringDoc, doc, stats);
      const temporalBoost = computeTemporalBoost(
        frag.title, frag.description, frag.tags, frag.fragment, temporalIntent, conflictIds.has(frag.id), queryNonTemporalTerms
      );
      const freshnessBias = computeFreshnessBias(frag.title, frag.description, frag.tags);
      const boostedRelevance = relevance + temporalBoost + freshnessBias;

      if (boostedRelevance > 0) {
        const matchedTerms = this.findMatchedTermsEnhanced(matchDoc, doc);
        results.push({
          item: frag,
          relevance: Math.min(boostedRelevance, 1),
          matchedTerms,
        });
      }
    }

    return results;
  }

  /**
   * Score all guides and return ranked results.
   */
  private scoreGuides(
    scoringDoc: TokenizedDocument,
    matchDoc: TokenizedDocument,
    guides: readonly Guide[],
    stats: TfIdfStats,
    temporalIntent: TemporalIntent
  ): Array<SearchResult<Guide>> {
    const results: Array<SearchResult<Guide>> = [];

    for (const guide of guides) {
      const doc = this.guides.get(guide.id);
      if (!doc) continue;

      const relevance = this.calculateFieldBoostedRelevance(scoringDoc, doc, stats);
      const guideContent = `${guide.description} ${guide.contexts.join(" ")} ${guide.learnings.join(" ")}`;
      const temporalBoost = computeTemporalBoost(
        guide.name, guide.description, [], guideContent, temporalIntent
      );
      const freshnessBias = computeFreshnessBias(guide.name, guide.description, []);
      const boostedRelevance = relevance + temporalBoost + freshnessBias;

      if (boostedRelevance > 0) {
        const matchedTerms = this.findMatchedTermsEnhanced(matchDoc, doc);
        results.push({
          item: guide,
          relevance: Math.min(boostedRelevance, 1),
          matchedTerms,
        });
      }
    }

    return results;
  }

  /**
   * Calculate field-boosted relevance score.
   * Title matches are worth 3x, description matches 2x, content matches 1x.
   */
  private calculateFieldBoostedRelevance(
    queryDoc: TokenizedDocument,
    doc: TokenizedDocument,
    stats: TfIdfStats
  ): number {
    const queryTokens = new Set(queryDoc.tokens);
    const queryBigrams = new Set(queryDoc.bigrams);

    // Base TF-IDF similarity
    const queryVector = buildVector(queryDoc, this.allTerms, stats);
    const docVector = buildVector(doc, this.allTerms, stats);
    let baseScore = cosineSimilarity(queryVector, docVector);

    // Apply field boosts
    const titleTerms = new Set(doc.titleTerms);
    const descTerms = new Set(doc.descriptionTerms);

    let fieldBoost = 1;

    // Check title matches (3x boost)
    for (const token of queryTokens) {
      if (titleTerms.has(token)) {
        fieldBoost += 0.5;
      }
    }

    // Check description matches (2x boost)
    for (const token of queryTokens) {
      if (descTerms.has(token)) {
        fieldBoost += 0.25;
      }
    }

    // Check bigram/exact phrase matches (2x boost)
    for (const bigram of queryBigrams) {
      if (doc.termFreq.has(bigram)) {
        fieldBoost += 0.3;
      }
    }

    // Normalize field boost to avoid excessive scores
    fieldBoost = Math.min(fieldBoost, 3);

    return baseScore * fieldBoost;
  }

  /**
   * Find matched terms including bigrams.
   */
  private findMatchedTermsEnhanced(
    queryDoc: TokenizedDocument,
    doc: TokenizedDocument
  ): readonly string[] {
    const docSet = new Set([...doc.tokens, ...doc.bigrams]);
    const queryTokens = [...queryDoc.tokens, ...queryDoc.bigrams];
    return queryTokens.filter((t) => docSet.has(t));
  }

  /**
   * Expand a query document using co-occurrence associations (spreading activation).
   * Returns a new TokenizedDocument with expanded terms weighted appropriately.
   */
  private expandQueryDocument(queryDoc: TokenizedDocument): TokenizedDocument {
    if (!this.cooccurrenceIndex) return queryDoc;

    const expanded = expandQueryWithCooccurrence(queryDoc.tokens, this.cooccurrenceIndex);
    if (expanded.length === queryDoc.tokens.length) return queryDoc; // No expansion happened

    // Build expanded term frequency map with weights
    const termFreq = new Map<string, number>();
    const tokens: string[] = [];
    for (const { token, weight } of expanded) {
      tokens.push(token);
      termFreq.set(token, (termFreq.get(token) ?? 0) + weight);
    }

    const bigrams = extractBigrams(tokens);

    return {
      id: queryDoc.id,
      tokens,
      bigrams,
      termFreq,
      totalTerms: tokens.length,
      titleTerms: queryDoc.titleTerms,
      descriptionTerms: queryDoc.descriptionTerms,
    };
  }

  /**
   * Detect groups of fragments with similar base titles (version conflicts).
   * Returns set of fragment IDs that belong to a conflict group.
   */
  private detectVersionConflicts(fragments: readonly MemoryFragment[]): Set<string> {
    const conflictIds = new Set<string>();
    const titleGroups = new Map<string, string[]>();

    for (const frag of fragments) {
      // Extract base title by removing version suffixes like " - Original", " - Updated", " - v1", etc.
      const baseTitle = frag.title.replace(/\s*[-–]\s*(original|updated|v\d+|current|latest|revision\d*|new)\s*$/i, "").trim().toLowerCase();
      if (!baseTitle) continue;

      const group = titleGroups.get(baseTitle) ?? [];
      group.push(frag.id);
      titleGroups.set(baseTitle, group);
    }

    for (const ids of titleGroups.values()) {
      if (ids.length > 1) {
        for (const id of ids) {
          conflictIds.add(id);
        }
      }
    }

    return conflictIds;
  }

  /**
   * Get term frequency stats for debugging.
   */
  getStats(): { totalTerms: number; fragmentCount: number; guideCount: number } {
    return {
      totalTerms: this.allTerms.length,
      fragmentCount: this.fragments.size,
      guideCount: this.guides.size,
    };
  }
}

/**
 * Default semantic search instance.
 */
export const defaultSemanticSearch = new SemanticSearch();
