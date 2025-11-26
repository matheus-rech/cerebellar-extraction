# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**cerebellar-extraction** is a data extraction tool for systematic reviews of cerebellar stroke research, specifically focused on Suboccipital Decompressive Craniectomy (SDC) studies. It combines AI-powered extraction (Google Gemini), a React web frontend, and Python cloud functions for PDF processing.

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

# Development
npm run dev                      # Run with tsx (development mode)

# Firebase
firebase emulators:start         # Local development (port 5002)
firebase deploy                  # Deploy hosting + functions

# Python Cloud Functions
cd functions-python
python test_extraction.py <pdf>  # Test extraction locally with HTML report
firebase deploy --only functions:python  # Deploy Python functions
```

## Architecture

### Directory Structure

```
cerebellar-extraction/
├── src/                     # Genkit CLI tools (TypeScript)
│   ├── genkit.ts           # Main extraction system (1,900+ lines)
│   ├── claude-citations.ts  # Citation processing
│   ├── pdf-positions.ts     # PDF text positioning
│   └── test-*.ts           # Test files
├── public/                  # Web frontend
│   └── index.html          # Single-file React app (3,400+ lines)
├── functions/              # Node.js Cloud Functions
├── functions-python/       # Python Cloud Functions (pdfplumber)
│   ├── main.py             # Cloud function definitions
│   ├── test_extraction.py  # Local testing with HTML reports
│   └── requirements.txt
├── data/                   # Local JSON storage (development)
│   └── studies.json
├── firebase.json           # Dual codebase config (Node.js + Python 3.12)
├── firestore.rules         # Security rules
└── package.json            # Root package with genkit scripts
```

### Three Main Components

#### 1. Genkit CLI Tool (`src/genkit.ts`)

AI extraction system using **Google Gemini 3 Pro** with the Genkit framework.

**Multi-Agent Worker Pattern**: 6 specialized agents run in parallel via `Promise.all()`:

| Agent | Focus | Key Fields |
|-------|-------|------------|
| `extractMetadata` | Title, abstract, affiliations | firstAuthor, year, hospital, studyPeriod |
| `extractPopulation` | Methods, Table 1 | sampleSize, age, GCS, hydrocephalus |
| `extractIntervention` | Surgical technique section | procedure, technique, EVD, duraplasty |
| `extractComparator` | Control group info | type, description, sampleSize |
| `extractOutcomes` | Results, outcome tables | mortality, mRS, complications, LOS |
| `extractQuality` | Entire paper | NOS scores (selection/comparability/outcome) |

**VerifiableField Pattern**: Data points wrapped with source attribution:
```typescript
VerifiableField<T> = {
  value: T | null,
  sourceText: string | null  // Verbatim quote from paper
}
```

**Dual Storage**: Toggle between local JSON (`./data/studies.json`) and Firestore with `USE_FIRESTORE=true`.

**RAG Search**: Uses `devLocalVectorstore` plugin with `text-embedding-004`. Always reference by string:
```typescript
// Correct:
ai.retrieve({ retriever: "devLocalVectorstore/studyIndex" })

// Wrong (will fail):
ai.retrieve({ retriever: studyIndexRetriever })
```

**Duplicate Detection**: Semantic matching checks hospital, period, author, sample size with confidence levels (High/Medium/Low).

**Evaluation Framework**: 4 weighted evaluators via `evaluateExtraction` flow:

| Evaluator | Weight | Checks |
|-----------|--------|--------|
| Schema Completeness | 30% | 8 critical fields populated |
| Source Text Verification | 30% | 12 VerifiableFields have quotes |
| NOS Consistency | 15% | Quality scores validate mathematically (sum ≤ 9) |
| LLM Accuracy | 25% | Gemini verifies values against source text |

#### 2. Web Frontend (`public/index.html`)

Single-file React app using React 18 via CDN with in-browser Babel JSX transformation.

**4-Tab Architecture**:
- **Form** - Comprehensive extraction with 7 dynamic field sections
- **Tables** - Table extraction interface
- **Figures** - Figure/image extraction interface
- **Chat** - Chat with Paper interface

**7 Dynamic Field Types** (integrated in Form tab):

| Component | Purpose | Key Feature |
|-----------|---------|-------------|
| `StudyArmField` | Treatment groups | Auto-links to mortality/mRS/complications |
| `IndicationField` | Surgical indications | Free text with validation |
| `InterventionField` | Surgical techniques | Procedure details |
| `MortalityField` | Mortality data | Arm selector dropdown |
| `MRSField` | Modified Rankin Scale | 7-column grid (scores 0-6) |
| `ComplicationField` | Adverse events | Arm selector dropdown |
| `PredictorField` | Statistical predictors | OR/CI extraction |

**Linked Selector System**: Study arms populate dependent dropdowns automatically:
```javascript
// Pass available arms to components that need arm selection
<MortalityField
  availableArms={studyArms.filter(arm => arm.label.trim())}
/>
```

**CSS Grid Layouts**:
- `.grid-2col` - Standard 2-column form layout
- `.grid-3col` - 3-column layout for complex fields
- `.grid-mrs` - 7-column grid for mRS scores (0-6)

**State Management Pattern**:
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

**Authentication**: Removed - direct app access without login.

**Firebase**: Firestore at `/artifacts/{appId}/users/{userId}/data/`

#### 3. Python Cloud Functions (`functions-python/`)

PDF processing functions using **pdfplumber** for layout-preserving extraction.

| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| `extract_text_with_layout` | 512MB | 120s | Layout-preserving text extraction |
| `extract_tables` | 512MB | 120s | Structured table extraction |
| `extract_text_positions` | 512MB | 120s | Character-level bounding boxes |
| `detect_sections` | 512MB | 120s | Auto-detect Abstract, Methods, Results |

**Visual Evidence** (via `test_extraction.py`):
- `capture_highlights` - Screenshot text with yellow highlights
- `generate_html_report` - HTML report with embedded screenshots
- `extract_figures` - Extract images/figures from pages

Run `python test_extraction.py <pdf>` to generate `extraction_report.html` with visual evidence.

## Data Schema

`CerebellarSDCSchema` structure with nested `VerifiableField` wrappers:

```typescript
CerebellarSDCSchema {
  metadata: {
    title: string
    firstAuthor: string
    publicationYear: number
    journal: string | null
    hospitalCenter: string
    studyPeriod: string
    studyDesign: "Retrospective" | "Prospective" | "RCT" | "Case Series" | "Other"
  }
  population: {
    sampleSize: number
    age: { mean: VerifiableField<number>, sd: VerifiableField<number>, range: string | null }
    gcs: { admissionMean: VerifiableField<number>, preOpMean: VerifiableField<number> }
    hydrocephalus: VerifiableField<number>  // Percentage 0-100
    diagnosis: string
    inclusionCriteria: string[]
  }
  intervention: {
    procedure: string
    technique: VerifiableField<string>
    evdUsed: VerifiableField<boolean>
    duraplasty: VerifiableField<boolean>
    timingToSurgery: VerifiableField<number>  // Hours
    additionalDetails: string | null
  }
  comparator: {
    exists: boolean
    type: "Medical Management" | "EVD Only" | "Other Surgery" | "None"
    description: string | null
    sampleSize: number | null
  }
  outcomes: {
    mortality: VerifiableField<string>
    mRS_favorable: VerifiableField<string>
    complications: string[]
    lengthOfStay: VerifiableField<number>  // Days
    allOutcomes: OutcomeMetric[]
  }
  quality: {
    selectionScore: number     // 0-4 (NOS Selection)
    comparabilityScore: number // 0-2 (NOS Comparability)
    outcomeScore: number       // 0-3 (NOS Outcome)
    totalScore: number         // 0-9 (Total NOS)
    biasNotes: string
  }
}
```

## Critical Implementation Details

### Adding New Dynamic Field Types to Frontend

1. Create field component (e.g., `NewFieldType`)
2. Add state array and handlers (add/update/remove)
3. If field needs study arm selector, accept `availableArms` prop
4. Add to `ExtractionForm` JSX with proper section styling
5. Test add/remove/update flows

### Genkit Flow Exports

Main flows exported from `genkit.ts`:
- `extractStudyData` - Main parallel extraction orchestrator
- `checkAndSaveStudy` - Duplicate detection + save
- `listStudies` - List all studies
- `searchSimilarStudies` - RAG semantic search
- `evaluateExtraction` - Run 4-evaluator quality assessment

### Testing Frontend with Playwright

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page()
    page.goto('http://127.0.0.1:5002')

    # Test 4 tabs
    page.click('text=Tables')
    page.click('text=Figures')
    page.click('text=Chat')
    page.click('text=Form')

    # Test dynamic fields
    page.click('button:has-text("Add Study Arm")')
    page.fill('input[placeholder="e.g., SDC Group"]', 'Treatment')
```

### Firebase Configuration

Dual codebase support in `firebase.json`:
- `default` codebase: Node.js functions (`functions/`)
- `pdf-processing` codebase: Python 3.12 functions (`functions-python/`)

## MCP Integration

Genkit flows exposed via MCP server. Config in `~/.claude.json` and Claude Desktop config.

Available MCP tools after restart:
- `extractStudyData`
- `checkAndSaveStudy`
- `listStudies`
- `searchSimilarStudies`
- `evaluateExtraction`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_GENAI_API_KEY` | Yes | Google AI API key (in `.env`) |
| `USE_FIRESTORE` | No | Set to `true` for Firestore storage (default: local JSON) |

## Dependencies

**Key Node.js packages** (`package.json`):
- `genkit` + `@genkit-ai/googleai` - AI framework
- `@genkit-ai/dev-local-vectorstore` - RAG vector storage
- `firebase-admin` + `@google-cloud/firestore` - Database
- `pdf-parse` - PDF text extraction
- `json2csv` - CSV export
- `p-limit` - Concurrency control

**Key Python packages** (`requirements.txt`):
- `pdfplumber` - Layout-preserving PDF extraction
- `firebase-functions` - Cloud Functions framework
- `Pillow` - Image processing for visual evidence

## Common Gotchas

1. **pdf-parse v2.x API**: Returns `{pages: [{text, num}...]}` instead of single string
2. **Vector store strings**: Always use string references, not objects
3. **VerifiableField null handling**: Check both `value` and `sourceText` for null
4. **Duplicate detection**: Uses semantic matching, not exact string comparison
5. **NOS scores**: Total must equal selection + comparability + outcome (max 9)
