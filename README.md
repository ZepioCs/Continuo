# Continuo

Token-aware persistent memory and procedural knowledge server for AI agents. Built as an MCP (Model Context Protocol) server with zero external dependencies.

## Why Continuo

AI assistants lose context between conversations. RAG systems retrieve irrelevant documents. Prompt-based memory management wastes tokens. Continuo solves these problems with a retrieval layer that understands **temporal recency**, **knowledge versioning**, and **semantic associations** - without embeddings, without vector databases, without API keys.

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

The semantic search engine is the core differentiator. It's a pure TF-IDF system augmented with three techniques inspired by human memory:

### Temporal Awareness

Queries like "What does the user currently live?" or "What is the latest API rate limit?" trigger temporal scoring that promotes recent/updated fragments over older ones. This works by detecting temporal intent markers ("current", "latest", specific years), then boosting fragments with freshness signals (tags like "updated", recent year mentions, higher version numbers).

### Version Conflict Detection

When multiple fragments share a base title (e.g., "API Rate Limit - Original" and "API Rate Limit - Updated"), the system detects the conflict and demotes unmarked versions while promoting marked ones. This ensures knowledge updates surface correctly even when queries don't contain explicit temporal words.

### Co-occurrence Expansion (Spreading Activation)

Inspired by associative memory in biological neural networks. The system builds a PMI-weighted term-term association matrix from the indexed corpus. When a query has weak TF-IDF matches (raw score < 0.5), the query is automatically expanded with associated terms. For example, "programming language" activates associations to "PHP", "TypeScript", "backend" based on corpus co-occurrence patterns.

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

## Installation

```bash
cd /path/to/continuo
bun install
```

## Configuration

Add to Claude Desktop config (`claude_desktop_config.json`):

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
| `memory_list` | List fragments with optional filtering |
| `memory_compress` | Compress similar low-priority fragments |

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

### Priority

| Tool | Purpose |
|------|---------|
| `priority_set` | Manually set fragment priority |
| `priority_auto` | Auto-prioritize based on access patterns |

## Key Features

### Token Budget Awareness

Fragments are selected to fit within a token budget. Critical-priority fragments are always included. Normal-priority fragments are ranked by relevance and fit greedily until the budget is exhausted.

```json
{
  "tokenBudget": 4000,
  "project": "api-service"
}
```

### Project Inheritance

Fragments can inherit context from parent projects, enabling shared configuration across related services:

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

Four priority levels control which fragments survive budget cuts:

- **critical** - Always included regardless of budget
- **high** - Included after critical fragments
- **normal** - Included by relevance ranking
- **low** - First to be dropped when budget is tight

### Procedural Knowledge (Guides)

Guides store reusable patterns and workflows. Unlike fragments (facts), guides track how often they're used and accumulate learnings over time:

```json
{
  "name": "typescript",
  "category": "programming-language",
  "description": "TypeScript patterns and strict typing",
  "contexts": ["readonly", "immutability"],
  "learnings": ["Use readonly arrays for immutable data"]
}
```

## Usage

### Start of Session

```json
// Load context from memory
memory_read({"tokenBudget": 4000})
// Find relevant procedural knowledge
guide_suggest({"task": "building React components"})
```

### During Session

```json
// Store important discoveries
memory_add({
  "fragment": "The user prefers dark mode and Tab for indentation.",
  "priority": "high",
  "tags": ["preference", "ui"]
})

// Search across stored knowledge
search_semantic({"query": "authentication flow"})
```

### End of Session

```json
// Record learnings
guide_practice({
  "guide": "typescript",
  "contexts": ["readonly", "generics"],
  "learnings": ["User prefers explicit return types on public methods"]
})
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
│   │   ├── types.ts          # Memory fragment and guide types
│   │   ├── storage.ts        # Atomic JSONL file storage
│   │   ├── memory.ts         # Fragment CRUD with token budgets
│   │   ├── guides.ts         # Guide CRUD with usage tracking
│   │   ├── sessions.ts       # Session lifecycle and caching
│   │   ├── context.ts        # Token-aware fragment selection
│   │   ├── prioritization.ts # Priority scoring and auto-promotion
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
│   ├── memory.test.ts        # Memory manager tests
│   └── guides.test.ts        # Guide manager tests
├── package.json
└── tsconfig.json
```

## Storage

All data is stored in `~/.continuo/`:

| File | Format | Content |
|------|--------|---------|
| `fragments.jsonl` | JSONL | Memory fragments |
| `guides.jsonl` | JSONL | Procedural knowledge guides |
| `sessions.json` | JSON | Active session state |

## License

MIT
