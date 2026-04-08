/**
 * Priority-based context management.
 * Scores and prioritizes memory fragments for intelligent context selection.
 */

import { createLogger } from "../utils/logging.js";
import type { SemanticSearch } from "./semantic.js";
import { tokenize } from "./semantic.js";
import type { MemoryFragment, Priority, ScoringFactors } from "./types.js";
import { DEFAULT_SCORING_FACTORS } from "./types.js";

const logger = createLogger("prioritization");

/**
 * Priority score values.
 */
const PRIORITY_VALUES: Record<Priority, number> = {
  critical: 10,
  high: 5,
  normal: 1,
  low: 0.5,
} as const;

/**
 * Fragment score with metadata.
 */
export interface FragmentScore {
  readonly fragment: MemoryFragment;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

/**
 * Score breakdown for debugging.
 */
export interface ScoreBreakdown {
  readonly confidence: number;
  readonly priority: number;
  readonly recency: number;
  readonly relevance: number;
  readonly accessFrequency: number;
  readonly total: number;
}

/**
 * Prioritizer for scoring and ranking fragments.
 */
export class Prioritizer {
  readonly factors: ScoringFactors;
  private readonly criticalIds: Set<string>;
  private readonly semanticSearch: SemanticSearch | null;

  constructor(factors: Partial<ScoringFactors> = {}, semanticSearch?: SemanticSearch) {
    this.factors = { ...DEFAULT_SCORING_FACTORS, ...factors };
    this.criticalIds = new Set();
    this.semanticSearch = semanticSearch ?? null;
  }

  /**
   * Mark fragment IDs as always-critical.
   */
  markCritical(fragmentIds: readonly string[]): void {
    for (const id of fragmentIds) {
      this.criticalIds.add(id);
    }
    logger.debug(`Marked ${fragmentIds.length} fragments as critical`);
  }

  /**
   * Remove critical status from fragment IDs.
   */
  unmarkCritical(fragmentIds: readonly string[]): void {
    for (const id of fragmentIds) {
      this.criticalIds.delete(id);
    }
  }

  /**
   * Check if a fragment is critical.
   */
  isCritical(fragment: MemoryFragment): boolean {
    return this.criticalIds.has(fragment.id) || fragment.priority === "critical";
  }

  /**
   * Calculate score for a fragment.
   */
  calculateScore(fragment: MemoryFragment, query?: string): FragmentScore {
    // Critical fragments always get max score
    if (this.isCritical(fragment)) {
      return {
        fragment,
        score: Number.MAX_VALUE,
        breakdown: {
          confidence: 1,
          priority: PRIORITY_VALUES.critical,
          recency: 1,
          relevance: 1,
          accessFrequency: 1,
          total: Number.MAX_VALUE,
        },
      };
    }

    const confidence = this.applyConfidenceDecay(fragment);
    const priority = PRIORITY_VALUES[fragment.priority] ?? 1;
    const recency = this.calculateRecency(fragment);
    const relevance = query ? this.calculateRelevance(fragment, query) : 0.5;
    const accessFrequency = this.calculateAccessFrequency(fragment);

    // Weighted sum
    const total =
      confidence * this.factors.confidenceWeight +
      priority * this.factors.priorityWeight +
      recency * this.factors.recencyWeight +
      relevance * this.factors.relevanceWeight +
      accessFrequency * this.factors.accessFrequencyWeight;

    return {
      fragment,
      score: total,
      breakdown: {
        confidence,
        priority,
        recency,
        relevance,
        accessFrequency,
        total,
      },
    };
  }

  /**
   * Apply confidence decay based on age since last access.
   * Fragments not accessed in 30+ days lose confidence gradually.
   */
  private applyConfidenceDecay(fragment: MemoryFragment): number {
    const ageDays = (Date.now() - new Date(fragment.lastAccessed).getTime()) / 86400000;

    if (ageDays < 30) return fragment.confidence;

    // Start decaying after 30 days of no access
    const decayDays = ageDays - 30;
    const decayFactor = Math.exp(-decayDays / 90); // Half-life of 90 days after initial grace period
    return Math.max(fragment.confidence * decayFactor, 0.05); // Floor at 0.05
  }

  /**
   * Calculate recency score (exponential decay).
   * Returns 1 for very recent, approaching 0 for old.
   * Uses faster decay for low-priority fragments (simulates forgetting).
   */
  private calculateRecency(fragment: MemoryFragment): number {
    const now = Date.now();
    const accessed = new Date(fragment.lastAccessed).getTime();
    const ageHours = (now - accessed) / (1000 * 60 * 60);

    // Lower priority fragments decay faster (forgetting curve)
    const halfLife = fragment.priority === "low" ? 72 : fragment.priority === "normal" ? 48 : 24;
    return Math.pow(0.5, ageHours / halfLife);
  }

  /**
   * Calculate relevance score for a query.
   * Uses semantic search if available, otherwise falls back to lexical matching.
   */
  private calculateRelevance(fragment: MemoryFragment, query: string): number {
    if (!query) {
      return 0.5;
    }

    // Try semantic search first (uses TF-IDF + cosine similarity)
    if (this.semanticSearch) {
      const results = this.semanticSearch.searchFragments(query, [fragment], 1);
      if (results.length > 0) {
        // Semantic relevance (0-1)
        return Math.min(results[0]!.relevance * 2, 1); // Boost to 0-1 range
      }
    }

    // Fallback to lexical matching
    return this.calculateLexicalRelevance(fragment, query);
  }

  /**
   * Calculate lexical relevance using fuzzy matching.
   */
  private calculateLexicalRelevance(fragment: MemoryFragment, query: string): number {
    const queryLower = query.toLowerCase();

    // Check title match
    if (fragment.title.toLowerCase().includes(queryLower)) {
      return 1;
    }

    // Check description match
    if (fragment.description.toLowerCase().includes(queryLower)) {
      return 0.9;
    }

    // Check tags
    for (const tag of fragment.tags) {
      if (tag.toLowerCase().includes(queryLower)) {
        return 0.95;
      }
    }

    // Check content match
    if (fragment.fragment.toLowerCase().includes(queryLower)) {
      return 0.7;
    }

    // Fuzzy word match using tokenization
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) {
      return 0;
    }

    const text = `${fragment.title} ${fragment.description} ${fragment.fragment}`;
    const textTokens = new Set(tokenize(text));

    const intersection = new Set([...queryTokens].filter((x) => textTokens.has(x)));
    if (intersection.size > 0) {
      return intersection.size / queryTokens.size;
    }

    return 0;
  }

  /**
   * Calculate access frequency score.
   */
  private calculateAccessFrequency(fragment: MemoryFragment): number {
    // Normalize by log to avoid extreme values
    return Math.log1p(fragment.accessed) / 10;
  }

  /**
   * Sort fragments by score (descending).
   */
  sortByScore(fragments: readonly MemoryFragment[], query?: string): FragmentScore[] {
    const scored = fragments.map((f) => this.calculateScore(f, query));
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Auto-prioritize fragments based on access patterns.
   */
  autoPrioritize(fragments: MemoryFragment[]): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Calculate access statistics
    const stats = new Map<string, { count: number; avgAge: number }>();

    for (const fragment of fragments) {
      const age = now - new Date(fragment.lastAccessed).getTime();
      const ageDays = age / dayMs;

      if (fragment.project) {
        let stat = stats.get(fragment.project);
        if (!stat) {
          stat = { count: 0, avgAge: 0 };
          stats.set(fragment.project, stat);
        }
        stat.count++;
        stat.avgAge = (stat.avgAge * (stat.count - 1) + ageDays) / stat.count;
      }
    }

    // Auto-promote frequently accessed items
    for (const fragment of fragments) {
      void fragment.project; // Used for stats calculation

      // High access rate promotion
      if (fragment.accessed >= 10 && fragment.priority === "normal") {
        (fragment as { priority: Priority }).priority = "high" as Priority;
        logger.debug(`Auto-promoted fragment ${fragment.id} to high priority`);
      }

      // Very high access rate promotion
      if (fragment.accessed >= 50) {
        (fragment as { priority: Priority }).priority = "critical" as Priority;
        logger.debug(`Auto-promoted fragment ${fragment.id} to critical priority`);
      }

      // Stale low-priority demotion
      if (
        fragment.priority === "high" &&
        fragment.accessed < 3 &&
        now - new Date(fragment.lastAccessed).getTime() > 30 * dayMs
      ) {
        (fragment as { priority: Priority }).priority = "normal" as Priority;
        logger.debug(`Auto-demoted fragment ${fragment.id} from high to normal`);
      }
    }
  }

  /**
   * Get top N fragments by score.
   */
  topN(fragments: readonly MemoryFragment[], n: number, query?: string): MemoryFragment[] {
    const scored = this.sortByScore(fragments, query);
    return scored.slice(0, n).map((s) => s.fragment);
  }

  /**
   * Filter fragments by priority.
   */
  filterByPriority(
    fragments: readonly MemoryFragment[],
    priorities: readonly Priority[]
  ): MemoryFragment[] {
    const prioritySet = new Set(priorities);
    return fragments.filter((f) => prioritySet.has(f.priority));
  }

  /**
   * Get priority order for iteration.
   */
  getPriorityOrder(): readonly string[] {
    return ["critical", "high", "normal", "low"] as const;
  }

  /**
   * Group fragments by priority.
   */
  groupByPriority(
    fragments: readonly MemoryFragment[]
  ): Readonly<Record<string, MemoryFragment[]>> {
    const groups: Record<string, MemoryFragment[]> = {
      critical: [],
      high: [],
      normal: [],
      low: [],
    };

    for (const fragment of fragments) {
      const group = groups[fragment.priority as keyof typeof groups];
      if (group) {
        group.push(fragment);
      }
    }

    return groups;
  }
}

/**
 * Default prioritizer instance.
 */
export const defaultPrioritizer = new Prioritizer();
