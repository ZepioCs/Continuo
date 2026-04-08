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
 */
export class MemoryManager {
  readonly storage: AtomicStorage;
  readonly fragmentStore: JsonlStorage<RawMemoryFragment>;
  readonly sessionManager: SessionManager;
  readonly contextSelector: ContextSelector;
  readonly prioritizer: Prioritizer;
  readonly semanticSearch: SemanticSearch | null;

  private initialized = false;

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

    // Auto-prioritize on load
    const fragments = await this.listFragments();
    this.prioritizer.autoPrioritize(fragments);

    // Index fragments for semantic search
    if (this.semanticSearch) {
      this.semanticSearch.indexFragments(fragments);
    }

    await this.saveFragments(fragments);

    this.initialized = true;
    logger.info("Memory manager initialized");
  }

  /**
   * Add a new memory fragment.
   */
  async add(params: MemoryAddParams): Promise<MemoryFragment> {
    const now = new Date().toISOString();

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
    };

    await this.fragmentStore.append(toRaw(fragment));

    // Incrementally update semantic search index
    if (this.semanticSearch) {
      this.semanticSearch.upsertFragment(fragment);
    }

    logger.debug("Added fragment", { id: fragment.id, title: fragment.title });

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
        // Build new raw object with updates applied
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
        };

        updated = raw;
        return raw;
      }
    );

    if (updated) {
      const fragment = fromRaw(updated);

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
   * List all fragments.
   */
  async listFragments(options?: {
    project?: string;
    priority?: Priority;
  }): Promise<MemoryFragment[]> {
    const raw = await this.fragmentStore.readAll();
    let fragments = raw.map(fromRaw);

    if (options?.project) {
      fragments = fragments.filter((f) => f.project === options.project);
    }

    if (options?.priority) {
      fragments = fragments.filter((f) => f.priority === options.priority);
    }

    return fragments;
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
    logger.info("Memory manager shutdown complete");
  }
}

/**
 * Convert raw fragment to MemoryFragment.
 * Handles missing inherits/tags fields from legacy data.
 */
function fromRaw(raw: RawMemoryFragment): MemoryFragment {
  return {
    ...raw,
    inherits: (raw.inherits as readonly string[] | undefined) ?? [],
    tags: (raw.tags as readonly string[] | undefined) ?? [],
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
