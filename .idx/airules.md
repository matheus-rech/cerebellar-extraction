# Cerebellar Extraction Project - AI Rules

You are an AI assistant for a medical research data extraction application focused on cerebellar stroke studies.

## Project Context

- **Firebase Project**: cerebellar-extraction
- **Purpose**: Extract structured data from medical research papers about suboccipital decompressive craniectomy (SDC)
- **Primary Users**: Medical researchers conducting systematic reviews

## Architecture

### Frontend (public/index.html)
- Single-file React 18 application (~3,500 lines)
- Firebase AI Logic integration (Gemini 2.0 Flash)
- PDF.js viewer with text selection
- 4-tab layout: Form, Tables, Figures, Chat
- 7 dynamic field types with linked selectors

### Backend
- **Genkit CLI** (src/genkit.ts): Multi-agent extraction with 6 specialized workers
- **Python Cloud Functions** (functions-python/): PDF processing with visual evidence

## Coding Standards

### State Management Pattern
```javascript
const [items, setItems] = useState([]);
const addItem = () => setItems([...items, { id: Date.now(), ...defaults }]);
const updateItem = (id, field, value) => setItems(items.map(item =>
  item.id === id ? { ...item, [field]: value } : item
));
const removeItem = (id) => setItems(items.filter(item => item.id !== id));
```

### Firebase AI Logic (NOT direct API)
```javascript
const { getAI, getGenerativeModel, GoogleAIBackend } = await import('firebase/ai');
const ai = getAI(app, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, { model: 'gemini-2.0-flash' });
```

### Extraction Division
| Task | Tool | Location |
|------|------|----------|
| Figures/Charts | Gemini 2.5 Flash | Frontend (Firebase AI Logic) |
| Tables | Mistral OCR | Backend (Genkit) |

## Key Data Types

### CerebellarSDCData Schema
- study_id, authors, year, title
- study_design, inclusion_criteria
- population: sample_size, mean_age, gcs, hydrocephalus_rate
- intervention: procedure, timing_hours, evd_used, duraplasty
- outcomes: mortality, mRS_favorable, complications

### 7 Dynamic Field Types
1. StudyArmField - Treatment groups
2. IndicationField - Surgical indications
3. InterventionField - Surgical techniques
4. MortalityField - Mortality data with arm selector
5. MRSField - Modified Rankin Scale (0-6 grid)
6. ComplicationField - Adverse events
7. PredictorField - Statistical predictors (OR/CI)

## Important Notes

- No authentication required for Firestore
- PDF limits: 20 MB request, 50 MB per file, 1000 pages max
- Always use Firebase AI Logic, never expose Gemini API keys in frontend
- Follow existing patterns when adding new features
