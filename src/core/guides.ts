/**
 * Guide management for procedural knowledge.
 * Similar to MemoryManager but for guides with usage tracking.
 */

import { createLogger } from "../utils/logging.js";
import { SemanticSearch } from "./semantic.js";
import { AtomicStorage, JsonlStorage } from "./storage.js";
import type {
  Guide,
  GuideAddParams,
  GuideCategory,
  GuideDistillParams,
  GuidePracticeParams,
  GuideSuggestParams,
  GuideSuggestion,
  GuideUpdateParams,
  MemoryFragment,
  RawGuide,
} from "./types.js";
import { toGuide, toRawGuide } from "./types.js";

const logger = createLogger("guides");

/**
 * Guide manager options.
 */
export interface GuideManagerOptions {
  readonly storagePath?: string;
  /**
   * Delete storage directory on shutdown. Useful for tests.
   * @default false
   */
  readonly cleanup?: boolean;
}

/**
 * Guide manager for CRUD, practice tracking, and suggestions.
 */
export class GuideManager {
  readonly storage: AtomicStorage;
  readonly guideStore: JsonlStorage<RawGuide>;
  readonly semanticSearch: SemanticSearch;
  readonly cleanup: boolean;

  private initialized = false;
  private cache = new Map<string, Guide>();

  constructor(options: GuideManagerOptions = {}) {
    this.cleanup = options.cleanup ?? false;
    this.storage = new AtomicStorage({ basePath: options.storagePath ?? "~/.continuo" });
    this.guideStore = new JsonlStorage<RawGuide>(this.storage, "guides.jsonl");
    this.semanticSearch = new SemanticSearch();
  }

  /**
   * Initialize the guide manager.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const guides = await this.listGuides();
    this.semanticSearch.indexGuides(guides);

    this.initialized = true;
    logger.info("Guide manager initialized");
  }

  /**
   * Add or update a guide.
   */
  async add(params: GuideAddParams): Promise<Guide> {
    const now = new Date().toISOString();

    // Check if guide already exists by name
    const existing = await this.getByName(params.name);
    if (existing) {
      // Update existing guide
      const updated = await this.update({
        id: existing.id,
        name: params.name,
        category: params.category,
        description: params.description,
      });
      if (updated) {
        return updated;
      }
    }

    const guide: Guide = {
      id: this.generateId(),
      name: params.name,
      category: params.category,
      description: params.description,
      created: now,
      lastUsed: now,
      usageCount: 0,
      contexts: params.contexts ?? [],
      learnings: params.learnings ?? [],
    };

    await this.guideStore.append(toRawGuide(guide));
    this.cache.set(guide.id, guide);
    this.semanticSearch.upsertGuide(guide);

    logger.debug("Added guide", { id: guide.id, name: guide.name });
    return guide;
  }

  /**
   * Update a guide.
   */
  async update(params: GuideUpdateParams): Promise<Guide | null> {
    let updated: RawGuide | null = null;

    await this.guideStore.update(
      (g) => g.id === params.id,
      (g) => {
        const raw: RawGuide = {
          id: g.id,
          name: params.name ?? g.name,
          category: params.category ?? g.category,
          description: params.description ?? g.description,
          created: g.created,
          lastUsed: g.lastUsed,
          usageCount: g.usageCount,
          contexts: [...g.contexts],
          learnings: [...g.learnings],
        };

        updated = raw;
        return raw;
      }
    );

    if (updated) {
      this.cache.delete(params.id);
      const guide = toGuide(updated);
      this.cache.set(guide.id, guide);
      this.semanticSearch.upsertGuide(guide);
      logger.debug("Updated guide", { id: params.id });
      return guide;
    }

    return null;
  }

  /**
   * Delete a guide by ID or name.
   */
  async delete(identifier: string): Promise<boolean> {
    // Check if guide exists
    const guide = await this.get(identifier);
    if (!guide) {
      return false;
    }

    await this.guideStore.delete((g) => g.id === identifier || g.name === identifier);
    this.cache.delete(identifier);
    this.semanticSearch.removeGuide(guide.id);
    logger.debug("Deleted guide", { identifier });

    return true;
  }

  /**
   * Get a guide by ID.
   */
  async getById(id: string): Promise<Guide | null> {
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }

    const guides = await this.listGuides();
    const guide = guides.find((g) => g.id === id);

    if (guide) {
      this.cache.set(guide.id, guide);
    }

    return guide ?? null;
  }

  /**
   * Get a guide by name.
   */
  async getByName(name: string): Promise<Guide | null> {
    // Check cache first
    for (const guide of this.cache.values()) {
      if (guide.name === name) {
        return guide;
      }
    }

    const guides = await this.listGuides();
    const guide = guides.find((g) => g.name === name);

    if (guide) {
      this.cache.set(guide.id, guide);
    }

    return guide ?? null;
  }

  /**
   * Get a guide by ID or name.
   */
  async get(identifier: string): Promise<Guide | null> {
    let guide = await this.getById(identifier);
    if (!guide) {
      guide = await this.getByName(identifier);
    }
    return guide;
  }

  /**
   * List all guides with optional filtering.
   */
  async listGuides(options?: {
    category?: GuideCategory;
    sortBy?: "name" | "usage" | "recent";
    limit?: number;
  }): Promise<Guide[]> {
    const raw = await this.guideStore.readAll();
    let guides = raw.map(toGuide);

    if (options?.category) {
      guides = guides.filter((g) => g.category === options.category);
    }

    // Sort
    switch (options?.sortBy) {
      case "name":
        guides.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "usage":
        guides.sort((a, b) => b.usageCount - a.usageCount);
        break;
      case "recent":
        guides.sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime());
        break;
      default:
        // Sort by usage then recent
        guides.sort((a, b) => {
          if (b.usageCount !== a.usageCount) {
            return b.usageCount - a.usageCount;
          }
          return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
        });
    }

    if (options?.limit) {
      guides = guides.slice(0, options.limit);
    }

    return guides;
  }

  /**
   * Record guide usage (practice).
   */
  async practice(params: GuidePracticeParams): Promise<Guide> {
    const guide = await this.get(params.guide);

    if (!guide) {
      // Create new guide if it doesn't exist
      return this.add({
        name: params.guide,
        category: params.category,
        description: params.description ?? "",
        contexts: params.contexts,
        learnings: params.learnings,
      });
    }

    // Update usage stats
    const now = new Date().toISOString();
    const mergedContexts = this.mergeUnique(guide.contexts, params.contexts);
    const mergedLearnings = this.mergeUnique(guide.learnings, params.learnings);

    await this.guideStore.update(
      (g) => g.id === guide.id,
      (g) => {
        g.lastUsed = now;
        g.usageCount++;
        g.contexts = [...mergedContexts];
        g.learnings = [...mergedLearnings];
        return g;
      }
    );

    // Update cache
    const updated: Guide = {
      ...guide,
      lastUsed: now,
      usageCount: guide.usageCount + 1,
      contexts: mergedContexts,
      learnings: mergedLearnings,
    };
    this.cache.set(guide.id, updated);
    this.semanticSearch.upsertGuide(updated);

    logger.debug("Practiced guide", { id: guide.id, usageCount: updated.usageCount });
    return updated;
  }

  /**
   * Suggest guides for a task.
   */
  async suggest(params: GuideSuggestParams): Promise<GuideSuggestion[]> {
    const guides = await this.listGuides();
    const results = this.semanticSearch.searchGuides(params.task, guides, params.limit ?? 5);

    return results.map((r) => ({
      guide: r.item,
      relevance: r.relevance,
      matchedContexts: r.matchedTerms,
    }));
  }

  /**
   * Distill a memory fragment into a guide learning.
   */
  async distill(
    params: GuideDistillParams,
    getFragment: (id: string) => Promise<MemoryFragment | null>
  ): Promise<Guide> {
    const fragment = await getFragment(params.memoryId);
    if (!fragment) {
      throw new Error(`Fragment not found: ${params.memoryId}`);
    }

    // Extract learning from fragment
    const learning = fragment.fragment;

    // Get or create guide
    let guide = await this.get(params.guide);
    if (!guide) {
      if (!params.category) {
        throw new Error("Category required when creating new guide");
      }
      guide = await this.add({
        name: params.guide,
        category: params.category,
        description: `Distilled from memory: ${fragment.title}`,
        learnings: [learning],
      });
    } else {
      // Add learning to existing guide
      const existingGuide = guide;
      const mergedLearnings = this.mergeUnique(existingGuide.learnings, [learning]);
      await this.guideStore.update(
        (g) => g.id === existingGuide.id,
        (g) => {
          g.learnings = [...mergedLearnings];
          return g;
        }
      );

      guide = {
        ...existingGuide,
        learnings: mergedLearnings,
      };
      this.cache.set(guide.id, guide);
      this.semanticSearch.upsertGuide(guide);
    }

    logger.debug("Distilled fragment into guide", {
      fragmentId: params.memoryId,
      guideId: guide.id,
    });
    return guide;
  }

  /**
   * Get guide statistics.
   */
  async getStats(): Promise<{
    totalGuides: number;
    byCategory: Readonly<Record<string, number>>;
    totalUsage: number;
    topGuides: readonly Guide[];
  }> {
    const guides = await this.listGuides();

    const byCategory: Record<string, number> = {};
    let totalUsage = 0;

    for (const g of guides) {
      byCategory[g.category] = (byCategory[g.category] ?? 0) + 1;
      totalUsage += g.usageCount;
    }

    const topGuides = guides.slice(0, 5);

    return {
      totalGuides: guides.length,
      byCategory,
      totalUsage,
      topGuides,
    };
  }

  /**
   * Merge arrays keeping only unique items.
   */
  private mergeUnique<T>(existing: readonly T[], newItems: readonly T[]): readonly T[] {
    const set = new Set(existing);
    for (const item of newItems) {
      set.add(item);
    }
    return Array.from(set);
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    return `guide_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Shutdown and cleanup.
   */
  async shutdown(): Promise<void> {
    this.cache.clear();
    this.storage.clearCache();

    // Delete storage directory if cleanup is enabled
    if (this.cleanup) {
      const { realpathSync } = await import("node:fs");
      const { rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");

      try {
        const resolvedPath = this.storage.basePath.startsWith("~")
          ? this.storage.basePath.replace("~", process.env.HOME ?? process.env.USERPROFILE ?? "")
          : this.storage.basePath;

        // Only delete if it's under temp directory to avoid accidents
        const tempDir = tmpdir();
        const realPath = realpathSync(resolvedPath);
        const realTempDir = realpathSync(tempDir);

        if (realPath.startsWith(realTempDir) || resolvedPath.includes("test-")) {
          rmSync(realPath, { recursive: true, force: true });
          logger.debug("Cleaned up test directory", { path: realPath });
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    logger.info("Guide manager shutdown complete");
  }
}

/**
 * Create a guide manager with default options.
 */
export async function createGuideManager(options?: GuideManagerOptions): Promise<GuideManager> {
  const manager = new GuideManager(options);
  await manager.initialize();
  return manager;
}
