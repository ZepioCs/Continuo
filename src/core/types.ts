/**
 * Priority levels for memory fragments.
 * Determines inclusion order when context must be truncated.
 */
export enum Priority {
  Critical = "critical",
  High = "high",
  Normal = "normal",
  Low = "low",
}

/**
 * Source of a memory fragment.
 */
export type FragmentSource = "user" | "ai";

/**
 * A snapshot of a fragment at a point in time.
 */
export interface FragmentVersion {
  readonly fragment: string;
  readonly title: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly changeReason: string;
}

/**
 * A memory fragment stored in Continuo.
 */
export interface MemoryFragment {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  fragment: string;
  project: string | null;
  priority: Priority;
  confidence: number;
  readonly source: FragmentSource;
  readonly created: string;
  lastAccessed: string;
  accessed: number;
  readonly inherits: readonly string[];
  estimatedTokens: number;
  readonly tags: readonly string[];
  readonly expiresAt: string | null;
  readonly parentFragmentId: string | null;
  readonly versionHistory: readonly FragmentVersion[];
}

/**
 * Raw fragment data from storage (uses plain arrays instead of readonly).
 */
export type RawMemoryFragment = Omit<MemoryFragment, "inherits" | "tags"> & {
  inherits: string[];
  tags: string[];
};

/**
 * Convert a raw fragment to a proper MemoryFragment.
 * Handles missing inherits/tags fields from legacy data.
 */
export function toMemoryFragment(raw: RawMemoryFragment): MemoryFragment {
  return {
    ...raw,
    inherits: (raw.inherits as readonly string[] | undefined) ?? [],
    tags: (raw.tags as readonly string[] | undefined) ?? [],
    expiresAt: (raw.expiresAt as string | null | undefined) ?? null,
    parentFragmentId: (raw.parentFragmentId as string | null | undefined) ?? null,
    versionHistory: (raw as { versionHistory?: readonly FragmentVersion[] }).versionHistory ?? [],
  };
}

/**
 * Convert a MemoryFragment to raw storage format.
 */
export function toRawMemoryFragment(fragment: MemoryFragment): RawMemoryFragment {
  return {
    ...fragment,
    inherits: [...fragment.inherits],
    tags: [...fragment.tags],
  };
}

/**
 * A cached context item in a session.
 */
export interface CachedContext {
  readonly key: string;
  value: unknown;
  readonly addedAtTurn: number;
  priority: Priority;
}

/**
 * A session for tracking conversation state.
 */
export interface Session {
  readonly id: string;
  readonly createdAt: string;
  lastActivity: string;
  contextCache: Map<string, CachedContext>;
  conversationSummary: string;
  turnCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Raw session data from storage.
 */
export interface RawSession {
  readonly id: string;
  readonly createdAt: string;
  lastActivity: string;
  contextCache: Array<[string, CachedContext]>;
  conversationSummary: string;
  turnCount: number;
  readonly metadata: Record<string, unknown>;
}

/**
 * Convert raw session to Session.
 */
export function toSession(raw: RawSession): Session {
  return {
    ...raw,
    contextCache: new Map(raw.contextCache),
    metadata: raw.metadata,
  };
}

/**
 * Convert Session to raw storage format.
 */
export function toRawSession(session: Session): RawSession {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    contextCache: Array.from(session.contextCache.entries()),
    conversationSummary: session.conversationSummary,
    turnCount: session.turnCount,
    metadata: { ...session.metadata },
  };
}

/**
 * Parameters for reading memory with token awareness.
 */
export interface ContextRequest {
  readonly sessionId?: string;
  readonly tokenBudget?: number;
  readonly project?: string;
  readonly query?: string;
  readonly priorities?: readonly Priority[];
  readonly includeInherited?: boolean;
  readonly includeGlobal?: boolean;
  readonly stream?: boolean;
}

/**
 * Result of a context selection operation.
 */
export interface SelectionResult {
  readonly fragments: readonly MemoryFragment[];
  readonly totalTokens: number;
  readonly droppedCount: number;
  readonly remainingBudget: number;
  readonly compressionApplied: boolean;
  readonly metadata: readonly SelectionMetadata[];
}

/**
 * Metadata for each selected fragment.
 */
export interface SelectionMetadata {
  readonly fragmentId: string;
  readonly score: number;
  readonly tokens: number;
  readonly isCompressed: boolean;
}

/**
 * A chunk in a streamed context response.
 */
export interface StreamChunk {
  readonly fragment: MemoryFragment;
  readonly tokens: number;
  readonly cumulativeTokens: number;
  readonly isComplete: boolean;
  readonly shouldContinue: boolean;
}

/**
 * A differential update for session tracking.
 */
export interface DeltaUpdate {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly addedContext: readonly CachedContext[];
  readonly modifiedContext: readonly CachedContext[];
  readonly removedKeys: readonly string[];
  readonly conversationSummary: string;
}

/**
 * Configuration for the Continuo server.
 */
export interface ContinuoConfig {
  readonly storage: StorageConfig;
  readonly context: ContextConfig;
  readonly sessions: SessionConfig;
}

/**
 * Storage configuration.
 */
export interface StorageConfig {
  readonly path: string;
  readonly format: "jsonl" | "json";
  readonly compression: boolean;
}

/**
 * Context selection configuration.
 */
export interface ContextConfig {
  readonly defaultTokenBudget: number;
  readonly defaultPriority: Priority;
  readonly enableInheritance: boolean;
  readonly cacheSize: number;
}

/**
 * Session management configuration.
 */
export interface SessionConfig {
  readonly ttl: number;
  readonly maxSessions: number;
  readonly cleanupInterval: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: ContinuoConfig = {
  storage: {
    path: "~/.continuo",
    format: "jsonl",
    compression: true,
  },
  context: {
    defaultTokenBudget: 8000,
    defaultPriority: Priority.Normal,
    enableInheritance: true,
    cacheSize: 100,
  },
  sessions: {
    ttl: 3600000, // 1 hour in ms
    maxSessions: 100,
    cleanupInterval: 300000, // 5 minutes in ms
  },
} as const;

/**
 * Memory add/update parameters.
 */
export type MemoryAddParams = {
  readonly fragment: string;
  readonly title?: string;
  readonly description?: string;
  readonly project?: string;
  readonly priority?: Priority;
  readonly confidence?: number;
  readonly source?: FragmentSource;
  readonly inherits?: readonly string[];
  readonly tags?: readonly string[];
  readonly ttl?: number;
  readonly parentFragmentId?: string;
};

/**
 * Memory update parameters.
 */
export interface MemoryUpdateParams {
  readonly id: string;
  readonly fragment?: string;
  readonly title?: string;
  readonly description?: string;
  readonly project?: string;
  readonly priority?: Priority;
  readonly confidence?: number;
  readonly versionReason?: string;
}

/**
 * Priority scoring factors.
 */
export interface ScoringFactors {
  readonly confidenceWeight: number;
  readonly priorityWeight: number;
  readonly recencyWeight: number;
  readonly relevanceWeight: number;
  readonly accessFrequencyWeight: number;
}

/**
 * Default scoring factors.
 */
export const DEFAULT_SCORING_FACTORS: ScoringFactors = {
  confidenceWeight: 1.0,
  priorityWeight: 2.0,
  recencyWeight: 0.5,
  relevanceWeight: 1.5,
  accessFrequencyWeight: 0.3,
} as const;

/**
 * Compression result.
 */
export interface CompressionResult {
  readonly compressed: MemoryFragment;
  readonly originalCount: number;
  readonly tokensSaved: number;
}

/**
 * Guide categories.
 */
export enum GuideCategory {
  WebFrontend = "web-frontend",
  WebBackend = "web-backend",
  DevTool = "dev-tool",
  ProgrammingLanguage = "programming-language",
  DataStorage = "data-storage",
  Testing = "testing",
  Deployment = "deployment",
  Other = "other",
}

/**
 * A guide represents procedural knowledge with usage tracking.
 */
export interface Guide {
  readonly id: string;
  readonly name: string;
  readonly category: GuideCategory;
  description: string;
  readonly created: string;
  lastUsed: string;
  usageCount: number;
  readonly contexts: readonly string[];
  readonly learnings: readonly string[];
}

/**
 * Raw guide data from storage.
 */
export type RawGuide = Omit<Guide, "contexts" | "learnings"> & {
  contexts: string[];
  learnings: string[];
};

/**
 * Parameters for creating or updating a guide.
 */
export type GuideAddParams = {
  readonly name: string;
  readonly category: GuideCategory;
  readonly description: string;
  readonly contexts?: readonly string[];
  readonly learnings?: readonly string[];
};

/**
 * Parameters for updating a guide.
 */
export type GuideUpdateParams = {
  readonly id: string;
  readonly name?: string;
  readonly category?: GuideCategory;
  readonly description?: string;
};

/**
 * Parameters for recording guide usage.
 */
export interface GuidePracticeParams {
  readonly guide: string; // Guide name or ID
  readonly category: GuideCategory;
  readonly description?: string;
  readonly contexts: readonly string[];
  readonly learnings: readonly string[];
}

/**
 * Parameters for suggesting guides.
 */
export interface GuideSuggestParams {
  readonly task: string;
  readonly limit?: number;
}

/**
 * Suggested guide result.
 */
export interface GuideSuggestion {
  readonly guide: Guide;
  readonly relevance: number;
  readonly matchedContexts: readonly string[];
}

/**
 * Parameters for distilling a memory fragment into guide learning.
 */
export interface GuideDistillParams {
  readonly memoryId: string;
  readonly guide: string; // Guide name
  readonly category?: GuideCategory; // Required if creating new guide
}

/**
 * Semantic search request parameters.
 */
export interface SemanticSearchRequest {
  readonly query: string;
  readonly tokenBudget?: number;
  readonly project?: string;
  readonly limit?: number;
  readonly includeGuides?: boolean;
  readonly includeFragments?: boolean;
}

/**
 * A recorded search query for pattern tracking.
 */
export interface QueryRecord {
  readonly query: string;
  readonly timestamp: string;
  readonly resultCount: number;
  readonly project: string | null;
  readonly tool: "memory_read" | "search_semantic";
}

/**
 * Semantic search result with relevance scores.
 */
export interface SemanticSearchResult {
  readonly fragments: readonly SemanticSearchMatch[];
  readonly totalTokens: number;
  readonly query: string;
}

/**
 * A search match with relevance score.
 */
export interface SemanticSearchMatch {
  readonly type: "fragment" | "guide";
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly relevance: number;
  readonly tokens: number;
  readonly project: string | null;
  readonly category?: GuideCategory;
}

/**
 * Convert raw guide to Guide.
 * Handles missing contexts/learnings fields from legacy data.
 */
export function toGuide(raw: RawGuide): Guide {
  return {
    ...raw,
    contexts: (raw.contexts as readonly string[] | undefined) ?? [],
    learnings: (raw.learnings as readonly string[] | undefined) ?? [],
  };
}

/**
 * Convert Guide to raw storage format.
 */
export function toRawGuide(guide: Guide): RawGuide {
  return {
    ...guide,
    contexts: [...guide.contexts],
    learnings: [...guide.learnings],
  };
}
