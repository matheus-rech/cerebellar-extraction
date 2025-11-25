# TheAgent 🧠

> Hybrid medical research data extraction agent for systematic reviews of cerebellar stroke studies

## Overview

TheAgent is a modular TypeScript agent built with the Claude Agent SDK, designed to extract and harmonize data from medical research papers. It combines 6 specialized modules into a unified extraction pipeline.

## Features

### 🎯 Core Capabilities

| Module | Description | Status |
|--------|-------------|--------|
| **Full-PDF Deep Extractor** | Extracts structured data from ALL sections (Methods, Results, Discussion) | ⚙️ Implementation ready |
| **Table & Figure Extractor** | Vision-based table/figure extraction using Docling MCP | ⚙️ Integration needed |
| **Imaging Metrics Extractor** | Extracts neuroimaging data (infarct volume, edema, etc.) | ✅ Pattern matching implemented |
| **Outcome Harmonizer** | Standardizes outcomes to common timepoints | ⚙️ Core logic ready |
| **IPD Reconstructor** | Reconstructs patient-level data from Kaplan-Meier curves | ⚙️ Algorithm ready |
| **Multi-Source Fuser** | Combines data from main paper + supplements + errata | ✅ Conflict resolution implemented |

### 🔧 Architecture

```
TheAgent (Hybrid Orchestrator)
    ↓
┌────────────────────┬────────────────────┬────────────────────┐
│  Full-PDF Extractor │  Table Extractor   │  Imaging Extractor │
│  (All pages)        │  (Docling MCP)     │  (Pattern + LLM)   │
└────────────────────┴────────────────────┴────────────────────┘
    ↓
┌────────────────────┬────────────────────┬────────────────────┐
│  Outcome Harmonizer │  IPD Reconstructor │  Multi-Source Fuser│
│  (Standardize)      │  (K-M curves)      │  (Conflict resolve)│
└────────────────────┴────────────────────┴────────────────────┘
    ↓
Structured, Harmonized, Patient-Level Data
```

## Quick Start

### Prerequisites

- Node.js >= 18
- npm or pnpm
- Anthropic API key ([Get one here](https://console.anthropic.com/))
- (Optional) Docling MCP for advanced table extraction

### Installation

```bash
cd TheAgent
npm install
```

### Configuration

1. Copy the environment template:
```bash
cp .env.example .env
```

2. Add your Anthropic API key:
```env
ANTHROPIC_API_KEY=your_key_here
```

3. (Optional) Enable Docling MCP:
```bash
# Install Docling MCP
uvx --from=docling-mcp docling-mcp-server

# Enable in .env
DOCLING_MCP_ENABLED=true
```

### Usage

#### CLI (Recommended)

```bash
# Process a single paper
npm run cli -- process paper.pdf

# Process with specific modules only
npm run cli -- process paper.pdf --modules full-pdf,tables,imaging

# Process multiple sources and fuse them
npm run cli -- fuse main:paper.pdf supplement:supplement.pdf erratum:erratum.pdf

# List available modules
npm run cli -- modules

# Check configuration
npm run cli -- config
```

#### Programmatic API

```typescript
import { TheAgent } from './src/index.js';

// Initialize with all modules
const agent = new TheAgent({
  modules: ['full-pdf', 'tables', 'imaging', 'harmonizer', 'ipd', 'fuser'],
  verbose: true,
});

// Process a single paper
const result = await agent.processPaper('paper.pdf');

console.log('Extracted data:', result.data);
console.log('Warnings:', result.warnings);

// Process multiple sources
const fusedResult = await agent.processMultiSource([
  { pdfPath: 'main.pdf', type: 'main-paper' },
  { pdfPath: 'supplement.pdf', type: 'supplement' },
  { pdfPath: 'erratum.pdf', type: 'erratum' },
]);
```

## Module Details

### Full-PDF Deep Extractor

Extracts from **all pages**, not just the abstract.

**Output:**
- Methods section (study design, statistical analysis)
- Results section (primary/secondary outcomes)
- Discussion section (key findings, limitations)

**TODO:** Integrate Claude Agent SDK for structured extraction

### Table & Figure Extractor

Uses Docling MCP for layout understanding or falls back to Claude vision.

**Output:**
- Structured table data with headers and rows
- Figure metadata and type classification
- Data points from charts (for IPD reconstruction)

**TODO:** Implement Docling MCP client connection

### Imaging Metrics Extractor

Cerebellar stroke-specific neuroimaging data.

**Extracts:**
- Infarct volume (mL)
- Edema volume (mL)
- Midline shift (mm)
- Fourth ventricle compression
- Hydrocephalus presence

**Method:** Pattern matching + LLM validation

### Outcome Harmonizer

Standardizes heterogeneous outcome reporting.

**Features:**
- Maps to standard timepoints (30, 90, 180, 365 days)
- Converts between mRS definitions (0-2 vs 0-3)
- Calculates harmonization confidence

**TODO:** Implement mRS distribution conversion logic

### IPD Reconstructor

Reconstructs individual patient data from aggregate statistics.

**Methods:**
1. Kaplan-Meier digitization (Guyot algorithm)
2. Aggregate imputation (low confidence)

**Output:** Patient-level survival and outcome data

**TODO:** Implement K-M curve digitization

### Multi-Source Fuser

Intelligently combines data from multiple sources.

**Features:**
- Conflict detection between sources
- Resolution strategies (most-recent, highest-quality)
- Source hierarchy: Erratum > Supplement > Main Paper

**Use cases:**
- Main paper + supplementary materials
- Published results + trial registry data
- Original publication + erratum

## Development

### Build

```bash
npm run build
```

### Type Check

```bash
npm run typecheck
```

### Run Tests

```bash
npm test
```

### Lint & Format

```bash
npm run lint
npm run format
```

## Integration with cerebellar-extraction

TheAgent is designed to complement your existing [cerebellar-extraction](../public/index.html) web app:

| Current App | TheAgent Enhancement |
|-------------|---------------------|
| Page 1 extraction only | **Full-PDF** extraction from all sections |
| Basic table detection | **Advanced table** extraction via Docling |
| Manual outcome entry | **Automated harmonization** to standard timepoints |
| Single PDF processing | **Multi-source fusion** (paper + supplements) |
| Aggregate data only | **IPD reconstruction** for meta-analysis |
| No imaging metrics | **Systematic imaging** data extraction |

### Migration Path

1. **Phase 1:** Use TheAgent CLI to batch-process existing PDFs
2. **Phase 2:** Integrate TheAgent as backend API for your web app
3. **Phase 3:** Sync TheAgent results to Firebase (Multi-Source Fuser → Firestore)

## Next Steps

### Required Implementations (TODOs)

Each module has clearly marked `TODO` sections in the source code. Key areas:

1. **Full-PDF Extractor** ([src/modules/full-pdf-extractor.ts](src/modules/full-pdf-extractor.ts))
   - Integrate Claude Agent SDK for structured extraction
   - Implement section-specific prompts

2. **Table Extractor** ([src/modules/table-figure-extractor.ts](src/modules/table-figure-extractor.ts))
   - Connect to Docling MCP server
   - Implement fallback vision-based extraction

3. **Outcome Harmonizer** ([src/modules/outcome-harmonizer.ts](src/modules/outcome-harmonizer.ts))
   - Implement mRS distribution parsing
   - Add mathematical conversion formulas

4. **IPD Reconstructor** ([src/modules/ipd-reconstructor.ts](src/modules/ipd-reconstructor.ts))
   - Implement Guyot K-M reconstruction algorithm
   - Add validation against reported outcomes

### Recommended Workflow

1. Start with a single module (e.g., Full-PDF Extractor)
2. Implement the TODO sections with Claude Agent SDK
3. Test with real papers from your systematic review
4. Gradually enable additional modules
5. Use Multi-Source Fuser for complex extraction scenarios

## Resources

- [Claude Agent SDK Documentation](https://docs.claude.com/en/api/agent-sdk/typescript)
- [Docling MCP Server](https://docling-project.github.io/docling/usage/mcp/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Guyot IPD Reconstruction Method](https://bmcmedresmethodol.biomedcentral.com/articles/10.1186/1471-2288-12-9)

## License

MIT

---

**Built with:**
- [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) - AI agent framework
- [Docling MCP](https://github.com/docling-project/docling-mcp) - Document understanding
- [pdf-parse](https://www.npmjs.com/package/pdf-parse) - PDF text extraction
- [TypeScript](https://www.typescriptlang.org/) - Type-safe development
