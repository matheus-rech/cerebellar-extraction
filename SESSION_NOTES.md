# Cerebellar Extraction - Session Notes (2025-11-25)

## Completed Features

### 1. Local Storage Mode
- **File**: `./data/studies.json`
- **Toggle**: `USE_FIRESTORE=true` for production Firestore
- **Functions**: `loadLocalStudies()`, `saveLocalStudies()`, `generateId()`

### 2. RAG with Local Vector Store
- **Package**: `@genkit-ai/dev-local-vectorstore`
- **Embedder**: `text-embedding-004`
- **Index**: `"devLocalVectorstore/studyIndex"`
- **Usage**: `npm run genkit search "cerebellar mortality"`

### 3. MCP Server Integration
Configured in two locations:

**Claude Code** (`~/.claude.json` under project `/Users/matheusrech/cerebellar-extraction`):
```json
{
  "genkit-cerebellar": {
    "type": "stdio",
    "command": "genkit",
    "args": ["mcp", "--project-root", "/Users/matheusrech/cerebellar-extraction"],
    "env": {}
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "genkit-cerebellar": {
    "command": "genkit",
    "args": ["mcp", "--project-root", "/Users/matheusrech/cerebellar-extraction"],
    "env": {
      "GOOGLE_GENAI_API_KEY": "AIzaSyA8U9dUHMBS2gK4tdHBRzTwR8-qb3QoG2k"
    }
  }
}
```

**Exposed Flows via MCP**:
- `extractStudyData` - Extract PICO data from PDF text
- `checkAndSaveStudy` - Duplicate detection + save
- `listStudies` - List all stored studies
- `searchSimilarStudies` - RAG semantic search
- `evaluateExtraction` - Quality assessment

### 4. Evaluation Framework

**Four Evaluators**:
1. `schemaCompletenessEvaluator` (30% weight) - 8 critical fields
2. `sourceTextVerificationEvaluator` (30% weight) - 12 VerifiableFields
3. `nosConsistencyEvaluator` (15% weight) - NOS score validation
4. `llmAccuracyEvaluator` (25% weight) - Gemini verifies against source

**Usage**: `npm run genkit eval ./study.pdf`

## CLI Commands

```bash
npm run genkit help        # Show all commands
npm run genkit chat        # Collaborate with Gemini
npm run genkit pdf <file>  # Interactive chat with PDF
npm run genkit eval <file> # Extract + evaluate quality
npm run genkit batch <dir> # Batch process PDFs
npm run genkit search <q>  # RAG semantic search
npm run genkit export      # Export to CSV
npm run genkit list        # List all studies
```

## Key Technical Decisions

1. **String-based retriever/indexer references**: Use `"devLocalVectorstore/studyIndex"` instead of object references to avoid initialization issues

2. **Dual storage mode**: Local JSON for development, Firestore for production (lazy-loaded)

3. **RAG indexing with try/catch**: Prevents RAG errors from breaking main extraction workflow

4. **Weighted evaluation scores**: Balances mechanical checks (completeness, consistency) with semantic verification (LLM accuracy)

## Files Modified

- `src/genkit.ts` - Main application (all features added here)
- `~/.claude.json` - Claude Code MCP config
- `~/Library/Application Support/Claude/claude_desktop_config.json` - Claude Desktop MCP config

## Next Steps After Restart

1. Verify MCP server is running: Look for "genkit-cerebellar" in Claude's MCP tools
2. Test with: "List available Genkit flows" or "Use genkit-cerebellar to list studies"
3. Run evaluation on a real PDF: `npm run genkit eval ./pdfs/sample.pdf`

## Firebase MCP (User Added)
User also added: `claude mcp add firebase npx -- -y firebase-tools@latest mcp`
