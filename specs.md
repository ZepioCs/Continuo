# MCP Context in Agents - Research Findings

## Executive Summary

This document outlines the research findings on context management issues in MCP (Model Context Protocol) agents. Three research areas were investigated:
1. Context Window Limitations and Resource Management
2. Context Propagation and Multi-turn Conversations
3. Agent State Management and Context Injection

---

## 1. Context Window Limitations and Resource Management

### Issues Found

#### 1.1 Hard-coded Top-K Truncation
**Severity**: High
**Description**: Lemma and many MCP servers implement hard-coded limits on context retrieval (e.g., `topK = 30` in `searchAndSortFragments`). This creates arbitrary ceilings that don't adapt to:
- Actual token budget available
- Varying fragment sizes
- LLM model context window differences

**Evidence**:
```javascript
// From lemma/src/memory/core.js:260
export function searchAndSortFragments(fragments, query = null, topK = 30) {
  // ... search logic ...
  const fuseResults = fuse.search(query, { limit: topK });
}
```

#### 1.2 No Token-Aware Context Selection
**Severity**: High
**Description**: MCP servers don't have visibility into the actual token budget of the LLM. Resources and tools return data without knowing:
- How many tokens the remaining context can hold
- Whether the response will be truncated
- What the priority of different context elements should be

**Impact**:
- Critical context may be dropped
- Non-essential context consumes token budget
- No dynamic prioritization based on query relevance

#### 1.3 Binary Summary vs Full Content Pattern
**Severity**: Medium
**Description**: Lemma implements a two-tier pattern where summary is shown by default, but full content requires a second API call. This:
- Adds latency (two round-trips)
- May not be optimal for all LLM usage patterns
- Creates cognitive overhead for LLMs to know when to request detail

**Evidence**:
```javascript
// From lemma/src/memory/core.js:318
// SUMMARY MODE: Shows only title + description, not full fragment content
export function formatMemoryForLLM(fragments, currentProject = null) {
  const summary = frag.description || frag.title;
  // Returns summary only, not full fragment
}
```

### Potential Solutions

1. **Token Budget Awareness Protocol**: Add a new MCP capability where clients can inform servers of available token budget
2. **Dynamic Top-K Calculation**: Calculate `topK` based on average fragment size and token budget
3. **Streaming Context Responses**: Allow servers to stream context in priority order, enabling clients to stop when token budget is reached

---

## 2. Context Propagation and Multi-turn Conversations

### Issues Found

#### 2.1 No Built-in Conversation History Management
**Severity**: High
**Description**: MCP itself does not define a standard for conversation history. Each session is stateless - servers don't automatically:
- Track conversation turns
- Maintain reference to previous context
- Know what was already discussed

**Evidence from MCP Spec**:
- MCP uses JSON-RPC 2.0 which is inherently stateless
- No standardized "conversation ID" or "session ID" in base protocol
- Servers must implement their own session tracking if needed

#### 2.2 Roots Feature Underutilization
**Severity**: Medium
**Description**: The MCP "roots" client feature is designed to provide filesystem context, but:
- Not all clients properly implement it
- Servers can't reliably depend on roots being available
- No standardized way to discover what roots a client has configured

**Impact**:
- Servers must guess project context
- Inconsistent behavior across different MCP clients
- Manual project detection required (like Lemma's `detectProject()`)

#### 2.3 Tool Results Don't Automatically Update Context
**Severity**: Medium
**Description**: When a tool is called and returns data, that data doesn't automatically become part of the conversation context for the next turn. The LLM must explicitly:
- Reference the tool result
- Decide if it should be stored
- Manually add it to memory/context

**Evidence**:
```javascript
// From lemma/src/server/handlers.js:8
export async function handleMemoryRead(args) {
  // Returns formatted text, but doesn't auto-inject into conversation history
  return {
    content: [{ type: "text", text: formatted }],
  };
}
```

### Potential Solutions

1. **Session ID Standard**: Add optional session IDs to MCP requests for servers to track conversation state
2. **Context Injection Hints**: Allow servers to mark responses as "should be retained in context"
3. **Root Discovery Protocol**: Standardized way for servers to query available roots from clients

---

## 3. Agent State Management and Context Injection

### Issues Found

#### 3.1 Strict Project Isolation Prevents Context Reuse
**Severity**: Medium
**Description**: Lemma implements STRICT project isolation where project-scoped fragments ONLY return their own project's data, not global.

**Evidence**:
```javascript
// From lemma/src/memory/core.js:204
// STRICT: Return ONLY the specified project's fragments (not global)
return fragments.filter(f => f.project === project);
```

**Impact**:
- Global knowledge (like user preferences) must be duplicated per project
- Cannot share common patterns across projects
- Creates data redundancy

#### 3.2 Race Conditions in Concurrent Tool Calls
**Severity**: Low
**Description**: Multiple concurrent tool calls to the same memory store can cause:
- Lost updates (last write wins)
- Inconsistent state between load/modify/save
- Confidence decay applied multiple times incorrectly

**Evidence**:
```javascript
// From lemma/src/server/handlers.js:14
let memory = core.loadMemory();
memory = core.decayConfidence(memory);
// ... modifications ...
core.saveMemory(core.loadMemory()); // Potential race: load again instead of using modified
```

#### 3.3 No Context Prioritization Mechanism
**Severity**: Medium
**Description**: All context is treated equally when retrieved. There's no way to:
- Mark some context as "always include"
- Tag context as "low priority, drop first"
- Express dependencies between context items

**Impact**:
- Important context may be dropped arbitrarily
- No fine-grained control over what survives truncation

### Potential Solutions

1. **Hierarchical Project Scoping**: Allow projects to "inherit" from global or parent project contexts
2. **Atomic Operations**: Implement proper read-modify-write locking or atomic file operations
3. **Context Priority Tags**: Add optional priority field to fragments for smarter truncation decisions

---

## 4. Additional Findings from Lemma Implementation

### Strengths
- **Confidence Decay**: Biological model where unused memories fade
- **Duplication Prevention**: Jaccard similarity checking prevents redundant entries
- **Fuzzy Search**: Fuse.js integration for typo-tolerant retrieval
- **Two-tier Access**: Summary mode vs detail mode saves tokens

### Architectural Issues
1. **No Sub-second Timestamps**: Created dates are YYYY-MM-DD only, losing granularity
2. **Synchronous File I/O**: `fs.readFileSync` blocks the event loop
3. **No Caching**: Every call loads the entire JSONL file from disk
4. **Memory Leak Risk**: Fragments below 0.1 confidence are filtered, but file is rewritten on every save

---

## Recommendations for Fixing Context Issues

### Immediate (High Priority)
1. **Token Budget Awareness**: Clients should pass available token count to servers
2. **Streaming Context**: Allow priority-ordered streaming of context resources
3. **Fix Race Conditions**: Use atomic file operations or a proper database

### Short-term (Medium Priority)
1. **Session Tracking**: Add optional session ID to MCP protocol
2. **Context Priority Tags**: Allow servers to mark context importance
3. **Project Inheritance**: Enable hierarchical project scoping

### Long-term (Low Priority)
1. **Context Compression**: Server-side summarization of large context sets
2. **Differential Updates**: Only send changed context fragments between turns
3. **Standardized Memory Protocol**: RFC for AI memory systems across MCP

---

## Conclusion

The main issues with context in MCP agents are:

1. **No token budget visibility** - Servers are blind to actual context limits
2. **Stateless protocol** - No built-in conversation history or session tracking
3. **Hard-coded limits** - Fixed top-K values don't adapt to dynamic conditions
4. **Isolation vs reuse tension** - Strict project scoping prevents knowledge sharing

The most impactful fix would be adding **token budget awareness** to the MCP protocol, allowing servers to intelligently select and prioritize context based on actual available space rather than arbitrary limits.

---

*Generated by 3-agent research team: context-researcher-1, context-researcher-2, context-researcher-3*
*Date: 2026-03-21*
