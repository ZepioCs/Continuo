/**
 * Memory management.
 * Integrates storage, sessions, and context selection.
 */

import { createLogger } from "../utils/logging.js";
import { estimateTokensAccurate } from "../utils/tokens.js";
import { ContextSelector } from "./context.js";
import { Prioritizer } from "./prioritization.js";
import type { SemanticSearch } from "./semantic.js";
import { SessionManager } from "./sessions.js";
import { AtomicStorage, JsonlStorage } from "./storage.js";
import type {
  ContextRequest,
  MemoryAddParams,
  MemoryFragment,
  MemoryUpdateParams,
  Priority,
  RawMemoryFragment,
  SelectionResult,
} from "./types.js";

const logger = createLogger("memory");

const MAX_FRAGMENT_LENGTH = 10000;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const AUTO_EXTRACT_MIN_WORDS = 150;
const AUTO_EXTRACT_MAX_SUBFACTS = 5;

/**
 * Memory manager options.
 */
export interface MemoryManagerOptions {
  readonly storagePath?: string;
  readonly defaultTokenBudget?: number;
  readonly sessionTtl?: number;
  readonly maxSessions?: number;
  readonly semanticSearch?: SemanticSearch;
}

/**
 * Memory manager for fragment CRUD and context selection.
 * Uses in-memory cache to avoid repeated JSONL file scans.
 */
export class MemoryManager {
  readonly storage: AtomicStorage;
  readonly fragmentStore: JsonlStorage<RawMemoryFragment>;
  readonly sessionManager: SessionManager;
  readonly contextSelector: ContextSelector;
  readonly prioritizer: Prioritizer;
  readonly semanticSearch: SemanticSearch | null;

  private initialized = false;
  private fragmentCache: MemoryFragment[] | null = null;

  constructor(options: MemoryManagerOptions = {}) {
    this.storage = new AtomicStorage({ basePath: options.storagePath ?? "~/.continuo" });
    this.fragmentStore = new JsonlStorage<RawMemoryFragment>(this.storage, "fragments.jsonl");
    this.sessionManager = new SessionManager(this.storage, options.sessionTtl, options.maxSessions);
    this.semanticSearch = options.semanticSearch ?? null;
    this.prioritizer = new Prioritizer(undefined, this.semanticSearch ?? undefined);
    this.contextSelector = new ContextSelector(
      this.prioritizer,
      options.defaultTokenBudget ?? 8000
    );
  }

  /**
   * Initialize the memory manager.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.sessionManager.initialize();

    // Load all fragments into cache
    const allRaw = await this.fragmentStore.readAll();
    let fragments = allRaw.map(fromRaw);

    // Clean up expired fragments
    const now = Date.now();
    const expired = fragments.filter((f) => f.expiresAt && new Date(f.expiresAt).getTime() < now);
    if (expired.length > 0) {
      logger.info(`Cleaning up ${expired.length} expired fragments`);
      const expiredIds = new Set(expired.map((f) => f.id));
      fragments = fragments.filter((f) => !expiredIds.has(f.id));
      await this.saveFragments(fragments);

      if (this.semanticSearch) {
        for (const f of expired) {
          this.semanticSearch.removeFragment(f.id);
        }
      }
    }

    // Auto-prioritize
    this.prioritizer.autoPrioritize(fragments);

    // Index for semantic search
    if (this.semanticSearch) {
      this.semanticSearch.indexFragments(fragments);
    }

    await this.saveFragments(fragments);

    // Populate cache
    this.fragmentCache = fragments;

    this.initialized = true;
    logger.info("Memory manager initialized", { fragmentCount: fragments.length });
  }

  /**
   * Add a new memory fragment.
   * Validates input, checks for duplicates, auto-extracts sub-facts, and adds if unique.
   */
  async add(params: MemoryAddParams): Promise<MemoryFragment> {
    validateFragmentContent(params.fragment);

    // Check for near-duplicates before adding
    const existing = await this.findDuplicate(params.fragment, params.project);
    if (existing) {
      const updated = await this.update({
        id: existing.id,
        fragment: params.fragment,
        priority: params.priority ?? (existing.priority as Priority),
        confidence: params.confidence ?? existing.confidence,
        tags: params.tags?.length ? params.tags : [...existing.tags],
      });
      logger.debug("Updated duplicate instead of adding new", {
        existingId: existing.id,
        title: existing.title,
      });
      return updated!;
    }

    const now = new Date().toISOString();
    const expiresAt = params.ttl ? new Date(Date.now() + params.ttl * 86400000).toISOString() : null;

    const fragment: MemoryFragment = {
      id: this.generateId(),
      title: params.title ?? this.extractTitle(params.fragment),
      description: params.description ?? "",
      fragment: params.fragment,
      project: params.project ?? null,
      priority: (params.priority ?? "normal") as Priority,
      confidence: params.confidence ?? 0.8,
      source: params.source ?? "user",
      created: now,
      lastAccessed: now,
      accessed: 0,
      inherits: params.inherits ?? [],
      estimatedTokens: estimateTokensAccurate(params.fragment),
      tags: params.tags ?? [],
      expiresAt,
      parentFragmentId: params.parentFragmentId ?? null,
    };

    await this.fragmentStore.append(toRaw(fragment));

    // Update cache
    if (this.fragmentCache) {
      this.fragmentCache.push(fragment);
    }

    // Incrementally update semantic search index
    if (this.semanticSearch) {
      this.semanticSearch.upsertFragment(fragment);
    }

    // Auto-extract sub-facts from large fragments
    const subFacts = this.extractSubFacts(fragment);
    for (const sub of subFacts) {
      await this.fragmentStore.append(toRaw(sub));
      if (this.fragmentCache) {
        this.fragmentCache.push(sub);
      }
      if (this.semanticSearch) {
        this.semanticSearch.upsertFragment(sub);
      }
    }

    logger.debug("Added fragment", {
      id: fragment.id,
      title: fragment.title,
      subFactsExtracted: subFacts.length,
    });

    return fragment;
  }

  /**
   * Update an existing fragment.
   */
  async update(params: MemoryUpdateParams): Promise<MemoryFragment | null> {
    let updated: RawMemoryFragment | null = null;

    await this.fragmentStore.update(
      (f) => f.id === params.id,
      (f) => {
        const raw: RawMemoryFragment = {
          id: f.id,
          title: params.title ?? f.title,
          description: params.description ?? f.description,
          fragment: params.fragment ?? f.fragment,
          project: params.project ?? f.project,
          priority: params.priority ?? f.priority,
          confidence: params.confidence ?? f.confidence,
          source: f.source,
          created: f.created,
          lastAccessed: f.lastAccessed,
          accessed: f.accessed,
          inherits: [...f.inherits],
          estimatedTokens:
            params.fragment !== undefined
              ? estimateTokensAccurate(params.fragment)
              : f.estimatedTokens,
          tags: [...f.tags],
          expiresAt: (f as { expiresAt?: string | null }).expiresAt ?? null,
          parentFragmentId: (f as { parentFragmentId?: string | null }).parentFragmentId ?? null,
        };

        updated = raw;
        return raw;
      }
    );

    if (updated) {
      const fragment = fromRaw(updated);

      // Update cache
      if (this.fragmentCache) {
        const idx = this.fragmentCache.findIndex((f) => f.id === fragment.id);
        if (idx !== -1) {
          this.fragmentCache[idx] = fragment;
        }
      }

      // Incrementally update semantic search index
      if (this.semanticSearch) {
        this.semanticSearch.upsertFragment(fragment);
      }

      logger.debug("Updated fragment", { id: params.id });
      return fragment;
    }

    return null;
  }

  /**
   * Delete a fragment by ID.
   */
  async delete(id: string): Promise<boolean> {
    let found = false;

    await this.fragmentStore.delete((f) => {
      if (f.id === id) {
        found = true;
        return true;
      }
      return false;
    });

    if (found) {
      // Update cache
      if (this.fragmentCache) {
        this.fragmentCache = this.fragmentCache.filter((f) => f.id !== id);
      }

      // Remove from semantic search index
      if (this.semanticSearch) {
        this.semanticSearch.removeFragment(id);
      }
      logger.debug("Deleted fragment", { id });
    }

    return found;
  }

  /**
   * Add multiple fragments in a single batch operation.
   * More efficient than multiple individual adds.
   */
  async addBatch(paramsList: readonly MemoryAddParams[]): Promise<MemoryFragment[]> {
    const now = new Date().toISOString();
    const fragments: MemoryFragment[] = [];

    for (const params of paramsList) {
      const expiresAt = params.ttl ? new Date(Date.now() + params.ttl * 86400000).toISOString() : null;
      const fragment: MemoryFragment = {
        id: this.generateId(),
        title: params.title ?? this.extractTitle(params.fragment),
        description: params.description ?? "",
        fragment: params.fragment,
        project: params.project ?? null,
        priority: (params.priority ?? "normal") as Priority,
        confidence: params.confidence ?? 0.8,
        source: params.source ?? "user",
        created: now,
        lastAccessed: now,
        accessed: 0,
        inherits: params.inherits ?? [],
        estimatedTokens: estimateTokensAccurate(params.fragment),
        tags: params.tags ?? [],
        expiresAt,
        parentFragmentId: params.parentFragmentId ?? null,
      };
      fragments.push(fragment);
    }

    // Batch write all fragments using storage transaction
    await this.storage.transaction(this.fragmentStore.filePath, async (current) => {
      const raw = fragments.map(toRaw);
      const newLines = raw.map((r) => JSON.stringify(r));
      const newValue = current.trim() ? `${current}\n${newLines.join("\n")}` : newLines.join("\n");
      return { result: undefined, newValue };
    });

    // Update cache
    if (this.fragmentCache) {
      this.fragmentCache.push(...fragments);
    }

    // Update semantic search index for all fragments
    if (this.semanticSearch) {
      for (const fragment of fragments) {
        this.semanticSearch.upsertFragment(fragment);
      }
    }

    logger.debug(`Added batch of ${fragments.length} fragments`);
    return fragments;
  }

  /**
   * Delete multiple fragments by IDs in a single batch operation.
   */
  async deleteBatch(ids: readonly string[]): Promise<{ deleted: number; notFound: string[] }> {
    const idSet = new Set(ids);
    let deleted = 0;
    const notFound: string[] = [];

    await this.storage.transaction(this.fragmentStore.filePath, async (current) => {
      const lines = current.split("\n").filter((l) => l.trim());
      const items: RawMemoryFragment[] = [];
      for (const line of lines) {
        items.push(JSON.parse(line) as RawMemoryFragment);
      }

      const remaining: RawMemoryFragment[] = [];
      for (const item of items) {
        if (idSet.has(item.id)) {
          deleted++;
        } else {
          remaining.push(item);
        }
      }

      // Check for not-found IDs
      const foundIds = new Set(items.map((i) => i.id));
      for (const id of ids) {
        if (!foundIds.has(id)) {
          notFound.push(id);
        }
      }

      const newValue = remaining.map((i) => JSON.stringify(i)).join("\n");
      return { result: undefined, newValue };
    });

    // Update cache
    if (this.fragmentCache) {
      this.fragmentCache = this.fragmentCache.filter((f) => !idSet.has(f.id));
    }

    // Remove from semantic search index
    if (this.semanticSearch) {
      for (const id of ids) {
        this.semanticSearch.removeFragment(id);
      }
    }

    logger.debug(`Deleted batch: ${deleted} fragments, ${notFound.length} not found`);
    return { deleted, notFound };
  }

  /**
   * Get a fragment by ID.
   */
  async get(id: string): Promise<MemoryFragment | null> {
    const fragments = await this.listFragments();
    const fragment = fragments.find((f) => f.id === id);

    if (fragment) {
      // Update access stats
      await this.updateAccessStats(id);
    }

    return fragment ?? null;
  }

  /**
   * Find a near-duplicate fragment using Jaccard similarity.
   * Only checks fragments with matching project scope.
   */
  private async findDuplicate(
    content: string,
    project?: string | null
  ): Promise<MemoryFragment | null> {
    const fragments = await this.listFragments();

    // First pass: exact content match (fast)
    const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
    for (const frag of fragments) {
      const existing = frag.fragment.toLowerCase().replace(/\s+/g, " ").trim();
      if (existing === normalized) {
        return frag;
      }
    }

    // Second pass: Jaccard similarity (only same project or global)
    for (const frag of fragments) {
      if (project !== undefined && frag.project !== project && frag.project !== null) {
        continue;
      }
      if (jaccardSimilarity(content, frag.fragment) > DEDUP_SIMILARITY_THRESHOLD) {
        return frag;
      }
    }

    return null;
  }

  /**
   * List all fragments. Returns from cache if available, filtering expired.
   */
  async listFragments(options?: {
    project?: string;
    priority?: Priority;
  }): Promise<MemoryFragment[]> {
    let fragments = await this.getAllFragments();

    // Filter by project
    if (options?.project) {
      fragments = fragments.filter((f) => f.project === options.project);
    }

    // Filter by priority
    if (options?.priority) {
      fragments = fragments.filter((f) => f.priority === options.priority);
    }

    return fragments;
  }

  /**
   * Get all non-expired fragments from cache or storage.
   */
  private async getAllFragments(): Promise<MemoryFragment[]> {
    if (this.fragmentCache) {
      return this.filterExpired(this.fragmentCache);
    }

    const raw = await this.fragmentStore.readAll();
    this.fragmentCache = raw.map(fromRaw);
    return this.filterExpired(this.fragmentCache);
  }

  /**
   * Filter out expired fragments.
   */
  private filterExpired(fragments: readonly MemoryFragment[]): MemoryFragment[] {
    const now = Date.now();
    return fragments.filter((f) => {
      if (!f.expiresAt) return true;
      return new Date(f.expiresAt).getTime() >= now;
    });
  }

  /**
   * Extract sub-facts from a large fragment.
   * Returns additional fragments with parentFragmentId set.
   */
  private extractSubFacts(parent: MemoryFragment): MemoryFragment[] {
    const wordCount = parent.fragment.split(/\s+/).length;
    if (wordCount < AUTO_EXTRACT_MIN_WORDS) {
      return [];
    }

    const sentences = this.splitSentences(parent.fragment);
    if (sentences.length < 3) {
      return [];
    }

    // Score sentences for extractability
    const scored = sentences
      .map((sentence, index) => ({
        sentence,
        score: this.scoreSubFact(sentence, index, sentences.length),
      }))
      .filter((s) => s.score > 2.0) // Only extract high-value sentences
      .sort((a, b) => b.score - a.score)
      .slice(0, AUTO_EXTRACT_MAX_SUBFACTS);

    if (scored.length === 0) {
      return [];
    }

    // Re-order by original position for coherence
    scored.sort((a, b) => {
      const idxA = sentences.indexOf(a.sentence);
      const idxB = sentences.indexOf(b.sentence);
      return idxA - idxB;
    });

    const now = new Date().toISOString();
    return scored.map((s) => ({
      id: this.generateId(),
      title: this.extractTitle(s.sentence),
      description: `Auto-extracted from: ${parent.title}`,
      fragment: s.sentence,
      project: parent.project,
      priority: parent.priority as Priority,
      confidence: parent.confidence * 0.9,
      source: parent.source,
      created: now,
      lastAccessed: now,
      accessed: 0,
      inherits: [],
      estimatedTokens: estimateTokensAccurate(s.sentence),
      tags: [...parent.tags, "auto-extracted"],
      expiresAt: parent.expiresAt,
      parentFragmentId: parent.id,
    }));
  }

  /**
   * Split text into sentences.
   */
  private splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15 && s.split(/\s+/).length >= 5);
  }

  /**
   * Score a sentence for sub-fact extraction.
   * Higher score = more likely to be a standalone useful fact.
   */
  private scoreSubFact(sentence: string, position: number, total: number): number {
    let score = 0;
    const lower = sentence.toLowerCase();

    // Numbers and specific details are valuable
    if (/\d+/.test(sentence)) score += 1.0;

    // Bullet points are usually self-contained facts
    if (/^[•\-*]\s/.test(sentence)) score += 1.5;

    // Numbered items
    if (/^\d+\.\s/.test(sentence)) score += 1.2;

    // Contains key-value patterns
    if (/:/.test(sentence) && !/\s+because/i.test(lower)) score += 0.8;

    // Technical indicators
    if (/[{}()[\]<>]/.test(sentence) || /\b(function|class|const|config|setting|endpoint|port|url)\b/i.test(lower)) {
      score += 0.7;
    }

    // Contains quotes (specific values)
    if (/"[^"]*"|`[^`]*`|'[^']*'/.test(sentence)) score += 0.5;

    // Preference/pattern indicators
    if (/\b(prefers?|always|never|must|should|requires?|uses?|supports?|needs?)\b/i.test(lower)) {
      score += 1.0;
    }

    // Problem/solution indicators
    if (/\b(fix|issue|bug|error|solution|resolved|cause|problem)\b/i.test(lower)) {
      score += 1.2;
    }

    // Reasonable length (not too short, not too long)
    const wordCount = sentence.split(/\s+/).length;
    if (wordCount >= 8 && wordCount <= 40) score += 0.5;

    // Avoid transition-only sentences
    if (/^(now let|next we|moving on|in summary|finally|as mentioned)/i.test(lower)) {
      score -= 3.0;
    }

    // Avoid pure questions
    if (sentence.endsWith("?")) score -= 2.0;

    return score;
  }

  /**
   * Select context based on request.
   */
  async selectContext(request: ContextRequest): Promise<SelectionResult> {
    const fragments = await this.listFragments();
    return this.contextSelector.select(fragments, request);
  }

  /**
   * Update access statistics for a fragment.
   */
  private async updateAccessStats(id: string): Promise<void> {
    await this.fragmentStore.update(
      (f) => f.id === id,
      (f) => {
        f.lastAccessed = new Date().toISOString();
        f.accessed++;
        return f;
      }
    );

    // Update cache
    if (this.fragmentCache) {
      const cached = this.fragmentCache.find((f) => f.id === id);
      if (cached) {
        (cached as { lastAccessed: string; accessed: number }).lastAccessed = new Date().toISOString();
        cached.accessed++;
      }
    }
  }

  /**
   * Save fragments (for auto-prioritize updates).
   */
  private async saveFragments(fragments: MemoryFragment[]): Promise<void> {
    const raw = fragments.map(toRaw);
    await this.fragmentStore.writeAll(raw);
  }

  /**
   * Extract a title from fragment content.
   */
  private extractTitle(content: string): string {
    const lines = content.split("\n");
    const firstLine = lines[0]?.trim() ?? "";

    if (firstLine.length < 100 && firstLine.length > 0) {
      return firstLine;
    }

    return content.slice(0, 50) + (content.length > 50 ? "..." : "");
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    return `frag_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Get fragment count.
   */
  async getCount(): Promise<number> {
    const fragments = await this.listFragments();
    return fragments.length;
  }

  /**
   * Get statistics.
   */
  async getStats(): Promise<{
    totalFragments: number;
    byProject: Readonly<Record<string, number>>;
    byPriority: Readonly<Record<Priority, number>>;
    totalTokens: number;
  }> {
    const fragments = await this.listFragments();

    const byProject: Record<string, number> = {};
    const byPriority: Record<string, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
    };
    let totalTokens = 0;

    for (const f of fragments) {
      if (f.project) {
        byProject[f.project] = (byProject[f.project] ?? 0) + 1;
      }
      const count = byPriority[f.priority];
      if (count !== undefined) {
        byPriority[f.priority] = count + 1;
      }
      totalTokens += f.estimatedTokens ?? 0;
    }

    return {
      totalFragments: fragments.length,
      byProject,
      byPriority: byPriority as Readonly<Record<Priority, number>>,
      totalTokens,
    };
  }

  /**
   * Shutdown and cleanup.
   */
  async shutdown(): Promise<void> {
    await this.sessionManager.shutdown();
    this.storage.clearCache();
    this.fragmentCache = null;
    logger.info("Memory manager shutdown complete");
  }
}

/**
 * Convert raw fragment to MemoryFragment.
 * Handles missing inherits/tags/expiresAt/parentFragmentId fields from legacy data.
 */
function fromRaw(raw: RawMemoryFragment): MemoryFragment {
  return {
    ...raw,
    inherits: (raw.inherits as readonly string[] | undefined) ?? [],
    tags: (raw.tags as readonly string[] | undefined) ?? [],
    expiresAt: (raw as { expiresAt?: string | null }).expiresAt ?? null,
    parentFragmentId: (raw as { parentFragmentId?: string | null }).parentFragmentId ?? null,
  };
}

/**
 * Convert MemoryFragment to raw.
 */
function toRaw(fragment: MemoryFragment): RawMemoryFragment {
  return {
    ...fragment,
    inherits: [...fragment.inherits],
    tags: [...fragment.tags],
  };
}

/**
 * Create a memory manager with default options.
 */
export async function createMemoryManager(options?: MemoryManagerOptions): Promise<MemoryManager> {
  const manager = new MemoryManager(options);
  await manager.initialize();
  return manager;
}

/**
 * Validate fragment content before storage.
 */
function validateFragmentContent(content: string): void {
  if (!content || content.trim().length === 0) {
    throw new Error("Fragment content must not be empty or whitespace-only");
  }
  if (content.length > MAX_FRAGMENT_LENGTH) {
    throw new Error(
      `Fragment content exceeds maximum length of ${MAX_FRAGMENT_LENGTH} characters (got ${content.length})`
    );
  }
}

/**
 * Jaccard word similarity between two strings.
 */
function jaccardSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2)
    );
  const wordsA = normalize(a);
  const wordsB = normalize(b);

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
