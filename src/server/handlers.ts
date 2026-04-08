/**
 * Tool and resource handlers for the MCP server.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { GuideManager } from "../core/guides.js";
import type { MemoryManager } from "../core/memory.js";
import type {
  ContextRequest,
  GuideAddParams,
  GuideCategory,
  GuideDistillParams,
  GuidePracticeParams,
  GuideSuggestParams,
  GuideUpdateParams,
  MemoryAddParams,
  MemoryUpdateParams,
  Priority,
  SemanticSearchRequest,
} from "../core/types.js";
import { defaultCompressor } from "../utils/compression.js";
import { createLogger } from "../utils/logging.js";

const logger = createLogger("handlers");

/**
 * Tool definitions for the MCP server.
 */
const TOOLS = [
  {
    name: "memory_read",
    description: "Read fragments with optional filtering by token budget, project, and query",
    inputSchema: {
      type: "object",
      properties: {
        tokenBudget: { type: "number", description: "Maximum tokens to return" },
        project: { type: "string", description: "Filter by project" },
        query: { type: "string", description: "Semantic search query" },
        sessionId: { type: "string", description: "Session ID for tracking" },
      },
    },
  },
  {
    name: "memory_add",
    description: "Add a new memory fragment with priority, confidence, tags, and optional TTL. Large fragments (>150 words) are automatically split into sub-facts.",
    inputSchema: {
      type: "object",
      properties: {
        fragment: { type: "string", description: "The content to remember" },
        title: { type: "string", description: "Short title" },
        description: { type: "string", description: "Brief description" },
        project: { type: "string", description: "Project name" },
        priority: { type: "string", enum: ["critical", "high", "normal", "low"], description: "Priority level" },
        confidence: { type: "number", description: "Confidence score (0-1)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        ttl: { type: "number", description: "Time-to-live in days (e.g., 30). Fragment auto-expires after this period." },
      },
      required: ["fragment"],
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory fragment by id",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Fragment ID to update" },
        fragment: { type: "string", description: "New content" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory fragment by id",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Fragment ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_add_batch",
    description: "Add multiple memory fragments in a single batch operation. More efficient than multiple individual adds.",
    inputSchema: {
      type: "object",
      properties: {
        fragments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fragment: { type: "string", description: "The content to remember" },
              title: { type: "string", description: "Short title" },
              description: { type: "string", description: "Brief description" },
              project: { type: "string", description: "Project name" },
              priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
              confidence: { type: "number", description: "Confidence score (0-1)" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["fragment"],
          },
          description: "Array of fragments to add",
        },
      },
      required: ["fragments"],
    },
  },
  {
    name: "memory_delete_batch",
    description: "Delete multiple memory fragments by IDs in a single batch operation",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of fragment IDs to delete",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "memory_list",
    description: "List all fragments with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
        includeMetadata: { type: "boolean", description: "Include full fragment metadata" },
      },
    },
  },
  {
    name: "memory_compress",
    description: "Compress low-priority fragments to save tokens. Originals are backed up and can be restored with memory_undo.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        maxFragments: { type: "number", description: "Maximum fragments to compress (default 10)" },
      },
    },
  },
  {
    name: "memory_undo",
    description: "Restore the most recently compressed fragments from backup",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_export",
    description: "Export all fragments as JSON for backup or migration",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_import",
    description: "Import fragments from a previously exported JSON backup",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "JSON string of exported fragments" },
      },
      required: ["data"],
    },
  },
  {
    name: "memory_stats",
    description: "Get memory usage statistics: fragment counts by project and priority, total tokens",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_extract",
    description: "Extract storeable facts from raw text using pattern matching. Returns extracted facts with suggested priority and tags for review before storing.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Raw text to extract facts from (conversation summary, error logs, etc.)" },
        project: { type: "string", description: "Project to associate extracted facts with" },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_suggest",
    description: "Analyze current memory state and return actionable suggestions: create guides for hot topics, compress stale fragments, cleanup expired items, etc.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "session_create",
    description: "Create a new session for conversation tracking",
    inputSchema: {
      type: "object",
      properties: {
        metadata: { type: "object", description: "Optional session metadata" },
      },
    },
  },
  {
    name: "session_get",
    description: "Get session info and cached context",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "session_delta",
    description: "Get differential updates since last turn",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        lastKnownTurn: { type: "number", description: "Last known turn number" },
      },
      required: ["sessionId", "lastKnownTurn"],
    },
  },
  {
    name: "session_close",
    description: "Close a session and cleanup",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID to close" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "session_update",
    description: "Update session context cache and conversation summary",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        summary: { type: "string", description: "Conversation summary to store" },
        context: {
          type: "object",
          description: "Key-value pairs to add to context cache",
          additionalProperties: true,
        },
        contextPriority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Priority for context entries (default: normal)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "priority_set",
    description: "Set fragment priority manually",
    inputSchema: {
      type: "object",
      properties: {
        fragmentId: { type: "string", description: "Fragment ID" },
        priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
      },
      required: ["fragmentId", "priority"],
    },
  },
  {
    name: "priority_auto",
    description: "Auto-prioritize fragments based on access patterns",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "guide_create",
    description: "Create a new guide for procedural knowledge",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Guide name" },
        category: { type: "string", description: "Category (e.g., 'programming-language', 'dev-tool')" },
        description: { type: "string", description: "Description of what the guide covers" },
        contexts: { type: "array", items: { type: "string" }, description: "When to use this guide" },
        learnings: { type: "array", items: { type: "string" }, description: "Key learnings/patterns" },
      },
      required: ["name", "category", "description"],
    },
  },
  {
    name: "guide_get",
    description: "Get a guide by name or id",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", description: "Guide name or ID" },
      },
      required: ["guide"],
    },
  },
  {
    name: "guide_list",
    description: "List guides with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category" },
        sortBy: { type: "string", enum: ["name", "usage", "recent"], description: "Sort order" },
        limit: { type: "number", description: "Maximum results" },
      },
    },
  },
  {
    name: "guide_practice",
    description: "Record guide usage with contexts and learnings",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", description: "Guide name or ID" },
        contexts: { type: "array", items: { type: "string" }, description: "Contexts where used" },
        learnings: { type: "array", items: { type: "string" }, description: "New learnings from this session" },
      },
      required: ["guide"],
    },
  },
  {
    name: "guide_update",
    description: "Update an existing guide",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", description: "Guide name or ID" },
        name: { type: "string", description: "New name" },
        category: { type: "string", description: "New category" },
        description: { type: "string", description: "New description" },
        contexts: { type: "array", items: { type: "string" } },
        learnings: { type: "array", items: { type: "string" } },
      },
      required: ["guide"],
    },
  },
  {
    name: "guide_delete",
    description: "Delete a guide by name or id",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", description: "Guide name or ID" },
      },
      required: ["guide"],
    },
  },
  {
    name: "guide_suggest",
    description: "Suggest relevant guides for a task using semantic search",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        limit: { type: "number", description: "Maximum suggestions (default 5)" },
      },
      required: ["task"],
    },
  },
  {
    name: "guide_distill",
    description: "Transform a memory fragment into a guide learning",
    inputSchema: {
      type: "object",
      properties: {
        guide: { type: "string", description: "Guide name or ID" },
        fragmentId: { type: "string", description: "Fragment ID to distill" },
        contexts: { type: "array", items: { type: "string" }, description: "Contexts for this learning" },
      },
      required: ["guide", "fragmentId"],
    },
  },
  {
    name: "search_semantic",
    description: "Semantic TF-IDF search across fragments and guides",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Maximum results (default 10)" },
        includeFragments: { type: "boolean", description: "Include fragments in search (default true)" },
        includeGuides: { type: "boolean", description: "Include guides in search (default true)" },
        project: { type: "string", description: "Filter fragments by project" },
      },
      required: ["query"],
    },
  },
];

/**
 * Register tool call handlers.
 */
export function registerServerToolHandlers(
  server: Server,
  manager: MemoryManager,
  guideManager?: GuideManager
): void {
  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool call requests
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "memory_read":
          return await handleMemoryRead(manager, args as unknown as ContextRequest);
        case "memory_add":
          return await handleMemoryAdd(manager, args as unknown as MemoryAddParams);
        case "memory_update":
          return await handleMemoryUpdate(manager, args as unknown as MemoryUpdateParams);
        case "memory_delete":
          return await handleMemoryDelete(manager, args as { id: string });
        case "memory_add_batch":
          return await handleMemoryAddBatch(manager, args as { fragments: unknown[] });
        case "memory_delete_batch":
          return await handleMemoryDeleteBatch(manager, args as { ids: string[] });
        case "memory_list":
          return await handleMemoryList(manager, args as unknown as ListArgs);
        case "memory_compress":
          return await handleMemoryCompress(manager, args as unknown as CompressArgs);
        case "memory_undo":
          return await handleMemoryUndo(manager);
        case "memory_export":
          return await handleMemoryExport(manager);
        case "memory_import":
          return await handleMemoryImport(manager, args as { data: string });
        case "memory_stats":
          return await handleMemoryStats(manager);
        case "memory_extract":
          return await handleMemoryExtract(manager, args as unknown as { text: string; project?: string });
        case "memory_suggest":
          return await handleMemorySuggest(manager, guideManager);
        case "session_create":
          return await handleSessionCreate(
            manager,
            args as unknown as { metadata?: Record<string, unknown> }
          );
        case "session_get":
          return await handleSessionGet(manager, args as unknown as { sessionId: string });
        case "session_delta":
          return await handleSessionDelta(
            manager,
            args as unknown as { sessionId: string; lastKnownTurn: number }
          );
        case "session_close":
          return await handleSessionClose(manager, args as unknown as { sessionId: string });
        case "session_update":
          return await handleSessionUpdate(
            manager,
            args as unknown as {
              sessionId: string;
              summary?: string;
              context?: Record<string, unknown>;
              contextPriority?: Priority;
            }
          );
        case "priority_set":
          return await handlePrioritySet(
            manager,
            args as unknown as { fragmentId: string; priority: Priority }
          );
        case "priority_auto":
          return await handlePriorityAuto(manager);
        case "guide_create":
          return await handleGuideCreate(guideManager, args as unknown as GuideAddParams);
        case "guide_get":
          return await handleGuideGet(guideManager, args as unknown as { guide: string });
        case "guide_list":
          return await handleGuideList(guideManager, args as unknown as GuideListArgs);
        case "guide_practice":
          return await handleGuidePractice(guideManager, args as unknown as GuidePracticeParams);
        case "guide_update":
          return await handleGuideUpdate(guideManager, args as unknown as GuideUpdateParams);
        case "guide_delete":
          return await handleGuideDelete(guideManager, args as unknown as { guide: string });
        case "guide_suggest":
          return await handleGuideSuggest(guideManager, args as unknown as GuideSuggestParams);
        case "guide_distill":
          return await handleGuideDistill(
            guideManager,
            manager,
            args as unknown as GuideDistillParams
          );
        case "search_semantic":
          return await handleSearchSemantic(
            manager,
            guideManager,
            args as unknown as SemanticSearchRequest
          );
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      logger.error(`Tool call failed: ${name}`, error as Error);
      throw error;
    }
  });
}

/**
 * Handle memory_read tool.
 */
async function handleMemoryRead(manager: MemoryManager, args: ContextRequest) {
  // Enable project inheritance when a specific project is requested
  const contextRequest: ContextRequest = {
    ...args,
    includeInherited: args.project ? true : undefined,
    includeGlobal: args.project ? true : undefined,
  };
  const result = await manager.selectContext(contextRequest);

  // Update session activity if provided
  if (args.sessionId) {
    manager.sessionManager.updateActivity(args.sessionId);
    manager.sessionManager.incrementTurn(args.sessionId);
  }

  const fragments = result.fragments.map((f) => formatFragment(f));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            fragments,
            metadata: {
              totalFragments: result.fragments.length,
              totalTokens: result.totalTokens,
              droppedCount: result.droppedCount,
              remainingBudget: result.remainingBudget,
              compressionApplied: result.compressionApplied,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_add tool.
 */
async function handleMemoryAdd(manager: MemoryManager, args: MemoryAddParams) {
  const fragment = await manager.add(args);

  // Check for auto-extracted sub-facts
  const fragments = await manager.listFragments();
  const subFacts = fragments.filter(
    (f) => f.parentFragmentId === fragment.id
  );

  const result: Record<string, unknown> = {
    id: fragment.id,
    message: "Fragment added successfully",
  };

  if (subFacts.length > 0) {
    result.subFactsExtracted = subFacts.length;
    result.subFactIds = subFacts.map((f) => f.id);
  }

  if (fragment.expiresAt) {
    result.expiresAt = fragment.expiresAt;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Handle memory_update tool.
 */
async function handleMemoryUpdate(manager: MemoryManager, args: MemoryUpdateParams) {
  const fragment = await manager.update(args);

  if (!fragment) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Fragment not found" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { message: "Fragment updated successfully", id: fragment.id },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_delete tool.
 */
async function handleMemoryDelete(manager: MemoryManager, args: { id: string }) {
  const deleted = await manager.delete(args.id);

  if (!deleted) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Fragment not found" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: "Fragment deleted successfully" }, null, 2),
      },
    ],
  };
}

/**
 * Handle memory_add_batch tool.
 */
async function handleMemoryAddBatch(manager: MemoryManager, args: { fragments: unknown[] }) {
  const params: MemoryAddParams[] = [];

  for (const item of args.fragments) {
    const f = item as { fragment?: unknown; title?: unknown; description?: unknown; project?: unknown; priority?: unknown; confidence?: unknown; tags?: unknown };

    const param: MemoryAddParams = {
      fragment: String(f["fragment"] ?? ""),
      ...((f["title"] !== undefined && f["title"] !== null) && { title: String(f["title"]) }),
      ...((f["description"] !== undefined && f["description"] !== null) && { description: String(f["description"]) }),
      ...((f["project"] !== undefined && f["project"] !== null) && { project: String(f["project"]) }),
      ...((f["priority"] !== undefined && f["priority"] !== null) && { priority: String(f["priority"]) as Priority }),
      ...(typeof f["confidence"] === "number" && { confidence: f["confidence"] }),
      ...(Array.isArray(f["tags"]) && { tags: f["tags"].map(String) }),
    };

    params.push(param);
  }

  const fragments = await manager.addBatch(params);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          message: `Added ${fragments.length} fragments successfully`,
          ids: fragments.map((f) => f.id),
        }, null, 2),
      },
    ],
  };
}

/**
 * Handle memory_delete_batch tool.
 */
async function handleMemoryDeleteBatch(manager: MemoryManager, args: { ids: string[] }) {
  const result = await manager.deleteBatch(args.ids);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          message: `Batch delete complete: ${result.deleted} deleted, ${result.notFound.length} not found`,
          deleted: result.deleted,
          notFound: result.notFound,
        }, null, 2),
      },
    ],
  };
}

/**
 * Handle memory_list tool.
 */
interface ListArgs {
  project?: string;
  priority?: Priority;
  includeMetadata?: boolean;
}

async function handleMemoryList(manager: MemoryManager, args: ListArgs) {
  const listOptions: { project?: string; priority?: Priority } = {};
  if (args.project !== undefined) {
    listOptions.project = args.project;
  }
  if (args.priority !== undefined) {
    listOptions.priority = args.priority;
  }

  const fragments = await manager.listFragments(listOptions);

  const formatted = fragments.map((f) =>
    args.includeMetadata ? formatFragment(f) : summarizeFragment(f)
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ fragments: formatted, count: formatted.length }, null, 2),
      },
    ],
  };
}

/**
 * Handle memory_compress tool.
 */
interface CompressArgs {
  project?: string;
  maxFragments?: number;
}

async function handleMemoryCompress(manager: MemoryManager, args: CompressArgs) {
  const maxFragments = args.maxFragments ?? 10;

  const listOptions = args.project !== undefined ? { project: args.project } : undefined;
  let fragments = listOptions
    ? await manager.listFragments(listOptions)
    : await manager.listFragments();

  // Filter for low/normal priority fragments that can be compressed
  fragments = fragments.filter((f) => f.priority === "low" || f.priority === "normal");

  if (fragments.length < 2) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Not enough fragments to compress (need at least 2)" },
            null,
            2
          ),
        },
      ],
    };
  }

  // Take the oldest accessed fragments
  const toCompress = fragments
    .sort((a, b) => new Date(a.lastAccessed).getTime() - new Date(b.lastAccessed).getTime())
    .slice(0, maxFragments);

  const result = defaultCompressor.compress(toCompress);

  // Add compressed fragment and remove originals
  const addParams: MemoryAddParams = {
    fragment: result.compressed.fragment,
    title: result.compressed.title,
    description: result.compressed.description,
    priority: result.compressed.priority,
    tags: result.compressed.tags,
  };
  if (result.compressed.project !== null) {
    (addParams as { project?: string }).project = result.compressed.project;
  }
  await manager.add(addParams);

  for (const f of toCompress) {
    await manager.delete(f.id);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: `Compressed ${result.originalCount} fragments into 1`,
            compressedId: result.compressed.id,
            tokensSaved: result.tokensSaved,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_stats tool.
 */
async function handleMemoryStats(manager: MemoryManager) {
  const stats = await manager.getStats();

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(stats, null, 2),
      },
    ],
  };
}

/**
 * Compression backup store (in-memory, per server instance).
 */
let compressionBackup: Array<{
  compressedId: string;
  originals: Array<{ id: string; title: string; fragment: string; priority: string; confidence: number; project: string | null; tags: readonly string[]; estimatedTokens: number; source: string; created: string; lastAccessed: string; accessed: number; inherits: string[]; expiresAt: string | null; parentFragmentId: string | null }>;
}> = [];

/**
 * Handle memory_compress tool — with backup.
 */
async function handleMemoryCompress(manager: MemoryManager, args: CompressArgs) {
  const maxFragments = args.maxFragments ?? 10;

  const listOptions = args.project !== undefined ? { project: args.project } : undefined;
  let fragments = listOptions
    ? await manager.listFragments(listOptions)
    : await manager.listFragments();

  // Filter for low/normal priority fragments that can be compressed
  fragments = fragments.filter((f) => f.priority === "low" || f.priority === "normal");

  if (fragments.length < 2) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { message: "Not enough fragments to compress (need at least 2)" },
            null,
            2
          ),
        },
      ],
    };
  }

  // Take the oldest accessed fragments
  const toCompress = fragments
    .sort((a, b) => new Date(a.lastAccessed).getTime() - new Date(b.lastAccessed).getTime())
    .slice(0, maxFragments);

  // Backup originals before compression
  const backup = toCompress.map((f) => ({
    id: f.id,
    title: f.title,
    fragment: f.fragment,
    priority: f.priority,
    confidence: f.confidence,
    project: f.project,
    tags: f.tags,
    estimatedTokens: f.estimatedTokens,
    source: f.source,
    created: f.created,
    lastAccessed: f.lastAccessed,
    accessed: f.accessed,
    inherits: [...f.inherits],
    expiresAt: f.expiresAt,
    parentFragmentId: f.parentFragmentId,
  }));

  const result = defaultCompressor.compress(toCompress);

  // Add compressed fragment and remove originals
  const addParams: MemoryAddParams = {
    fragment: result.compressed.fragment,
    title: result.compressed.title,
    description: result.compressed.description,
    priority: result.compressed.priority,
    tags: [...result.compressed.tags, "compressed"],
  };
  if (result.compressed.project !== null) {
    (addParams as { project?: string }).project = result.compressed.project;
  }
  await manager.add(addParams);

  for (const f of toCompress) {
    await manager.delete(f.id);
  }

  // Store backup for undo
  compressionBackup.push({
    compressedId: result.compressed.id,
    originals: backup,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: `Compressed ${result.originalCount} fragments into 1`,
            compressedId: result.compressed.id,
            tokensSaved: result.tokensSaved,
            canUndo: true,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_undo tool — restore last compression.
 */
async function handleMemoryUndo(manager: MemoryManager) {
  if (compressionBackup.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "No compression to undo" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const backup = compressionBackup.pop()!;
  const restored: string[] = [];

  // Delete the compressed fragment
  await manager.delete(backup.compressedId);

  // Restore all originals
  for (const original of backup.originals) {
    await manager.add({
      fragment: original.fragment,
      title: original.title,
      project: original.project ?? undefined,
      priority: original.priority as Priority,
      confidence: original.confidence,
      tags: original.tags,
      ttl: original.expiresAt
        ? Math.max(0, (new Date(original.expiresAt).getTime() - Date.now()) / 86400000)
        : undefined,
    });
    restored.push(original.id);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: `Restored ${restored.length} fragments from compression backup`,
            restoredIds: restored,
            deletedCompressedId: backup.compressedId,
            remainingBackups: compressionBackup.length,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_export tool.
 */
async function handleMemoryExport(manager: MemoryManager) {
  const fragments = await manager.listFragments();

  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    fragmentCount: fragments.length,
    fragments: fragments.map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
      fragment: f.fragment,
      project: f.project,
      priority: f.priority,
      confidence: f.confidence,
      source: f.source,
      created: f.created,
      lastAccessed: f.lastAccessed,
      accessed: f.accessed,
      inherits: [...f.inherits],
      estimatedTokens: f.estimatedTokens,
      tags: [...f.tags],
      expiresAt: f.expiresAt,
      parentFragmentId: f.parentFragmentId,
    })),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(exportData),
      },
    ],
  };
}

/**
 * Handle memory_import tool.
 */
async function handleMemoryImport(manager: MemoryManager, args: { data: string }) {
  let importData: unknown;
  try {
    importData = JSON.parse(args.data);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Invalid JSON data" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const data = importData as {
    version?: number;
    fragments?: unknown[];
  };

  if (!Array.isArray(data.fragments)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Missing 'fragments' array in import data" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const item of data.fragments) {
    const f = item as Record<string, unknown>;
    const fragment = f["fragment"];
    if (typeof fragment !== "string" || !fragment.trim()) {
      skipped.push(String(f["id"] ?? "unknown"));
      continue;
    }

    try {
      const result = await manager.add({
        fragment,
        title: typeof f["title"] === "string" ? f["title"] : undefined,
        description: typeof f["description"] === "string" ? f["description"] : undefined,
        project: typeof f["project"] === "string" ? f["project"] : undefined,
        priority: typeof f["priority"] === "string" ? f["priority"] as Priority : undefined,
        confidence: typeof f["confidence"] === "number" ? f["confidence"] : undefined,
        tags: Array.isArray(f["tags"]) ? (f["tags"] as string[]).filter((t: unknown) => typeof t === "string") : undefined,
      });
      imported.push(result.id);
    } catch {
      skipped.push(String(f["id"] ?? "unknown"));
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: `Imported ${imported.length} fragments (${skipped.length} skipped)`,
            importedIds: imported,
            skippedIds: skipped,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_extract tool.
 * Extracts storeable facts from raw text using pattern matching.
 */
async function handleMemoryExtract(
  manager: MemoryManager,
  args: { text: string; project?: string }
) {
  const facts = extractFacts(args.text);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            factsExtracted: facts.length,
            facts: facts.map((f) => ({
              content: f.content,
              suggestedPriority: f.priority,
              suggestedTags: f.tags,
              type: f.type,
            })),
            hint: "Review these facts and store relevant ones with memory_add or memory_add_batch.",
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle memory_suggest tool.
 * Analyzes memory state and returns actionable suggestions.
 */
async function handleMemorySuggest(
  manager: MemoryManager,
  guideManager: GuideManager | undefined
) {
  const stats = await manager.getStats();
  const fragments = await manager.listFragments();
  const suggestions: Array<{ type: string; message: string; action?: string; details?: unknown }> = [];

  // Check for hot topics (many fragments in same project)
  const projectCounts = Object.entries(stats.byProject)
    .sort((a, b) => b[1] - a[1]);

  for (const [project, count] of projectCounts) {
    if (count >= 10) {
      suggestions.push({
        type: "guide_candidate",
        message: `Project "${project}" has ${count} fragments — consider creating a guide for procedural knowledge`,
        action: `guide_create({name: "${project}", category: "dev-tool", description: "Procedural knowledge for ${project}"})`,
        details: { project, fragmentCount: count },
      });
    }
  }

  // Check for stale low-priority fragments
  const staleFragments = fragments.filter((f) => {
    if (f.priority !== "low" && f.priority !== "normal") return false;
    const ageDays = (Date.now() - new Date(f.lastAccessed).getTime()) / 86400000;
    return ageDays > 30 && f.accessed < 2;
  });

  if (staleFragments.length >= 3) {
    suggestions.push({
      type: "compress",
      message: `${staleFragments.length} stale fragments (not accessed in 30+ days) — consider compressing`,
      action: `memory_compress({maxFragments: ${Math.min(staleFragments.length, 10)}})`,
      details: { staleCount: staleFragments.length, ids: staleFragments.slice(0, 5).map((f) => f.id) },
    });
  }

  // Check for expired fragments
  const expiredFragments = fragments.filter(
    (f) => f.expiresAt && new Date(f.expiresAt).getTime() < Date.now()
  );

  if (expiredFragments.length > 0) {
    suggestions.push({
      type: "cleanup",
      message: `${expiredFragments.length} expired fragments found — will be cleaned on next restart`,
      details: { expiredCount: expiredFragments.length },
    });
  }

  // Check for near-duplicates (same project, similar titles)
  const titleGroups = new Map<string, number>();
  for (const f of fragments) {
    const baseTitle = f.title.split(/[-:[]/)[0]?.trim().toLowerCase() ?? f.title;
    if (baseTitle.length > 3) {
      titleGroups.set(baseTitle, (titleGroups.get(baseTitle) ?? 0) + 1);
    }
  }

  const duplicates = [...titleGroups.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    suggestions.push({
      type: "dedup",
      message: `${duplicates.length} potential duplicate groups detected — dedup is active on write`,
      details: {
        duplicateGroups: duplicates.slice(0, 5).map(([title, count]) => ({ title, count })),
      },
    });
  }

  // Check token usage
  if (stats.totalTokens > 6000) {
    suggestions.push({
      type: "budget",
      message: `Memory using ${stats.totalTokens} tokens — consider compressing or increasing budget`,
      details: { totalTokens: stats.totalTokens, defaultBudget: 8000 },
    });
  }

  // Check if guides exist for common projects
  if (guideManager) {
    const guides = await guideManager.listGuides({});
    if (projectCounts.length > 0 && guides.length === 0) {
      suggestions.push({
        type: "no_guides",
        message: "No guides created yet — guides track reusable procedural knowledge across sessions",
        action: "guide_create({name: 'workflow', category: 'dev-tool', description: 'Your workflow patterns'})",
      });
    }
  }

  // Check for orphaned sub-facts (parent deleted)
  const subFacts = fragments.filter((f) => f.parentFragmentId);
  if (subFacts.length > 0) {
    const parentIds = new Set(fragments.map((f) => f.id));
    const orphans = subFacts.filter((f) => !parentIds.has(f.parentFragmentId!));
    if (orphans.length > 0) {
      suggestions.push({
        type: "orphans",
        message: `${orphans.length} orphaned sub-facts found (parent fragment deleted) — consider removing`,
        details: { orphanIds: orphans.map((f) => f.id) },
      });
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            suggestions: suggestions.length > 0 ? suggestions : [{ type: "healthy", message: "Memory looks healthy — no action needed" }],
            stats,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle session_create tool.
 */
async function handleSessionCreate(
  manager: MemoryManager,
  args: { metadata?: Record<string, unknown> }
) {
  const session = manager.sessionManager.createSession(args.metadata);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ sessionId: session.id, createdAt: session.createdAt }, null, 2),
      },
    ],
  };
}

/**
 * Handle session_get tool.
 */
async function handleSessionGet(manager: MemoryManager, args: { sessionId: string }) {
  const session = manager.sessionManager.getSession(args.sessionId);

  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Session not found or expired" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const context = Array.from(session.contextCache.values());

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            sessionId: session.id,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            turnCount: session.turnCount,
            conversationSummary: session.conversationSummary,
            contextCache: context,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle session_delta tool.
 */
async function handleSessionDelta(
  manager: MemoryManager,
  args: {
    sessionId: string;
    lastKnownTurn: number;
  }
) {
  const delta = manager.sessionManager.getDelta(args.sessionId, args.lastKnownTurn);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(delta, null, 2),
      },
    ],
  };
}

/**
 * Handle session_close tool.
 */
async function handleSessionClose(manager: MemoryManager, args: { sessionId: string }) {
  manager.sessionManager.closeSession(args.sessionId);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: "Session closed" }, null, 2),
      },
    ],
  };
}

/**
 * Handle session_update tool.
 */
async function handleSessionUpdate(
  manager: MemoryManager,
  args: {
    sessionId: string;
    summary?: string;
    context?: Record<string, unknown>;
    contextPriority?: Priority;
  }
) {
  const session = manager.sessionManager.getSession(args.sessionId);

  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Session not found or expired" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  // Update conversation summary
  if (args.summary !== undefined) {
    manager.sessionManager.updateSummary(args.sessionId, args.summary);
  }

  // Add context cache entries
  if (args.context) {
    const priority = args.contextPriority ?? "normal";
    for (const [key, value] of Object.entries(args.context)) {
      manager.sessionManager.addToContext(args.sessionId, key, value, priority);
    }
  }

  // Return updated session
  const updated = manager.sessionManager.getSession(args.sessionId);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: "Session updated",
            sessionId: args.sessionId,
            turnCount: updated?.turnCount,
            conversationSummary: updated?.conversationSummary,
            contextCacheSize: updated?.contextCache.size ?? 0,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle priority_set tool.
 */
async function handlePrioritySet(
  manager: MemoryManager,
  args: {
    fragmentId: string;
    priority: Priority;
  }
) {
  const fragment = await manager.update({
    id: args.fragmentId,
    priority: args.priority,
  });

  if (!fragment) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Fragment not found" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: "Priority updated", priority: fragment.priority }, null, 2),
      },
    ],
  };
}

/**
 * Handle priority_auto tool.
 */
async function handlePriorityAuto(manager: MemoryManager) {
  const fragments = await manager.listFragments();
  manager.prioritizer.autoPrioritize(fragments);

  // Save updated priorities
  for (const fragment of fragments) {
    await manager.update({ id: fragment.id, priority: fragment.priority });
  }

  const byPriority = fragments.reduce(
    (acc, f) => {
      acc[f.priority] = (acc[f.priority] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: "Auto-prioritization complete", byPriority }, null, 2),
      },
    ],
  };
}

/**
 * Format a fragment for output.
 */
function formatFragment(fragment: unknown): Record<string, unknown> {
  const f = fragment as {
    id: string;
    title: string;
    description: string;
    fragment: string;
    project: string | null;
    priority: string;
    confidence: number;
    source: string;
    created: string;
    lastAccessed: string;
    accessed: number;
    estimatedTokens: number;
    tags: readonly string[];
  };

  return {
    id: f.id,
    title: f.title,
    description: f.description,
    content: f.fragment,
    project: f.project,
    priority: f.priority,
    confidence: f.confidence,
    source: f.source,
    created: f.created,
    lastAccessed: f.lastAccessed,
    accessed: f.accessed,
    estimatedTokens: f.estimatedTokens,
    tags: f.tags,
  };
}

/**
 * Summarize a fragment for list output.
 */
function summarizeFragment(fragment: unknown): Record<string, unknown> {
  const f = fragment as {
    id: string;
    title: string;
    description: string;
    project: string | null;
    priority: string;
    estimatedTokens: number;
  };

  return {
    id: f.id,
    title: f.title,
    description: f.description,
    project: f.project,
    priority: f.priority,
    estimatedTokens: f.estimatedTokens,
  };
}

/**
 * Handle guide_create tool.
 */
async function handleGuideCreate(guideManager: GuideManager | undefined, args: GuideAddParams) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const guide = await guideManager.add(args);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { id: guide.id, name: guide.name, message: "Guide created successfully" },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle guide_get tool.
 */
async function handleGuideGet(guideManager: GuideManager | undefined, args: { guide: string }) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const guide = await guideManager.get(args.guide);

  if (!guide) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Guide not found" }, null, 2) }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(formatGuide(guide), null, 2),
      },
    ],
  };
}

/**
 * Handle guide_list tool.
 */
interface GuideListArgs {
  category?: GuideCategory;
  sortBy?: "name" | "usage" | "recent";
  limit?: number;
}

async function handleGuideList(guideManager: GuideManager | undefined, args: GuideListArgs) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const guides = await guideManager.listGuides(args);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ guides: guides.map(formatGuide), count: guides.length }, null, 2),
      },
    ],
  };
}

/**
 * Handle guide_practice tool.
 */
async function handleGuidePractice(
  guideManager: GuideManager | undefined,
  args: GuidePracticeParams
) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const guide = await guideManager.practice(args);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: "Guide practice recorded",
            guide: formatGuide(guide),
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle guide_update tool.
 */
async function handleGuideUpdate(guideManager: GuideManager | undefined, args: GuideUpdateParams) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const guide = await guideManager.update(args);

  if (!guide) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Guide not found" }, null, 2) }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { message: "Guide updated successfully", guide: formatGuide(guide) },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle guide_delete tool.
 */
async function handleGuideDelete(guideManager: GuideManager | undefined, args: { guide: string }) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const deleted = await guideManager.delete(args.guide);

  if (!deleted) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Guide not found" }, null, 2) }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: "Guide deleted successfully" }, null, 2),
      },
    ],
  };
}

/**
 * Handle guide_suggest tool.
 */
async function handleGuideSuggest(
  guideManager: GuideManager | undefined,
  args: GuideSuggestParams
) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  const suggestions = await guideManager.suggest(args);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            task: args.task,
            suggestions: suggestions.map((s) => ({
              guide: formatGuide(s.guide),
              relevance: s.relevance,
              matchedContexts: s.matchedContexts,
            })),
            count: suggestions.length,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Handle guide_distill tool.
 */
async function handleGuideDistill(
  guideManager: GuideManager | undefined,
  memoryManager: MemoryManager,
  args: GuideDistillParams
) {
  if (!guideManager) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: "Guide manager not initialized" }, null, 2) },
      ],
      isError: true,
    };
  }

  try {
    const guide = await guideManager.distill(args, (id) => memoryManager.get(id));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "Memory distilled into guide",
              guide: formatGuide(guide),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: (error as Error).message }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Handle search_semantic tool.
 */
async function handleSearchSemantic(
  memoryManager: MemoryManager,
  guideManager: GuideManager | undefined,
  args: SemanticSearchRequest
) {
  const limit = args.limit ?? 10;
  const results: Array<{
    type: "fragment" | "guide";
    id: string;
    title: string;
    content: string;
    relevance: number;
    tokens: number;
    project: string | null;
    category?: string;
  }> = [];

  // Search fragments
  if (args.includeFragments !== false && memoryManager.semanticSearch) {
    const fragments = await memoryManager.listFragments(
      args.project ? { project: args.project } : undefined
    );
    const fragmentResults = memoryManager.semanticSearch.searchFragments(
      args.query,
      fragments,
      limit
    );

    for (const r of fragmentResults) {
      results.push({
        type: "fragment",
        id: r.item.id,
        title: r.item.title,
        content: r.item.fragment,
        relevance: r.relevance,
        tokens: r.item.estimatedTokens ?? 0,
        project: r.item.project,
      });
    }
  }

  // Search guides
  if (args.includeGuides !== false && guideManager) {
    const guides = await guideManager.listGuides();
    const guideResults = guideManager.semanticSearch.searchGuides(args.query, guides, limit);

    for (const r of guideResults) {
      results.push({
        type: "guide",
        id: r.item.id,
        title: r.item.name,
        content: r.item.description,
        relevance: r.relevance,
        tokens: 0,
        project: null,
        category: r.item.category,
      });
    }
  }

  // Sort by relevance and limit
  results.sort((a, b) => b.relevance - a.relevance);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            query: args.query,
            results: results.slice(0, limit),
            totalFound: results.length,
            returned: Math.min(results.length, limit),
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Format a guide for output.
 */
function formatGuide(guide: {
  id: string;
  name: string;
  category: string;
  description: string;
  created: string;
  lastUsed: string;
  usageCount: number;
  contexts: readonly string[];
  learnings: readonly string[];
}): Record<string, unknown> {
  return {
    id: guide.id,
    name: guide.name,
    category: guide.category,
    description: guide.description,
    created: guide.created,
    lastUsed: guide.lastUsed,
    usageCount: guide.usageCount,
    contexts: guide.contexts,
    learnings: guide.learnings,
  };
}

/**
 * Fact extraction patterns and types.
 */
interface ExtractedFact {
  readonly content: string;
  readonly priority: string;
  readonly tags: readonly string[];
  readonly type: string;
}

interface ExtractionPattern {
  readonly type: string;
  readonly regex: RegExp;
  readonly priority: string;
  readonly tags: readonly string[];
}

const EXTRACTION_PATTERNS: readonly ExtractionPattern[] = [
  {
    type: "preference",
    regex: /(?:I |user |they )?(?:prefer|prefers|likes?|dislikes?|loves?|hates?|always uses?|never uses?|avoids?|avoids? using)\s+(.+?)(?:\.|,|$)/gi,
    priority: "high",
    tags: ["preference"],
  },
  {
    type: "fact",
    regex: /^[-•*]\s+(?:\w[\w\s]*?)(?:\s+(?:is|are|uses?|supports?|requires?|has|have|provides?|runs? on|located at|stored in))\s+(.+?)(?:\.|,|$)/gim,
    priority: "normal",
    tags: ["fact"],
  },
  {
    type: "solution",
    regex: /(?:fix|solution|resolved|workaround|the issue was|the problem was|root cause)[:\s]+(.+?)(?:\.|,|$)/gi,
    priority: "high",
    tags: ["solution", "debugging"],
  },
  {
    type: "constant",
    regex: /(?:rate limit|timeout|port|max retries?|buffer size|cache size|token budget|ttl|max sessions?|deadline)[:\s]+(\d[\d,.]*\s*\w*)(?:\.|,|$)/gi,
    priority: "normal",
    tags: ["constant"],
  },
  {
    type: "version",
    regex: /(?:version|v|using|upgraded to|migrated to|switched to)[:\s]+(\S+?)(?:\.|,|$)/gi,
    priority: "normal",
    tags: ["version"],
  },
  {
    type: "error",
    regex: /(?:error|bug|issue|failure|crash|panic)[:\s]+(.+?)(?:\.|,|$)/gi,
    priority: "high",
    tags: ["error", "debugging"],
  },
  {
    type: "key-value",
    regex: /^(\w[\w\s]{2,25}?)[:=]\s*(.+?)$/gm,
    priority: "normal",
    tags: ["key-value"],
  },
];

/**
 * Extract facts from raw text using pattern matching.
 */
function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const pattern of EXTRACTION_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const content = match[0]!.trim();
      const normalized = content.toLowerCase();

      // Deduplicate
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // Skip very short or very long matches
      if (content.length < 10 || content.length > 200) continue;

      // Skip pure numeric matches
      if (/^\d+$/.test(content.trim())) continue;

      facts.push({
        content,
        priority: pattern.priority,
        tags: pattern.tags,
        type: pattern.type,
      });
    }
  }

  return facts.slice(0, 20); // Cap at 20 facts
}
