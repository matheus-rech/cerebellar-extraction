// Genkit AI configuration for cerebellar-extraction
// Firebase AI Logic with Google AI (Gemini 3 Pro)
// Production-ready extraction system for SDC systematic review
// Supports both local development (JSON files) and production (Firestore)

import "dotenv/config";
import {googleAI} from "@genkit-ai/googleai";
import {genkit, z, Document} from "genkit";
import {devLocalVectorstore} from "@genkit-ai/dev-local-vectorstore";
import * as fs from "fs";
import * as path from "path";
import pLimit from "p-limit";
import {createRequire} from "module";
import {Parser} from "json2csv";
import * as readline from "readline/promises";
const require = createRequire(import.meta.url);
const {PDFParse} = require("pdf-parse");

// Helper function to parse PDF (compatible with pdf-parse v2.x API)
// Note: pdf-parse v2.x requires Uint8Array instead of Buffer
// Note: pdf-parse v2.x getText() returns {pages: [{text, num}...]} instead of a single string
async function parsePdf(dataBuffer: Buffer): Promise<{text: string; numpages: number}> {
  // Convert Buffer to Uint8Array (required by pdf-parse v2.x)
  const uint8Array = new Uint8Array(dataBuffer);
  const pdfParser = new PDFParse(uint8Array);
  await pdfParser.load();
  const textData = await pdfParser.getText();
  const info = await pdfParser.getInfo();

  // pdf-parse v2.x returns {pages: [{text: string, num: number}...]}
  // Concatenate all page texts into a single string
  let text = "";
  if (textData && typeof textData === "object" && "pages" in textData) {
    const pages = (textData as {pages: Array<{text: string; num: number}>}).pages;
    text = pages.map(p => p.text).join("\n\n");
  } else if (typeof textData === "string") {
    text = textData;
  }

  return {
    text: text || "",
    numpages: info?.numPages || (textData as {pages: unknown[]})?.pages?.length || 0,
  };
}

// ==========================================
// Storage Configuration (Local vs Firestore)
// ==========================================

const DATA_DIR = path.join(process.cwd(), "data");
const STUDIES_FILE = path.join(DATA_DIR, "studies.json");
const USE_LOCAL_STORAGE = process.env.USE_FIRESTORE !== "true";

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
}

// Local JSON-based storage (development mode)
interface LocalStudy {
  id: string;
  data: unknown;
  createdAt: string;
  duplicateCheck?: unknown;
}

function loadLocalStudies(): LocalStudy[] {
  if (!fs.existsSync(STUDIES_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(STUDIES_FILE, "utf-8"));
}

function saveLocalStudies(studies: LocalStudy[]): void {
  fs.writeFileSync(STUDIES_FILE, JSON.stringify(studies, null, 2));
}

function generateId(): string {
  return `study_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Firestore initialization (production mode - lazy loaded)
let db: FirebaseFirestore.Firestore | null = null;
async function getFirestoreDb(): Promise<FirebaseFirestore.Firestore> {
  if (db) return db;
  const {initializeApp, getApps} = await import("firebase-admin/app");
  const {getFirestore} = await import("firebase-admin/firestore");

  if (getApps().length === 0) {
    initializeApp({projectId: "cerebellar-extraction"});
  }
  db = getFirestore();
  return db;
}

// Configure Genkit instance with Gemini 3 Pro and local vector store
const ai = genkit({
  plugins: [
    googleAI(),
    devLocalVectorstore([
      {
        indexName: "studyIndex",
        embedder: googleAI.embedder("text-embedding-004"),
      },
    ]),
  ],
  model: "googleai/gemini-3-pro-preview",
});

// ==========================================
// 1. Zod Schemas (The Data Model)
// ==========================================

// Helper for verification: Every major data point gets a value and a source quote
const VerifiableField = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({
    value: schema.nullable(),
    sourceText: z
      .string()
      .describe("The verbatim quote from the text that proves this value.")
      .nullable(),
  });

const StudyMetadataSchema = z.object({
  title: z.string(),
  firstAuthor: z.string(),
  publicationYear: z.number().int(),
  journal: z.string().nullable(),
  hospitalCenter: z.string().describe("Name of the hospital/institution where the study took place"),
  studyPeriod: z.string().describe("The start and end dates of data collection (e.g., 'Jan 2010 - Dec 2020')"),
  studyDesign: z.enum(["Retrospective", "Prospective", "RCT", "Case Series", "Other"]).nullable(),
});

const PopulationSchema = z.object({
  sampleSize: z.number().int().describe("Total number of patients in the SDC group"),
  age: z.object({
    mean: VerifiableField(z.number()),
    sd: VerifiableField(z.number()),
    range: z.string().nullable(),
  }).describe("Age demographics"),
  gcs: z.object({
    admissionMean: VerifiableField(z.number()),
    preOpMean: VerifiableField(z.number()),
  }).describe("Glasgow Coma Scale scores"),
  hydrocephalus: VerifiableField(z.number()).describe("Percentage (0-100) of patients presenting with hydrocephalus"),
  diagnosis: z.string().describe("Primary diagnosis (e.g., cerebellar infarction, hemorrhage)"),
  inclusionCriteria: z.array(z.string()).describe("List of inclusion criteria from Methods section"),
});

const InterventionSchema = z.object({
  procedure: z.string().describe("Name of procedure (e.g., Suboccipital Decompressive Craniectomy)"),
  technique: VerifiableField(z.string()).describe("Surgical technique details (e.g., 'suboccipital craniectomy with C1 arch removal')"),
  evdUsed: VerifiableField(z.boolean()).describe("Was External Ventricular Drain (EVD) used?"),
  duraplasty: VerifiableField(z.boolean()).describe("Was duraplasty performed?"),
  timingToSurgery: VerifiableField(z.number()).describe("Mean time from onset to surgery in hours"),
  additionalDetails: z.string().nullable().describe("Any other surgical details mentioned"),
});

const ComparatorSchema = z.object({
  exists: z.boolean(),
  type: z.enum(["Medical Management", "EVD Only", "Other Surgery", "None"]).nullable(),
  description: z.string().nullable(),
  sampleSize: z.number().nullable().describe("Number of patients in comparator group if applicable"),
});

const OutcomeMetricSchema = z.object({
  measureName: z.string().describe("e.g., 'Mortality', 'GOS', 'mRS'"),
  timepoint: z.string().describe("e.g., 'Discharge', '30 days', '6 months', '1 year'"),
  resultValue: z.string().describe("The numerical value or percentage reported"),
  definition: z.string().nullable().describe("How the outcome was defined (e.g., mRS 0-2 vs 0-3)"),
  sourceText: z.string().describe("Verbatim quote for verification"),
});

const OutcomesSchema = z.object({
  mortality: VerifiableField(z.string()).describe("Mortality rate with timepoint"),
  mRS_favorable: VerifiableField(z.string()).describe("Favorable mRS outcome (specify definition)"),
  complications: z.array(z.string()).describe("List of reported complications"),
  lengthOfStay: VerifiableField(z.number()).describe("Mean length of hospital stay in days"),
  allOutcomes: z.array(OutcomeMetricSchema).describe("All primary and secondary outcomes extracted"),
});

const QualitySchema = z.object({
  selectionScore: z.number().min(0).max(4).describe("NOS Selection score (0-4)"),
  comparabilityScore: z.number().min(0).max(2).describe("NOS Comparability score (0-2)"),
  outcomeScore: z.number().min(0).max(3).describe("NOS Outcome score (0-3)"),
  totalScore: z.number().describe("Total Newcastle-Ottawa Scale score (0-9)"),
  biasNotes: z.string().describe("Assessment of potential biases (selection, attrition, etc.)"),
});

// The Master Schema - aligned with CerebellumExtractionData in TheAgent
export const CerebellarSDCSchema = z.object({
  metadata: StudyMetadataSchema,
  population: PopulationSchema,
  intervention: InterventionSchema,
  comparator: ComparatorSchema,
  outcomes: OutcomesSchema,
  quality: QualitySchema,
});

// Type export for use in frontend/database
export type CerebellarSDCData = z.infer<typeof CerebellarSDCSchema>;

// ==========================================
// 1b. Duplicate Detection Schema
// ==========================================

const DuplicateAssessmentSchema = z.object({
  isDuplicate: z.boolean().describe("True if this study appears to be a duplicate or subset of an existing study"),
  confidence: z.enum(["High", "Medium", "Low"]),
  matchedStudyId: z.string().nullable().describe("The Firestore doc ID of the existing study that overlaps"),
  overlapType: z.enum(["Same Cohort", "Subset", "Superset", "Partial Overlap", "None"]),
  reasoning: z.string().describe("Explain why these cohorts overlap based on Hospital, Period, and Authors"),
});

export type DuplicateAssessment = z.infer<typeof DuplicateAssessmentSchema>;

// ==========================================
// 2. Verification Helper Functions
// ==========================================

/**
 * Formats the extracted JSON into a human-readable verification report.
 * This helps you audit the AI's work against the raw text.
 */
export function formatVerificationReport(data: CerebellarSDCData): string {
  let report = `# Data Verification Report\n`;
  report += `## ${data.metadata.firstAuthor} et al. (${data.metadata.publicationYear})\n`;
  report += `**${data.metadata.title}**\n\n`;
  report += `Hospital: ${data.metadata.hospitalCenter} | Period: ${data.metadata.studyPeriod}\n\n`;

  const addLine = (label: string, item: {value: unknown; sourceText: string | null} | undefined) => {
    if (!item) return;
    const val = item.value !== null ? item.value : "Not Found";
    const quote = item.sourceText ? `\n  > "${item.sourceText}"` : "";
    report += `- **${label}**: ${val}${quote}\n`;
  };

  report += `### Population (n=${data.population.sampleSize})\n`;
  addLine("Age (Mean)", data.population.age.mean);
  addLine("Age (SD)", data.population.age.sd);
  addLine("GCS (Admission)", data.population.gcs.admissionMean);
  addLine("GCS (Pre-Op)", data.population.gcs.preOpMean);
  addLine("Hydrocephalus %", data.population.hydrocephalus);
  report += `- **Diagnosis**: ${data.population.diagnosis}\n\n`;

  report += `### Intervention\n`;
  report += `- **Procedure**: ${data.intervention.procedure}\n`;
  addLine("Technique", data.intervention.technique);
  addLine("Timing (Hours)", data.intervention.timingToSurgery);
  addLine("EVD Used", data.intervention.evdUsed);
  addLine("Duraplasty", data.intervention.duraplasty);

  report += `\n### Comparator\n`;
  report += `- **Exists**: ${data.comparator.exists ? "Yes" : "No"}\n`;
  if (data.comparator.exists) {
    report += `- **Type**: ${data.comparator.type}\n`;
    report += `- **Description**: ${data.comparator.description}\n`;
  }

  report += `\n### Outcomes\n`;
  addLine("Mortality", data.outcomes.mortality);
  addLine("Favorable mRS", data.outcomes.mRS_favorable);
  addLine("Length of Stay (days)", data.outcomes.lengthOfStay);
  report += `- **Complications**: ${data.outcomes.complications.join(", ") || "None reported"}\n`;

  report += `\n#### All Outcome Measures\n`;
  data.outcomes.allOutcomes.forEach((outcome) => {
    report += `- **${outcome.measureName}** @ ${outcome.timepoint}: ${outcome.resultValue}\n`;
    report += `  > "${outcome.sourceText}"\n`;
  });

  report += `\n### Quality Assessment (Newcastle-Ottawa Scale)\n`;
  report += `- Selection: ${data.quality.selectionScore}/4\n`;
  report += `- Comparability: ${data.quality.comparabilityScore}/2\n`;
  report += `- Outcome: ${data.quality.outcomeScore}/3\n`;
  report += `- **Total: ${data.quality.totalScore}/9**\n`;
  report += `- Bias Notes: ${data.quality.biasNotes}\n`;

  return report;
}

// ==========================================
// 3. Specialized Extraction Agents (Worker Pattern)
// ==========================================

/**
 * Metadata Agent - Extracts study identification info
 * Focuses on: Title, authors, journal, hospital, study period
 */
const extractMetadata = ai.defineFlow(
  {
    name: "extractMetadata",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: StudyMetadataSchema,
  },
  async ({pdfText}) => {
    const {output} = await ai.generate({
      prompt: `You are extracting study metadata from a medical research paper on cerebellar stroke surgery.

Focus on the TITLE, ABSTRACT, and AUTHOR AFFILIATIONS sections.

Extract:
- Title, first author name, publication year
- Journal name
- Hospital/institution where the study was conducted
- Study period (data collection dates)
- Study design type

STUDY TEXT:
${pdfText.slice(0, 15000)}`, // First ~15k chars usually contain metadata
      output: {schema: StudyMetadataSchema},
    });
    return output!;
  }
);

/**
 * Population Agent - Extracts patient demographics and characteristics
 * Focuses on: Methods section, Table 1 (patient characteristics)
 */
const extractPopulation = ai.defineFlow(
  {
    name: "extractPopulation",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: PopulationSchema,
  },
  async ({pdfText}) => {
    const {output} = await ai.generate({
      prompt: `You are extracting POPULATION data from a medical study on Suboccipital Decompressive Craniectomy (SDC).

Focus on the METHODS section and TABLE 1 (Baseline Characteristics).

Extract:
- Sample size (number of SDC patients)
- Age demographics (mean, SD, range) with source quotes
- GCS scores (admission and pre-operative) with source quotes
- Hydrocephalus percentage with source quote
- Primary diagnosis
- Inclusion/exclusion criteria

CRITICAL: For every value, provide the verbatim quote from the text in 'sourceText'.
If a value is not stated, return null (do not calculate or estimate).

STUDY TEXT:
${pdfText}`,
      output: {schema: PopulationSchema},
    });
    return output!;
  }
);

/**
 * Intervention Agent - Extracts surgical procedure details
 * Focuses on: Methods section, Surgical Technique descriptions
 */
const extractIntervention = ai.defineFlow(
  {
    name: "extractIntervention",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: InterventionSchema,
  },
  async ({pdfText}) => {
    const {output} = await ai.generate({
      prompt: `You are extracting INTERVENTION data from a medical study on Suboccipital Decompressive Craniectomy (SDC).

Focus on the METHODS section, particularly "Surgical Technique" or "Operative Procedure" subsections.

Extract:
- Procedure name and description
- Surgical technique details (craniectomy extent, C1 removal, etc.) with source quote
- EVD (External Ventricular Drain) usage with source quote
- Duraplasty performed with source quote
- Time from symptom onset to surgery with source quote
- Any additional procedural details

CRITICAL: For every value, provide the verbatim quote from the text in 'sourceText'.
If a value is not stated, return null.

STUDY TEXT:
${pdfText}`,
      output: {schema: InterventionSchema},
    });
    return output!;
  }
);

/**
 * Comparator Agent - Extracts control group information
 */
const extractComparator = ai.defineFlow(
  {
    name: "extractComparator",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: ComparatorSchema,
  },
  async ({pdfText}) => {
    const {output} = await ai.generate({
      prompt: `You are checking if this medical study has a COMPARATOR/CONTROL group.

Look for:
- Comparison groups (medical management only, EVD only, other surgery)
- Matched cohorts
- Historical controls

If NO comparator exists (single-arm study), return:
{ exists: false, type: "None", description: null, sampleSize: null }

If a comparator EXISTS, describe it fully.

STUDY TEXT:
${pdfText}`,
      output: {schema: ComparatorSchema},
    });
    return output!;
  }
);

/**
 * Outcomes Agent - Extracts all clinical outcomes
 * Focuses on: Results section, Tables 2+, Discussion
 */
const extractOutcomes = ai.defineFlow(
  {
    name: "extractOutcomes",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: OutcomesSchema,
  },
  async ({pdfText}) => {
    const {output} = await ai.generate({
      prompt: `You are extracting OUTCOMES data from a medical study on Suboccipital Decompressive Craniectomy (SDC).

Focus on the RESULTS section, TABLES (especially outcome tables), and DISCUSSION.

Extract:
- Mortality rate with timepoint (in-hospital, 30-day, 6-month, etc.) with source quote
- mRS (modified Rankin Scale) favorable outcome with definition (mRS 0-2 or 0-3?) with source quote
- Length of hospital stay with source quote
- All complications reported
- ALL outcome measures in the study (GOS, NIHSS, ICU stay, etc.)

CRITICAL RULES:
1. For every value, provide the VERBATIM QUOTE from the text in 'sourceText'
2. Always note the TIMEPOINT for outcome measurement
3. For mRS, always specify the DEFINITION of "favorable" (0-2 vs 0-3)
4. If a value is not stated, return null

STUDY TEXT:
${pdfText}`,
      output: {schema: OutcomesSchema},
    });
    return output!;
  }
);

/**
 * Quality Agent - Assesses study quality using Newcastle-Ottawa Scale
 * Focuses on: Methods, Results, entire paper for bias assessment
 */
const extractQuality = ai.defineFlow(
  {
    name: "extractQuality",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: QualitySchema,
  },
  async ({pdfText}) => {
    const {output} = await ai.generate({
      prompt: `You are assessing the METHODOLOGICAL QUALITY of a medical study using the Newcastle-Ottawa Scale (NOS).

NEWCASTLE-OTTAWA SCALE for Cohort Studies:

SELECTION (max 4 stars):
1. Representativeness of exposed cohort (1 star if truly representative)
2. Selection of non-exposed cohort (1 star if from same community)
3. Ascertainment of exposure (1 star if secure record/structured interview)
4. Outcome not present at start (1 star if demonstrated)

COMPARABILITY (max 2 stars):
1. Comparability based on design/analysis (1 star for controlling most important factor)
2. Additional factor controlled (1 star for additional factor)

OUTCOME (max 3 stars):
1. Assessment of outcome (1 star if independent blind assessment or record linkage)
2. Follow-up long enough (1 star if adequate for outcome)
3. Adequacy of follow-up (1 star if complete or unlikely to introduce bias)

Provide scores for each section and a total score (0-9).
Also note any specific biases: selection bias, attrition bias, detection bias, reporting bias.

STUDY TEXT:
${pdfText}`,
      output: {schema: QualitySchema},
    });
    return output!;
  }
);

// ==========================================
// 4. Orchestrator Flow (Parallel Execution)
// ==========================================

/**
 * Main extraction flow - orchestrates parallel agent execution
 * Uses the Worker Pattern for improved accuracy and speed
 */
export const extractStudyData = ai.defineFlow(
  {
    name: "extractStudyData",
    inputSchema: z.object({
      pdfText: z.string().describe("The raw text content of the medical PDF"),
    }),
    outputSchema: CerebellarSDCSchema,
  },
  async ({pdfText}) => {
    console.log("🔄 Dispatching to specialized extraction agents...");

    // Run all agents in parallel for speed
    const [metadata, population, intervention, comparator, outcomes, quality] = await Promise.all([
      extractMetadata({pdfText}),
      extractPopulation({pdfText}),
      extractIntervention({pdfText}),
      extractComparator({pdfText}),
      extractOutcomes({pdfText}),
      extractQuality({pdfText}),
    ]);

    console.log("✅ All agents completed. Aggregating results...");

    // Aggregate results into master schema
    const fullRecord: CerebellarSDCData = {
      metadata,
      population,
      intervention,
      comparator,
      outcomes,
      quality,
    };

    return fullRecord;
  }
);

/**
 * Check for duplicates and save to database
 * Uses semantic matching to detect overlapping cohorts
 * Supports both local storage (dev) and Firestore (production)
 */
export const checkAndSaveStudy = ai.defineFlow(
  {
    name: "checkAndSaveStudy",
    inputSchema: CerebellarSDCSchema,
    outputSchema: z.object({
      status: z.enum(["saved", "flagged_duplicate", "error"]),
      docId: z.string().nullable(),
      duplicateReport: DuplicateAssessmentSchema.nullable(),
      message: z.string(),
    }),
  },
  async (extractedData) => {
    try {
      // 1. Fetch existing studies metadata
      let existingStudies: Array<{
        id: string;
        center: string;
        period: string;
        firstAuthor: string;
        year: number;
        sampleSize: number;
      }> = [];

      if (USE_LOCAL_STORAGE) {
        // Local file storage mode
        const localStudies = loadLocalStudies();
        existingStudies = localStudies.map((s) => {
          const data = s.data as CerebellarSDCData;
          return {
            id: s.id,
            center: data.metadata?.hospitalCenter || "",
            period: data.metadata?.studyPeriod || "",
            firstAuthor: data.metadata?.firstAuthor || "",
            year: data.metadata?.publicationYear || 0,
            sampleSize: data.population?.sampleSize || 0,
          };
        });
      } else {
        // Firestore mode
        const firestore = await getFirestoreDb();
        const snapshot = await firestore.collection("studies").get();
        existingStudies = snapshot.docs.map((doc) => ({
          id: doc.id,
          center: doc.data().metadata?.hospitalCenter || "",
          period: doc.data().metadata?.studyPeriod || "",
          firstAuthor: doc.data().metadata?.firstAuthor || "",
          year: doc.data().metadata?.publicationYear || 0,
          sampleSize: doc.data().population?.sampleSize || 0,
        }));
      }

      // 2. If database is empty, save immediately
      if (existingStudies.length === 0) {
        const docId = generateId();
        if (USE_LOCAL_STORAGE) {
          const studies = loadLocalStudies();
          studies.push({
            id: docId,
            data: extractedData,
            createdAt: new Date().toISOString(),
          });
          saveLocalStudies(studies);

          // Also index for RAG (use the devLocalVectorstore indexer)
          try {
            await ai.index({
              indexer: "devLocalVectorstore/studyIndex",
              documents: [
                Document.fromText(JSON.stringify(extractedData), {
                  id: docId,
                  firstAuthor: extractedData.metadata.firstAuthor,
                  hospital: extractedData.metadata.hospitalCenter,
                }),
              ],
            });
          } catch (indexError) {
            console.warn("Warning: RAG indexing failed:", indexError);
          }
        } else {
          const firestore = await getFirestoreDb();
          const {FieldValue} = await import("firebase-admin/firestore");
          await firestore.collection("studies").doc(docId).set({
            ...extractedData,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        return {
          status: "saved" as const,
          docId,
          duplicateReport: null,
          message: `First study added to database (${USE_LOCAL_STORAGE ? "local" : "Firestore"}).`,
        };
      }

      // 3. Ask Gemini to check for semantic duplicates
      const {output: assessment} = await ai.generate({
        prompt: `You are a research assistant managing a systematic review database.
Check if the NEW STUDY is a duplicate or cohort overlap of an EXISTING STUDY.

CRITERIA FOR DUPLICATE/OVERLAP:
1. Same or very similar Hospital/Center name (account for variations like "Charité" vs "Charité Universitätsmedizin")
2. Overlapping Study Periods (e.g., Study A is 2010-2015, Study B is 2010-2018 from same center)
3. Similar first author names
4. Similar sample sizes from same institution/period suggest same cohort

---
NEW STUDY:
- Center: ${extractedData.metadata.hospitalCenter}
- Period: ${extractedData.metadata.studyPeriod}
- First Author: ${extractedData.metadata.firstAuthor}
- Year: ${extractedData.metadata.publicationYear}
- Sample Size: ${extractedData.population.sampleSize}
---
EXISTING STUDIES IN DATABASE:
${JSON.stringify(existingStudies, null, 2)}

Analyze carefully and return your assessment.`,
        output: {schema: DuplicateAssessmentSchema},
      });

      if (!assessment) {
        throw new Error("Failed to generate duplicate assessment");
      }

      // 4. Handle based on assessment
      if (assessment.isDuplicate && assessment.confidence !== "Low") {
        return {
          status: "flagged_duplicate" as const,
          docId: null,
          duplicateReport: assessment,
          message: `⚠️ Potential duplicate detected (${assessment.confidence} confidence): ${assessment.reasoning}`,
        };
      }

      // 5. No significant duplicate found - save to database
      const docId = generateId();
      if (USE_LOCAL_STORAGE) {
        const studies = loadLocalStudies();
        studies.push({
          id: docId,
          data: extractedData,
          createdAt: new Date().toISOString(),
          duplicateCheck: assessment,
        });
        saveLocalStudies(studies);

        // Index for RAG
        try {
          await ai.index({
            indexer: "devLocalVectorstore/studyIndex",
            documents: [
              Document.fromText(JSON.stringify(extractedData), {
                id: docId,
                firstAuthor: extractedData.metadata.firstAuthor,
                hospital: extractedData.metadata.hospitalCenter,
              }),
            ],
          });
        } catch (indexError) {
          console.warn("Warning: RAG indexing failed:", indexError);
        }
      } else {
        const firestore = await getFirestoreDb();
        const {FieldValue} = await import("firebase-admin/firestore");
        await firestore.collection("studies").doc(docId).set({
          ...extractedData,
          duplicateCheck: assessment,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      return {
        status: "saved" as const,
        docId,
        duplicateReport: assessment,
        message: `✅ Study saved with ID: ${docId} (${USE_LOCAL_STORAGE ? "local" : "Firestore"})`,
      };
    } catch (error) {
      return {
        status: "error" as const,
        docId: null,
        duplicateReport: null,
        message: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
);

/**
 * List all studies in the database
 * Supports both local storage (dev) and Firestore (production)
 */
export const listStudies = ai.defineFlow(
  {
    name: "listStudies",
    inputSchema: z.object({}),
    outputSchema: z.object({
      count: z.number(),
      storageMode: z.string(),
      studies: z.array(z.object({
        id: z.string(),
        firstAuthor: z.string(),
        year: z.number(),
        hospital: z.string(),
        sampleSize: z.number(),
      })),
    }),
  },
  async () => {
    let studies: Array<{
      id: string;
      firstAuthor: string;
      year: number;
      hospital: string;
      sampleSize: number;
    }> = [];

    if (USE_LOCAL_STORAGE) {
      const localStudies = loadLocalStudies();
      studies = localStudies.map((s) => {
        const data = s.data as CerebellarSDCData;
        return {
          id: s.id,
          firstAuthor: data.metadata?.firstAuthor || "Unknown",
          year: data.metadata?.publicationYear || 0,
          hospital: data.metadata?.hospitalCenter || "Unknown",
          sampleSize: data.population?.sampleSize || 0,
        };
      });
    } else {
      const firestore = await getFirestoreDb();
      const snapshot = await firestore.collection("studies").get();
      studies = snapshot.docs.map((doc) => ({
        id: doc.id,
        firstAuthor: doc.data().metadata?.firstAuthor || "Unknown",
        year: doc.data().metadata?.publicationYear || 0,
        hospital: doc.data().metadata?.hospitalCenter || "Unknown",
        sampleSize: doc.data().population?.sampleSize || 0,
      }));
    }

    return {
      count: studies.length,
      storageMode: USE_LOCAL_STORAGE ? "local" : "firestore",
      studies,
    };
  }
);

/**
 * RAG-powered semantic search for similar studies
 * Uses vector embeddings to find related research
 */
export const searchSimilarStudies = ai.defineFlow(
  {
    name: "searchSimilarStudies",
    inputSchema: z.object({
      query: z.string().describe("Search query (e.g., 'cerebellar stroke mortality outcomes')"),
      limit: z.number().default(5).describe("Maximum number of results"),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        id: z.string(),
        relevanceScore: z.number(),
        content: z.string(),
        metadata: z.record(z.unknown()),
      })),
    }),
  },
  async ({query, limit = 5}) => {
    const docs = await ai.retrieve({
      retriever: "devLocalVectorstore/studyIndex",
      query,
      options: {k: limit},
    });

    return {
      results: docs.map((doc, idx) => ({
        id: doc.metadata?.id as string || `result_${idx}`,
        relevanceScore: doc.metadata?.score as number || 0,
        content: doc.text.slice(0, 500) + "...",
        metadata: doc.metadata || {},
      })),
    };
  }
);

// ==========================================
// 5. Evaluation Framework
// ==========================================

/**
 * Schema Completeness Evaluator
 * Checks if all critical fields have been extracted
 */
export const schemaCompletenessEvaluator = ai.defineEvaluator(
  {
    name: "cerebellar/schemaCompleteness",
    displayName: "Schema Completeness",
    definition: "Evaluates whether all critical fields in the extraction schema are populated",
  },
  async (datapoint) => {
    const output = datapoint.output as CerebellarSDCData;
    if (!output) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {score: 0, details: {reason: "No output provided"}},
      };
    }

    // Define critical fields that must be present
    const criticalFields = [
      {path: "metadata.firstAuthor", value: output.metadata?.firstAuthor},
      {path: "metadata.publicationYear", value: output.metadata?.publicationYear},
      {path: "metadata.hospitalCenter", value: output.metadata?.hospitalCenter},
      {path: "population.sampleSize", value: output.population?.sampleSize},
      {path: "population.diagnosis", value: output.population?.diagnosis},
      {path: "intervention.procedure", value: output.intervention?.procedure},
      {path: "outcomes.mortality.value", value: output.outcomes?.mortality?.value},
      {path: "quality.totalScore", value: output.quality?.totalScore},
    ];

    const populated = criticalFields.filter(f => f.value !== null && f.value !== undefined);
    const score = populated.length / criticalFields.length;
    const missingFields = criticalFields.filter(f => f.value === null || f.value === undefined);

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score,
        details: {
          populated: populated.length,
          total: criticalFields.length,
          missingFields: missingFields.map(f => f.path),
        },
      },
    };
  }
);

/**
 * Source Text Verification Evaluator
 * Checks if VerifiableFields have proper source quotes
 */
export const sourceTextVerificationEvaluator = ai.defineEvaluator(
  {
    name: "cerebellar/sourceTextVerification",
    displayName: "Source Text Verification",
    definition: "Evaluates whether extracted values have supporting source quotes",
  },
  async (datapoint) => {
    const output = datapoint.output as CerebellarSDCData;
    if (!output) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {score: 0, details: {reason: "No output provided"}},
      };
    }

    // Check all VerifiableFields
    const verifiableFields = [
      {path: "population.age.mean", field: output.population?.age?.mean},
      {path: "population.age.sd", field: output.population?.age?.sd},
      {path: "population.gcs.admissionMean", field: output.population?.gcs?.admissionMean},
      {path: "population.gcs.preOpMean", field: output.population?.gcs?.preOpMean},
      {path: "population.hydrocephalus", field: output.population?.hydrocephalus},
      {path: "intervention.technique", field: output.intervention?.technique},
      {path: "intervention.evdUsed", field: output.intervention?.evdUsed},
      {path: "intervention.duraplasty", field: output.intervention?.duraplasty},
      {path: "intervention.timingToSurgery", field: output.intervention?.timingToSurgery},
      {path: "outcomes.mortality", field: output.outcomes?.mortality},
      {path: "outcomes.mRS_favorable", field: output.outcomes?.mRS_favorable},
      {path: "outcomes.lengthOfStay", field: output.outcomes?.lengthOfStay},
    ];

    const withValue = verifiableFields.filter(f => f.field?.value !== null && f.field?.value !== undefined);
    const withSource = withValue.filter(f => f.field?.sourceText && f.field.sourceText.length > 10);

    const score = withValue.length > 0 ? withSource.length / withValue.length : 1;
    const missingSources = withValue.filter(f => !f.field?.sourceText || f.field.sourceText.length <= 10);

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score,
        details: {
          fieldsWithValue: withValue.length,
          fieldsWithSource: withSource.length,
          missingSources: missingSources.map(f => f.path),
        },
      },
    };
  }
);

/**
 * NOS Consistency Evaluator
 * Checks if Newcastle-Ottawa Scale scores are consistent
 */
export const nosConsistencyEvaluator = ai.defineEvaluator(
  {
    name: "cerebellar/nosConsistency",
    displayName: "NOS Score Consistency",
    definition: "Evaluates whether Newcastle-Ottawa Scale scores are mathematically consistent",
  },
  async (datapoint) => {
    const output = datapoint.output as CerebellarSDCData;
    if (!output?.quality) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {score: 0, details: {reason: "No quality data provided"}},
      };
    }

    const {selectionScore, comparabilityScore, outcomeScore, totalScore} = output.quality;

    // Validate ranges
    const rangeValid =
      selectionScore >= 0 && selectionScore <= 4 &&
      comparabilityScore >= 0 && comparabilityScore <= 2 &&
      outcomeScore >= 0 && outcomeScore <= 3 &&
      totalScore >= 0 && totalScore <= 9;

    // Validate total equals sum
    const expectedTotal = selectionScore + comparabilityScore + outcomeScore;
    const sumMatches = totalScore === expectedTotal;

    let score = 0;
    if (rangeValid) score += 0.5;
    if (sumMatches) score += 0.5;

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score,
        details: {
          rangeValid,
          sumMatches,
          expectedTotal,
          actualTotal: totalScore,
          components: {selectionScore, comparabilityScore, outcomeScore},
        },
      },
    };
  }
);

/**
 * LLM-based Accuracy Evaluator
 * Uses Gemini to verify if extracted values match the source text
 */
export const llmAccuracyEvaluator = ai.defineEvaluator(
  {
    name: "cerebellar/llmAccuracy",
    displayName: "LLM Accuracy Check",
    definition: "Uses LLM to verify if extracted values are supported by the source text",
  },
  async (datapoint) => {
    const output = datapoint.output as CerebellarSDCData;
    const context = datapoint.context as string | undefined;

    if (!output || !context) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {score: 0, details: {reason: "Missing output or context (PDF text)"}},
      };
    }

    // Sample key extractions for verification
    const claimsToVerify = [
      `Sample size is ${output.population?.sampleSize}`,
      `First author is ${output.metadata?.firstAuthor}`,
      `Publication year is ${output.metadata?.publicationYear}`,
      output.outcomes?.mortality?.value ? `Mortality: ${output.outcomes.mortality.value}` : null,
      output.population?.age?.mean?.value ? `Mean age: ${output.population.age.mean.value}` : null,
    ].filter(Boolean).join("\n- ");

    const {output: verification} = await ai.generate({
      prompt: `You are verifying data extraction accuracy.

Given the following claims extracted from a medical paper:
- ${claimsToVerify}

And the original paper text (truncated):
${context.slice(0, 15000)}

For each claim, determine if it is SUPPORTED, PARTIALLY SUPPORTED, or UNSUPPORTED by the text.
Return a JSON object with:
{
  "overallAccuracy": 0-1 (proportion of supported claims),
  "claims": [{"claim": "...", "status": "SUPPORTED|PARTIALLY|UNSUPPORTED", "reason": "..."}]
}`,
      output: {
        schema: z.object({
          overallAccuracy: z.number().min(0).max(1),
          claims: z.array(z.object({
            claim: z.string(),
            status: z.enum(["SUPPORTED", "PARTIALLY", "UNSUPPORTED"]),
            reason: z.string(),
          })),
        }),
      },
    });

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: verification?.overallAccuracy || 0,
        details: verification || {reason: "LLM verification failed"},
      },
    };
  }
);

/**
 * Run all evaluators on extracted data
 */
export const evaluateExtraction = ai.defineFlow(
  {
    name: "evaluateExtraction",
    inputSchema: z.object({
      extractedData: CerebellarSDCSchema,
      pdfText: z.string().optional().describe("Original PDF text for LLM accuracy check"),
    }),
    outputSchema: z.object({
      overallScore: z.number(),
      evaluations: z.array(z.object({
        evaluator: z.string(),
        score: z.number(),
        details: z.record(z.unknown()),
      })),
      recommendations: z.array(z.string()),
    }),
  },
  async ({extractedData, pdfText}) => {
    // Helper functions for evaluation (bypass evaluator framework for direct use)
    function evaluateSchemaCompleteness(output: CerebellarSDCData) {
      const criticalFields = [
        {path: "metadata.firstAuthor", value: output.metadata?.firstAuthor},
        {path: "metadata.publicationYear", value: output.metadata?.publicationYear},
        {path: "metadata.hospitalCenter", value: output.metadata?.hospitalCenter},
        {path: "population.sampleSize", value: output.population?.sampleSize},
        {path: "population.diagnosis", value: output.population?.diagnosis},
        {path: "intervention.procedure", value: output.intervention?.procedure},
        {path: "outcomes.mortality.value", value: output.outcomes?.mortality?.value},
        {path: "quality.totalScore", value: output.quality?.totalScore},
      ];
      const populated = criticalFields.filter(f => f.value !== null && f.value !== undefined);
      const missingFields = criticalFields.filter(f => f.value === null || f.value === undefined);
      return {
        score: populated.length / criticalFields.length,
        details: {populated: populated.length, total: criticalFields.length, missingFields: missingFields.map(f => f.path)},
      };
    }

    function evaluateSourceTextVerification(output: CerebellarSDCData) {
      const verifiableFields = [
        {path: "population.age.mean", field: output.population?.age?.mean},
        {path: "population.age.sd", field: output.population?.age?.sd},
        {path: "population.gcs.admissionMean", field: output.population?.gcs?.admissionMean},
        {path: "population.hydrocephalus", field: output.population?.hydrocephalus},
        {path: "intervention.technique", field: output.intervention?.technique},
        {path: "intervention.evdUsed", field: output.intervention?.evdUsed},
        {path: "outcomes.mortality", field: output.outcomes?.mortality},
        {path: "outcomes.mRS_favorable", field: output.outcomes?.mRS_favorable},
      ];
      const withValue = verifiableFields.filter(f => f.field?.value !== null && f.field?.value !== undefined);
      const withSource = withValue.filter(f => f.field?.sourceText && f.field.sourceText.length > 10);
      const missingSources = withValue.filter(f => !f.field?.sourceText || f.field.sourceText.length <= 10);
      return {
        score: withValue.length > 0 ? withSource.length / withValue.length : 1,
        details: {fieldsWithValue: withValue.length, fieldsWithSource: withSource.length, missingSources: missingSources.map(f => f.path)},
      };
    }

    function evaluateNosConsistency(output: CerebellarSDCData) {
      const quality = output.quality;
      if (!quality) return {score: 0, details: {reason: "No quality data"}};
      const {selectionScore, comparabilityScore, outcomeScore, totalScore} = quality;
      const expectedTotal = (selectionScore || 0) + (comparabilityScore || 0) + (outcomeScore || 0);
      const rangeValid = (selectionScore ?? 0) <= 4 && (comparabilityScore ?? 0) <= 2 && (outcomeScore ?? 0) <= 3;
      const sumMatches = totalScore === expectedTotal;
      let score = 0;
      if (rangeValid) score += 0.5;
      if (sumMatches) score += 0.5;
      return {score, details: {rangeValid, sumMatches, expectedTotal, actualTotal: totalScore}};
    }

    // Run all evaluations
    const completeness = evaluateSchemaCompleteness(extractedData);
    const sourceVerification = evaluateSourceTextVerification(extractedData);
    const nosConsistency = evaluateNosConsistency(extractedData);

    // Use explicit type for evaluations array to allow varied detail structures
    const evaluations: Array<{evaluator: string; score: number; details: Record<string, unknown>}> = [
      {evaluator: "Schema Completeness", score: completeness.score, details: completeness.details as Record<string, unknown>},
      {evaluator: "Source Text Verification", score: sourceVerification.score, details: sourceVerification.details as Record<string, unknown>},
      {evaluator: "NOS Consistency", score: nosConsistency.score, details: nosConsistency.details as Record<string, unknown>},
    ];

    // Run LLM accuracy check if PDF text is provided
    if (pdfText) {
      const claimsToVerify = [
        `Sample size is ${extractedData.population?.sampleSize}`,
        `First author is ${extractedData.metadata?.firstAuthor}`,
        `Publication year is ${extractedData.metadata?.publicationYear}`,
        extractedData.outcomes?.mortality?.value ? `Mortality: ${extractedData.outcomes.mortality.value}` : null,
      ].filter(Boolean).join("\n- ");

      try {
        const {output: verification} = await ai.generate({
          prompt: `Verify these claims from a medical paper:\n- ${claimsToVerify}\n\nSource text (truncated):\n${pdfText.slice(0, 15000)}\n\nReturn JSON: {"overallAccuracy": 0-1, "claims": [{"claim": "...", "status": "SUPPORTED|PARTIALLY|UNSUPPORTED"}]}`,
          output: {schema: z.object({overallAccuracy: z.number(), claims: z.array(z.object({claim: z.string(), status: z.string()}))})},
        });
        evaluations.push({evaluator: "LLM Accuracy", score: verification?.overallAccuracy || 0, details: (verification || {}) as Record<string, unknown>});
      } catch {
        evaluations.push({evaluator: "LLM Accuracy", score: 0, details: {error: "LLM verification failed"}});
      }
    }

    // Calculate weighted overall score
    const weights: Record<string, number> = {
      "Schema Completeness": 0.3,
      "Source Text Verification": 0.3,
      "NOS Consistency": 0.15,
      "LLM Accuracy": 0.25,
    };

    let totalWeight = 0;
    let weightedSum = 0;
    for (const ev of evaluations) {
      const weight = weights[ev.evaluator] || 0.1;
      weightedSum += ev.score * weight;
      totalWeight += weight;
    }
    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Generate recommendations
    const recommendations: string[] = [];
    if ((completeness.details as {missingFields?: string[]})?.missingFields?.length) {
      recommendations.push(`Missing critical fields: ${(completeness.details as {missingFields: string[]}).missingFields.join(", ")}`);
    }
    if ((sourceVerification.details as {missingSources?: string[]})?.missingSources?.length) {
      recommendations.push(`Add source quotes for: ${(sourceVerification.details as {missingSources: string[]}).missingSources.join(", ")}`);
    }
    if (!(nosConsistency.details as {sumMatches?: boolean})?.sumMatches) {
      recommendations.push("NOS total score doesn't match sum of components - verify calculation");
    }

    return {
      overallScore: Math.round(overallScore * 100) / 100,
      evaluations,
      recommendations,
    };
  }
);

// ==========================================
// CSV Export Helper Functions
// ==========================================

/**
 * Flattens a VerifiableField into separate columns for CSV export
 */
function flattenVerifiable(
  flatData: Record<string, unknown>,
  prefix: string,
  field: {value: unknown; sourceText: string | null} | undefined
) {
  if (!field) {
    flatData[`${prefix}`] = null;
    flatData[`${prefix}_Source`] = null;
    return;
  }
  flatData[`${prefix}`] = field.value;
  flatData[`${prefix}_Source`] = field.sourceText;
}

/**
 * Flattens the hierarchical CerebellarSDCData into a flat row for CSV export
 * Converts nested VerifiableFields into separate columns
 */
export function flattenStudyData(study: CerebellarSDCData & {docId?: string}): Record<string, unknown> {
  const flatData: Record<string, unknown> = {
    // Metadata
    DocID: study.docId || "N/A",
    FirstAuthor: study.metadata.firstAuthor,
    Year: study.metadata.publicationYear,
    Title: study.metadata.title,
    Journal: study.metadata.journal,
    Hospital: study.metadata.hospitalCenter,
    StudyPeriod: study.metadata.studyPeriod,
    StudyDesign: study.metadata.studyDesign,

    // Population - Basic
    SampleSize: study.population.sampleSize,
    Diagnosis: study.population.diagnosis,
    InclusionCriteria: study.population.inclusionCriteria.join("; "),
  };

  // Population - Verifiable Fields
  flattenVerifiable(flatData, "Age_Mean", study.population.age.mean);
  flattenVerifiable(flatData, "Age_SD", study.population.age.sd);
  flatData["Age_Range"] = study.population.age.range;
  flattenVerifiable(flatData, "GCS_Admission", study.population.gcs.admissionMean);
  flattenVerifiable(flatData, "GCS_PreOp", study.population.gcs.preOpMean);
  flattenVerifiable(flatData, "Hydrocephalus_Pct", study.population.hydrocephalus);

  // Intervention
  flatData["Procedure"] = study.intervention.procedure;
  flattenVerifiable(flatData, "Technique", study.intervention.technique);
  flattenVerifiable(flatData, "EVD_Used", study.intervention.evdUsed);
  flattenVerifiable(flatData, "Duraplasty", study.intervention.duraplasty);
  flattenVerifiable(flatData, "TimingToSurgery_Hours", study.intervention.timingToSurgery);
  flatData["Intervention_Notes"] = study.intervention.additionalDetails;

  // Comparator
  flatData["Comparator_Exists"] = study.comparator.exists;
  flatData["Comparator_Type"] = study.comparator.type;
  flatData["Comparator_Description"] = study.comparator.description;
  flatData["Comparator_N"] = study.comparator.sampleSize;

  // Outcomes
  flattenVerifiable(flatData, "Mortality", study.outcomes.mortality);
  flattenVerifiable(flatData, "mRS_Favorable", study.outcomes.mRS_favorable);
  flattenVerifiable(flatData, "LOS_Days", study.outcomes.lengthOfStay);
  flatData["Complications"] = study.outcomes.complications.join("; ");

  // All outcome measures as a semi-colon separated list
  flatData["AllOutcomes"] = study.outcomes.allOutcomes
    .map(o => `${o.measureName}@${o.timepoint}: ${o.resultValue}`)
    .join("; ");

  // Quality Assessment (NOS)
  flatData["NOS_Selection"] = study.quality.selectionScore;
  flatData["NOS_Comparability"] = study.quality.comparabilityScore;
  flatData["NOS_Outcome"] = study.quality.outcomeScore;
  flatData["NOS_Total"] = study.quality.totalScore;
  flatData["Bias_Notes"] = study.quality.biasNotes;

  return flatData;
}

/**
 * Export all studies to CSV file
 * Supports both local storage (dev) and Firestore (production)
 */
export const exportDatasetToCSV = ai.defineFlow(
  {
    name: "exportDatasetToCSV",
    inputSchema: z.object({
      outputPath: z.string().default("./output/sdc_dataset.csv"),
      includeDuplicates: z.boolean().default(false).describe("Include studies flagged as duplicates"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      count: z.number(),
      path: z.string(),
      message: z.string(),
    }),
  },
  async ({outputPath, includeDuplicates = false}) => {
    // 1. Fetch all studies from storage
    const studies: Array<CerebellarSDCData & {docId: string; isDuplicate: boolean}> = [];

    if (USE_LOCAL_STORAGE) {
      const localStudies = loadLocalStudies();
      if (localStudies.length === 0) {
        return {
          success: false,
          count: 0,
          path: outputPath,
          message: "No studies found in local database. Use 'batch' or 'extract' to add studies first.",
        };
      }
      localStudies.forEach((s) => {
        const data = s.data as CerebellarSDCData;
        const isDuplicate = (s.duplicateCheck as DuplicateAssessment | undefined)?.isDuplicate &&
          (s.duplicateCheck as DuplicateAssessment | undefined)?.confidence !== "Low";
        if (includeDuplicates || !isDuplicate) {
          studies.push({
            ...data,
            docId: s.id,
            isDuplicate: isDuplicate || false,
          });
        }
      });
    } else {
      const firestore = await getFirestoreDb();
      const snapshot = await firestore.collection("studies").get();

      if (snapshot.empty) {
        return {
          success: false,
          count: 0,
          path: outputPath,
          message: "No studies found in Firestore. Use 'batch' or 'extract' to add studies first.",
        };
      }

      snapshot.forEach(doc => {
        const data = doc.data();
        const isDuplicate = data.duplicateCheck?.isDuplicate && data.duplicateCheck?.confidence !== "Low";
        if (includeDuplicates || !isDuplicate) {
          studies.push({
            ...data as CerebellarSDCData,
            docId: doc.id,
            isDuplicate,
          });
        }
      });
    }

    if (studies.length === 0) {
      return {
        success: false,
        count: 0,
        path: outputPath,
        message: "All studies are flagged as duplicates. Use --include-duplicates to export them.",
      };
    }

    // 3. Flatten data for CSV
    const flatRows = studies.map(s => ({
      ...flattenStudyData(s),
      IsDuplicate: s.isDuplicate,
    }));

    // 4. Convert to CSV
    const parser = new Parser();
    const csv = parser.parse(flatRows);

    // 5. Ensure output directory exists
    const outputDir = path.dirname(path.resolve(outputPath));
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, {recursive: true});
    }

    // 6. Write to file
    fs.writeFileSync(path.resolve(outputPath), csv);

    console.log(`\n✅ Dataset exported to ${outputPath}`);
    console.log(`   Total studies: ${studies.length}`);
    console.log(`   Columns: ${Object.keys(flatRows[0]).length}`);

    return {
      success: true,
      count: studies.length,
      path: path.resolve(outputPath),
      message: `Exported ${studies.length} studies to ${outputPath}`,
    };
  }
);

/**
 * Batch process multiple PDFs from a directory
 * Uses concurrency limiting to avoid API rate limits
 */
export const batchProcessPDFs = ai.defineFlow(
  {
    name: "batchProcessPDFs",
    inputSchema: z.object({
      directory: z.string().describe("Path to directory containing PDFs"),
      concurrency: z.number().default(2).describe("Number of concurrent extractions (default: 2)"),
    }),
    outputSchema: z.object({
      totalFiles: z.number(),
      processed: z.number(),
      saved: z.number(),
      duplicates: z.number(),
      errors: z.number(),
      results: z.array(z.object({
        filename: z.string(),
        status: z.enum(["saved", "flagged_duplicate", "error"]),
        docId: z.string().nullable(),
        message: z.string(),
      })),
    }),
  },
  async ({directory, concurrency = 2}) => {
    // Find all PDF files in the directory
    const dirPath = path.resolve(directory);
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (files.length === 0) {
      throw new Error(`No PDF files found in: ${dirPath}`);
    }

    console.log(`\n📁 Found ${files.length} PDF files in ${dirPath}`);
    console.log(`🔄 Processing with concurrency: ${concurrency}\n`);

    // Set up concurrency limiter
    const limit = pLimit(concurrency);

    // Process each PDF
    const results: Array<{
      filename: string;
      status: "saved" | "flagged_duplicate" | "error";
      docId: string | null;
      message: string;
    }> = [];

    const processFile = async (filename: string) => {
      const filepath = path.join(dirPath, filename);
      console.log(`📄 Processing: ${filename}...`);

      try {
        // Read and parse PDF
        const dataBuffer = fs.readFileSync(filepath);
        const pdfData = await parsePdf(dataBuffer);
        const pdfText = pdfData.text;

        if (!pdfText || pdfText.length < 100) {
          return {
            filename,
            status: "error" as const,
            docId: null,
            message: "PDF appears empty or contains minimal text (possible scanned PDF)",
          };
        }

        // Extract structured data
        console.log(`   🧠 Extracting data from ${filename}...`);
        const extractedData = await extractStudyData({pdfText});

        // Check for duplicates and save
        console.log(`   💾 Checking duplicates and saving ${filename}...`);
        const saveResult = await checkAndSaveStudy(extractedData);

        console.log(`   ✅ ${filename}: ${saveResult.status}`);
        return {
          filename,
          status: saveResult.status,
          docId: saveResult.docId,
          message: saveResult.message,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ❌ ${filename}: ${errorMsg}`);
        return {
          filename,
          status: "error" as const,
          docId: null,
          message: errorMsg,
        };
      }
    };

    // Process all files with concurrency limit
    const promises = files.map(f => limit(() => processFile(f)));
    const processedResults = await Promise.all(promises);
    results.push(...processedResults);

    // Calculate summary stats
    const saved = results.filter(r => r.status === "saved").length;
    const duplicates = results.filter(r => r.status === "flagged_duplicate").length;
    const errors = results.filter(r => r.status === "error").length;

    console.log(`\n========================================`);
    console.log(`📊 BATCH PROCESSING COMPLETE`);
    console.log(`========================================`);
    console.log(`   Total files: ${files.length}`);
    console.log(`   ✅ Saved: ${saved}`);
    console.log(`   ⚠️  Duplicates: ${duplicates}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`========================================\n`);

    return {
      totalFiles: files.length,
      processed: results.length,
      saved,
      duplicates,
      errors,
      results,
    };
  }
);

/**
 * Conversation flow - for interactive collaboration with Gemini
 */
export const chat = ai.defineFlow(
  {
    name: "chat",
    inputSchema: z.object({
      message: z.string().describe("Your message to Gemini"),
      context: z.string().optional().describe("Optional context about current task"),
    }),
    outputSchema: z.object({
      response: z.string(),
    }),
  },
  async ({message, context}) => {
    const systemContext = context || `You are collaborating with a medical researcher on a systematic review of Suboccipital Decompressive Craniectomy (SDC) for cerebellar stroke.
You have access to a Genkit-powered extraction system with Zod schemas for structured data extraction.
Be helpful, precise, and provide code examples when relevant.`;

    const {text} = await ai.generate(`${systemContext}\n\nUser: ${message}`);
    return {response: text};
  }
);

/**
 * Interactive PDF Chat - Query a specific PDF document
 * Based on Genkit chat-with-pdf tutorial pattern
 */
export async function chatWithPDF(pdfPath: string): Promise<void> {
  // 1. Load and parse the PDF
  const absolutePath = path.resolve(pdfPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`PDF not found: ${absolutePath}`);
  }

  console.log(`\n📄 Loading PDF: ${absolutePath}`);
  const dataBuffer = fs.readFileSync(absolutePath);
  const pdfData = await parsePdf(dataBuffer);
  const pdfText = pdfData.text;

  if (!pdfText || pdfText.length < 100) {
    throw new Error("PDF appears empty or is a scanned image (OCR not supported)");
  }

  console.log(`   ✅ Loaded ${pdfText.length} characters from ${pdfData.numpages} pages`);

  // 2. Create the system prompt with PDF context
  const systemPrompt = `You are an expert neurosurgical researcher assistant helping with a systematic review on Suboccipital Decompressive Craniectomy (SDC) for cerebellar stroke.

You have been given the full text of a medical research paper. Your role is to:
1. Answer questions about this specific paper accurately
2. Extract data points when asked (demographics, outcomes, surgical techniques)
3. Identify limitations or potential biases in the study
4. Compare findings with standard practices when relevant
5. Always cite the specific section or quote from the paper that supports your answer

IMPORTANT: Only answer based on the content of this paper. If information is not in the paper, say so clearly.

---
PAPER CONTENT:
${pdfText}
---

Ready to answer questions about this paper.`;

  // 3. Set up readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 4. Initialize conversation history
  type MessageRole = "user" | "model";
  const history: Array<{role: MessageRole; content: string}> = [];

  console.log(`\n🧠 Chat session started. Ask questions about the paper.`);
  console.log(`   Type 'exit' or press Ctrl+C to quit.\n`);

  // Quick extraction prompts
  console.log(`💡 Quick commands:`);
  console.log(`   /summary    - Get a brief summary of the study`);
  console.log(`   /pico       - Extract PICO elements`);
  console.log(`   /outcomes   - List all reported outcomes`);
  console.log(`   /quality    - Assess study quality (NOS)`);
  console.log(`   /extract    - Run full structured extraction\n`);

  // 5. Interactive chat loop
  while (true) {
    const userInput = await rl.question("You: ");

    if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log("\n👋 Chat session ended.");
      rl.close();
      break;
    }

    // Handle quick commands
    let prompt = userInput;
    if (userInput === "/summary") {
      prompt = "Provide a brief summary of this study in 3-4 sentences, including: study design, sample size, main intervention, and key findings.";
    } else if (userInput === "/pico") {
      prompt = "Extract the PICO elements from this study: Population (who was studied, inclusion/exclusion criteria), Intervention (what surgical procedure), Comparator (if any control group), Outcomes (primary and secondary outcomes measured).";
    } else if (userInput === "/outcomes") {
      prompt = "List all reported outcomes from this study, including: mortality rates, functional outcomes (GOS, mRS), complications, and any other measured endpoints. Include the specific values and timepoints.";
    } else if (userInput === "/quality") {
      prompt = "Assess the methodological quality of this study using the Newcastle-Ottawa Scale criteria: Selection (4 items), Comparability (2 items), Outcome (3 items). Provide scores and rationale for each.";
    } else if (userInput === "/extract") {
      prompt = `Extract all data fields needed for meta-analysis:
1. Study Metadata: Authors, year, journal, hospital, study period
2. Population: Sample size, age (mean±SD), GCS scores, diagnosis, hydrocephalus %
3. Intervention: Procedure details, timing, EVD use, duraplasty
4. Comparator: If present, describe the control group
5. Outcomes: Mortality (with timepoint), mRS outcomes (with definition), complications, length of stay
6. Quality: Newcastle-Ottawa Scale assessment

For each numeric value, provide the exact quote from the paper.`;
    }

    try {
      // Add user message to history
      history.push({role: "user", content: prompt});

      // Generate response with conversation history
      const {text} = await ai.generate({
        system: systemPrompt,
        messages: history.map(msg => ({
          role: msg.role,
          content: [{text: msg.content}],
        })),
      });

      // Add assistant response to history
      history.push({role: "model", content: text});

      console.log(`\nGemini: ${text}\n`);
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

// ==========================================
// 4. CLI Entry Point
// ==========================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "chat";

  if (command === "chat") {
    // Interactive collaboration mode
    const message = args.slice(1).join(" ") ||
      `Excellent progress! The system is now feature-complete for basic systematic review data extraction:

✅ **Completed Features:**
- CerebellarSDCSchema with VerifiableFields (value + sourceText pairs)
- formatVerificationReport() for human-readable audit trails
- extractStudyData flow for structured PICO extraction
- checkAndSaveStudy flow with semantic duplicate detection
- batchProcessPDFs flow with p-limit concurrency control
- exportDatasetToCSV flow with flattened VerifiableFields
- **chatWithPDF** - Interactive PDF chat with quick commands (/summary, /pico, /outcomes, /quality, /extract)

🔧 **CLI Commands:**
- npm run genkit pdf ./study.pdf  → Chat with specific paper
- npm run genkit batch ./pdfs 3   → Batch process directory
- npm run genkit export           → Export to CSV
- npm run genkit list             → View database

📚 **Genkit Resources Studied:**
- Multi-agent systems (genkit.dev/docs/multi-agent/)
- Agentic patterns (genkit.dev/docs/agentic-patterns/)
- Chat with PDF tutorial (genkit.dev/docs/tutorials/chat-with-pdf/)
- Flows documentation (genkit.dev/docs/flows/)

🤔 **Architecture Question:**
The multi-agent docs show how to create specialized agents that a triage agent routes to.
For systematic review, we could create:
- PopulationAgent (demographics, sample size, inclusion criteria)
- InterventionAgent (surgical technique, timing, EVD use)
- OutcomesAgent (mortality, mRS, complications)
- QualityAgent (Newcastle-Ottawa Scale assessment)

Each would have focused prompts optimized for their domain.
The main extractStudyData flow would delegate to these specialists.

Should we implement this multi-agent architecture? Or focus on:
1. RAG for cross-referencing extracted data across studies
2. Web UI for reviewing flagged duplicates
3. Streaming output for large batch processing
4. Firebase Cloud Function deployment

What's the best next step for production use?`;

    const result = await chat({message});
    console.log(result.response);
  } else if (command === "extract") {
    // Extraction mode
    const pdfText = args.slice(1).join(" ");
    if (!pdfText) {
      console.error("Usage: npm run genkit extract <pdf_text>");
      process.exit(1);
    }
    const data = await extractStudyData({pdfText});
    console.log("\n=== EXTRACTED DATA (JSON) ===\n");
    console.log(JSON.stringify(data, null, 2));
    console.log("\n=== VERIFICATION REPORT ===\n");
    console.log(formatVerificationReport(data));
  } else if (command === "list") {
    // List all studies in Firestore
    const result = await listStudies({});
    console.log(`\n=== STUDIES IN DATABASE (${result.count}) ===\n`);
    if (result.count === 0) {
      console.log("No studies yet. Use 'extract' to add some!");
    } else {
      result.studies.forEach((s, i) => {
        console.log(`${i + 1}. ${s.firstAuthor} (${s.year}) - ${s.hospital} [n=${s.sampleSize}]`);
      });
    }
  } else if (command === "batch") {
    // Batch processing mode
    const directory = args[1];
    const concurrency = parseInt(args[2]) || 2;

    if (!directory) {
      console.error("Usage: npm run genkit batch <pdf_directory> [concurrency]");
      console.error("Example: npm run genkit batch ./pdfs 3");
      process.exit(1);
    }

    const result = await batchProcessPDFs({directory, concurrency});

    // Output detailed results as JSON for further processing
    console.log("\n=== DETAILED RESULTS (JSON) ===\n");
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "export") {
    // Export to CSV mode
    const outputPath = args[1] || "./output/sdc_dataset.csv";
    const includeDuplicates = args.includes("--include-duplicates");

    const result = await exportDatasetToCSV({outputPath, includeDuplicates});

    if (result.success) {
      console.log(`\n📁 File: ${result.path}`);
    } else {
      console.error(`\n❌ Export failed: ${result.message}`);
      process.exit(1);
    }
  } else if (command === "pdf") {
    // Interactive PDF chat mode
    const pdfPath = args[1];
    if (!pdfPath) {
      console.error("Usage: npm run genkit pdf <path_to_pdf>");
      console.error("Example: npm run genkit pdf ./pdfs/smith2022.pdf");
      process.exit(1);
    }
    await chatWithPDF(pdfPath);
  } else if (command === "search") {
    // RAG-powered semantic search
    const query = args.slice(1).join(" ");
    if (!query) {
      console.error("Usage: npm run genkit search <query>");
      console.error("Example: npm run genkit search 'cerebellar stroke mortality outcomes'");
      process.exit(1);
    }
    console.log(`\n🔍 Searching for: "${query}"\n`);
    const result = await searchSimilarStudies({query, limit: 5});
    if (result.results.length === 0) {
      console.log("No matching studies found. Add studies first with 'batch' or 'extract'.");
    } else {
      console.log(`Found ${result.results.length} relevant studies:\n`);
      result.results.forEach((r, i) => {
        console.log(`${i + 1}. [${r.id}] Score: ${r.relevanceScore.toFixed(3)}`);
        console.log(`   ${r.content}\n`);
      });
    }
  } else if (command === "eval") {
    // Evaluation mode - evaluate extracted data quality
    const pdfPath = args[1];
    if (!pdfPath) {
      console.error("Usage: npm run genkit eval <pdf_file>");
      console.error("Example: npm run genkit eval ./pdfs/smith2022.pdf");
      console.error("\nThis will extract data from the PDF and run quality evaluations.");
      process.exit(1);
    }

    const absolutePath = path.resolve(pdfPath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`PDF not found: ${absolutePath}`);
      process.exit(1);
    }

    console.log(`\n📄 Loading PDF: ${absolutePath}`);
    const dataBuffer = fs.readFileSync(absolutePath);
    const pdfData = await parsePdf(dataBuffer);
    const pdfText = pdfData.text;

    if (!pdfText || pdfText.length < 100) {
      console.error("PDF appears empty or is a scanned image");
      process.exit(1);
    }

    console.log(`   ✅ Loaded ${pdfText.length} characters\n`);
    console.log("🔄 Extracting structured data...");
    const extractedData = await extractStudyData({pdfText});

    console.log("📊 Running quality evaluations...\n");
    const evalResult = await evaluateExtraction({extractedData, pdfText});

    console.log("═══════════════════════════════════════════════════");
    console.log(`📈 OVERALL QUALITY SCORE: ${(evalResult.overallScore * 100).toFixed(1)}%`);
    console.log("═══════════════════════════════════════════════════\n");

    console.log("Individual Evaluations:");
    evalResult.evaluations.forEach((ev) => {
      const emoji = ev.score >= 0.8 ? "✅" : ev.score >= 0.5 ? "⚠️" : "❌";
      console.log(`  ${emoji} ${ev.evaluator}: ${(ev.score * 100).toFixed(1)}%`);
    });

    if (evalResult.recommendations.length > 0) {
      console.log("\n💡 Recommendations:");
      evalResult.recommendations.forEach((r) => {
        console.log(`  • ${r}`);
      });
    }

    console.log("\n📋 Extracted Study Summary:");
    console.log(`  Author: ${extractedData.metadata.firstAuthor} (${extractedData.metadata.publicationYear})`);
    console.log(`  Hospital: ${extractedData.metadata.hospitalCenter}`);
    console.log(`  Sample Size: ${extractedData.population.sampleSize}`);
    console.log(`  NOS Score: ${extractedData.quality.totalScore}/9`);

    // Show the full verification report WITH CITATIONS (sourceText)
    console.log("\n" + "═".repeat(50));
    console.log("📖 VERIFICATION REPORT WITH CITATIONS");
    console.log("═".repeat(50) + "\n");
    console.log(formatVerificationReport(extractedData));
  } else if (command === "help") {
    console.log(`
🧠 Cerebellar SDC Extraction System
Storage: ${USE_LOCAL_STORAGE ? "LOCAL (./data/studies.json)" : "FIRESTORE"}
MCP: genkit-cerebellar (exposing ${Object.keys({extractStudyData, checkAndSaveStudy, listStudies, searchSimilarStudies, evaluateExtraction}).length} flows)

Commands:
  chat [message]     - Collaborate with Gemini 3 Pro
  pdf <file>         - Interactive chat with a specific PDF
  extract <text>     - Extract structured data from PDF text
  batch <dir> [n]    - Batch process PDFs from directory (n = concurrency)
  search <query>     - RAG semantic search across indexed studies
  eval <file>        - Extract and evaluate quality from a PDF
  export [path]      - Export studies to CSV
  list               - Show all studies in database
  help               - Show this help

PDF Chat Commands (inside pdf session):
  /summary           - Get a brief summary of the study
  /pico              - Extract PICO elements
  /outcomes          - List all reported outcomes
  /quality           - Assess study quality (Newcastle-Ottawa Scale)
  /extract           - Run full structured extraction

Evaluation Metrics:
  • Schema Completeness   - Critical fields populated (30% weight)
  • Source Verification   - Values have supporting quotes (30% weight)
  • NOS Consistency       - Quality scores are valid (15% weight)
  • LLM Accuracy          - AI verifies values match text (25% weight)

Export Options:
  --include-duplicates  Include studies flagged as potential duplicates

Environment Variables:
  USE_FIRESTORE=true    Use Firestore instead of local JSON storage
  GOOGLE_GENAI_API_KEY  Your Google AI API key

Examples:
  npm run genkit chat "How should I handle multicenter studies?"
  npm run genkit pdf ./pdfs/smith2022.pdf
  npm run genkit eval ./pdfs/smith2022.pdf
  npm run genkit search "mortality outcomes cerebellar"
  npm run genkit batch ./pdfs 3
  npm run genkit export ./my_dataset.csv
  npm run genkit list
    `);
  } else {
    console.log("Unknown command. Use 'help' for available commands.");
  }
}

main().catch(console.error);

// Exports for use in other modules
export {ai};
