# Continuo

Token-aware persistent memory and procedural knowledge server for AI agents. Built as an MCP server using pure TypeScript — the only runtime dependency is the MCP SDK itself.

## Why Continuo

AI assistants lose context between conversations. RAG systems retrieve irrelevant documents. Prompt-based memory management wastes tokens. Continuo provides a retrieval layer that understands **temporal recency**, **knowledge versioning**, and **semantic associations** — using TF-IDF instead of embeddings, JSONL files instead of a database, and a single runtime dependency instead of a stack.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AI Agent (LLM)                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP Protocol
┌──────────────────────────▼──────────────────────────────────┐
│                    Continuo Server                        │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  Memory     │  │   Guides     │  │  Semantic Search    │ │
│  │  Manager    │  │   Manager    │  │  Engine            │ │
│  │             │  │             │  │                    │ │
│  │ - Fragments │  │ - Procedural │  │ - TF-IDF + cosine  │ │
│  │ - Priority  │  │   knowledge  │  │ - Temporal boost   │ │
│  │ - Token     │  │ - Usage      │  │ - Co-occurrence   │ │
│  │   budgets   │  │   tracking  │  │   expansion        │ │
│  │ - Project   │  │ - Categories │  │ - Version conflict │ │
│  │   inheritance│ │             │  │   detection        │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬─────────┘ │
│         │                │                      │           │
│  ┌──────▼────────────────▼──────────────────────▼─────────┐ │
│  │              Atomic File Storage (JSONL)               │ │
│  │         ~/.continuo/fragments.jsonl                 │ │
│  │         ~/.continuo/guides.jsonl                     │ │
│  │         ~/.continuo/sessions.json                    │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Search Engine

TF-IDF with cosine similarity, augmented with three techniques:

### Temporal Awareness

Queries like "What does the user currently live?" or "What is the latest API rate limit?" trigger temporal scoring that promotes recent/updated fragments. Detects temporal intent markers ("current", "latest", specific years) and boosts fragments with freshness signals.

### Version Conflict Detection

When multiple fragments share a base title (e.g., "API Rate Limit - Original" and "API Rate Limit - Updated"), the system demotes unmarked versions and promotes marked ones.

### Co-occurrence Expansion

PMI-weighted term-term associations built from the indexed corpus. When TF-IDF scores are weak (< 0.5), the query is expanded with associated terms.

## Benchmark Results

Evaluated against LongMemEval (ICLR 2025) and LoCoMo (ACL 2024) retrieval tracks:

| Benchmark | Metric | Score |
|-----------|--------|-------|
| LongMemEval: Information Extraction | R@1 | 80.0% |
| LongMemEval: Multi-Session Reasoning | R@5 | 100.0% |
| LongMemEval: Temporal Reasoning | R@1 | 90.0% |
| LongMemEval: Knowledge Updates | R@1 | 60.0% |
| LongMemEval: Abstention | MAP | 80.0% |
| LoCoMo: Long Conversational Memory | R@1 | 90.0% |
| Guide Retrieval: Procedural Knowledge | R@1 | 100.0% |
| Needle-in-a-Haystack (100+ corpus) | R@1 | 100.0% |
| **Weighted Average** | **R@1** | **75.3%** |

Reference: LongMemEval reports BM25 retrieval R@5 at ~65-75% (session-level) and dense retrieval R@5 at ~70-80%.

## Limitations

- **TF-IDF, not embeddings** — Search relies on term overlap, not semantic understanding. "Where does the user live?" won't match a fragment containing "residence" unless the term appears. This is the main tradeoff for zero-dependency search. Embeddings would significantly improve recall but require an external model.

- **JSONL file storage** — Every read/write scans or rewrites the entire file. Works well for hundreds of fragments. Performance will degrade with thousands. No indexing beyond what's loaded into memory.

- **Single-process only** — The in-memory cache means one MCP server instance per storage directory. Multiple clients writing to the same `~/.continuo/` will have stale caches.

- **Plaintext storage** — Fragments are stored as readable JSONL. Don't store passwords, API keys, or other sensitive data.

- **Abstention doesn't work** — R@1 for the abstention benchmark is 0%. The system returns results when it should return nothing. This is a fundamental limitation of the scoring approach — there's no confidence threshold below which the system refuses to answer.

- **Knowledge Updates R@1 is 60%** — When content has multiple versions, the updated version doesn't always rank first. Temporal boosting helps but doesn't fully solve this.

- **Query history grows unbounded** — `query-history.jsonl` accumulates every search forever. No automatic cleanup.

## Installation

```bash
cd /path/to/continuo
bun install
```

Runtime dependency: `@modelcontextprotocol/sdk`. Dev dependencies: TypeScript, Biome (linter). That's it.

## Configuration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "continuo": {
      "command": "bun",
      "args": ["run", "/path/to/continuo/src/index.ts"]
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTINUO_STORAGE_PATH` | `~/.continuo` | Storage directory |
| `CONTINUO_TOKEN_BUDGET` | `8000` | Default token budget for reads |
| `CONTINUO_SESSION_TTL` | `3600000` | Session expiry in ms (1 hour) |
| `CONTINUO_MAX_SESSIONS` | `100` | Max concurrent sessions |

## Tools

### Memory

| Tool | Purpose |
|------|---------|
| `memory_read` | Read fragments with token budget, project filter, semantic query |
| `memory_add` | Store a new memory fragment with metadata |
| `memory_add_batch` | Store multiple fragments in one operation |
| `memory_update` | Update an existing fragment |
| `memory_delete` | Delete a fragment by ID |
| `memory_delete_batch` | Delete multiple fragments in one operation |
| `memory_list` | List fragments with optional filtering |
| `memory_compress` | Compress similar low-priority fragments (non-destructive) |
| `memory_undo` | Restore last compressed fragments |
| `memory_export` | Export all fragments as JSON |
| `memory_import` | Import fragments from JSON |
| `memory_stats` | Memory health statistics |
| `memory_extract` | Extract storeable facts from raw text |
| `memory_suggest` | Proactive suggestions based on memory state |
| `memory_history` | View version history for a fragment |
| `memory_queries` | View search query history and patterns |

### Guides (Procedural Knowledge)

| Tool | Purpose |
|------|---------|
| `guide_create` | Create a procedural knowledge guide |
| `guide_get` | Retrieve a guide by name or ID |
| `guide_list` | List guides with category/sort filtering |
| `guide_suggest` | Suggest relevant guides for a task |
| `guide_practice` | Record usage with contexts and learnings |
| `guide_update` | Update guide properties |
| `guide_distill` | Extract guide learning from a memory fragment |

### Semantic Search

| Tool | Purpose |
|------|---------|
| `search_semantic` | Cross-fragment and guide semantic search |

### Sessions

| Tool | Purpose |
|------|---------|
| `session_create` | Start a tracked conversation session |
| `session_get` | Get session info and cached context |
| `session_delta` | Get differential updates since last turn |
| `session_close` | Close session and cleanup |
| `session_update` | Update session context and conversation summary |

### Priority

| Tool | Purpose |
|------|---------|
| `priority_set` | Manually set fragment priority |
| `priority_auto` | Auto-prioritize based on access patterns |

## Key Features

### Token Budget Awareness

Fragments are selected to fit within a token budget. Critical-priority fragments are always included. High-priority fragments get a 50% budget discount. Low-priority fragments cost 200%.

```json
{
  "tokenBudget": 4000,
  "project": "api-service"
}
```

### Project Inheritance

Fragments can inherit context from parent projects:

```json
{
  "fragment": "All services use OAuth 2.0",
  "project": "shared-auth"
}
// Later:
{
  "fragment": "User service endpoints...",
  "project": "user-service",
  "inherits": ["shared-auth"]
}
```

### Priority System

Four levels control which fragments survive budget cuts:

- **critical** — Always included, zero budget cost
- **high** — 50% budget cost
- **normal** — Full budget cost
- **low** — 200% budget cost, first to be dropped

### Fragment Versioning

When a fragment is updated (via dedup merge or manual update), the previous content is saved. Up to 10 versions kept per fragment. Query with `memory_history` to see what the AI knew at a given point in time.

### Procedural Knowledge (Guides)

Guides store reusable patterns and workflows. Unlike fragments (facts), guides track usage and accumulate learnings:

```json
{
  "name": "typescript",
  "category": "programming-language",
  "description": "TypeScript patterns and strict typing",
  "contexts": ["readonly", "immutability"],
  "learnings": ["Use readonly arrays for immutable data"]
}
```

## Development

```bash
bun test          # Run test suite (60 tests)
bun run lint     # Lint
bun run lint:fix # Auto-fix lint issues
```

## Project Structure

```
continuo/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── core/
│   │   ├── types.ts          # Types for fragments, guides, sessions
│   │   ├── storage.ts        # Atomic JSONL file storage
│   │   ├── memory.ts         # Fragment CRUD, versioning, query tracking
│   │   ├── guides.ts         # Guide CRUD with usage tracking
│   │   ├── sessions.ts       # Session lifecycle and caching
│   │   ├── context.ts        # Token-aware fragment selection
│   │   ├── prioritization.ts # Priority scoring and confidence decay
│   │   ├── semantic.ts       # TF-IDF + temporal + co-occurrence search
│   │   └── streaming.ts      # Response streaming utilities
│   ├── server/
│   │   ├── index.ts          # Server setup and tool registration
│   │   └── handlers.ts       # MCP tool handlers
│   └── utils/
│       ├── tokens.ts         # Token estimation
│       ├── compression.ts    # Fragment compression
│       └── logging.ts        # Structured logging
├── tests/
│   ├── index.test.ts          # Integration tests
│   └── guides.test.ts        # Guide manager tests
├── package.json
├── tsconfig.json
├── biome.json
├── LICENSE
├── README.md
└── ROADMAP.md
```

## Storage

All data is stored in `~/.continuo/`:

| File | Format | Content |
|------|--------|---------|
| `fragments.jsonl` | JSONL | Memory fragments (with version history) |
| `guides.jsonl` | JSONL | Procedural knowledge guides |
| `sessions.json` | JSON | Active session state |
| `query-history.jsonl` | JSONL | Search query history |

## License

MIT
