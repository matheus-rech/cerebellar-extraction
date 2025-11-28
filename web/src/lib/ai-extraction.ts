/**
 * AI-powered extraction utilities using Firebase AI Logic
 *
 * Uses Gemini via Firebase - no API key needed in client code.
 * Firebase handles authentication automatically.
 */

import { geminiModel } from './firebase';

// PICO extraction schema for cerebellar stroke studies
export interface ExtractionData {
  // Metadata
  study_id: string;
  authors: string;
  year: number;
  title: string;

  // Population
  population: {
    sample_size: number;
    mean_age?: number;
    age_range?: string;
    male_percentage?: number;
    diagnosis: string;
    inclusion_criteria?: string;
    exclusion_criteria?: string;
    gcs_range?: string;
    nihss_mean?: number;
  };

  // Intervention
  intervention: {
    procedure: string;
    timing_hours?: number;
    technique?: string;
    evd_used?: boolean;
    duraplasty?: boolean;
  };

  // Comparator
  comparator?: {
    exists: boolean;
    type?: string;
    description?: string;
    sample_size?: number;
  };

  // Outcomes
  outcomes: {
    mortality_rate?: number;
    mortality_timepoint?: string;
    mrs_favorable_rate?: number;
    mrs_favorable_definition?: string;
    complications?: string[];
    length_of_stay_days?: number;
    follow_up_months?: number;
  };

  // Quality assessment
  study_design: string;
  newcastle_ottawa_score?: number;
}

// Extraction prompt template
const EXTRACTION_PROMPT = `You are a medical data extraction specialist. Extract structured PICO data from this cerebellar stroke research paper.

Return a JSON object with the following structure:
{
  "study_id": "FirstAuthorYear format (e.g., Smith2023)",
  "authors": "Author names",
  "year": publication year as number,
  "title": "Full paper title",
  "population": {
    "sample_size": number of patients,
    "mean_age": mean age if available,
    "diagnosis": "cerebellar infarction/hemorrhage/etc",
    "inclusion_criteria": "criteria text",
    "gcs_range": "GCS range if reported"
  },
  "intervention": {
    "procedure": "suboccipital decompressive craniectomy/etc",
    "timing_hours": hours from symptom onset if available,
    "technique": "surgical technique details",
    "evd_used": true/false,
    "duraplasty": true/false
  },
  "comparator": {
    "exists": true/false,
    "type": "conservative/medical management/etc",
    "sample_size": number if available
  },
  "outcomes": {
    "mortality_rate": percentage as decimal (0.15 = 15%),
    "mortality_timepoint": "30-day/in-hospital/etc",
    "mrs_favorable_rate": percentage as decimal,
    "mrs_favorable_definition": "mRS 0-3/mRS 0-2/etc",
    "complications": ["complication1", "complication2"],
    "length_of_stay_days": number if available,
    "follow_up_months": follow-up duration
  },
  "study_design": "retrospective cohort/prospective/RCT/etc",
  "newcastle_ottawa_score": NOS score if calculable (0-9)
}

Only include fields where data is explicitly stated in the paper. Use null for missing data.
Ensure all numbers are actual numbers, not strings.

PAPER TEXT:
`;

/**
 * Extract PICO data from PDF text using Gemini
 */
export async function extractFromPDF(pdfText: string): Promise<ExtractionData> {
  const prompt = EXTRACTION_PROMPT + pdfText;

  const result = await geminiModel.generateContent(prompt);
  const responseText = result.response.text();

  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                    responseText.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error('Failed to parse extraction response as JSON');
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  return JSON.parse(jsonStr) as ExtractionData;
}

/**
 * Chat with the AI about a loaded paper
 */
export async function chatAboutPaper(
  pdfText: string,
  question: string,
  conversationHistory: Array<{ role: 'user' | 'model'; content: string }> = []
): Promise<string> {
  const contextPrompt = `You are analyzing a cerebellar stroke research paper. Answer questions accurately based on the paper content.

PAPER TEXT:
${pdfText}

---
Previous conversation:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

User question: ${question}`;

  const result = await geminiModel.generateContent(contextPrompt);
  return result.response.text();
}

/**
 * Validate and critique an extraction
 */
export async function critiqueExtraction(
  pdfText: string,
  extraction: ExtractionData
): Promise<{
  score: number;
  issues: string[];
  suggestions: string[];
}> {
  const prompt = `You are a medical research quality assessor. Compare this extraction against the source paper and identify any issues.

EXTRACTION:
${JSON.stringify(extraction, null, 2)}

SOURCE PAPER:
${pdfText}

Return a JSON object:
{
  "score": 0-100 accuracy score,
  "issues": ["list of inaccuracies or missing data"],
  "suggestions": ["recommendations for improvement"]
}`;

  const result = await geminiModel.generateContent(prompt);
  const responseText = result.response.text();

  const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                    responseText.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error('Failed to parse critique response');
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  return JSON.parse(jsonStr);
}

/**
 * Extract specific field with source text verification
 */
export async function extractFieldWithSource(
  pdfText: string,
  fieldName: string,
  fieldDescription: string
): Promise<{
  value: string | number | boolean | null;
  sourceText: string;
  confidence: number;
  page?: number;
}> {
  const prompt = `Extract the "${fieldName}" from this medical paper.
Field description: ${fieldDescription}

Return JSON:
{
  "value": the extracted value (use appropriate type),
  "sourceText": "exact quote from paper supporting this value",
  "confidence": 0.0-1.0 confidence score,
  "page": page number if identifiable
}

If not found, return: { "value": null, "sourceText": "", "confidence": 0 }

PAPER TEXT:
${pdfText}`;

  const result = await geminiModel.generateContent(prompt);
  const responseText = result.response.text();

  const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                    responseText.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { value: null, sourceText: '', confidence: 0 };
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  return JSON.parse(jsonStr);
}
