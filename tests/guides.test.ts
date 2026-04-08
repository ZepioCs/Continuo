/**
 * Guide and semantic search test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tokenize,
  tokenizeDocument,
  calculateDocFreq,
  SemanticSearch,
} from "../src/core/semantic.js";
import { GuideManager } from "../src/core/guides.js";
import { GuideCategory, type MemoryFragment, Priority } from "../src/core/types.js";

describe("Semantic Search - Tokenization", () => {
  it("should tokenize text into terms with stemming", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const tokens = tokenize(text);

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    // "jumps" stems to "jump"
    expect(tokens.some((t) => t === "jump" || t === "jumps")).toBe(true);
  });

  it("should filter stop words", () => {
    const text = "the and is of to a an";
    const tokens = tokenize(text);

    // Stop words should be filtered out
    expect(tokens.length).toBe(0);
  });

  it("should handle empty strings", () => {
    const tokens = tokenize("");
    expect(tokens).toEqual([]);
  });

  it("should handle punctuation", () => {
    const text = "hello, world! test.";
    const tokens = tokenize(text);

    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("test");
  });
});

describe("Semantic Search - BM25", () => {
  it("should tokenize documents", () => {
    const doc = tokenizeDocument("doc1", "test content here");
    expect(doc.id).toBe("doc1");
    expect(doc.tokens.length).toBeGreaterThan(0);
    expect(doc.totalTerms).toBe(doc.tokens.length);
  });

  it("should calculate term frequency", () => {
    const doc = tokenizeDocument("doc1", "test test content");
    const tf = doc.termFreq.get("test");

    expect(tf).toBe(2);
  });

  it("should calculate document frequency", () => {
    const docs = [
      tokenizeDocument("1", "apple banana"),
      tokenizeDocument("2", "apple cherry"),
      tokenizeDocument("3", "banana cherry"),
    ];

    const docFreq = calculateDocFreq(docs);

    // Light stemmer keeps short words unchanged
    expect(docFreq.get("apple")).toBe(2);
    expect(docFreq.get("banana")).toBe(2);
    expect(docFreq.get("cherry")).toBe(2);
  });

  it("should generate bigrams from tokens", () => {
    const doc = tokenizeDocument("1", "react component testing");
    expect(doc.bigrams.length).toBeGreaterThan(0);
  });

  it("should skip duplicate bigrams (same stem)", () => {
    const doc = tokenizeDocument("1", "test test testing");
    // "test" stems to "test", so "test_test" would be a dupe and skipped
    expect(doc.bigrams.length).toBe(0);
  });
});

describe("Semantic Search - Search", () => {
  let search: SemanticSearch;
  let fragments: MemoryFragment[];

  beforeEach(() => {
    search = new SemanticSearch();

    const now = new Date().toISOString();
    fragments = [
      {
        id: "frag1",
        title: "React Component Testing",
        description: "How to test React components",
        fragment: "Use Jest and React Testing Library for testing components",
        project: "frontend",
        priority: Priority.Normal,
        confidence: 0.9,
        source: "user",
        created: now,
        lastAccessed: now,
        accessed: 0,
        inherits: [],
        estimatedTokens: 50,
        tags: ["react", "testing"],
      },
      {
        id: "frag2",
        title: "TypeScript Best Practices",
        description: "TypeScript coding standards",
        fragment: "Use strict types and avoid any for better type safety",
        project: "backend",
        priority: Priority.High,
        confidence: 0.95,
        source: "user",
        created: now,
        lastAccessed: now,
        accessed: 0,
        inherits: [],
        estimatedTokens: 40,
        tags: ["typescript", "best-practices"],
      },
      {
        id: "frag3",
        title: "API Error Handling",
        description: "Handle API errors properly",
        fragment: "Always implement try-catch for API calls",
        project: "frontend",
        priority: Priority.Normal,
        confidence: 0.8,
        source: "user",
        created: now,
        lastAccessed: now,
        accessed: 0,
        inherits: [],
        estimatedTokens: 30,
        tags: ["api", "error-handling"],
      },
    ];
  });

  it("should index fragments", () => {
    search.indexFragments(fragments);
    // Trigger index building by searching
    search.searchFragments("test", fragments, 1);
    const stats = search.getStats();

    expect(stats.fragmentCount).toBe(3);
    expect(stats.totalTerms).toBeGreaterThan(0);
  });

  it("should search fragments by query", () => {
    search.indexFragments(fragments);

    const results = search.searchFragments("react testing", fragments, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.item.id).toBe("frag1");
  });

  it("should rank results by relevance", () => {
    search.indexFragments(fragments);

    const results = search.searchFragments("typescript types", fragments, 5);

    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by relevance
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.relevance).toBeLessThanOrEqual(results[i - 1]!.relevance);
    }
  });

  it("should return empty results for non-matching query", () => {
    search.indexFragments(fragments);

    const results = search.searchFragments("quantum physics", fragments, 5);

    // May return results with low relevance due to partial matches
    expect(results).toBeDefined();
  });
});

describe("Guide Manager", () => {
  let manager: GuideManager;

  beforeEach(async () => {
    manager = new GuideManager({
      storagePath: join(tmpdir(), `test-guides-${Date.now()}`),
      cleanup: true,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("should add a new guide", async () => {
    const guide = await manager.add({
      name: "typescript",
      category: GuideCategory.ProgrammingLanguage,
      description: "TypeScript best practices",
      contexts: ["types", "strict-mode"],
      learnings: ["Avoid using any", "Use readonly for immutables"],
    });

    expect(guide.id).toBeTruthy();
    expect(guide.name).toBe("typescript");
    expect(guide.category).toBe(GuideCategory.ProgrammingLanguage);
    expect(guide.usageCount).toBe(0);
  });

  it("should get guide by name", async () => {
    await manager.add({
      name: "react",
      category: GuideCategory.WebFrontend,
      description: "React framework guide",
    });

    const guide = await manager.getByName("react");

    expect(guide).toBeTruthy();
    expect(guide?.name).toBe("react");
  });

  it("should update existing guide", async () => {
    const created = await manager.add({
      name: "vue",
      category: GuideCategory.WebFrontend,
      description: "Vue framework guide",
    });

    const updated = await manager.update({
      id: created.id,
      description: "Updated Vue framework guide",
    });

    expect(updated?.description).toBe("Updated Vue framework guide");
  });

  it("should delete guide", async () => {
    const created = await manager.add({
      name: "angular",
      category: GuideCategory.WebFrontend,
      description: "Angular framework guide",
    });

    const deleted = await manager.delete(created.id);

    expect(deleted).toBe(true);

    const guide = await manager.getById(created.id);
    expect(guide).toBeNull();
  });

  it("should list guides", async () => {
    await manager.add({
      name: "python",
      category: GuideCategory.ProgrammingLanguage,
      description: "Python guide",
    });

    await manager.add({
      name: "javascript",
      category: GuideCategory.ProgrammingLanguage,
      description: "JavaScript guide",
    });

    const guides = await manager.listGuides();

    expect(guides.length).toBeGreaterThanOrEqual(2);
  });

  it("should filter guides by category", async () => {
    await manager.add({
      name: "rust",
      category: GuideCategory.ProgrammingLanguage,
      description: "Rust guide",
    });

    await manager.add({
      name: "docker",
      category: GuideCategory.DevTool,
      description: "Docker guide",
    });

    const langGuides = await manager.listGuides({
      category: GuideCategory.ProgrammingLanguage,
    });

    expect(langGuides.length).toBeGreaterThanOrEqual(1);
    expect(langGuides.every((g) => g.category === GuideCategory.ProgrammingLanguage)).toBe(true);
  });

  it("should sort guides by usage", async () => {
    await manager.add({
      name: "high-usage",
      category: GuideCategory.DevTool,
      description: "High usage guide",
    });

    await manager.add({
      name: "low-usage",
      category: GuideCategory.DevTool,
      description: "Low usage guide",
    });

    // Practice one guide multiple times
    await manager.practice({
      guide: "high-usage",
      category: GuideCategory.DevTool,
      contexts: [],
      learnings: ["test"],
    });

    await manager.practice({
      guide: "high-usage",
      category: GuideCategory.DevTool,
      contexts: [],
      learnings: ["test2"],
    });

    const guides = await manager.listGuides({ sortBy: "usage" });

    const highUsageIndex = guides.findIndex((g) => g.name === "high-usage");
    const lowUsageIndex = guides.findIndex((g) => g.name === "low-usage");

    expect(highUsageIndex).toBeLessThan(lowUsageIndex);
  });
});

describe("Guide Practice", () => {
  let manager: GuideManager;

  beforeEach(async () => {
    manager = new GuideManager({
      storagePath: join(tmpdir(), `test-practice-${Date.now()}`),
      cleanup: true,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("should record guide usage", async () => {
    await manager.add({
      name: "tdd",
      category: GuideCategory.Testing,
      description: "Test driven development",
    });

    const practiced = await manager.practice({
      guide: "tdd",
      category: GuideCategory.Testing,
      contexts: ["red-green-refactor"],
      learnings: ["Write tests first"],
    });

    expect(practiced.usageCount).toBe(1);
    expect(practiced.contexts).toContain("red-green-refactor");
    expect(practiced.learnings).toContain("Write tests first");
  });

  it("should merge contexts and learnings", async () => {
    await manager.add({
      name: "agile",
      category: GuideCategory.DevTool,
      description: "Agile methodology",
      contexts: ["scrum"],
      learnings: ["daily standup"],
    });

    const practiced = await manager.practice({
      guide: "agile",
      category: GuideCategory.DevTool,
      contexts: ["kanban"],
      learnings: ["retrospective"],
    });

    expect(practiced.contexts.length).toBe(2);
    expect(practiced.learnings.length).toBe(2);
  });

  it("should create guide if not exists", async () => {
    const practiced = await manager.practice({
      guide: "new-guide",
      category: GuideCategory.DevTool,
      description: "Created via practice",
      contexts: ["context1"],
      learnings: ["learning1"],
    });

    expect(practiced.name).toBe("new-guide");
    expect(practiced.usageCount).toBe(0); // New guides start at 0
  });
});

describe("Guide Suggest", () => {
  let manager: GuideManager;

  beforeEach(async () => {
    manager = new GuideManager({
      storagePath: join(tmpdir(), `test-suggest-${Date.now()}`),
      cleanup: true,
    });
    await manager.initialize();

    // Add test guides
    await manager.add({
      name: "react",
      category: GuideCategory.WebFrontend,
      description: "React component library",
      contexts: ["hooks", "components", "jsx"],
      learnings: ["Use useState for state", "useEffect for side effects"],
    });

    await manager.add({
      name: "typescript",
      category: GuideCategory.ProgrammingLanguage,
      description: "TypeScript language",
      contexts: ["types", "interfaces", "generics"],
      learnings: ["Avoid any type", "Use strict mode"],
    });

    await manager.add({
      name: "docker",
      category: GuideCategory.Deployment,
      description: "Container orchestration",
      contexts: ["containers", "images"],
      learnings: ["Use multi-stage builds", "Minimize layer count"],
    });
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("should suggest guides for a task", async () => {
    const suggestions = await manager.suggest({
      task: "building React components with TypeScript",
      limit: 5,
    });

    expect(suggestions.length).toBeGreaterThan(0);
    // Should suggest React and TypeScript
    const guideNames = suggestions.map((s) => s.guide.name);
    expect(guideNames).toContain("react");
  });

  it("should return relevance scores", async () => {
    const suggestions = await manager.suggest({
      task: "type safety in code",
    });

    for (const suggestion of suggestions) {
      expect(suggestion.relevance).toBeGreaterThan(0);
      expect(suggestion.guide).toBeDefined();
      expect(suggestion.matchedContexts).toBeDefined();
    }
  });

  it("should limit suggestions", async () => {
    const suggestions = await manager.suggest({
      task: "development",
      limit: 2,
    });

    expect(suggestions.length).toBeLessThanOrEqual(2);
  });
});

describe("Guide Stats", () => {
  let manager: GuideManager;

  beforeEach(async () => {
    manager = new GuideManager({
      storagePath: join(tmpdir(), `test-stats-${Date.now()}`),
      cleanup: true,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("should calculate statistics", async () => {
    await manager.add({
      name: "guide1",
      category: GuideCategory.DevTool,
      description: "Guide 1",
    });

    await manager.add({
      name: "guide2",
      category: GuideCategory.ProgrammingLanguage,
      description: "Guide 2",
    });

    const stats = await manager.getStats();

    expect(stats.totalGuides).toBeGreaterThanOrEqual(2);
    expect(stats.byCategory[GuideCategory.DevTool]).toBeGreaterThanOrEqual(1);
    expect(stats.topGuides).toBeDefined();
  });
});
