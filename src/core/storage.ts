/**
 * Atomic file-based storage with locking.
 * Ensures concurrent access safety for read-modify-write operations.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { createLogger } from "../utils/logging.js";

const logger = createLogger("storage");

/**
 * Storage options.
 */
export interface StorageOptions {
  readonly basePath: string;
  readonly lockTimeout: number;
  readonly lockPollInterval: number;
  /**
   * Delete storage directory on cleanup. Useful for tests.
   * @default false
   */
  readonly cleanup?: boolean;
}

/**
 * Default storage options.
 */
export const DEFAULT_STORAGE_OPTIONS: StorageOptions = {
  basePath: "~/.continuo",
  lockTimeout: 5000,
  lockPollInterval: 50,
} as const;

/**
 * Expand tilde in path.
 */
function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
    return resolve(home, path.slice(2));
  }
  return resolve(path);
}

/**
 * Get lock file path for a given file.
 */
function getLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

/**
 * Atomic storage implementation with file locking.
 */
export class AtomicStorage {
  readonly basePath: string;
  readonly lockTimeout: number;
  readonly lockPollInterval: number;
  readonly cache: Map<string, string>;
  readonly cleanup: boolean;

  constructor(options: Partial<StorageOptions> = {}) {
    const opts = { ...DEFAULT_STORAGE_OPTIONS, ...options };
    this.basePath = expandTilde(opts.basePath);
    this.lockTimeout = opts.lockTimeout;
    this.lockPollInterval = opts.lockPollInterval;
    this.cleanup = opts.cleanup ?? false;
    this.cache = new Map();

    // Ensure base directory exists
    this.ensureDir(this.basePath);
  }

  /**
   * Ensure a directory exists.
   */
  private ensureDir(path: string): void {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      // Ignore if already exists
    }
  }

  /**
   * Get full path for a storage file.
   */
  getStoragePath(...parts: string[]): string {
    const fullPath = join(this.basePath, ...parts);
    this.ensureDir(dirname(fullPath));
    return fullPath;
  }

  /**
   * Execute an operation with a lock held.
   */
  async withLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
    const startTime = Date.now();

    // Try to acquire lock
    while (true) {
      try {
        // Try to create lock file exclusively
        writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
        break; // Lock acquired
      } catch (e) {
        // Check for timeout
        if (Date.now() - startTime > this.lockTimeout) {
          // Check if lock is stale
          try {
            const lockContent = readFileSync(lockPath, "utf-8");
            const lockPid = Number.parseInt(lockContent, 10);

            // Try to check if process is still running
            try {
              process.kill(lockPid, 0);
              // Process is still alive
              throw new Error(`Lock timeout after ${this.lockTimeout}ms`);
            } catch {
              // Process is dead, remove stale lock
              unlinkSync(lockPath);
              logger.warn(`Removed stale lock file: ${lockPath}`);
              continue;
            }
          } catch {
            // Couldn't read or clean lock, give up
            throw new Error(`Lock timeout after ${this.lockTimeout}ms`);
          }
        }

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, this.lockPollInterval));
      }
    }

    try {
      // Execute operation with lock held
      return await operation();
    } finally {
      // Release lock
      try {
        unlinkSync(lockPath);
      } catch {
        logger.warn(`Failed to remove lock file: ${lockPath}`);
      }
    }
  }

  /**
   * Read a file with optional caching.
   */
  async read(path: string, options: { useCache?: boolean } = {}): Promise<string> {
    const fullPath = this.getStoragePath(path);

    if (options.useCache && this.cache.has(fullPath)) {
      return this.cache.get(fullPath)!;
    }

    if (!existsSync(fullPath)) {
      const error = new Error(`File not found: ${path}`) as { code?: string };
      error.code = "ENOENT";
      throw error;
    }

    const content = readFileSync(fullPath, "utf-8");
    this.cache.set(fullPath, content);
    return content;
  }

  /**
   * Write a file atomically.
   */
  async write(path: string, content: string): Promise<void> {
    const fullPath = this.getStoragePath(path);
    const lockPath = getLockPath(fullPath);

    await this.withLock(lockPath, async () => {
      // Write to temp file first
      const tempPath = `${fullPath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tempPath, content, "utf-8");

      // Rename to actual path (atomic on most systems)
      try {
        renameSync(tempPath, fullPath);
      } catch {
        // Fallback for systems without atomic rename
        writeFileSync(fullPath, content, "utf-8");
        try {
          unlinkSync(tempPath);
        } catch {
          // Ignore
        }
      }

      // Update cache
      this.cache.set(fullPath, content);
    });
  }

  /**
   * Execute a transaction (read-modify-write).
   */
  async transaction<T>(
    path: string,
    fn: (current: string) => Promise<{ result: T; newValue: string }>
  ): Promise<T> {
    const fullPath = this.getStoragePath(path);
    const lockPath = getLockPath(fullPath);

    return this.withLock(lockPath, async () => {
      // Invalidate cache for this path
      this.cache.delete(fullPath);

      // Read current content
      let current = "";
      if (existsSync(fullPath)) {
        current = readFileSync(fullPath, "utf-8");
      }

      // Apply transformation
      const { result, newValue } = await fn(current);

      // Write new value
      writeFileSync(fullPath, newValue, "utf-8");
      this.cache.set(fullPath, newValue);

      return result;
    });
  }

  /**
   * Check if a file exists.
   */
  exists(path: string): boolean {
    return existsSync(this.getStoragePath(path));
  }

  /**
   * Delete a file.
   */
  async delete(path: string): Promise<void> {
    const fullPath = this.getStoragePath(path);
    const lockPath = getLockPath(fullPath);

    await this.withLock(lockPath, async () => {
      this.cache.delete(fullPath);
      try {
        unlinkSync(fullPath);
      } catch {
        // Ignore if doesn't exist
      }
    });
  }

  /**
   * List files in a directory.
   */
  list(dir: string): string[] {
    const fullPath = this.getStoragePath(dir);
    try {
      // Use Bun's readdir if available
      // @ts-expect-error - Deno may not exist
      return Array.from(globalThis.Deno?.readDirSync?.(fullPath) ?? []);
    } catch {
      // Fallback - return empty array since we don't have fs.readdir in this scope
      return [];
    }
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache size.
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Cleanup - delete storage directory if cleanup option was enabled.
   * Only deletes if the path is under temp directory or contains "test-" to avoid accidents.
   */
  destroy(): void {
    if (!this.cleanup) {
      return;
    }

    try {
      const realPath = realpathSync(this.basePath);
      const realTempDir = realpathSync(tmpdir());

      // Only delete if under temp directory or contains "test-"
      if (realPath.startsWith(realTempDir) || this.basePath.includes("test-")) {
        rmSync(realPath, { recursive: true, force: true });
        logger.debug("Cleaned up test directory", { path: realPath });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Line-based storage for JSONL files.
 */
export class JsonlStorage<T> {
  readonly storage: AtomicStorage;
  readonly filePath: string;

  constructor(storage: AtomicStorage, filePath: string) {
    this.storage = storage;
    this.filePath = filePath;
  }

  /**
   * Read all lines from a JSONL file.
   */
  async readAll(): Promise<T[]> {
    try {
      const content = await this.storage.read(this.filePath);
      if (!content.trim()) {
        return [];
      }

      const lines = content.split("\n").filter((l) => l.trim());
      return lines.map((line) => JSON.parse(line) as T);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw e;
    }
  }

  /**
   * Write all items to a JSONL file.
   */
  async writeAll(items: readonly T[]): Promise<void> {
    const content = items.map((item) => JSON.stringify(item)).join("\n");
    await this.storage.write(this.filePath, content);
  }

  /**
   * Append an item to a JSONL file.
   */
  async append(item: T): Promise<void> {
    await this.storage.transaction(this.filePath, async (current) => {
      const newLine = JSON.stringify(item);
      const newValue = current.trim() ? `${current}\n${newLine}` : newLine;
      return { result: undefined, newValue };
    });
  }

  /**
   * Update items matching a predicate.
   */
  async update(predicate: (item: T) => boolean, updater: (item: T) => T): Promise<void> {
    await this.storage.transaction(this.filePath, async (current) => {
      const lines = current.split("\n").filter((l) => l.trim());
      const items = lines.map((line) => JSON.parse(line) as T);

      let updated = false;
      const newItems = items.map((item) => {
        if (predicate(item)) {
          updated = true;
          return updater(item);
        }
        return item;
      });

      if (!updated) {
        return { result: undefined, newValue: current };
      }

      const newValue = newItems.map((i) => JSON.stringify(i)).join("\n");
      return { result: undefined, newValue };
    });
  }

  /**
   * Delete items matching a predicate.
   */
  async delete(predicate: (item: T) => boolean): Promise<void> {
    await this.storage.transaction(this.filePath, async (current) => {
      const lines = current.split("\n").filter((l) => l.trim());
      const items = lines.map((line) => JSON.parse(line) as T);

      const filtered = items.filter((item) => !predicate(item));
      const newValue = filtered.map((i) => JSON.stringify(i)).join("\n");

      return { result: undefined, newValue };
    });
  }
}

/**
 * JSON storage for single JSON files.
 */
export class JsonStorage<T> {
  readonly storage: AtomicStorage;
  readonly filePath: string;
  readonly defaultValue: T;

  constructor(storage: AtomicStorage, filePath: string, defaultValue: T) {
    this.storage = storage;
    this.filePath = filePath;
    this.defaultValue = defaultValue;
  }

  /**
   * Read the JSON file.
   */
  async read(): Promise<T> {
    try {
      const content = await this.storage.read(this.filePath);
      return JSON.parse(content) as T;
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") {
        return this.defaultValue;
      }
      throw e;
    }
  }

  /**
   * Write to the JSON file.
   */
  async write(value: T): Promise<void> {
    const content = JSON.stringify(value, null, 2);
    await this.storage.write(this.filePath, content);
  }

  /**
   * Update the JSON value.
   */
  async update(updater: (current: T) => T): Promise<void> {
    await this.storage.transaction(this.filePath, async (current) => {
      const value = current.trim() ? (JSON.parse(current) as T) : this.defaultValue;
      const newValue = updater(value);
      return { result: undefined, newValue: JSON.stringify(newValue, null, 2) };
    });
  }
}
