# Continuo Roadmap

## What is Continuo?

Continuo is a token-aware persistent memory MCP server for AI agents. It provides semantic search, priority-based context selection, procedural knowledge (Guides), and session tracking — all with zero external dependencies using pure TypeScript/Bun and JSONL file storage.

## Current Capabilities

### Core Memory
- **Semantic Search** — TF-IDF + cosine similarity, no embeddings required
- **Temporal Awareness** — Detects temporal intent in queries, boosts recent/updated content
- **Co-occurrence Expansion** — Spreading activation via PMI-weighted related terms
- **Token Budget Awareness** — Selects context within configurable token limits
- **Priority System** — Critical/High/Normal/Low with multipliers (high=50% cost, low=200% cost)
- **Confidence Decay** — Forgetting curve simulation with 90-day half-life after 30-day grace period

### Data Management
- **Deduplication on Write** — Jaccard similarity (0.85 threshold) prevents duplicate facts
- **Input Validation** — Rejects empty/whitespace content and fragments >10k characters
- **Auto Sub-fact Extraction** — Large fragments (>150 words) split into retrievable sub-facts
- **Fragment TTL** — Optional time-to-live with auto-expiration
- **Compression** — Token-efficient compression with non-destructive undo backup
- **Export/Import** — JSON backup and migration between instances

### Intelligence
- **Memory Extract** — Heuristic fact extraction (preferences, facts, solutions, constants, versions, errors, key-values)
- **Memory Suggest** — Proactive analysis (guide candidates, stale fragments, duplicates, budget warnings, orphans, frequent queries)
- **Auto-prioritization** — Promotes frequently accessed fragments, demotes stale high-priority ones
- **Project Inheritance** — Shared context across related projects via `inherits` array
- **Fragment Versioning** — Track content history (max 10 versions) with `memory_history` tool
- **Query Pattern Tracking** — Record all searches, surface frequent queries as suggestions

### Procedural Knowledge
- **Guides** — Track reusable procedures with usage counts and contextual learnings
- **Guide Suggestions** — Semantic search across guides for task-relevant knowledge
- **Guide Distillation** — Transform memory fragments into guide learnings

### Performance
- **In-memory Fragment Cache** — Eliminates repeated JSONL file scans
- **Session Tracking** — Conversation state with differential updates
- **Memory Stats** — Real-time memory health monitoring

## Benchmark Results

| Benchmark | R@1 | R@5 | MRR | MAP |
|-----------|-----|-----|-----|-----|
| Info Extraction | 80.0% | 100.0% | 88.3% | 88.3% |
| Multi-Session | 41.7% | 100.0% | 100.0% | 92.5% |
| Temporal Reasoning | 90.0% | 100.0% | 100.0% | 96.7% |
| Knowledge Updates | 60.0% | 100.0% | 80.0% | 80.0% |
| Abstention | 0.0% | 0.0% | 0.0% | 80.0% |
| LoCoMo | 90.0% | 100.0% | 95.0% | 95.8% |
| Guide Retrieval | 100.0% | 100.0% | 100.0% | 100.0% |
| Needle-in-Haystack | 100.0% | 100.0% | 100.0% | 100.0% |
| **Weighted Average** | **75.3%** | **90.4%** | **85.3%** | **92.2%** |

## Technical Constraints

- Zero external dependencies (pure TypeScript/Bun)
- JSONL file storage (no SQLite, no Redis)
- MCP protocol only (no HTTP endpoints)
- 60 tests, all passing

## Future Directions

### Short-term Improvements
- **Semantic memory_read Integration** — Full semantic engine ranking instead of just priority-based selection

### Long-term Vision
- **Adaptive Token Budgets** — Learn optimal budgets per project/task type
- **Cross-agent Memory Sharing** — Share memory between different AI agent instances
- **Plugin Architecture** — Allow custom extraction patterns and scoring functions

---

## Changelog

### v0.5.0 — Fragment Versioning, Query Pattern Tracking
- Fragment version history: track previous content on update (max 10 versions)
- `memory_history` tool to view past content at any point in time
- Query pattern tracking: record all memory_read and search_semantic queries
- `memory_queries` tool to view history and top repeated queries
- Frequent queries (3+) surfaced in memory_suggest as guide candidates

### v0.4.0 — Priority Multipliers, Memory Decay, Undo, Export/Import
- Priority multipliers actually affect token budget allocation
- Confidence decay simulates human forgetting curve
- Non-destructive compression with `memory_undo` tool
- Auto project inheritance in `memory_read`
- `memory_export` and `memory_import` for JSON backup/migration
- Auto-prioritization based on access patterns

### v0.3.0 — Cache, TTL, Auto-Extraction, Suggest
- In-memory fragment cache eliminates repeated JSONL scans
- Fragment TTL with auto-expiration
- Auto sub-fact extraction from large fragments
- `memory_extract` tool with 7 pattern types
- `memory_suggest` tool for proactive memory health analysis

### v0.2.0 — Validation, Dedup, Stats, Sessions
- Input validation on `memory_add` (empty, whitespace, length)
- Deduplication on write via Jaccard similarity
- `memory_stats` tool for memory health monitoring
- `session_update` tool wires up dead session code

### v0.1.0 — Foundation
- TF-IDF semantic search with cosine similarity
- Temporal awareness (temporal boost, version conflict detection)
- Co-occurrence query expansion (spreading activation)
- Priority-based context selection with token budgets
- Procedural knowledge (Guides) with usage tracking
- Session tracking with differential updates
