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

**VerifiableField pattern**: Data points have both `value` and `sourceText` (verbatim quote) for audit trails.

**Dual Storage**: Local JSON (`./data/studies.json`) vs Firestore. Toggle with `USE_FIRESTORE=true`.

**RAG**: Uses `devLocalVectorstore` plugin. Reference by string: `"devLocalVectorstore/studyIndex"` (not object).

**Evaluation Framework**: 4 weighted evaluators run via `evaluateExtraction` flow:
- Schema Completeness (30%) - 8 critical fields
- Source Text Verification (30%) - 12 VerifiableFields have quotes
- NOS Consistency (15%) - Quality scores validate mathematically
- LLM Accuracy (25%) - Gemini verifies against source text

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

## MCP Integration

Genkit flows exposed via MCP server. Config in `~/.claude.json` and Claude Desktop config. After restart, flows callable as tools: `extractStudyData`, `checkAndSaveStudy`, `listStudies`, `searchSimilarStudies`, `evaluateExtraction`.

## Environment

- `GOOGLE_GENAI_API_KEY` - Required (in `.env`)
- `USE_FIRESTORE=true` - Switch from local JSON to Firestore
