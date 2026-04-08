/**
 * Token-aware context selection.
 * Dynamically selects context fragments based on available token budget.
 */

import { defaultCompressor } from "../utils/compression.js";
import { createLogger } from "../utils/logging.js";
import { createTokenBudget, estimateTokensAccurate } from "../utils/tokens.js";
import { Prioritizer } from "./prioritization.js";
import type {
  ContextRequest,
  MemoryFragment,
  Priority,
  SelectionMetadata,
  SelectionResult,
} from "./types.js";

const logger = createLogger("context");

/**
 * Context selector for token-aware fragment selection.
 */
export class ContextSelector {
  readonly prioritizer: Prioritizer;
  readonly defaultTokenBudget: number;

  constructor(prioritizer: Prioritizer = new Prioritizer(), defaultTokenBudget = 8000) {
    this.prioritizer = prioritizer;
    this.defaultTokenBudget = defaultTokenBudget;
  }

  /**
   * Select fragments based on context request and token budget.
   */
  select(fragments: readonly MemoryFragment[], request: ContextRequest): SelectionResult {
    const tokenBudget = request.tokenBudget ?? this.defaultTokenBudget;
    const budget = createTokenBudget(tokenBudget);

    logger.debug("Selecting context", {
      availableFragments: fragments.length,
      tokenBudget,
      project: request.project,
      query: request.query,
    });

    // Filter fragments
    let filtered = this.filterFragments(fragments, request);
    logger.debug("After filtering", { count: filtered.length });

    // Sort by priority then score
    filtered = this.sortByPriorityThenScore(filtered, request.query);
    logger.debug("After sorting", { topPriorities: this.countByPriority(filtered.slice(0, 10)) });

    // Select within budget
    const { selected, dropped, metadata } = this.selectWithinBudget(filtered, budget);

    // Update access times
    this.updateAccessTimes(selected);

    const totalTokens = this.calculateTotalTokens(selected);
    const remainingBudget = Math.max(budget.total - totalTokens, 0);

    logger.debug("Selection complete", {
      selected: selected.length,
      dropped: dropped.length,
      totalTokens,
      remainingBudget,
    });

    return {
      fragments: selected,
      totalTokens,
      droppedCount: dropped.length,
      remainingBudget,
      compressionApplied: false,
      metadata,
    };
  }

  /**
   * Select fragments with compression if needed.
   */
  selectWithCompression(
    fragments: readonly MemoryFragment[],
    request: ContextRequest
  ): SelectionResult {
    // First try normal selection
    let result = this.select(fragments, request);

    // If we dropped many fragments and have low priority items, try compression
    if (result.droppedCount > 0) {
      const droppedLow = this.select(fragments, {
        ...request,
        priorities: ["critical", "high", "normal"] as readonly Priority[],
      });

      if (droppedLow.droppedCount < result.droppedCount) {
        // Compress the remaining low-priority fragments
        const lowPriorityFragments = fragments.filter(
          (f) => f.priority === "low" || f.priority === "normal"
        );

        if (lowPriorityFragments.length > 1) {
          const compression = defaultCompressor.compress(lowPriorityFragments);
          const compressedFragments = [...droppedLow.fragments, compression.compressed];

          result = {
            fragments: compressedFragments,
            totalTokens: this.calculateTotalTokens(compressedFragments),
            droppedCount: 0,
            remainingBudget: 0,
            compressionApplied: true,
            metadata: droppedLow.metadata,
          };

          logger.debug("Applied compression", {
            originalCount: lowPriorityFragments.length,
            tokensSaved: compression.tokensSaved,
          });
        }
      }
    }

    return result;
  }

  /**
   * Filter fragments based on request criteria.
   */
  private filterFragments(
    fragments: readonly MemoryFragment[],
    request: ContextRequest
  ): MemoryFragment[] {
    let filtered = [...fragments];

    // Filter by project
    if (request.project) {
      const project = request.project;
      filtered = filtered.filter((f) => {
        // Direct project match
        if (f.project === project) {
          return true;
        }

        // Include inherited projects if requested
        if (request.includeInherited && f.inherits.includes(project)) {
          return true;
        }

        // Include global if requested
        if (request.includeGlobal && f.project === null) {
          return true;
        }

        return false;
      });
    } else if (request.includeGlobal === false) {
      // Exclude global (project-specific only)
      filtered = filtered.filter((f) => f.project !== null);
    }

    // Filter by priority
    if (request.priorities && request.priorities.length > 0) {
      const prioritySet = new Set(request.priorities);
      filtered = filtered.filter((f) => prioritySet.has(f.priority));
    }

    // Query-based relevance filtering
    if (request.query) {
      // Only filter out very low relevance, keep rest for scoring
      const scored = filtered.map((f) => ({
        fragment: f,
        relevance: this.prioritizer.calculateScore(f, request.query).score,
      }));

      // Keep top 75% by relevance
      scored.sort((a, b) => b.relevance - a.relevance);
      const keepCount = Math.max(Math.floor(scored.length * 0.75), 10);
      filtered = scored.slice(0, keepCount).map((s) => s.fragment);
    }

    return filtered;
  }

  /**
   * Sort by priority first, then score within priority groups.
   */
  private sortByPriorityThenScore(
    fragments: readonly MemoryFragment[],
    query?: string
  ): MemoryFragment[] {
    const priorityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    return [...fragments].sort((a, b) => {
      // First by priority
      const aPriority = priorityOrder[a.priority] ?? 99;
      const bPriority = priorityOrder[b.priority] ?? 99;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // Then by score within same priority
      const aScore = this.prioritizer.calculateScore(a, query).score;
      const bScore = this.prioritizer.calculateScore(b, query).score;

      return bScore - aScore;
    });
  }

  /**
   * Select fragments within token budget.
   * Priority multipliers: critical=free, high=50% cost, normal=100%, low=200% cost.
   */
  private selectWithinBudget(
    fragments: readonly MemoryFragment[],
    budget: ReturnType<typeof createTokenBudget>
  ): {
    selected: MemoryFragment[];
    dropped: MemoryFragment[];
    metadata: SelectionMetadata[];
  } {
    const selected: MemoryFragment[] = [];
    const dropped: MemoryFragment[] = [];
    const metadata: SelectionMetadata[] = [];

    let usedTokens = 0;

    for (const fragment of fragments) {
      const score = this.prioritizer.calculateScore(fragment);
      const fragmentTokens = fragment.estimatedTokens ?? estimateTokensAccurate(fragment.fragment);

      // Critical fragments are always included, high get 50% discount, low cost 200%
      const isCritical = this.prioritizer.isCritical(fragment);
      const effectiveCost = isCritical
        ? 0
        : fragment.priority === "high"
          ? Math.ceil(fragmentTokens * 0.5)
          : fragment.priority === "low"
            ? Math.ceil(fragmentTokens * 2)
            : fragmentTokens;

      if (usedTokens + effectiveCost <= budget.total || isCritical) {
        selected.push(fragment);
        usedTokens += fragmentTokens;
        metadata.push({
          fragmentId: fragment.id,
          score: score.score,
          tokens: fragmentTokens,
          isCompressed: false,
        });
      } else {
        dropped.push(fragment);
        metadata.push({
          fragmentId: fragment.id,
          score: score.score,
          tokens: fragmentTokens,
          isCompressed: false,
        });
      }

      // Stop if budget exhausted (except for critical)
      if (usedTokens >= budget.total && !isCritical) {
        break;
      }
    }

    return { selected, dropped, metadata };
  }

  /**
   * Calculate total tokens for selected fragments.
   */
  private calculateTotalTokens(fragments: readonly MemoryFragment[]): number {
    return fragments.reduce((sum, f) => {
      return sum + (f.estimatedTokens ?? estimateTokensAccurate(f.fragment));
    }, 0);
  }

  /**
   * Update access times for selected fragments.
   */
  private updateAccessTimes(fragments: readonly MemoryFragment[]): void {
    const now = new Date().toISOString();
    for (const fragment of fragments) {
      (fragment as { lastAccessed: string; accessed: number }).lastAccessed = now;
      fragment.accessed++;
    }
  }

  /**
   * Count fragments by priority level.
   */
  private countByPriority(
    fragments: readonly MemoryFragment[]
  ): Readonly<Record<Priority, number>> {
    const counts = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
    };

    for (const f of fragments) {
      counts[f.priority]++;
    }

    return counts;
  }

  /**
   * Get fragments for a streaming response.
   * Yields fragments in priority order with cumulative token counts.
   */
  async *streamInPriorityOrder(
    fragments: readonly MemoryFragment[],
    tokenBudget: number
  ): AsyncGenerator<{ fragment: MemoryFragment; cumulativeTokens: number }> {
    const sorted = this.sortByPriorityThenScore(fragments);
    let cumulative = 0;

    for (const fragment of sorted) {
      const tokens = fragment.estimatedTokens ?? estimateTokensAccurate(fragment.fragment);

      if (cumulative + tokens > tokenBudget) {
        break;
      }

      cumulative += tokens;
      yield { fragment, cumulativeTokens: cumulative };
    }
  }

  /**
   * Estimate if fragments will fit in budget.
   */
  willFit(fragments: readonly MemoryFragment[], tokenBudget: number): boolean {
    const total = this.calculateTotalTokens(fragments);
    return total <= tokenBudget;
  }

  /**
   * Get effective token budget after accounting for critical fragments.
   */
  getEffectiveBudget(fragments: readonly MemoryFragment[], tokenBudget: number): number {
    const criticalTokens = fragments
      .filter((f) => this.prioritizer.isCritical(f))
      .reduce((sum, f) => sum + (f.estimatedTokens ?? estimateTokensAccurate(f.fragment)), 0);

    return Math.max(tokenBudget - criticalTokens, 0);
  }
}

/**
 * Default context selector instance.
 */
export const defaultSelector = new ContextSelector();
