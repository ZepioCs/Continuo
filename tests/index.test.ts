/**
 * Continuo test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateTokens,
  estimateTokensAccurate,
  createTokenBudget,
} from "../src/utils/tokens.js";
import {
  ContextCompressor,
} from "../src/utils/compression.js";
import {
  Prioritizer,
} from "../src/core/prioritization.js";
import {
  ContextSelector,
} from "../src/core/context.js";
import {
  MemoryFragment,
  Priority,
  ContextRequest,
  type StreamChunk,
} from "../src/core/types.js";
import { AtomicStorage, JsonlStorage } from "../src/core/storage.js";
import { Logger, LogLevel } from "../src/utils/logging.js";
import { ContextStream } from "../src/core/streaming.js";

describe("Token Estimation", () => {
  it("should estimate tokens by character count", () => {
    const text = "hello world this is a test";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(text.length);
  });

  it("should handle empty strings", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokensAccurate("")).toBe(0);
  });

  it("should estimate more accurately with word counting", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    void estimateTokens(text);
    const accurate = estimateTokensAccurate(text);
    expect(accurate).toBeGreaterThan(0);
  });

  it("should create token budget correctly", () => {
    const budget = createTokenBudget(1000, 300);
    expect(budget.total).toBe(1000);
    expect(budget.used).toBe(300);
    expect(budget.remaining).toBe(700);
  });
});

describe("Logger", () => {
  it("should create logger with config", () => {
    const logger = new Logger({ level: LogLevel.Info, output: "none" });
    expect(logger.config.level).toBe(LogLevel.Info);
  });

  it("should create child logger with context", () => {
    const parent = new Logger({ level: LogLevel.Info, output: "none" });
    const child = parent.withContext({ component: "test" });
    expect(child).toBeDefined();
  });
});

describe("ContextCompressor", () => {
  const compressor = new ContextCompressor();

  it("should compress empty list throws error", () => {
    expect(() => compressor.compress([])).toThrow();
  });

  it("should return single fragment unchanged", () => {
    const fragment: MemoryFragment = {
      id: "1",
      title: "Test",
      description: "Test fragment",
      fragment: "content",
      project: null,
      priority: Priority.Normal,
      confidence: 1,
      source: "user",
      created: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessed: 0,
      inherits: [],
      estimatedTokens: 10,
      tags: [],
    };

    const result = compressor.compress([fragment]);
    expect(result.originalCount).toBe(1);
    expect(result.tokensSaved).toBe(0);
  });

  it("should compress multiple fragments", () => {
    const fragments: MemoryFragment[] = [
      {
        id: "1",
        title: "Test 1",
        description: "First test",
        fragment: "content one",
        project: "test",
        priority: Priority.Normal,
        confidence: 1,
        source: "user",
        created: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        accessed: 0,
        inherits: [],
        estimatedTokens: 50,
        tags: [],
      },
      {
        id: "2",
        title: "Test 2",
        description: "Second test",
        fragment: "content two",
        project: "test",
        priority: Priority.Normal,
        confidence: 1,
        source: "user",
        created: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        accessed: 0,
        inherits: [],
        estimatedTokens: 50,
        tags: [],
      },
    ];

    const result = compressor.compress(fragments);
    expect(result.originalCount).toBe(2);
    expect(result.compressed.title).toContain("Compressed");
  });

  it("should extract key points", () => {
    const longText = "This is a very long text with multiple sentences. It has important information. " +
      "Another sentence here. And one more sentence for good measure. " +
      "Additional text to make it longer for testing compression functionality. " +
      "Even more content to ensure we exceed the token budget.";
    const result = compressor.extractKeyPoints(longText, 50);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(longText.length);
  });

  it("should deduplicate fragments", () => {
    const fragments: MemoryFragment[] = [
      {
        id: "1",
        title: "Test",
        description: "Test",
        fragment: "same content",
        project: null,
        priority: Priority.Normal,
        confidence: 1,
        source: "user",
        created: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        accessed: 0,
        inherits: [],
        estimatedTokens: 50,
        tags: [],
      },
      {
        id: "2",
        title: "Test",
        description: "Test",
        fragment: "same content",
        project: null,
        priority: Priority.Normal,
        confidence: 1,
        source: "user",
        created: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        accessed: 0,
        inherits: [],
        estimatedTokens: 50,
        tags: [],
      },
    ];

    const result = compressor.deduplicate(fragments);
    expect(result.length).toBe(1);
  });
});

describe("Prioritizer", () => {
  const prioritizer = new Prioritizer();

  const createFragment = (
    id: string,
    priority: Priority,
    accessed: number,
    lastAccessed: string
  ): MemoryFragment => ({
    id,
    title: `Fragment ${id}`,
    description: "",
    fragment: "content",
    project: null,
    priority,
    confidence: 0.8,
    source: "user",
    created: new Date().toISOString(),
    lastAccessed,
    accessed,
    inherits: [],
    estimatedTokens: 50,
    tags: [],
  });

  it("should score critical fragments highest", () => {
    const critical = createFragment("1", Priority.Critical, 0, new Date().toISOString());
    const normal = createFragment("2", Priority.Normal, 100, new Date().toISOString());

    const criticalScore = prioritizer.calculateScore(critical);
    const normalScore = prioritizer.calculateScore(normal);

    expect(criticalScore.score).toBeGreaterThan(normalScore.score);
  });

  it("should mark fragments as critical", () => {
    prioritizer.markCritical(["frag_1"]);
    expect(prioritizer.isCritical({ id: "frag_1" } as unknown as MemoryFragment)).toBe(true);
    expect(prioritizer.isCritical({ id: "other" } as unknown as MemoryFragment)).toBe(false);
  });

  it("should sort fragments by score", () => {
    const now = new Date().toISOString();
    const fragments = [
      createFragment("1", Priority.Low, 0, now),
      createFragment("2", Priority.High, 0, now),
      createFragment("3", Priority.Normal, 0, now),
    ];

    const sorted = prioritizer.sortByScore(fragments);
    expect(sorted[0]?.fragment.priority).toBe(Priority.High);
  });

  it("should filter by priority", () => {
    const fragments = [
      createFragment("1", Priority.Low, 0, new Date().toISOString()),
      createFragment("2", Priority.High, 0, new Date().toISOString()),
      createFragment("3", Priority.Normal, 0, new Date().toISOString()),
    ];

    const filtered = prioritizer.filterByPriority(fragments, [Priority.High, Priority.Critical]);
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.priority).toBe(Priority.High);
  });

  it("should group by priority", () => {
    const fragments = [
      createFragment("1", Priority.Low, 0, new Date().toISOString()),
      createFragment("2", Priority.High, 0, new Date().toISOString()),
      createFragment("3", Priority.High, 0, new Date().toISOString()),
    ];

    const grouped = prioritizer.groupByPriority(fragments);
    expect(grouped["high"]?.length).toBe(2);
    expect(grouped["low"]?.length).toBe(1);
  });
});

describe("ContextSelector", () => {
  const prioritizer = new Prioritizer();
  const selector = new ContextSelector(prioritizer, 1000);

  const createFragment = (
    id: string,
    priority: Priority,
    estimatedTokens: number
  ): MemoryFragment => ({
    id,
    title: `Fragment ${id}`,
    description: "",
    fragment: "x".repeat(estimatedTokens * 4),
    project: null,
    priority,
    confidence: 0.8,
    source: "user",
    created: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    accessed: 0,
    inherits: [],
    estimatedTokens,
    tags: [],
  });

  it("should select fragments within budget", () => {
    const fragments = [
      createFragment("1", Priority.High, 300),
      createFragment("2", Priority.Normal, 400),
      createFragment("3", Priority.Low, 500),
    ];

    const request: ContextRequest = { tokenBudget: 500 };
    const result = selector.select(fragments, request);

    expect(result.fragments.length).toBeLessThanOrEqual(2);
    expect(result.totalTokens).toBeLessThanOrEqual(500);
  });

  it("should always include critical fragments", () => {
    const fragments = [
      createFragment("1", Priority.Critical, 800),
      createFragment("2", Priority.Normal, 300),
    ];

    const request: ContextRequest = { tokenBudget: 500 };
    const result = selector.select(fragments, request);

    // Critical should be included even if over budget
    const hasCritical = result.fragments.some((f) => f.id === "1");
    expect(hasCritical).toBe(true);
  });

  it("should filter by project", () => {
    const fragments = [
      createFragment("1", Priority.Normal, 100),
      createFragment("2", Priority.Normal, 100),
      createFragment("3", Priority.Normal, 100),
    ];

    (fragments[1] as { project: string }).project = "test-project";
    (fragments[2] as { project: string }).project = "test-project";

    const request: ContextRequest = { project: "test-project" };
    const result = selector.select(fragments, request);

    expect(result.fragments.length).toBe(2);
  });

  it("should filter by priority levels", () => {
    const fragments = [
      createFragment("1", Priority.Critical, 100),
      createFragment("2", Priority.High, 100),
      createFragment("3", Priority.Normal, 100),
      createFragment("4", Priority.Low, 100),
    ];

    const request: ContextRequest = {
      priorities: [Priority.Critical, Priority.High],
    };
    const result = selector.select(fragments, request);

    expect(result.fragments.length).toBe(2);
    expect(result.fragments.every((f) => f.priority === Priority.Critical || f.priority === Priority.High))
      .toBe(true);
  });
});

describe("ContextStream", () => {
  const stream = new ContextStream();

  const createFragment = (
    id: string,
    priority: Priority,
    estimatedTokens: number
  ): MemoryFragment => ({
    id,
    title: `Fragment ${id}`,
    description: "",
    fragment: "content",
    project: null,
    priority,
    confidence: 0.8,
    source: "user",
    created: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    accessed: 0,
    inherits: [],
    estimatedTokens,
    tags: [],
  });

  it("should stream in priority order", async () => {
    const fragments = [
      createFragment("1", Priority.Low, 100),
      createFragment("2", Priority.Critical, 100),
      createFragment("3", Priority.High, 100),
    ];

    const chunks: StreamChunk[] = [];

    for await (const chunk of stream.streamInPriorityOrder(fragments, 500)) {
      chunks.push(chunk);
    }

    // Critical should be first
    expect(chunks[0]?.fragment.priority).toBe(Priority.Critical);
  });

  it("should stop when budget exceeded", async () => {
    const fragments = [
      createFragment("1", Priority.High, 300),
      createFragment("2", Priority.Normal, 400),
      createFragment("3", Priority.Normal, 400),
    ];

    const chunks: StreamChunk[] = [];

    for await (const chunk of stream.streamInPriorityOrder(fragments, 500)) {
      chunks.push(chunk);
    }

    // Should stop after first or second fragment
    expect(chunks.length).toBeLessThanOrEqual(2);
  });
});

describe("AtomicStorage", () => {
  let storage: AtomicStorage;

  beforeEach(() => {
    storage = new AtomicStorage({
      basePath: join(tmpdir(), "test-storage"),
      cleanup: true,
    });
  });

  afterEach(() => {
    storage.destroy();
  });

  it("should create storage path", () => {
    expect(storage.basePath).toBeTruthy();
    expect(storage.basePath).toContain("test-storage");
  });

  it("should handle lock acquisition", async () => {
    const lockPath = storage.getStoragePath("test.lock");
    let executed = false;

    await storage.withLock(lockPath, async () => {
      executed = true;
    });

    expect(executed).toBe(true);
  });

  it("should read and write files", async () => {
    const path = "test-read-write.txt";
    const content = "test content";

    await storage.write(path, content);
    const read = await storage.read(path);

    expect(read).toBe(content);
  });

  it("should handle transactions", async () => {
    const path = `test-transaction-${Date.now()}.txt`;

    const result = await storage.transaction(path, async (current) => {
      return {
        result: current.length,
        newValue: current + "appended",
      };
    });

    expect(result).toBe(0);

    // Verify the transaction worked
    const content = await storage.read(path);
    expect(content).toBe("appended");
  });
});

describe("JsonlStorage", () => {
  let storage: AtomicStorage;
  let jsonl: JsonlStorage<{ id: string; value: string }>;

  beforeEach(() => {
    storage = new AtomicStorage({
      basePath: join(tmpdir(), `test-jsonl-${Date.now()}`),
      cleanup: true,
    });
    jsonl = new JsonlStorage(storage, "test.jsonl");
  });

  afterEach(() => {
    storage.destroy();
  });

  it("should write and read items", async () => {
    const items = [
      { id: "1", value: "one" },
      { id: "2", value: "two" },
    ];

    await jsonl.writeAll(items);
    const read = await jsonl.readAll();

    expect(read).toEqual(items);
  });

  it("should append items", async () => {
    await jsonl.writeAll([]);
    await jsonl.append({ id: "1", value: "one" });
    await jsonl.append({ id: "2", value: "two" });

    const read = await jsonl.readAll();
    expect(read.length).toBe(2);
  });

  it("should update matching items", async () => {
    await jsonl.writeAll([
      { id: "1", value: "one" },
      { id: "2", value: "two" },
    ]);

    await jsonl.update((item) => item.id === "1", (item) => ({
      ...item,
      value: "updated",
    }));

    const read = await jsonl.readAll();
    expect(read.find((i) => i.id === "1")?.value).toBe("updated");
  });

  it("should delete matching items", async () => {
    await jsonl.writeAll([
      { id: "1", value: "one" },
      { id: "2", value: "two" },
    ]);

    await jsonl.delete((item) => item.id === "1");

    const read = await jsonl.readAll();
    expect(read.length).toBe(1);
    expect(read[0]?.id).toBe("2");
  });
});
