/**
 * Continuo - Advanced MCP Memory & Context Server
 * Entry point
 */

import { startServer } from "./server/index.js";
import { createLogger } from "./utils/logging.js";

const logger = createLogger("main");

// Parse environment configuration
const config = {
  name: "continuo",
  version: "1.0.0",
  storagePath: process.env["CONTINUO_STORAGE_PATH"] ?? "~/.continuo",
  defaultTokenBudget: Number.parseInt(process.env["CONTINUO_TOKEN_BUDGET"] ?? "8000", 10),
  sessionTtl: Number.parseInt(process.env["CONTINUO_SESSION_TTL"] ?? "3600000", 10),
  maxSessions: Number.parseInt(process.env["CONTINUO_MAX_SESSIONS"] ?? "100", 10),
};

// Start the server
logger.info("Starting Continuo server", config);

startServer(config).catch((error) => {
  logger.error("Failed to start server", error);
  process.exit(1);
});
