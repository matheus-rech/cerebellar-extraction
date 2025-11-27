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
- Layer 2: 8 specialized LLM critics running in parallel (math consistency, scale inversion, EVD confounding, etc.)
- Layer 3: Evidence anchoring (verifies 12 VerifiableFields have source quotes)
- Two modes: AUTO (batch processing with auto-correct) and REVIEW (manual review with suggestions)
- Toggle via `CRITIQUE_MODE` environment variable or per-call `--mode` flag

### 2. Web Frontend (`public/index.html`)
Single-file React app (3,400+ lines) with CDN-based React 18 and in-browser Babel JSX transformation.

**4-Tab Architecture:**
- **Form** - Comprehensive extraction with 7 integrated dynamic field sections
- **Tables** - Table extraction interface
- **Figures** - Figure/image extraction interface
- **Chat** - Chat with Paper interface

**7 Dynamic Field Types** (integrated in Form tab):
1. `StudyArmField` - Treatment groups (auto-links to mortality/mRS/complications)
2. `IndicationField` - Surgical indications
3. `InterventionField` - Surgical techniques
4. `MortalityField` - Mortality data with arm selector dropdown
5. `MRSField` - Modified Rankin Scale with 7-column grid (scores 0-6)
6. `ComplicationField` - Adverse events with arm selector
7. `PredictorField` - Statistical predictors (OR/CI)

**Linked Selector System:**
Study arms added via `addStudyArm()` automatically populate dropdowns in dependent sections. Pass `availableArms={studyArms.filter(arm => arm.label.trim())}` prop to components that need arm selectors.

**CSS Grid Layouts:**
- `.grid-2col` - Standard 2-column form layout
- `.grid-3col` - 3-column layout for complex fields
- `.grid-mrs` - 7-column grid specifically for mRS scores (0-6)

**State Management Pattern:**
```javascript
const [fieldArray, setFieldArray] = useState([]);

const addField = () => {
  setFieldArray([...fieldArray, { id: Date.now(), ...defaults }]);
};

const updateField = (id, field, value) => {
  setFieldArray(fieldArray.map(item =>
    item.id === id ? { ...item, [field]: value } : item
  ));
};

const removeField = (id) => {
  setFieldArray(fieldArray.filter(item => item.id !== id));
};
```

**Authentication:** Removed - direct app access (no login required).

**Firebase:** Firestore for data storage at `/artifacts/{appId}/users/{userId}/data/`

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

**Layer 2: Specialized LLM Critics** (parallel execution)
1. `mathConsistencyChecker` - Percentage/N mismatches, subgroup sums
2. `scaleInversionSentinel` - mRS vs GOS confusion (0=good vs 1=death)
3. `etiologySegregator` - Infarction vs hemorrhage outcome segregation
4. `evdConfoundingDetector` - SDC+EVD vs SDC-alone confounding
5. `flowchartConsistencyChecker` - Patient N tracking (screened→excluded→enrolled→analyzed)
6. `surgicalTechniqueClassifier` - Duraplasty, C1 laminectomy documentation
7. `outcomeDefinitionVerifier` - mRS cutoff clarity (0-2 vs 0-3), mortality timepoint
8. `sourceCitationVerifier` - Extracted values match source quotes

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

### Available Genkit Flows (24 total)

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
| `mathConsistencyChecker` | Detects percentage/N mismatches, subgroup sum errors |
| `scaleInversionSentinel` | Catches mRS vs GOS confusion (#1 error) |
| `etiologySegregator` | Verifies infarction vs hemorrhage segregation |
| `evdConfoundingDetector` | Detects SDC+EVD vs SDC-alone confounding |
| `flowchartConsistencyChecker` | Tracks patient N through study timeline |
| `surgicalTechniqueClassifier` | Verifies duraplasty, C1 laminectomy documentation |
| `outcomeDefinitionVerifier` | Checks mRS cutoff and mortality timepoint clarity |
| `sourceCitationVerifier` | Verifies extracted values match source quotes |
| `checkAndSaveStudy` | Validate and save to storage (with optional critique) |
| `listStudies` | List stored studies |
| `searchSimilarStudies` | RAG semantic search |
| `evaluateExtraction` | Quality evaluation |
| `exportDatasetToCSV` | Export to CSV |
| `batchProcessPDFs` | Batch processing |
| `chat` | Interactive chat |

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

## Environment

- `GOOGLE_GENAI_API_KEY` - Required (in `.env`)
- `USE_FIRESTORE=true` - Switch from local JSON to Firestore
- `CRITIQUE_MODE=AUTO|REVIEW` - Default critique mode (defaults to REVIEW if not set)

<genkit_prompts hash="9017b550">
<!-- Genkit Context - Auto-generated, do not edit -->

Genkit Framework Instructions:
 - @./GENKIT.md

</genkit_prompts>