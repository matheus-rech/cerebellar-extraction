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
npm run genkit critique <file> [--mode=AUTO|REVIEW]  # Validate extraction quality
npm run genkit tables <file> [--json] [--analyze]   # Extract tables with Mistral OCR
npm run genkit figures <file>                       # Extract figures/charts with Mistral OCR

# Genkit Express Server (for frontend integration)
npm run genkit serve 3400        # Start HTTP server on port 3400
npm run genkit serve 3400 --cors # Start with CORS enabled (for cross-origin requests)

# Build
npm run build                    # Compile TypeScript

# Firebase
firebase emulators:start         # Local development (port 5002)
firebase deploy                  # Deploy hosting + functions

# Python Cloud Functions (NEW)
cd functions-python
python test_extraction.py <pdf>  # Test extraction locally with HTML report
firebase deploy --only functions:python  # Deploy Python functions
```

## Architecture

Two main components:

### 1. Web Frontend (`public/index.html`) - PRIMARY

Full-featured React 18 app (3,400+ lines) with Firebase AI Logic integration.

**Features:**

- PDF.js viewer with text selection
- 4-tab layout: Form, Tables, Figures, Chat
- 7 dynamic field types with linked selectors
- Firebase AI Logic (Gemini 3 Pro Preview) - no API key exposure
- QuickCritique real-time validation
- Paper library with Firebase Storage

**Firebase AI Logic Integration:**

```javascript
// Initialized automatically via dynamic import
const { getAI, getGenerativeModel, GoogleAIBackend } = await import('firebase/ai');
const ai = getAI(app, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, { model: 'gemini-3-pro-preview' });

// Two extraction modes:
callGemini(prompt, schema)           // Text-based analysis
callGeminiWithPDF(pdfFile, prompt)   // Native PDF analysis (multimodal vision)
```

**Extraction Division:**

| Task | Tool | Accuracy | Location |
|------|------|----------|----------|
| **Figures/Charts** | Gemini 2.5 Flash | Vision-based | Frontend (Firebase AI Logic) |
| **Tables** | Mistral OCR | 96.12% | Backend (Genkit) |

**Figure Types:** flowchart, bar_chart, line_chart, kaplan_meier, forest_plot, ct_scan, mri, scatter_plot, etc.

**PDF Limits:** 20 MB request, 50 MB per file, 1000 pages max

**Run locally:**

```bash
python3 -m http.server 3000 --directory public
# Open http://localhost:3000
```

**7 Dynamic Field Types:**

1. `StudyArmField` - Treatment groups (auto-links to mortality/mRS/complications)
2. `IndicationField` - Surgical indications
3. `InterventionField` - Surgical techniques
4. `MortalityField` - Mortality data with arm selector dropdown
5. `MRSField` - Modified Rankin Scale with 7-column grid (scores 0-6)
6. `ComplicationField` - Adverse events with arm selector
7. `PredictorField` - Statistical predictors (OR/CI)

**State Management Pattern:**

```javascript
const [fieldArray, setFieldArray] = useState([]);
const addField = () => setFieldArray([...fieldArray, { id: Date.now(), ...defaults }]);
const updateField = (id, field, value) => setFieldArray(fieldArray.map(item =>
  item.id === id ? { ...item, [field]: value } : item
));
const removeField = (id) => setFieldArray(fieldArray.filter(item => item.id !== id));
```

**Firebase:** Firestore for data storage. No authentication required.

### 2. Genkit CLI Tool (`src/genkit.ts`)
AI extraction system using Gemini. Backend processing and batch operations.

**Multi-Agent Worker Pattern**: 6 specialized agents run in parallel:
- `extractMetadata` - Title, authors, hospital, period
- `extractPopulation` - Demographics, GCS, hydrocephalus
- `extractIntervention` - Surgical technique, EVD, duraplasty
- `extractComparator` - Control group details
- `extractOutcomes` - Mortality, mRS, complications
- `extractQuality` - Newcastle-Ottawa Scale assessment

**Streaming Progress**: The `extractStudyData` flow uses `streamSchema` and `sendChunk()` to provide real-time progress updates. Consumers receive `ExtractionProgressSchema` chunks with:
- `agent`: Name of the active agent
- `status`: "started" | "completed" | "error"
- `progress`: 0-1 weighted progress
- `message`: Human-readable status
- `timestamp`: ISO timestamp

**Dotprompt Templates**: Extraction agents use external `.prompt` files in `prompts/`:
- `prompts/extractMetadata.prompt`
- `prompts/extractPopulation.prompt`
- `prompts/extractIntervention.prompt`
- `prompts/extractComparator.prompt`
- `prompts/extractOutcomes.prompt`
- `prompts/extractQuality.prompt`

Prompts use YAML front matter for model config and Handlebars templating. Edit prompts without touching TypeScript code.

**VerifiableField pattern**: Data points have both `value` and `sourceText` (verbatim quote) for audit trails.

**Dual Storage**: Local JSON (`./data/studies.json`) vs Firestore. Toggle with `USE_FIRESTORE=true`.

**RAG**: Uses `devLocalVectorstore` plugin. Reference by string: `"devLocalVectorstore/studyIndex"` (not object).

**Evaluation Framework**: 4 weighted evaluators run via `evaluateExtraction` flow:
- Schema Completeness (30%) - 8 critical fields
- Source Text Verification (30%) - 12 VerifiableFields have quotes
- NOS Consistency (15%) - Quality scores validate mathematically
- LLM Accuracy (25%) - Gemini verifies against source text

**Critique/Reflector Agent System**: 3-layer validation architecture for quality control:
- Layer 1: Programmatic gates (8 instant checks: age, GCS, percentages, NOS scores)
- Layer 2: 8 specialized LLM critics with retry logic (exponential backoff, jitter, 3 retries)
- Layer 3: Evidence anchoring (verifies 12 VerifiableFields have source quotes)
- Two modes: AUTO (batch processing with auto-correct) and REVIEW (manual review with suggestions)
- Toggle via `CRITIQUE_MODE` environment variable or per-call `--mode` flag

**Multi-Agent Critic System** (`src/critics/multi_agent.ts`):

- Triage orchestrator determines which critics to dispatch based on data availability
- Specialized critic agents with inter-agent communication (shareFinding, readFindings, crossReference tools)
- Synthesizer agent aggregates findings and detects consensus vs disagreements
- Agents: mathConsistency, scaleInversion, sourceCitation (with more in development)
- Run via `multiAgentCritique` flow for advanced validation workflows

**Advanced Evaluators** (`src/evaluators.ts`):

Four specialized evaluators with weighted scoring:

- **Faithfulness** (30%): Measures extraction fidelity to source text
- **Answer Relevancy** (15%): Validates data relevance to SDC schema
- **Hallucination Detection** (30%): Detects fabricated medical data (critical for clinical research)
- **Clinical Accuracy** (25%): Domain-specific validation (scale interpretation, medical terminology, clinical logic)
- Run via `runAllEvaluators` flow, returns composite score with pass/fail threshold (≥0.7)

**Chat Sessions** (`createChatSession`, `sendChatMessage`, `getChatHistory`, `listChatSessions` flows):

- Persistent multi-threaded conversations with PDF papers
- SessionStore interface with LocalSessionStore (JSON files) and FirestoreSessionStore implementations
- System prompt includes PDF content (first 50k chars) for context-aware responses
- Thread support for multiple conversation contexts within same session

**Figure Analysis** (`analyzeFigure`, `analyzeFigures` flows):

- Gemini vision-based extraction from figures/charts in PDFs
- FigureDataSchema supports 14 types: flowchart, bar_chart, kaplan_meier, CT scan, etc.
- Batch processing with concurrency control (pLimit)
- Extracts: figure type, caption, data points with confidence scores, clinical relevance

**Mistral OCR Integration** (`src/mistral-ocr.ts`):

High-accuracy document understanding using Mistral's Document AI:

- **Performance**: 96.12% table accuracy, 94.29% math comprehension
- **Cost**: $0.001/page, Speed: 2,000 pages/minute
- **Output**: Markdown with preserved structure + structured JSON

**Genkit Express Server** (for frontend integration):

The `serve` command starts an HTTP server using `@genkit-ai/express` that exposes Genkit flows as REST endpoints:

```bash
npm run genkit serve 3400         # Start server on port 3400
npm run genkit serve 3400 --cors  # Enable CORS for cross-origin requests
```

**Available Endpoints**:

- `POST /createChatSession` - Create new chat session
- `POST /sendChatMessage` - Send message and get response
- `POST /getChatHistory` - Get session history
- `POST /listChatSessions` - List all sessions
- `POST /deleteChatSession` - Delete a session
- `POST /extractStudyData` - Extract structured data from PDF text
- `POST /checkAndSaveStudy` - Save extracted study with validation
- `POST /listStudies` - List all stored studies
- `POST /searchSimilarStudies` - Semantic search across studies
- `POST /evaluateExtraction` - Run quality evaluation
- `POST /critiqueExtraction` - Run critique/reflector validation
- `POST /quickCritique` - Real-time validation (for frontend)

**Request Format** (Genkit Express convention):

```javascript
// Wrap input in "data" property
const response = await fetch('http://localhost:3400/quickCritique', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: { extractedData: yourData } })
});

// Response is wrapped in "result" property
const { result } = await response.json();
```

**Genkit Flows**:

- `extractWithMistralOCR` - Full extraction (tables + figures + markdown)
- `extractTablesWithMistral` - Tables only (faster)
- `extractFiguresWithMistral` - Figures with BBox annotations
- `mapTableToSchema` - Map table data to CerebellarSDCSchema fields
- `analyzeTableSemantically` - Gemini-powered semantic table understanding

**CLI Commands**:

```bash
npm run genkit tables ./study.pdf              # Extract tables (markdown)
npm run genkit tables ./study.pdf --json       # Output as JSON
npm run genkit tables ./study.pdf --analyze    # With Gemini semantic analysis
npm run genkit figures ./study.pdf             # Extract figures/charts
```

**Table Types Detected**:

- demographics, baseline, outcomes, complications
- flowchart, statistical, imaging, surgical, other

**Schema Mapping**: Tables are automatically mapped to CerebellarSDCSchema fields via `mapTableToSchemaFields()`, enabling "Use in Form" functionality.

**Environment**: Requires `MISTRAL_API_KEY` in `.env` file.

**Evaluation Dataset System** (`src/evaluation/dataset.ts`):

Implements Hybrid Approach for building benchmark datasets with 3 phases:

- **Phase 1 (Baseline)**: 15-paper regression baseline + 5 ground truth annotations
- **Phase 2 (Expanded)**: 20 ground truth + 10 challenge cases
- **Phase 3 (Expert)**: 50 papers with inter-rater reliability

**Key Components**:

- `GroundTruthSchema`: Field-level annotations with source evidence, annotator confidence
- `createGroundTruth` flow: Initialize ground truth template for a study
- `annotateField` flow: Add/update field annotations with verbatim source quotes
- `evaluateAgainstGroundTruth` flow: Compare extraction with ground truth, calculate field-level precision/recall
- `generateEvaluationReport` flow: Aggregate metrics stratified by study design and difficulty

**Evaluation Metrics**:

- Field-level precision/recall (weighted by clinical importance)
- Source grounding rate (% of VerifiableFields with valid quotes)
- NOS consistency (Newcastle-Ottawa Scale mathematical validity)
- Error breakdown: missing, hallucination, inaccurate, partial, correct
- Critical field accuracy (high-importance fields weighted higher)

**CLI Commands**:

- `npm run genkit annotate <study_id>` - Interactive annotation session
- `npm run genkit evaluate-dataset <study_id>` - Evaluate extraction against ground truth
- `npm run genkit report [phase]` - Generate aggregate evaluation report

**Storage**: `./evaluation-dataset/` directory with JSON files for ground truth and results

### 3. Python Cloud Functions (`functions-python/`)
9 specialized Cloud Functions for PDF processing with visual evidence capture.

**Core Extraction:**
- `extract_for_llm` - Markdown with multi-column support (pymupdf4llm)
- `extract_tables` - Structured table data
- `extract_text_with_layout` - Layout-preserving (pdfplumber)
- `detect_sections` - Auto-detect Abstract, Methods, Results

**Visual Evidence (NEW):**
- `capture_highlights` - Screenshot text with yellow highlights
- `generate_html_report` - HTML report with embedded screenshots
- `extract_figures` - Extract images/figures from pages

Run `python test_extraction.py <pdf>` to generate `extraction_report.html` with visual evidence.

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

## Critical Implementation Details

### Frontend Dynamic Fields
When adding new dynamic field types to the Form tab:
1. Create field component (e.g., `NewFieldType`)
2. Add state array and handlers (add/update/remove)
3. If field needs study arm selector, accept `availableArms` prop
4. Add to `ExtractionForm` JSX with proper section styling
5. Test add/remove/update flows

### Genkit Vector Store
Always reference by string:
```typescript
// ✓ Correct:
ai.retrieve({ retriever: "devLocalVectorstore/studyIndex" })

// ✗ Wrong:
ai.retrieve({ retriever: studyIndexRetriever })
```

### Testing Frontend
Use Playwright for E2E tests:
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page()
    page.goto('http://127.0.0.1:5002')
    # Test 4 tabs, dynamic fields, arm selectors, etc.
```

## Critique/Reflector Agent System

### Architecture

Three-layer validation system for quality control:

**Layer 1: Programmatic Gates** (instant, free validation)
- Age validation (0-120 years)
- GCS validation (3-15 scale)
- Hydrocephalus percentage (0-100%)
- Sample size validation (positive integer)
- Publication year (1900-current+1)
- NOS score validation (0-9 total, components sum correctly)
- Comparator sampleSize null check

**Layer 2: Specialized LLM Critics** (parallel execution with retry logic)

All Layer 2 critics use exponential backoff retry pattern:

1. `mathConsistencyChecker` - Percentage/N mismatches, subgroup sums
2. `scaleInversionSentinel` - mRS vs GOS confusion (0=good vs 1=death)
3. `etiologySegregator` - Infarction vs hemorrhage outcome segregation
4. `evdConfoundingDetector` - SDC+EVD vs SDC-alone confounding
5. `flowchartConsistencyChecker` - Patient N tracking (screened→excluded→enrolled→analyzed)
6. `surgicalTechniqueClassifier` - Duraplasty, C1 laminectomy documentation
7. `outcomeDefinitionVerifier` - mRS cutoff clarity (0-2 vs 0-3), mortality timepoint
8. `sourceCitationVerifier` - Extracted values match source quotes

**Retry Configuration** (`withRetry` utility in `src/critics/layer2_logic.ts`):

- Max retries: 3 attempts
- Initial delay: 1000ms
- Max delay: 10000ms
- Backoff multiplier: 2x
- Jitter: Random 0-500ms added to delay
- Retryable errors: 429 (rate limit), 500/503 (server errors), timeouts

**Layer 3: Evidence Anchoring**
- Verifies 12 VerifiableFields have source quotes (minimum 10 characters)
- Fields: age.mean, age.sd, technique, evdUsed, duraplasty, mortality, mRS_favorable, lengthOfStay, complications

### Operating Modes

**AUTO Mode** (batch processing with auto-correct):
```bash
npm run genkit critique <pdf> --mode=AUTO
```
- Auto-corrects CRITICAL issues using `suggestedValue`
- Continues processing even if validation fails
- Ideal for batch processing workflows
- Applied corrections returned in `corrections` map

**REVIEW Mode** (manual review with suggestions):
```bash
npm run genkit critique <pdf> --mode=REVIEW
```
- Returns failed status if validation fails
- Blocks saving until issues are addressed
- Provides `suggestedValue` for human review
- Ideal for high-stakes single-paper extraction

**Default Mode**: Set via `CRITIQUE_MODE` environment variable (defaults to REVIEW)

### Integration with checkAndSaveStudy

The `checkAndSaveStudy` flow accepts optional critique parameters:

```typescript
await checkAndSaveStudy({
  extractedData,
  pdfText,          // Required for critique
  runCritique: true,
  critiqueMode: "REVIEW"  // or "AUTO"
});
```

**Behavior**:
- If `runCritique=false`: Standard duplicate check + save
- If `runCritique=true` + `critiqueMode=REVIEW`: Blocks saving if validation fails, returns `status: "failed_critique"`
- If `runCritique=true` + `critiqueMode=AUTO`: Auto-corrects CRITICAL issues, continues with save

**Output Schema**:
```typescript
{
  status: "saved" | "flagged_duplicate" | "failed_critique" | "error",
  docId: string | null,
  duplicateReport: DuplicateAssessment | null,
  critiqueReport: CritiqueResult | null,
  message: string
}
```

### CritiqueResult Schema

```typescript
{
  mode: "AUTO" | "REVIEW",
  passedValidation: boolean,
  overallConfidence: number,  // 0-1 weighted average
  issues: Array<{
    criticId: string,
    severity: "CRITICAL" | "WARNING" | "INFO",
    field: string,                    // e.g., "population.age.mean"
    message: string,
    currentValue: unknown,
    suggestedValue: unknown | null,
    sourceEvidence: string | null,
    autoCorrectApplied: boolean
  }>,
  corrections: Record<string, unknown>,  // AUTO mode only
  summary: string,
  layer1Results: { passed: boolean, errors: string[] },
  layer2Results: Array<{
    criticId: string,
    passed: boolean,
    confidence: number,
    issues: CritiqueIssue[]
  }>,
  layer3Results: {
    evidenceAnchored: boolean,
    missingSourceFields: string[]
  }
}
```

### Domain-Specific Checks

**Scale Confusion** (most common error):
- mRS: 0=no symptoms, 6=death (lower is better)
- GOS: 1=death, 5=good recovery (higher is better)
- GOS-E: 1=death, 8=upper good recovery (higher is better)
- Critic checks for inverted interpretations

**EVD Confounding**:
- Studies often conflate SDC+EVD vs SDC-alone outcomes
- Critic flags when EVD usage isn't stratified in outcomes

**Mathematical Consistency**:
- Percentages must match N values
- Subgroups (infarction + hemorrhage) should sum to total
- Mortality + survivors should equal sample size

**Flowchart Tracking**:
- Screened → Excluded → Enrolled → Analyzed
- Each step should have documented N values
- Losses to follow-up should be explained

## MCP Integration

### Starting the Genkit Server

```bash
# Start Genkit runtime (REQUIRED for MCP to discover flows)
npx genkit start -- node dist/genkit.js

# This starts:
# - Developer UI: http://localhost:4001
# - Reflection API: http://localhost:3100 (or 3101 if busy)
# - Telemetry: http://localhost:4036
```

### Available Genkit Flows (32+ total)

| Flow | Purpose |
|------|---------|
| `extractStudyData` | Main orchestrator - runs 6 agents in parallel with streaming progress |
| `extractMetadata` | Title, authors, hospital, period |
| `extractPopulation` | Demographics, GCS, hydrocephalus |
| `extractIntervention` | Surgical technique, EVD, duraplasty |
| `extractComparator` | Control group details |
| `extractOutcomes` | Mortality, mRS, complications |
| `extractQuality` | Newcastle-Ottawa Scale assessment |
| `critiqueExtraction` | Main critique orchestrator - runs 3-layer validation with human review interrupt |
| `quickCritique` | Fast Layer 1 + Layer 3 validation for real-time UI feedback |
| `multiAgentCritique` | Multi-agent critic system with triage, inter-agent communication, synthesis |
| `mathConsistencyChecker` | Detects percentage/N mismatches, subgroup sum errors |
| `scaleInversionSentinel` | Catches mRS vs GOS confusion (#1 error) |
| `etiologySegregator` | Verifies infarction vs hemorrhage segregation |
| `evdConfoundingDetector` | Detects SDC+EVD vs SDC-alone confounding |
| `flowchartConsistencyChecker` | Tracks patient N through study timeline |
| `surgicalTechniqueClassifier` | Verifies duraplasty, C1 laminectomy documentation |
| `outcomeDefinitionVerifier` | Checks mRS cutoff and mortality timepoint clarity |
| `sourceCitationVerifier` | Verifies extracted values match source quotes |
| `runAllEvaluators` | Composite evaluation (Faithfulness, Relevancy, Hallucination, Clinical) |
| `createChatSession` | Create or resume PDF chat session with thread support |
| `sendChatMessage` | Send message in chat session (includes PDF context in prompt) |
| `getChatHistory` | Retrieve chat history for a session/thread |
| `listChatSessions` | List all active chat sessions |
| `analyzeFigure` | Gemini vision-based figure/chart extraction from PDF page |
| `analyzeFigures` | Batch figure analysis with concurrency control |
| `checkAndSaveStudy` | Validate and save to storage (with optional critique) |
| `listStudies` | List stored studies |
| `searchSimilarStudies` | RAG semantic search |
| `evaluateExtraction` | Legacy quality evaluation (4 evaluators) |
| `exportDatasetToCSV` | Export to CSV |
| `batchProcessPDFs` | Batch processing with parallel execution |
| `chat` | Interactive chat with PDF |

### MCP Configuration

Config file at `.mcp.json` enables Claude Code integration:

```json
{
  "mcpServers": {
    "genkit-cerebellar": {
      "command": "/Users/matheusrech/.nvm/versions/node/v20.19.4/bin/node",
      "args": ["./node_modules/.bin/genkit", "mcp"],
      "cwd": "/Users/matheusrech/cerebellar-extraction",
      "timeout": 60000,
      "trust": true,
      "env": {
        "PATH": "/Users/matheusrech/.nvm/versions/node/v20.19.4/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Human Review Interrupt Tool**: In REVIEW mode, `critiqueExtraction` can pause for human decisions:

```typescript
// Tool pauses flow and returns review request
humanReviewTool({
  issues: criticalIssues,
  summary: "3 critical issues require review",
  extractedData,
  confidence: 0.45
})

// Response schema
{
  approved: boolean,
  decisions: [{field, action: "accept"|"reject"|"modify", customValue?, rationale?}],
  notes?: string
}
```

### Testing Flow Execution

```bash
# List flows via Reflection API
curl http://localhost:3101/api/actions | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k) for k in d if '/flow/' in k]"

# Run a flow
curl -X POST http://localhost:3101/api/runAction \
  -H "Content-Type: application/json" \
  -d '{"key":"/flow/listStudies","input":{}}'
```

## Testing

### End-to-End Tests (Playwright)

```bash
npm run test:e2e              # Run all E2E tests (headless)
npm run test:e2e:ui           # Run tests with Playwright UI
npm run test:e2e:headed       # Run tests in headed browser
npm run test:e2e:debug        # Run tests in debug mode
```

**Test Files** (in root directory):

- `test_features.py` - Frontend feature tests (4 tabs, dynamic fields)
- `test_dropdown.py` - Study arm selector integration tests
- `test_console.py` - Browser console error detection
- `test_citation_jump.py` - Citation navigation tests
- `test_tooltip.py` - UI tooltip functionality

**Testing Strategy**:

- Use Playwright for frontend E2E tests
- Test 4-tab architecture (Form, Tables, Figures, Chat)
- Validate dynamic field add/remove/update flows
- Verify linked selector system (study arms → mortality/mRS/complications)
- Check console for errors during critical workflows

## Environment

- `GOOGLE_GENAI_API_KEY` - Required (in `.env`)
- `USE_FIRESTORE=true` - Switch from local JSON to Firestore
- `CRITIQUE_MODE=AUTO|REVIEW` - Default critique mode (defaults to REVIEW if not set)

<genkit_prompts hash="9017b550">
<!-- Genkit Context - Auto-generated, do not edit -->

Genkit Framework Instructions:
 - @./GENKIT.md

</genkit_prompts>