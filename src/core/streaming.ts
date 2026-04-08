/**
 * Streaming context response.
 * Streams fragments in priority order with token budget tracking.
 */

import { estimateTokensAccurate } from "../utils/tokens.js";
import type { MemoryFragment, Priority, StreamChunk } from "./types.js";

/**
 * Priority order for streaming (highest first).
 */
const PRIORITY_ORDER: readonly ("critical" | "high" | "normal" | "low")[] = [
  "critical",
  "high",
  "normal",
  "low",
] as const;

/**
 * Context stream for priority-ordered fragment delivery.
 */
export class ContextStream {
  /**
   * Stream fragments in priority order.
   */
  async *streamInPriorityOrder(
    fragments: readonly MemoryFragment[],
    tokenBudget: number
  ): AsyncGenerator<StreamChunk> {
    // Sort by priority then score
    const sorted = this.sortByPriority(fragments);

    let cumulativeTokens = 0;

    for (const fragment of sorted) {
      const tokens = fragment.estimatedTokens ?? estimateTokensAccurate(fragment.fragment);
      const newCumulative = cumulativeTokens + tokens;

      // Check if we should continue
      const shouldContinue = newCumulative <= tokenBudget;

      yield {
        fragment,
        tokens,
        cumulativeTokens: newCumulative,
        isComplete: true,
        shouldContinue,
      };

      cumulativeTokens = newCumulative;

      // Stop if budget exceeded
      if (!shouldContinue) {
        break;
      }
    }
  }

  /**
   * Stream fragments with partial content for long fragments.
   */
  async *streamWithChunks(
    fragments: readonly MemoryFragment[],
    tokenBudget: number,
    _chunkSize = 500
  ): AsyncGenerator<StreamChunk> {
    const sorted = this.sortByPriority(fragments);
    let cumulativeTokens = 0;

    for (const fragment of sorted) {
      const totalTokens = fragment.estimatedTokens ?? estimateTokensAccurate(fragment.fragment);

      // Check if fragment fits
      if (cumulativeTokens + totalTokens > tokenBudget) {
        // Create a partial fragment
        const remainingTokens = tokenBudget - cumulativeTokens;
        if (remainingTokens <= 0) {
          break;
        }

        const partialContent = this.createPartialFragment(fragment, remainingTokens);
        yield {
          fragment: partialContent,
          tokens: remainingTokens,
          cumulativeTokens: cumulativeTokens + remainingTokens,
          isComplete: false,
          shouldContinue: false,
        };
        break;
      }

      // Full fragment fits
      yield {
        fragment,
        tokens: totalTokens,
        cumulativeTokens: cumulativeTokens + totalTokens,
        isComplete: true,
        shouldContinue: true,
      };

      cumulativeTokens += totalTokens;
    }
  }

  /**
   * Stream fragments with compression for low-priority items.
   */
  async *streamWithCompression(
    fragments: readonly MemoryFragment[],
    tokenBudget: number,
    compressBelow: Priority = "normal" as Priority
  ): AsyncGenerator<StreamChunk> {
    const sorted = this.sortByPriority(fragments);
    let cumulativeTokens = 0;
    const compressed: MemoryFragment[] = [];

    for (const fragment of sorted) {
      const tokens = fragment.estimatedTokens ?? estimateTokensAccurate(fragment.fragment);

      // Low-priority fragments get buffered for compression
      if (PRIORITY_ORDER.indexOf(fragment.priority) >= PRIORITY_ORDER.indexOf(compressBelow)) {
        compressed.push(fragment);
        continue;
      }

      // High-priority fragments are streamed directly
      if (cumulativeTokens + tokens <= tokenBudget) {
        yield {
          fragment,
          tokens,
          cumulativeTokens: cumulativeTokens + tokens,
          isComplete: true,
          shouldContinue: true,
        };
        cumulativeTokens += tokens;
      } else {
        break;
      }
    }

    // Compress and yield buffered low-priority fragments if space remains
    if (compressed.length > 0 && cumulativeTokens < tokenBudget) {
      const compressedFragment = this.createCompressedFragment(compressed);
      const compressedTokens =
        compressedFragment.estimatedTokens ?? estimateTokensAccurate(compressedFragment.fragment);

      if (cumulativeTokens + compressedTokens <= tokenBudget) {
        yield {
          fragment: compressedFragment,
          tokens: compressedTokens,
          cumulativeTokens: cumulativeTokens + compressedTokens,
          isComplete: true,
          shouldContinue: false,
        };
      }
    }
  }

  /**
   * Sort fragments by priority.
   */
  private sortByPriority(fragments: readonly MemoryFragment[]): MemoryFragment[] {
    return [...fragments].sort((a, b) => {
      const aIndex = PRIORITY_ORDER.indexOf(a.priority);
      const bIndex = PRIORITY_ORDER.indexOf(b.priority);

      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }

      // Within same priority, sort by accessed (most recent first)
      return new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime();
    });
  }

  /**
   * Create a partial fragment with truncated content.
   */
  private createPartialFragment(fragment: MemoryFragment, maxTokens: number): MemoryFragment {
    const content = fragment.fragment;
    const targetChars = Math.min(maxTokens * 4, content.length);
    const truncated = content.slice(0, targetChars);

    return {
      ...fragment,
      fragment: truncated + "...",
      estimatedTokens: maxTokens,
    };
  }

  /**
   * Create a compressed fragment from multiple fragments.
   */
  private createCompressedFragment(fragments: readonly MemoryFragment[]): MemoryFragment {
    const summaries = fragments.map((f) => {
      const title = f.title || "Untitled";
      const desc = f.description || f.fragment.slice(0, 100);
      return `• [${title}] ${desc}${desc.length >= 100 ? "..." : ""}`;
    });

    return {
      id: `compressed_${Date.now()}`,
      title: `Compressed: ${fragments.length} fragments`,
      description: "Summary of low-priority fragments",
      fragment: summaries.join("\n"),
      project: fragments[0]?.project ?? null,
      priority: "low" as Priority,
      confidence: 0.5,
      source: "ai",
      created: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessed: 0,
      inherits: [],
      estimatedTokens: estimateTokensAccurate(summaries.join("\n")),
      tags: ["compressed"],
    };
  }

  /**
   * Format a chunk for output.
   */
  async *formatChunk(fragment: MemoryFragment): AsyncGenerator<string> {
    const separator = "---".repeat(20);
    yield `${separator}\n`;
    yield `## ${fragment.title}\n`;

    if (fragment.description) {
      yield `${fragment.description}\n`;
    }

    yield `${fragment.fragment}\n`;
    yield `${separator}\n`;
  }

  /**
   * Count fragments by priority level.
   */
  countByPriority(fragments: readonly MemoryFragment[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
    };

    for (const f of fragments) {
      const count = counts[f.priority];
      if (count !== undefined) {
        counts[f.priority] = count + 1;
      }
    }

    return counts;
  }
}

/**
 * Default context stream instance.
 */
export const defaultStream = new ContextStream();

/**
 * Stream helper for direct usage.
 */
export async function* streamContext(
  fragments: readonly MemoryFragment[],
  tokenBudget: number
): AsyncGenerator<StreamChunk> {
  yield* defaultStream.streamInPriorityOrder(fragments, tokenBudget);
}
