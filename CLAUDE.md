# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Genkit CLI (main development entry)
npm run genkit help              # Show all commands
npm run genkit pdf <file>        # Interactive chat with a PDF
npm run genkit eval <file>       # Extract and evaluate quality
npm run genkit batch <dir> [n]   # Batch process PDFs (n=concurrency)
npm run genkit search "<query>"  # RAG semantic search
npm run genkit export [path]     # Export to CSV
npm run genkit list              # List stored studies

# Build
npm run build                    # Compile TypeScript

# Firebase
firebase emulators:start         # Local development
firebase deploy                  # Deploy hosting + functions
```

## Architecture

Three components:

### 1. Genkit CLI Tool (`src/genkit.ts`)
AI extraction system using Gemini 3 Pro. This is the primary development focus.

**Multi-Agent Worker Pattern**: 6 specialized agents run in parallel:
- `extractMetadata` - Title, authors, hospital, period
- `extractPopulation` - Demographics, GCS, hydrocephalus
- `extractIntervention` - Surgical technique, EVD, duraplasty
- `extractComparator` - Control group details
- `extractOutcomes` - Mortality, mRS, complications
- `extractQuality` - Newcastle-Ottawa Scale assessment

**VerifiableField pattern**: Data points have both `value` and `sourceText` (verbatim quote) for audit trails.

**Dual Storage**: Local JSON (`./data/studies.json`) vs Firestore. Toggle with `USE_FIRESTORE=true`.

**RAG**: Uses `devLocalVectorstore` plugin. Reference by string: `"devLocalVectorstore/studyIndex"` (not object).

**Evaluation Framework**: 4 weighted evaluators run via `evaluateExtraction` flow:
- Schema Completeness (30%) - 8 critical fields
- Source Text Verification (30%) - 12 VerifiableFields have quotes
- NOS Consistency (15%) - Quality scores validate mathematically
- LLM Accuracy (25%) - Gemini verifies against source text

### 2. Web Frontend (`public/index.html`)
Single-file React app for PDF viewing. Uses Firebase Auth + Firestore.

### 3. Firebase Functions (`functions/`)
Gen2 Cloud Functions scaffolding.

## Data Schema

`CerebellarSDCSchema` uses nested `VerifiableField` wrappers:

```typescript
// VerifiableField wraps values with source quotes
VerifiableField<T> = { value: T | null, sourceText: string | null }

CerebellarSDCSchema {
  metadata: { firstAuthor, publicationYear, hospitalCenter, studyPeriod, studyDesign }
  population: { sampleSize, age: {mean: VerifiableField, sd: VerifiableField}, gcs, hydrocephalus, diagnosis }
  intervention: { procedure, technique: VerifiableField, evdUsed: VerifiableField, duraplasty: VerifiableField }
  comparator: { exists, type, description, sampleSize }
  outcomes: { mortality: VerifiableField, mRS_favorable: VerifiableField, lengthOfStay: VerifiableField, complications }
  quality: { selectionScore(0-4), comparabilityScore(0-2), outcomeScore(0-3), totalScore(0-9), biasNotes }
}
```

## MCP Integration

Genkit flows exposed via MCP server. Config in `~/.claude.json` and Claude Desktop config. After restart, flows callable as tools: `extractStudyData`, `checkAndSaveStudy`, `listStudies`, `searchSimilarStudies`, `evaluateExtraction`.

## Environment

- `GOOGLE_GENAI_API_KEY` - Required (in `.env`)
- `USE_FIRESTORE=true` - Switch from local JSON to Firestore
