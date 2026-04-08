/**
 * Context compression utilities.
 * Summarizes and deduplicates memory fragments to fit within token budgets.
 */

import type { MemoryFragment, Priority } from "../core/types.js";
import { estimateTokensAccurate } from "./tokens.js";

/**
 * Compression result with metrics.
 */
export interface CompressionResult {
  readonly compressed: MemoryFragment;
  readonly originalCount: number;
  readonly tokensSaved: number;
  readonly compressionRatio: number; // output / input (lower is better)
}

/**
 * Key point extraction result.
 */
export interface KeyPoints {
  readonly points: readonly string[];
  readonly totalTokens: number;
  readonly extractedTokens: number;
}

/**
 * Context compressor for summarizing and deduplicating fragments.
 */
export class ContextCompressor {
  /**
   * Compress multiple fragments into a single summary fragment.
   */
  compress(fragments: readonly MemoryFragment[]): CompressionResult {
    if (fragments.length === 0) {
      throw new Error("Cannot compress empty fragment list");
    }

    if (fragments.length === 1) {
      return {
        compressed: fragments[0]!,
        originalCount: 1,
        tokensSaved: 0,
        compressionRatio: 1,
      };
    }

    const originalTokens = estimateTokensAccurate(fragments.map((f) => f.fragment).join("\n\n"));

    // Extract key points from all fragments
    const keyPoints = this.extractKeyPointsFromFragments(fragments);

    // Create a summary
    const summary = this.createSummary(fragments, keyPoints);

    const compressedTokens = estimateTokensAccurate(summary.fragment);
    const compressionRatio = compressedTokens / originalTokens;

    return {
      compressed: summary,
      originalCount: fragments.length,
      tokensSaved: originalTokens - compressedTokens,
      compressionRatio,
    };
  }

  /**
   * Extract key points from long content.
   * Enhanced with position-aware scoring and better compression ratio.
   */
  extractKeyPoints(content: string, maxTokens: number): string {
    if (maxTokens <= 0) {
      return "";
    }

    const contentTokens = estimateTokensAccurate(content);
    if (contentTokens <= maxTokens) {
      return content;
    }

    // Split into paragraphs/sentences
    const sentences = this.splitIntoSentences(content);

    // Score sentences by importance with position awareness
    const scored = sentences.map((sentence, index) => ({
      sentence,
      score: this.scoreSentence(sentence, index, sentences.length),
      originalIndex: index,
    }));

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    // Take top sentences within budget
    const selected: Array<{ sentence: string; originalIndex: number }> = [];
    let currentTokens = 0;

    for (const { sentence, originalIndex } of scored) {
      const sentenceTokens = estimateTokensAccurate(sentence);
      if (currentTokens + sentenceTokens <= maxTokens) {
        selected.push({ sentence, originalIndex });
        currentTokens += sentenceTokens;
      }
      if (currentTokens >= maxTokens) {
        break;
      }
    }

    // Reorder to original flow for coherence
    selected.sort((a, b) => a.originalIndex - b.originalIndex);
    const result = selected.map((s) => s.sentence).join(" ");

    return result;
  }

  /**
   * Extract key points from multiple fragments.
   */
  private extractKeyPointsFromFragments(fragments: readonly MemoryFragment[]): string[] {
    const points: string[] = [];

    for (const fragment of fragments) {
      // Add description if available
      if (fragment.description) {
        points.push(`[${fragment.title || "Untitled"}] ${fragment.description}`);
      }

      // Extract key points from fragment content
      const contentPoints = this.extractBulletPoints(fragment.fragment);
      points.push(...contentPoints);

      // If no bullet points, extract first sentence
      if (contentPoints.length === 0) {
        const firstSentence = this.extractFirstSentence(fragment.fragment);
        if (firstSentence) {
          points.push(firstSentence);
        }
      }
    }

    return this.deduplicatePoints(points);
  }

  /**
   * Create a summary fragment from compressed content.
   * Enhanced with better title generation.
   */
  private createSummary(
    fragments: readonly MemoryFragment[],
    keyPoints: readonly string[]
  ): MemoryFragment {
    // Determine combined project scope
    const projects = new Set<string>();
    const allTags = new Set<string>();
    for (const f of fragments) {
      if (f.project) {
        projects.add(f.project);
      }
      for (const tag of f.tags) {
        allTags.add(tag);
      }
    }

    // Generate a descriptive title based on content themes
    const title = this.generateDescriptiveTitle(fragments, keyPoints);

    const summaryFragment: MemoryFragment = {
      id: this.generateId(),
      title,
      description: `Compressed ${fragments.length} fragments (${this.getThemeDescription(fragments)})`,
      fragment: keyPoints.join("\n"),
      project: projects.size === 1 ? Array.from(projects)[0]! : null,
      priority: this.highestPriority(fragments) as Priority,
      confidence: this.averageConfidence(fragments),
      source: "ai",
      created: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessed: 0,
      inherits: [],
      estimatedTokens: estimateTokensAccurate(keyPoints.join("\n")),
      tags: ["compressed", ...Array.from(allTags).slice(0, 3)],
    };

    return summaryFragment;
  }

  /**
   * Generate a descriptive title based on fragment themes.
   */
  private generateDescriptiveTitle(fragments: readonly MemoryFragment[], _keyPoints: readonly string[]): string {
    // Extract common themes from fragment titles
    const titleWords = new Map<string, number>();
    for (const f of fragments) {
      const words = f.title.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length > 3 && !this.isStopWord(word)) {
          titleWords.set(word, (titleWords.get(word) ?? 0) + 1);
        }
      }
    }

    // Get top theme words
    const themes = [...titleWords.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((e) => e[0])
      .filter(Boolean);

    // Build title
    if (themes.length >= 2) {
      const themeStr = themes.slice(0, 2).join(", ");
      return `Compressed: ${themeStr} (${fragments.length} items)`;
    }

    // Fallback to first fragment's title theme
    const firstTitle = fragments[0]?.title ?? "Memory";
    return `Compressed: ${firstTitle.split(/:|-/)[0] ?? firstTitle} (+${fragments.length - 1})`;
  }

  /**
   * Get a brief description of the themes across fragments.
   */
  private getThemeDescription(fragments: readonly MemoryFragment[]): string {
    const domains = new Set<string>();
    for (const f of fragments) {
      if (f.project) {
        domains.add(f.project);
      }
    }
    if (domains.size > 0) {
      return Array.from(domains).slice(0, 2).join(", ");
    }
    return "related topics";
  }

  /**
   * Check if a word is a stop word.
   */
  private isStopWord(word: string): boolean {
    const stops = new Set([
      "the", "a", "an", "and", "or", "but", "for", "with", "from", "this", "that",
      "fragment", "memory", "item", "note", "info", "data", "text", "content",
    ]);
    return stops.has(word);
  }

  /**
   * Deduplicate similar key points.
   */
  private deduplicatePoints(points: readonly string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const point of points) {
      // Normalize for comparison
      const normalized = point.toLowerCase().trim().replace(/\s+/g, " ");

      // Check for near-duplicates using simple similarity
      let isDuplicate = false;
      for (const existing of seen) {
        if (this.similarity(normalized, existing) > 0.85) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        seen.add(normalized);
        unique.push(point);
      }
    }

    return unique;
  }

  /**
   * Calculate string similarity (Jaccard-like).
   */
  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));

    if (wordsA.size === 0 && wordsB.size === 0) {
      return 1;
    }

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Split text into sentences.
   */
  private splitIntoSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Score a sentence by importance.
   * Enhanced with position bias and better feature detection.
   */
  private scoreSentence(sentence: string, position: number, totalSentences: number): number {
    let score = 1;

    // Position bias: first and last sentences are often more important
    const relativePos = position / Math.max(totalSentences - 1, 1);
    if (relativePos < 0.1 || relativePos > 0.9) {
      score += 0.5;
    }

    // Sentence length optimization (not too short, not too long)
    const length = sentence.length;
    if (length > 20 && length < 150) {
      score += 0.3;
    }

    // Sentences with keywords are important
    const keywords = [
      "important", "critical", "key", "main", "essential", "must", "should",
      "note", "remember", "because", "therefore", "thus", "however", "additionally",
      "furthermore", "consequently", "specifically", "particularly", "especially",
      "primary", "secondary", "final", "conclusion", "summary", "result",
    ];
    const lower = sentence.toLowerCase();
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        score += 0.4;
      }
    }

    // Numbers and specific details are valuable
    if (/\d+/.test(sentence)) {
      score += 0.4;
    }

    // Code/technical indicators
    if (/[{}()[\]<>]/.test(sentence) || /function|class|const|let|var|import|export/.test(lower)) {
      score += 0.6;
    }

    // Bullet points are usually important
    if (sentence.startsWith("•") || sentence.startsWith("-") || sentence.startsWith("*")) {
      score += 0.7;
    }

    // Contains quotes (often important values or messages)
    if (/"[^"]*"|`[^`]*`/.test(sentence)) {
      score += 0.3;
    }

    // Avoid transition-only sentences
    const transitionPhrases = [
      "now let", "next we", "moving on", "as mentioned", "as shown above",
      "in conclusion", "to summarize", "finally", "in summary",
    ];
    for (const phrase of transitionPhrases) {
      if (lower.startsWith(phrase)) {
        score -= 0.5;
        break;
      }
    }

    return Math.max(score, 0);
  }

  /**
   * Extract bullet points from text.
   */
  private extractBulletPoints(text: string): string[] {
    const lines = text.split("\n");
    const bullets: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("•") ||
        trimmed.startsWith("-") ||
        trimmed.startsWith("*") ||
        /^\d+\./.test(trimmed)
      ) {
        bullets.push(trimmed);
      }
    }

    return bullets;
  }

  /**
   * Extract the first sentence from text.
   */
  private extractFirstSentence(text: string): string {
    const match = text.match(/^.+?[.!?]/);
    return match ? match[0]!.trim() : text.slice(0, 100);
  }

  /**
   * Get the highest priority from a list of fragments.
   */
  private highestPriority(fragments: readonly MemoryFragment[]): string {
    const priorityOrder = ["critical", "high", "normal", "low"];

    for (const level of priorityOrder) {
      if (fragments.some((f) => f.priority === level)) {
        return level;
      }
    }

    return "normal";
  }

  /**
   * Calculate average confidence.
   */
  private averageConfidence(fragments: readonly MemoryFragment[]): number {
    if (fragments.length === 0) {
      return 0.5;
    }

    const sum = fragments.reduce((acc, f) => acc + f.confidence, 0);
    return sum / fragments.length;
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    return `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Deduplicate overlapping fragments.
   */
  deduplicate(fragments: readonly MemoryFragment[]): MemoryFragment[] {
    if (fragments.length <= 1) {
      return [...fragments];
    }

    const unique: MemoryFragment[] = [];
    const seenContent = new Set<string>();

    for (const fragment of fragments) {
      // Check for duplicate content
      const contentHash = this.hashContent(fragment.fragment);

      if (!seenContent.has(contentHash)) {
        seenContent.add(contentHash);
        unique.push(fragment);
      } else {
        // For duplicates, we just skip them (merging readonly props is complex)
        // The first occurrence wins
      }
    }

    return unique;
  }

  /**
   * Create a simple content hash for deduplication.
   */
  private hashContent(content: string): string {
    // Simple normalization for comparison
    return content
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "")
      .trim();
  }
}

/**
 * Default compressor instance.
 */
export const defaultCompressor = new ContextCompressor();
