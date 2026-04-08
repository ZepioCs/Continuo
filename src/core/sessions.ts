/**
 * Session tracking and conversation history.
 * Maintains session state across multiple tool calls.
 */

import { createLogger } from "../utils/logging.js";
import { AtomicStorage, JsonStorage } from "./storage.js";
import type { CachedContext, DeltaUpdate, Priority, RawSession, Session } from "./types.js";

const logger = createLogger("sessions");

/**
 * Session manager for tracking conversation state.
 */
export class SessionManager {
  readonly storage: AtomicStorage;
  readonly sessionStore: JsonStorage<RawSession[]>;
  readonly sessions: Map<string, Session>;
  readonly ttl: number;
  readonly maxSessions: number;

  constructor(storage: AtomicStorage, ttl = 3600000, maxSessions = 100) {
    this.storage = storage;
    this.ttl = ttl;
    this.maxSessions = maxSessions;
    this.sessions = new Map();

    // Initialize session storage
    this.sessionStore = new JsonStorage<RawSession[]>(storage, "sessions.json", []);
  }

  /**
   * Initialize by loading existing sessions.
   */
  async initialize(): Promise<void> {
    try {
      const rawSessions = await this.sessionStore.read();
      const now = Date.now();

      for (const raw of rawSessions) {
        // Check if session is still valid
        const lastActivity = new Date(raw.lastActivity).getTime();
        if (now - lastActivity < this.ttl) {
          this.sessions.set(raw.id, {
            ...raw,
            contextCache: new Map(raw.contextCache),
            metadata: raw.metadata,
          });
        }
      }

      // Enforce max sessions limit
      this.enforceSessionLimit();

      logger.info(`Loaded ${this.sessions.size} active sessions`);
    } catch (e) {
      logger.error("Failed to load sessions", e as Error);
    }
  }

  /**
   * Create a new session.
   */
  createSession(metadata?: Record<string, unknown>): Session {
    const id = this.generateId();
    const now = new Date().toISOString();

    const session: Session = {
      id,
      createdAt: now,
      lastActivity: now,
      contextCache: new Map(),
      conversationSummary: "",
      turnCount: 0,
      metadata: metadata ?? {},
    };

    this.sessions.set(id, session);
    this.enforceSessionLimit();
    this.scheduleSave();

    logger.debug("Created session", { id });
    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(id: string): Session | null {
    const session = this.sessions.get(id);

    if (!session) {
      return null;
    }

    // Check if session is expired
    const lastActivity = new Date(session.lastActivity).getTime();
    if (Date.now() - lastActivity > this.ttl) {
      this.sessions.delete(id);
      this.scheduleSave();
      return null;
    }

    return session;
  }

  /**
   * Update session activity timestamp.
   */
  updateActivity(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = new Date().toISOString();
      this.scheduleSave();
    }
  }

  /**
   * Add context to a session.
   */
  addToContext(
    sessionId: string,
    key: string,
    value: unknown,
    priority: Priority = "normal" as Priority
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.contextCache.set(key, {
      key,
      value,
      addedAtTurn: session.turnCount,
      priority,
    });

    // Enforce cache size limit
    this.enforceCacheLimit(session);

    this.scheduleSave();
  }

  /**
   * Get context from a session.
   */
  getContext(sessionId: string, key: string): unknown | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const cached = session.contextCache.get(key);
    return cached?.value ?? null;
  }

  /**
   * Get full context snapshot for a session.
   */
  getContextSnapshot(sessionId: string): readonly CachedContext[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    return Array.from(session.contextCache.values());
  }

  /**
   * Increment turn count for a session.
   */
  incrementTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.turnCount++;
      session.lastActivity = new Date().toISOString();
      this.scheduleSave();
    }
  }

  /**
   * Update conversation summary.
   */
  updateSummary(sessionId: string, summary: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.conversationSummary = summary;
      this.scheduleSave();
    }
  }

  /**
   * Get differential updates since a specific turn.
   */
  getDelta(sessionId: string, lastKnownTurn: number): DeltaUpdate {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const added: CachedContext[] = [];
    const modified: CachedContext[] = [];
    const removedKeys: string[] = [];

    for (const [, cached] of session.contextCache.entries()) {
      if (cached.addedAtTurn > lastKnownTurn) {
        added.push(cached);
      } else {
        // Check if modified (same key, different turn - treating as modified)
        modified.push(cached);
      }
    }

    return {
      sessionId: session.id,
      turnCount: session.turnCount,
      addedContext: added,
      modifiedContext: modified,
      removedKeys,
      conversationSummary: session.conversationSummary,
    };
  }

  /**
   * Close and remove a session.
   */
  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      this.scheduleSave();
      logger.debug("Closed session", { id });
    }
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): readonly Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clean up expired sessions.
   */
  cleanup(): number {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      const lastActivity = new Date(session.lastActivity).getTime();
      if (now - lastActivity > this.ttl) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      this.sessions.delete(id);
    }

    if (expired.length > 0) {
      this.scheduleSave();
      logger.debug("Cleaned up expired sessions", { count: expired.length });
    }

    return expired.length;
  }

  /**
   * Enforce maximum session limit.
   */
  private enforceSessionLimit(): void {
    if (this.sessions.size <= this.maxSessions) {
      return;
    }

    // Sort by last activity (oldest first)
    const entries = Array.from(this.sessions.entries()).sort((a, b) => {
      const aTime = new Date(a[1].lastActivity).getTime();
      const bTime = new Date(b[1].lastActivity).getTime();
      return aTime - bTime;
    });

    // Remove oldest sessions
    const toRemove = entries.slice(0, this.sessions.size - this.maxSessions);
    for (const [id] of toRemove) {
      this.sessions.delete(id);
    }

    logger.debug("Enforced session limit", { removed: toRemove.length });
  }

  /**
   * Enforce cache size limit for a session.
   */
  private enforceCacheLimit(session: Session, maxSize = 100): void {
    if (session.contextCache.size <= maxSize) {
      return;
    }

    // Sort by priority (low to high) then by turn (oldest first)
    const entries = Array.from(session.contextCache.entries()).sort((a, b) => {
      const priorityOrder: Record<Priority, number> = {
        low: 0,
        normal: 1,
        high: 2,
        critical: 3,
      };

      const aPriority = priorityOrder[a[1].priority] ?? 1;
      const bPriority = priorityOrder[b[1].priority] ?? 1;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      return a[1].addedAtTurn - b[1].addedAtTurn;
    });

    // Remove lowest priority entries
    const toRemove = entries.slice(0, session.contextCache.size - maxSize);
    for (const [key] of toRemove) {
      session.contextCache.delete(key);
    }
  }

  /**
   * Schedule a save operation (debounced).
   */
  private scheduleSave(): void {
    // Clear any existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Schedule new save
    this.saveTimeout = setTimeout(() => {
      this.save();
    }, 1000);
  }

  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Save sessions to storage.
   */
  private async save(): Promise<void> {
    try {
      const rawSessions: RawSession[] = Array.from(this.sessions.values()).map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        contextCache: Array.from(s.contextCache.entries()),
        conversationSummary: s.conversationSummary,
        turnCount: s.turnCount,
        metadata: { ...s.metadata },
      }));

      await this.sessionStore.write(rawSessions);
      logger.debug("Saved sessions", { count: rawSessions.length });
    } catch (e) {
      logger.error("Failed to save sessions", e as Error);
    }
  }

  /**
   * Generate a unique session ID.
   */
  private generateId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Shutdown and save all sessions.
   */
  async shutdown(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    await this.save();
    logger.info("Session manager shutdown complete");
  }
}

/**
 * Create a session manager with default storage.
 */
export async function createSessionManager(
  basePath: string,
  ttl?: number,
  maxSessions?: number
): Promise<SessionManager> {
  const storage = new AtomicStorage({ basePath });
  const manager = new SessionManager(storage, ttl, maxSessions);
  await manager.initialize();
  return manager;
}
