/**
 * MCP server setup for Continuo.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GuideManager } from "../core/guides.js";
import type { MemoryManagerOptions } from "../core/memory.js";
import { MemoryManager } from "../core/memory.js";
import { SemanticSearch } from "../core/semantic.js";
import { createLogger } from "../utils/logging.js";
import { registerServerToolHandlers } from "./handlers.js";

const logger = createLogger("server");

/**
 * Server configuration.
 */
export interface ContinuoServerConfig extends MemoryManagerOptions {
  readonly name?: string;
  readonly version?: string;
}

/**
 * Create and configure the MCP server.
 */
export function createServer(config: ContinuoServerConfig = {}): {
  server: Server;
  manager: MemoryManager;
  guideManager: GuideManager;
} {
  const server = new Server(
    {
      name: config.name ?? "continuo",
      version: config.version ?? "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // Create semantic search
  const semanticSearch = new SemanticSearch();

  // Create memory manager with semantic search
  const manager = new MemoryManager({ ...config, semanticSearch });

  // Create guide manager
  const guideManager = new GuideManager({ storagePath: config.storagePath ?? "~/.continuo" });

  // Register handlers
  registerServerToolHandlers(server, manager, guideManager);

  // Error handling
  server.onerror = (error) => {
    logger.error("Server error", error);
  };

  logger.info("Server created", {
    name: config.name ?? "continuo",
    version: config.version ?? "1.0.0",
  });

  return { server, manager, guideManager };
}

/**
 * Start the server with stdio transport.
 */
export async function startServer(config: ContinuoServerConfig = {}): Promise<void> {
  const { server, manager, guideManager } = createServer(config);

  // Initialize managers
  await manager.initialize();
  await guideManager.initialize();

  // Re-index fragments with semantic search after guide initialization
  const fragments = await manager.listFragments();
  manager.semanticSearch?.indexFragments(fragments);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Server started on stdio");

  // Handle shutdown
  const shutdown = async () => {
    logger.info("Shutting down server...");
    await manager.shutdown();
    await guideManager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
