/**
 * Token estimation utilities.
 * Approximates token counts for text without actual tokenizer.
 */

/**
 * Simple token estimation: ~4 characters per token.
 * Fast but less accurate for code or heavily punctuated text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * More accurate token estimation considering words, punctuation, and special chars.
 * Closer to GPT-4/Claude tokenization.
 */
export function estimateTokensAccurate(text: string): number {
  if (!text) return 0;

  let tokens = 0;

  // Count words (separated by whitespace)
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  tokens += words.length;

  // Count punctuation marks as separate tokens
  const punctMatches = text.match(/[.,!?;:()\[\]{}"'`~@#$%^&*+=|\\/<>]/g);
  tokens += punctMatches?.length ?? 0;

  // Count numbers as tokens (each number is roughly 1 token)
  const numberMatches = text.match(/\b\d+(\.\d+)?\b/g);
  tokens += numberMatches?.length ?? 0;

  // Add overhead for markup/code (special characters count more)
  const markupMatches = text.match(/[<>&\[\](){}]/g);
  tokens += Math.ceil((markupMatches?.length ?? 0) / 2);

  return Math.max(tokens, Math.ceil(text.length / 4)); // At least the simple estimate
}

/**
 * Estimate tokens for multiple fragments.
 */
export function estimateTokensForFragments(
  fragments: readonly { fragment: string; estimatedTokens?: number }[]
): number {
  return fragments.reduce((sum, f) => {
    return sum + (f.estimatedTokens ?? estimateTokensAccurate(f.fragment));
  }, 0);
}

/**
 * Token budget information.
 */
export interface TokenBudget {
  readonly total: number;
  readonly used: number;
  readonly remaining: number;
}

/**
 * Create a token budget.
 */
export function createTokenBudget(total: number, used = 0): TokenBudget {
  return {
    total,
    used: Math.min(used, total),
    remaining: Math.max(total - used, 0),
  };
}

/**
 * Check if a budget has remaining capacity.
 */
export function hasCapacity(budget: TokenBudget, additionalTokens: number): boolean {
  return budget.remaining >= additionalTokens;
}

/**
 * Calculate how many fragments fit in a budget.
 */
export function calculateFittingCount(
  fragments: readonly { estimatedTokens: number }[],
  budget: TokenBudget
): number {
  let count = 0;
  let used = 0;

  for (const fragment of fragments) {
    if (used + fragment.estimatedTokens <= budget.total) {
      count++;
      used += fragment.estimatedTokens;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Priority multipliers for token allocation.
 * Critical fragments get priority when budget is tight.
 */
export const PRIORITY_MULTIPLIERS = {
  critical: 0, // Always include, don't count against budget
  high: 0.5, // Count half tokens
  normal: 1, // Full tokens
  low: 2, // Count double tokens (deprioritize)
} as const;

/**
 * Calculate effective token cost based on priority.
 */
export function effectiveTokenCost(tokens: number, priority: string): number {
  const multiplier = PRIORITY_MULTIPLIERS[priority as keyof typeof PRIORITY_MULTIPLIERS] ?? 1;
  return tokens * multiplier;
}

/**
 * Format token count for display.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}
