# PDF Extraction Functions with Screenshot Capture & HTML Reporting

Complete guide to the Python Cloud Functions for medical research PDF extraction with visual evidence capture.

## 📋 Table of Contents

- [Overview](#overview)
- [Available Functions](#available-functions)
- [Quick Start](#quick-start)
- [Function Details](#function-details)
- [HTML Report Features](#html-report-features)
- [Testing](#testing)
- [Deployment](#deployment)

## 🎯 Overview

This system provides **9 specialized Cloud Functions** for extracting structured data from medical research PDFs:

### Core Extraction Functions
1. `extract_text_with_layout` - Layout-preserving text extraction (pdfplumber)
2. `extract_tables` - Structured table extraction with row/column data
3. `extract_text_with_positions` - Character-level position tracking
4. `extract_for_llm` - LLM-ready Markdown with multi-column support (pymupdf4llm)
5. `extract_tables_markdown` - Tables in Markdown format
6. `detect_sections` - Automatic section detection (Abstract, Methods, Results, etc.)

### Visual Evidence Functions ⭐ NEW
7. `capture_highlights` - Screenshot text regions with yellow highlights
8. `generate_html_report` - Professional HTML report with embedded screenshots
9. `extract_figures` - Extract images/figures from PDF pages

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd functions-python
pip install -r requirements.txt
```

### 2. Test Locally

```bash
python test_extraction.py path/to/your/research_paper.pdf
```

This will generate:
- `screenshot_1_Mortality_Rate.png`
- `screenshot_2_Mean_Age.png`
- `extraction_report.html` ← Open this in your browser!

### 3. Deploy to Firebase

```bash
cd ..
firebase deploy --only functions:python
```

## 📚 Function Details

### 1. `extract_for_llm` - LLM-Ready Extraction

**Purpose:** Extract PDF content optimized for LLM processing with multi-column support.

**Request:**
```json
{
  "pdf_base64": "JVBERi0xLjQK...",
  "embed_images": false,
  "page_chunks": true,
  "pages": null
}
```

**Response:**
```json
{
  "success": true,
  "chunks": [
    {
      "page": 1,
      "text": "# Abstract\n\nThis study investigated...",
      "tables": [],
      "images": 0,
      "toc_items": ["Abstract", "Introduction"]
    }
  ],
  "page_count": 12
}
```

**Key Features:**
- ✓ Multi-column layout detection
- ✓ Automatic header hierarchy detection
- ✓ Tables converted to Markdown
- ✓ Optional image embedding
- ✓ Page-level chunking for RAG systems

---

### 2. `extract_tables` - Structured Table Extraction

**Purpose:** Extract tables with precise row/column structure for medical data.

**Request:**
```json
{
  "pdf_base64": "JVBERi0xLjQK..."
}
```

**Response:**
```json
{
  "success": true,
  "tables": [
    {
      "page": 3,
      "table_index": 0,
      "headers": ["Patient ID", "Age", "GCS", "Outcome"],
      "rows": [
        ["001", "62", "12", "Survived"],
        ["002", "58", "8", "Deceased"]
      ],
      "raw": [["Patient ID", "Age", "GCS", "Outcome"], ...]
    }
  ],
  "table_count": 4
}
```

---

### 3. `extract_text_with_positions` - Position Tracking

**Purpose:** Extract text with character-level coordinates for citation mapping.

**Request:**
```json
{
  "pdf_base64": "JVBERi0xLjQK..."
}
```

**Response:**
```json
{
  "success": true,
  "text": "Abstract\n\nThis study investigated...",
  "positions": [
    {
      "text": "Abstract",
      "startChar": 0,
      "endChar": 8,
      "x": 72.0,
      "y": 120.5,
      "width": 48.2,
      "height": 12.0,
      "page": 1
    }
  ],
  "page_count": 12
}
```

**Use Case:** Map Claude citation indices to PDF coordinates for highlighting.

---

### 4. `capture_highlights` ⭐ NEW - Screenshot Text Evidence

**Purpose:** Capture screenshots of specific text regions with yellow highlight overlays.

**Request:**
```json
{
  "pdf_base64": "JVBERi0xLjQK...",
  "highlights": [
    {
      "page": 3,
      "text": "Overall mortality rate was 15.3% (24/156 patients)",
      "x0": 100,
      "y0": 250,
      "x1": 350,
      "y1": 270,
      "label": "Mortality Rate"
    }
  ],
  "dpi": 200,
  "padding": 15
}
```

**Response:**
```json
{
  "success": true,
  "screenshots": [
    {
      "page": 3,
      "label": "Mortality Rate",
      "text": "Overall mortality rate was 15.3%...",
      "image_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
      "width": 280,
      "height": 45,
      "bbox": {
        "x0": 100,
        "y0": 250,
        "x1": 350,
        "y1": 270
      }
    }
  ],
  "screenshot_count": 1
}
```

**Highlight Visualization:**
```
┌─────────────────────────────────────┐
│                                     │
│  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  │ ← Yellow highlight
│  █ mortality rate was 15.3% █       │
│  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  │
│                                     │
└─────────────────────────────────────┘
```

---

### 5. `generate_html_report` ⭐ NEW - Professional Reporting

**Purpose:** Generate publication-ready HTML report with extraction data and screenshot evidence.

**Request:**
```json
{
  "pdf_base64": "JVBERi0xLjQK...",
  "extraction_data": {
    "metadata": {
      "firstAuthor": "Smith et al.",
      "publicationYear": 2023,
      "studyPeriod": "2018-2022"
    },
    "population": {
      "sampleSize": 156,
      "age": {
        "value": {"mean": 62.5, "sd": 12.3},
        "sourceText": "mean age was 62.5 ± 12.3 years"
      }
    },
    "outcomes": {
      "mortality": {
        "value": 15.3,
        "sourceText": "Overall mortality rate was 15.3%"
      }
    }
  },
  "highlights": [...],
  "title": "Cerebellar Stroke Study - Smith 2023",
  "dpi": 150,
  "padding": 20
}
```

**Response:**
```json
{
  "success": true,
  "html": "<!DOCTYPE html>...",
  "screenshots": 5,
  "timestamp": "2025-01-15 14:32:45"
}
```

---

## 🎨 HTML Report Features

The generated HTML report includes:

### 1. **Professional Header**
```
╔══════════════════════════════════════╗
║  Cerebellar Stroke Study - Smith 2023 ║
║  Generated on 2025-01-15 14:32:45     ║
╚══════════════════════════════════════╝
```

### 2. **Structured Data Sections**
- **Metadata:** Study details, authors, publication info
- **Population:** Demographics, sample size, baseline characteristics
- **Outcomes:** Mortality, mRS scores, complications

Each field shows:
- ✓ **Field Label** (uppercase, colored)
- ✓ **Extracted Value** (large, bold)
- ✓ **Source Text** (italicized quote from PDF)

### 3. **Evidence Screenshots**
```
┌────────────────────────────────────────┐
│ 📸 Evidence Screenshots                 │
├────────────────────────────────────────┤
│ [Page 3] Mortality Rate                │
│ ┌────────────────────────────────────┐ │
│ │  [Yellow highlighted screenshot]   │ │
│ └────────────────────────────────────┘ │
│ "Overall mortality rate was 15.3%..."  │
└────────────────────────────────────────┘
```

### 4. **Statistics Dashboard**
```
┌───────────┬───────────────┬───────────────┐
│ Sections  │ Fields        │ Screenshots   │
│     5     │      24       │       8       │
└───────────┴───────────────┴───────────────┘
```

### 5. **Styling Features**
- ✓ Gradient header (dark blue/purple)
- ✓ Card-based layout with shadows
- ✓ Color-coded sections (purple accents)
- ✓ Responsive design (mobile-friendly)
- ✓ Print-friendly CSS
- ✓ Embedded base64 images (no external files)

---

## 🧪 Testing

### Local Testing (No Firebase Required)

```bash
# 1. Navigate to functions directory
cd functions-python

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run test suite
python test_extraction.py path/to/research_paper.pdf
```

### Sample Test Output

```
Loading PDF: ../samples/cerebellar_study.pdf
✓ Loaded 458234 bytes (base64 encoded)

============================================================
TEST 1: Extract for LLM (pymupdf4llm)
============================================================
✓ Success! Extracted 12 pages
✓ Generated 12 chunks

First chunk preview:
  Page: 1
  Text length: 1523 chars
  Tables: 0
  Images: 1

============================================================
TEST 2: Extract Tables (pdfplumber)
============================================================
✓ Success! Found 4 tables

Table 1:
  Page: 3
  Headers: ['Patient ID', 'Age', 'GCS', 'Outcome']
  Rows: 156

============================================================
TEST 3: Extract Text with Positions
============================================================
✓ Success! Extracted 8542 word positions
✓ Total text length: 45231 chars

First 5 words:
  'Abstract' at page 1 (x:72.0, y:120.5)
  'This' at page 1 (x:72.0, y:135.2)
  ...

============================================================
TEST 4: Capture Highlights
============================================================
✓ Success! Captured 2 screenshots

Screenshot 1:
  Page: 1
  Label: Mortality Rate
  Size: 280x45px
  Text: "Overall mortality rate was 15.3% (24/156 pat..."
  Saved to: screenshot_1_Mortality_Rate.png

============================================================
TEST 5: Generate HTML Report
============================================================
✓ Success! Generated HTML report
✓ Included 2 screenshots
✓ Generated at: 2025-01-15 14:32:45
✓ Saved to: extraction_report.html

Open the report in your browser:
  open extraction_report.html

============================================================
ALL TESTS COMPLETED!
============================================================

✓ Check your current directory for:
  - screenshot_*.png files
  - extraction_report.html

Open the HTML report to see the full extraction with highlights!
```

---

## 🚀 Deployment

### Deploy to Firebase

```bash
# 1. Build functions (optional - Firebase handles this)
cd functions-python

# 2. Deploy all Python functions
cd ..
firebase deploy --only functions:python

# 3. Deploy specific function
firebase deploy --only functions:python:capture_highlights
```

### Function URLs

After deployment, you'll get URLs like:
```
https://us-central1-PROJECT_ID.cloudfunctions.net/capture_highlights
https://us-central1-PROJECT_ID.cloudfunctions.net/generate_html_report
```

### Call from Frontend

```javascript
// Example: Capture highlights
const response = await fetch(
  'https://us-central1-PROJECT_ID.cloudfunctions.net/capture_highlights',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdf_base64: pdfBase64String,
      highlights: [
        {
          page: 3,
          text: "mortality rate was 15.3%",
          x0: 100, y0: 250, x1: 350, y1: 270,
          label: "Mortality Rate"
        }
      ],
      dpi: 200,
      padding: 15
    })
  }
);

const result = await response.json();
console.log(`Captured ${result.screenshots.length} screenshots`);
```

---

## 🔧 Configuration

### Memory & Timeout Settings

| Function | Memory | Timeout | Use Case |
|----------|--------|---------|----------|
| `extract_text_with_layout` | 512 MB | 120s | Text extraction |
| `extract_tables` | 512 MB | 120s | Table extraction |
| `extract_text_with_positions` | 1 GB | 180s | Position tracking |
| `extract_for_llm` | 1 GB | 180s | LLM Markdown |
| `capture_highlights` | 1 GB | 180s | Screenshot capture |
| `generate_html_report` | 1 GB | 240s | Full report generation |

### Performance Tips

1. **DPI Settings:**
   - 150 DPI: Good balance (default for reports)
   - 200 DPI: High quality screenshots
   - 300 DPI: Publication quality (slower)

2. **Padding:**
   - 10px: Tight crop around text
   - 20px: Standard context (default)
   - 40px: Wide context for complex tables

3. **Batch Processing:**
   - Process highlights by page (faster)
   - Limit to 10-15 highlights per request
   - Use parallel requests for multiple PDFs

---

## 📊 Use Cases

### 1. Systematic Review Extraction
```python
# Extract from 50 cerebellar stroke papers
for pdf in paper_collection:
    data = extract_study_data(pdf)
    highlights = identify_key_findings(data)
    report = generate_html_report(pdf, data, highlights)
    save_report(f"review_{pdf.id}.html")
```

### 2. Quality Assessment
```python
# Generate evidence reports for NOS scoring
nos_fields = [
    {"label": "Selection Criteria", "page": 2, ...},
    {"label": "Comparability", "page": 3, ...},
    {"label": "Outcome Assessment", "page": 5, ...}
]
report = generate_html_report(pdf, extraction, nos_fields)
```

### 3. Citation Verification
```python
# Capture screenshots of Claude citations
positions = extract_text_with_positions(pdf)
citations = claude_extract_with_citations(text)
highlights = map_citations_to_positions(citations, positions)
screenshots = capture_highlights(pdf, highlights)
```

---

## 🛠️ Troubleshooting

### Issue: "PDF decoding failed"
**Solution:** Ensure PDF is valid and not password-protected
```bash
qpdf --check your_file.pdf
```

### Issue: Screenshots are blurry
**Solution:** Increase DPI
```json
{"dpi": 300}  // instead of 150
```

### Issue: Highlights don't align with text
**Solution:** Use `extract_text_with_positions` to get exact coordinates
```python
positions = extract_text_with_positions(pdf)
# Use positions.x, positions.y for highlight coordinates
```

### Issue: HTML report too large
**Solution:** Reduce screenshot DPI or use fewer highlights
```json
{"dpi": 100, "padding": 10}
```

---

## 📝 License

MIT License - See main project LICENSE file

---

## 🤝 Contributing

Found a bug or have a feature request?
1. Check existing issues
2. Create detailed bug report with PDF example
3. Submit PR with tests

---

## 📞 Support

For questions or issues:
- GitHub Issues: [cerebellar-extraction/issues](https://github.com/yourusername/cerebellar-extraction/issues)
- Documentation: See main README.md

---

**Built with:**
- 🔥 Firebase Functions
- 📄 pdfplumber (layout-preserving extraction)
- 📚 pymupdf4llm (LLM-optimized Markdown)
- 🖼️ Pillow (image processing)
- 🎨 Modern HTML/CSS (responsive design)
