// Genkit AI configuration for cerebellar-extraction
// Firebase AI Logic with Google AI (Gemini 3 Pro)
// Production-ready extraction system for SDC systematic review
// Supports both local development (JSON files) and production (Firestore)

import * as dotenv from "dotenv";
dotenv.config({ override: true }); // Override existing env vars (e.g., from shell)
import {googleAI} from "@genkit-ai/googleai";
import {genkit, z, Document} from "genkit";
import {devLocalVectorstore} from "@genkit-ai/dev-local-vectorstore";
import * as fs from "fs";
import * as path from "path";
import {fileURLToPath} from "url";
import pLimit from "p-limit";
import {createRequire} from "module";
import {Parser} from "json2csv";
import * as readline from "readline/promises";
import {startFlowServer} from "@genkit-ai/express";
import {critiqueExtraction, quickCritique, CritiqueReportSchema, CritiqueMode} from "./critics/index.js";
import {
  createGroundTruth,
  annotateField,
  evaluateAgainstGroundTruth,
  generateEvaluationReport,
  loadGroundTruth,
} from "./evaluation/dataset.js";
import {validateNosScores, validateNosScoresDetailed} from "./utils/nos-validation.js";
import {
  mistralOCR,
  ExtractedTableSchema,
  ExtractedFigureSchema,
  MistralOCRResultSchema,
  mapTableToSchemaFields,
} from "./mistral-ocr.js";
import {
  semanticChunk,
  chunkMedicalPaper,
  chunkWithPages,
  ChunkSchema,
  ChunkingOptionsSchema,
  PartialChunkingOptionsSchema,
  type Chunk,
  type ChunkingOptions,
  type PartialChunkingOptions,
  type PageText,
  DEFAULT_CHUNKING_OPTIONS,
} from "./chunking.js";

// Chat module (modularized)
import {
  createChatSession,
  sendChatMessage,
  getChatHistory,
  listChatSessions,
  deleteChatSession,
  chat,
  chatWithPDF,
  type SessionData,
  type PDFChatState,
} from "./chat/index.js";
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
  promptDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "prompts"), // Dotprompt templates for extraction agents
});

// ==========================================
// 1. Zod Schemas (The Data Model)
// ==========================================

// Helper for verification: Every major data point gets a value and a source quote
// pageNumber enables "Jump to Source" functionality in the Review UI
const VerifiableField = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({
    value: schema.nullable(),
    sourceText: z
      .string()
      .describe("The verbatim quote from the text that proves this value.")
      .nullable(),
    pageNumber: z
      .number()
      .int()
      .positive()
      .describe("The page number (1-indexed) where this value was found in the PDF.")
      .nullable()
      .optional(),
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

// Individual NOS item assessment for reproducibility
const NOSItemAssessmentSchema = z.object({
  item: z.string().describe("The NOS item being assessed"),
  score: z.number().min(0).max(1).describe("0 = no star, 1 = star awarded"),
  justification: z.string().describe("Brief explanation for the score"),
  sourceText: z.string().nullable().describe("Verbatim quote supporting the assessment"),
  pageNumber: z.number().int().positive().nullable().optional().describe("Page number where evidence was found"),
});

const QualitySchema = z.object({
  // Selection Domain (0-4 stars)
  selection: z.object({
    representativeness: NOSItemAssessmentSchema.describe("S1: Representativeness of the exposed cohort"),
    selectionOfNonExposed: NOSItemAssessmentSchema.describe("S2: Selection of the non-exposed cohort"),
    ascertainmentOfExposure: NOSItemAssessmentSchema.describe("S3: Ascertainment of exposure"),
    outcomeNotPresentAtStart: NOSItemAssessmentSchema.describe("S4: Demonstration that outcome was not present at start"),
    subtotal: z.number().min(0).max(4).describe("Selection domain subtotal (0-4)"),
  }),
  // Comparability Domain (0-2 stars)
  comparability: z.object({
    controlForMostImportant: NOSItemAssessmentSchema.describe("C1: Study controls for the most important factor (e.g., GCS)"),
    controlForAdditional: NOSItemAssessmentSchema.describe("C2: Study controls for additional factor (e.g., age)"),
    subtotal: z.number().min(0).max(2).describe("Comparability domain subtotal (0-2)"),
  }),
  // Outcome Domain (0-3 stars)
  outcome: z.object({
    assessmentOfOutcome: NOSItemAssessmentSchema.describe("O1: Assessment of outcome (independent/blinded)"),
    followUpLength: NOSItemAssessmentSchema.describe("O2: Was follow-up long enough for outcomes to occur"),
    adequacyOfFollowUp: NOSItemAssessmentSchema.describe("O3: Adequacy of follow-up of cohorts"),
    subtotal: z.number().min(0).max(3).describe("Outcome domain subtotal (0-3)"),
  }),
  // Overall
  totalScore: z.number().min(0).max(9).describe("Total Newcastle-Ottawa Scale score (0-9)"),
  qualityRating: z.enum(["Good", "Fair", "Poor"]).describe("Overall quality: Good (7-9), Fair (4-6), Poor (0-3)"),
  biasNotes: z.string().describe("Summary of key methodological limitations and potential biases"),
  // Legacy fields for backward compatibility
  selectionScore: z.number().min(0).max(4).describe("NOS Selection score (0-4)"),
  comparabilityScore: z.number().min(0).max(2).describe("NOS Comparability score (0-2)"),
  outcomeScore: z.number().min(0).max(3).describe("NOS Outcome score (0-3)"),
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

  const addLine = (label: string, item: {value: unknown; sourceText: string | null; pageNumber?: number | null} | undefined) => {
    if (!item) return;
    const val = item.value !== null ? item.value : "Not Found";
    const pageRef = item.pageNumber ? ` (p.${item.pageNumber})` : "";
    const quote = item.sourceText ? `\n  > "${item.sourceText}"${pageRef}` : "";
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
  report += `**Overall: ${data.quality.totalScore}/9 (${data.quality.qualityRating || "Not rated"})**\n\n`;

  // Selection Domain (enhanced detail)
  report += `#### Selection (${data.quality.selectionScore}/4)\n`;
  if (data.quality.selection) {
    const s = data.quality.selection;
    const formatItem = (item: {score: number; justification: string; sourceText?: string | null; pageNumber?: number | null}) => {
      const star = item.score === 1 ? "★" : "☆";
      const page = item.pageNumber ? ` (p.${item.pageNumber})` : "";
      let line = `  ${star} ${item.justification}${page}\n`;
      if (item.sourceText) {
        line += `    > "${item.sourceText}"\n`;
      }
      return line;
    };
    report += `- S1 (Representativeness):\n${formatItem(s.representativeness)}`;
    report += `- S2 (Non-exposed selection):\n${formatItem(s.selectionOfNonExposed)}`;
    report += `- S3 (Exposure ascertainment):\n${formatItem(s.ascertainmentOfExposure)}`;
    report += `- S4 (Outcome not at start):\n${formatItem(s.outcomeNotPresentAtStart)}`;
  } else {
    report += `- Score: ${data.quality.selectionScore}/4\n`;
  }

  // Comparability Domain
  report += `\n#### Comparability (${data.quality.comparabilityScore}/2)\n`;
  if (data.quality.comparability) {
    const c = data.quality.comparability;
    const formatItem = (item: {score: number; justification: string; sourceText?: string | null; pageNumber?: number | null}) => {
      const star = item.score === 1 ? "★" : "☆";
      const page = item.pageNumber ? ` (p.${item.pageNumber})` : "";
      let line = `  ${star} ${item.justification}${page}\n`;
      if (item.sourceText) {
        line += `    > "${item.sourceText}"\n`;
      }
      return line;
    };
    report += `- C1 (Most important factor):\n${formatItem(c.controlForMostImportant)}`;
    report += `- C2 (Additional factor):\n${formatItem(c.controlForAdditional)}`;
  } else {
    report += `- Score: ${data.quality.comparabilityScore}/2\n`;
  }

  // Outcome Domain
  report += `\n#### Outcome (${data.quality.outcomeScore}/3)\n`;
  if (data.quality.outcome) {
    const o = data.quality.outcome;
    const formatItem = (item: {score: number; justification: string; sourceText?: string | null; pageNumber?: number | null}) => {
      const star = item.score === 1 ? "★" : "☆";
      const page = item.pageNumber ? ` (p.${item.pageNumber})` : "";
      let line = `  ${star} ${item.justification}${page}\n`;
      if (item.sourceText) {
        line += `    > "${item.sourceText}"\n`;
      }
      return line;
    };
    report += `- O1 (Outcome assessment):\n${formatItem(o.assessmentOfOutcome)}`;
    report += `- O2 (Follow-up length):\n${formatItem(o.followUpLength)}`;
    report += `- O3 (Follow-up adequacy):\n${formatItem(o.adequacyOfFollowUp)}`;
  } else {
    report += `- Score: ${data.quality.outcomeScore}/3\n`;
  }

  report += `\n#### Bias Summary\n`;
  report += `${data.quality.biasNotes}\n`;

  return report;
}

// ==========================================
// 3. Specialized Extraction Agents (Worker Pattern)
// ==========================================

/**
 * Metadata Agent - Extracts study identification info
 * Focuses on: Title, authors, journal, hospital, study period
 * Uses Dotprompt template: prompts/extractMetadata.prompt
 */
const extractMetadata = ai.defineFlow(
  {
    name: "extractMetadata",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: StudyMetadataSchema,
  },
  async ({pdfText}) => {
    const metadataPrompt = ai.prompt("extractMetadata");
    const {output} = await metadataPrompt({pdfText: pdfText.slice(0, 15000)});
    return output as z.infer<typeof StudyMetadataSchema>;
  }
);

/**
 * Population Agent - Extracts patient demographics and characteristics
 * Focuses on: Methods section, Table 1 (patient characteristics)
 * Uses Dotprompt template: prompts/extractPopulation.prompt
 */
const extractPopulation = ai.defineFlow(
  {
    name: "extractPopulation",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: PopulationSchema,
  },
  async ({pdfText}) => {
    const populationPrompt = ai.prompt("extractPopulation");
    const {output} = await populationPrompt({pdfText});
    return output as z.infer<typeof PopulationSchema>;
  }
);

/**
 * Intervention Agent - Extracts surgical procedure details
 * Focuses on: Methods section, Surgical Technique descriptions
 * Uses Dotprompt template: prompts/extractIntervention.prompt
 */
const extractIntervention = ai.defineFlow(
  {
    name: "extractIntervention",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: InterventionSchema,
  },
  async ({pdfText}) => {
    const interventionPrompt = ai.prompt("extractIntervention");
    const {output} = await interventionPrompt({pdfText});
    return output as z.infer<typeof InterventionSchema>;
  }
);

/**
 * Comparator Agent - Extracts control group information
 * Uses Dotprompt template: prompts/extractComparator.prompt
 */
const extractComparator = ai.defineFlow(
  {
    name: "extractComparator",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: ComparatorSchema,
  },
  async ({pdfText}) => {
    const comparatorPrompt = ai.prompt("extractComparator");
    const {output} = await comparatorPrompt({pdfText});
    return output as z.infer<typeof ComparatorSchema>;
  }
);

/**
 * Outcomes Agent - Extracts all clinical outcomes
 * Focuses on: Results section, Tables 2+, Discussion
 * Uses Dotprompt template: prompts/extractOutcomes.prompt
 */
const extractOutcomes = ai.defineFlow(
  {
    name: "extractOutcomes",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: OutcomesSchema,
  },
  async ({pdfText}) => {
    const outcomesPrompt = ai.prompt("extractOutcomes");
    const {output} = await outcomesPrompt({pdfText});
    return output as z.infer<typeof OutcomesSchema>;
  }
);

/**
 * Quality Agent - Assesses study quality using Newcastle-Ottawa Scale
 * Enhanced with item-by-item scoring and detailed guidance
 * Focuses on: Methods, Results, entire paper for bias assessment
 * Uses Dotprompt template: prompts/extractQuality.prompt
 */
const extractQuality = ai.defineFlow(
  {
    name: "extractQuality",
    inputSchema: z.object({pdfText: z.string()}),
    outputSchema: QualitySchema,
  },
  async ({pdfText}) => {
    const qualityPrompt = ai.prompt("extractQuality");
    const {output} = await qualityPrompt({pdfText});
    return output as z.infer<typeof QualitySchema>;
  }
);

// ==========================================
// 4. Orchestrator Flow (Parallel Execution with Streaming)
// ==========================================

/**
 * Progress update schema for streaming extraction status
 */
const ExtractionProgressSchema = z.object({
  agent: z.string().describe("Name of the agent reporting progress"),
  status: z.enum(["started", "completed", "error"]).describe("Current status"),
  progress: z.number().min(0).max(1).describe("Overall progress 0-1"),
  message: z.string().optional().describe("Optional status message"),
  timestamp: z.string().describe("ISO timestamp of this update"),
});

/**
 * Main extraction flow - orchestrates parallel agent execution
 * Uses the Worker Pattern for improved accuracy and speed
 * Now with streaming progress updates for better UX
 */
export const extractStudyData = ai.defineFlow(
  {
    name: "extractStudyData",
    inputSchema: z.object({
      pdfText: z.string().describe("The raw text content of the medical PDF"),
    }),
    outputSchema: CerebellarSDCSchema,
    streamSchema: ExtractionProgressSchema,
  },
  async ({pdfText}, {sendChunk}) => {
    console.log("🔄 Dispatching to specialized extraction agents...");

    const agents = [
      {name: "metadata", fn: extractMetadata, weight: 0.1},
      {name: "population", fn: extractPopulation, weight: 0.2},
      {name: "intervention", fn: extractIntervention, weight: 0.15},
      {name: "comparator", fn: extractComparator, weight: 0.1},
      {name: "outcomes", fn: extractOutcomes, weight: 0.25},
      {name: "quality", fn: extractQuality, weight: 0.2},
    ];

    // Track completion
    const completed: Set<string> = new Set();
    let currentProgress = 0;

    // Send initial progress
    sendChunk({
      agent: "orchestrator",
      status: "started",
      progress: 0,
      message: "Starting extraction with 6 specialized agents...",
      timestamp: new Date().toISOString(),
    });

    // Helper to run agent and report progress
    const runWithProgress = async <T>(
      agentName: string,
      agentFn: (input: {pdfText: string}) => Promise<T>,
      weight: number
    ): Promise<T> => {
      sendChunk({
        agent: agentName,
        status: "started",
        progress: currentProgress,
        message: `${agentName} agent analyzing PDF...`,
        timestamp: new Date().toISOString(),
      });

      try {
        const result = await agentFn({pdfText});
        completed.add(agentName);
        currentProgress += weight;

        sendChunk({
          agent: agentName,
          status: "completed",
          progress: Math.min(currentProgress, 0.95), // Reserve 5% for aggregation
          message: `${agentName} extraction complete`,
          timestamp: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        sendChunk({
          agent: agentName,
          status: "error",
          progress: currentProgress,
          message: `${agentName} failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: new Date().toISOString(),
        });
        throw error;
      }
    };

    // Run all agents in parallel for speed with progress tracking
    const [metadata, population, intervention, comparator, outcomes, quality] = await Promise.all([
      runWithProgress("metadata", extractMetadata, 0.1),
      runWithProgress("population", extractPopulation, 0.2),
      runWithProgress("intervention", extractIntervention, 0.15),
      runWithProgress("comparator", extractComparator, 0.1),
      runWithProgress("outcomes", extractOutcomes, 0.25),
      runWithProgress("quality", extractQuality, 0.2),
    ]);

    console.log("✅ All agents completed. Aggregating results...");

    // Send final aggregation progress
    sendChunk({
      agent: "orchestrator",
      status: "completed",
      progress: 1,
      message: "All 6 agents completed. Results aggregated successfully.",
      timestamp: new Date().toISOString(),
    });

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

// ==========================================
// 5. Figure Analysis Flow (Vision-based)
// ==========================================

/**
 * Schema for extracted figure data
 */
const FigureDataSchema = z.object({
  figureType: z.enum([
    "flowchart",
    "bar_chart",
    "line_graph",
    "scatter_plot",
    "table",
    "kaplan_meier",
    "forest_plot",
    "box_plot",
    "histogram",
    "pie_chart",
    "anatomical_diagram",
    "ct_scan",
    "mri",
    "other",
  ]).describe("Type of figure detected"),
  caption: z.string().nullable().describe("Figure caption if visible"),
  title: z.string().nullable().describe("Figure title or label"),
  description: z.string().describe("Detailed description of what the figure shows"),
  extractedData: z.array(z.object({
    label: z.string(),
    value: z.string(),
    unit: z.string().optional(),
    confidence: z.number().min(0).max(1),
  })).describe("Structured data extracted from the figure"),
  axisLabels: z.object({
    xAxis: z.string().nullable(),
    yAxis: z.string().nullable(),
  }).optional().describe("Axis labels for charts/graphs"),
  legend: z.array(z.string()).optional().describe("Legend items"),
  clinicalRelevance: z.string().optional().describe("Clinical significance of the figure for SDC research"),
  sourceEvidence: z.string().describe("Key text/numbers visible in the figure"),
});

/**
 * Input schema for figure analysis
 */
const FigureAnalysisInputSchema = z.object({
  imageBase64: z.string().describe("Base64 encoded image data"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).default("image/png"),
  context: z.string().optional().describe("Optional context about the figure (e.g., surrounding text)"),
  extractionFocus: z.enum([
    "general",
    "patient_flow",
    "outcomes",
    "survival",
    "statistical",
    "imaging",
  ]).default("general").describe("What type of data to focus on extracting"),
});

/**
 * Figure Analysis Flow
 * Uses Gemini's vision capabilities to analyze medical figures, charts, and tables
 * Extracts structured data from images for systematic review inclusion
 */
export const analyzeFigure = ai.defineFlow(
  {
    name: "analyzeFigure",
    inputSchema: FigureAnalysisInputSchema,
    outputSchema: FigureDataSchema,
  },
  async ({imageBase64, mimeType, context, extractionFocus}) => {
    console.log(`🔬 Analyzing figure with focus: ${extractionFocus}`);

    const focusInstructions: Record<string, string> = {
      general: "Extract all visible data, labels, and values comprehensively.",
      patient_flow: "Focus on patient numbers at each stage: screened, excluded, enrolled, analyzed, lost to follow-up.",
      outcomes: "Focus on outcome measures: mortality rates, mRS scores, complications, recovery rates.",
      survival: "Focus on survival curves: median survival, hazard ratios, confidence intervals, p-values.",
      statistical: "Focus on statistical measures: odds ratios, confidence intervals, p-values, correlations.",
      imaging: "Focus on imaging findings: lesion volumes, locations, measurements in cm³ or mm.",
    };

    const prompt = `You are a medical research data extractor analyzing a figure from a cerebellar stroke surgery study.

CONTEXT: ${context || "Figure from a medical research paper about suboccipital decompressive craniectomy (SDC)"}

EXTRACTION FOCUS: ${focusInstructions[extractionFocus]}

ANALYZE THIS FIGURE AND EXTRACT:
1. Figure Type: Identify what kind of visualization this is
2. All visible text: Labels, titles, captions, legends
3. Numerical data: Extract ALL numbers with their labels and units
4. For charts/graphs: Axis labels, data points, trend descriptions
5. For flowcharts: Each box/step with patient numbers
6. For tables: All rows and columns as structured data
7. Clinical relevance to SDC research

IMPORTANT:
- Be precise with numbers - don't round or estimate
- Include confidence score (0-1) for each extracted value
- Note any values that are partially visible or unclear
- For Kaplan-Meier curves, extract survival percentages at key timepoints

Return structured JSON matching the output schema.`;

    try {
      const response = await ai.generate({
        model: googleAI.model("gemini-3-pro-preview"),
        prompt: [
          {text: prompt},
          {media: {contentType: mimeType, url: `data:${mimeType};base64,${imageBase64}`}},
        ],
        output: {schema: FigureDataSchema},
      });

      const result = response.output;
      if (!result) {
        throw new Error("No output from figure analysis");
      }

      console.log(`✅ Extracted ${result.extractedData.length} data points from ${result.figureType}`);
      return result;
    } catch (error) {
      console.error("Figure analysis failed:", error);
      // Return minimal result on error
      return {
        figureType: "other" as const,
        caption: null,
        title: null,
        description: "Analysis failed - unable to process image",
        extractedData: [],
        sourceEvidence: "",
      };
    }
  }
);

/**
 * Batch Figure Analysis Flow
 * Analyzes multiple figures from a PDF in parallel
 */
export const analyzeFigures = ai.defineFlow(
  {
    name: "analyzeFigures",
    inputSchema: z.object({
      figures: z.array(FigureAnalysisInputSchema),
      concurrency: z.number().default(3).describe("Number of parallel analyses"),
    }),
    outputSchema: z.object({
      results: z.array(FigureDataSchema),
      summary: z.object({
        total: z.number(),
        successful: z.number(),
        byType: z.record(z.number()),
      }),
    }),
  },
  async ({figures, concurrency}) => {
    console.log(`📊 Analyzing ${figures.length} figures with concurrency ${concurrency}`);

    const limit = pLimit(concurrency);
    const results: z.infer<typeof FigureDataSchema>[] = [];
    const typeCount: Record<string, number> = {};

    const tasks = figures.map((figure, idx) =>
      limit(async () => {
        console.log(`Processing figure ${idx + 1}/${figures.length}...`);
        const result = await analyzeFigure(figure);
        results.push(result);

        // Count by type
        typeCount[result.figureType] = (typeCount[result.figureType] || 0) + 1;

        return result;
      })
    );

    await Promise.all(tasks);

    const successful = results.filter(r => r.extractedData.length > 0).length;

    console.log(`✅ Batch analysis complete: ${successful}/${figures.length} successful`);

    return {
      results,
      summary: {
        total: figures.length,
        successful,
        byType: typeCount,
      },
    };
  }
);

// ==========================================
// 7b. Mistral OCR Flows (High-Accuracy Table/Figure Extraction)
// ==========================================

/**
 * Extract tables and figures from PDF using Mistral OCR
 * 96.12% table accuracy, 94.29% math comprehension
 * Cost: $0.001/page, Speed: 2,000 pages/minute
 */
export const extractWithMistralOCR = ai.defineFlow(
  {
    name: "extractWithMistralOCR",
    inputSchema: z.object({
      pdfPath: z.string().optional().describe("Local path to PDF file"),
      pdfBase64: z.string().optional().describe("Base64-encoded PDF"),
      pdfUrl: z.string().optional().describe("URL to publicly accessible PDF"),
      includeFigureAnalysis: z.boolean().default(true),
      includeTableParsing: z.boolean().default(true),
    }),
    outputSchema: MistralOCRResultSchema,
  },
  async ({pdfPath, pdfBase64, pdfUrl, includeFigureAnalysis, includeTableParsing}) => {
    if (!process.env.MISTRAL_API_KEY) {
      throw new Error("MISTRAL_API_KEY not configured. Add it to .env file.");
    }

    console.log("🔍 Starting Mistral OCR extraction...");

    const result = await mistralOCR.extract(
      {pdfPath, pdfBase64, pdfUrl},
      {includeFigureAnalysis, includeTableParsing}
    );

    console.log(`✅ Mistral OCR complete: ${result.tables.length} tables, ${result.figures.length} figures`);
    console.log(`   Processing time: ${result.metadata.processingTimeMs}ms`);

    return result;
  }
);

/**
 * Extract only tables from PDF using Mistral OCR (faster, no figure analysis)
 */
export const extractTablesWithMistral = ai.defineFlow(
  {
    name: "extractTablesWithMistral",
    inputSchema: z.object({
      pdfPath: z.string().optional(),
      pdfBase64: z.string().optional(),
      pdfUrl: z.string().optional(),
    }),
    outputSchema: z.array(ExtractedTableSchema),
  },
  async (input) => {
    if (!process.env.MISTRAL_API_KEY) {
      throw new Error("MISTRAL_API_KEY not configured. Add it to .env file.");
    }

    console.log("📊 Extracting tables with Mistral OCR...");
    const tables = await mistralOCR.extractTables(input);
    console.log(`✅ Found ${tables.length} tables`);

    // Log table types for debugging
    const typeCount: Record<string, number> = {};
    tables.forEach((t) => {
      const type = t.tableType || "other";
      typeCount[type] = (typeCount[type] || 0) + 1;
    });
    console.log("   Table types:", typeCount);

    return tables;
  }
);

/**
 * Extract figures with structured data using Mistral BBox annotations
 */
export const extractFiguresWithMistral = ai.defineFlow(
  {
    name: "extractFiguresWithMistral",
    inputSchema: z.object({
      pdfPath: z.string().optional(),
      pdfBase64: z.string().optional(),
      pdfUrl: z.string().optional(),
    }),
    outputSchema: z.array(ExtractedFigureSchema),
  },
  async (input) => {
    if (!process.env.MISTRAL_API_KEY) {
      throw new Error("MISTRAL_API_KEY not configured. Add it to .env file.");
    }

    console.log("📈 Extracting figures with Mistral OCR...");
    const figures = await mistralOCR.extractFigures(input);
    console.log(`✅ Found ${figures.length} figures`);

    return figures;
  }
);

/**
 * Map extracted table to CerebellarSDCSchema fields
 * Returns field paths and values for "Use in Form" functionality
 */
export const mapTableToSchema = ai.defineFlow(
  {
    name: "mapTableToSchema",
    inputSchema: ExtractedTableSchema,
    outputSchema: z.array(
      z.object({
        field: z.string().describe("Schema field path (e.g., 'population.age.mean.value')"),
        value: z.any().describe("Extracted value"),
        sourceText: z.string().describe("Source text from table cell"),
      })
    ),
  },
  async (table) => {
    console.log(`🔗 Mapping table (${table.tableType}) to schema fields...`);
    const mappings = mapTableToSchemaFields(table);
    console.log(`✅ Found ${mappings.length} mappable fields`);
    return mappings;
  }
);

/**
 * Semantic table analysis using Gemini for complex tables
 * Understands context and can extract fields that simple parsing misses
 */
export const analyzeTableSemantically = ai.defineFlow(
  {
    name: "analyzeTableSemantically",
    inputSchema: z.object({
      markdownTable: z.string().describe("Table in markdown format"),
      caption: z.string().optional(),
      context: z.string().optional().describe("Surrounding text context"),
    }),
    outputSchema: z.object({
      tableType: z.enum([
        "demographics",
        "baseline",
        "outcomes",
        "complications",
        "flowchart",
        "statistical",
        "imaging",
        "surgical",
        "other",
      ]),
      extractedFields: z.array(
        z.object({
          field: z.string().describe("Schema field path"),
          value: z.any(),
          confidence: z.number().min(0).max(1),
          sourceCell: z.string(),
          reasoning: z.string().optional(),
        })
      ),
      studyArmDetected: z
        .object({
          label: z.string(),
          sampleSize: z.number().nullable(),
          description: z.string().nullable(),
        })
        .nullable()
        .describe("If this table represents a study arm/group"),
      warnings: z.array(z.string()).describe("Potential issues or ambiguities"),
    }),
  },
  async ({markdownTable, caption, context}) => {
    console.log("🧠 Analyzing table semantically with Gemini...");

    const prompt = `You are a medical research data extraction expert specializing in cerebellar stroke and suboccipital decompressive craniectomy (SDC) studies.

Analyze this table and extract relevant data fields for our CerebellarSDCSchema.

${caption ? `Table Caption: ${caption}` : ""}
${context ? `Context: ${context}` : ""}

Table:
${markdownTable}

Schema fields to look for:
- population.sampleSize: Total N
- population.age.mean/sd: Age statistics
- population.gcs.median/range: Glasgow Coma Scale
- population.hydrocephalus.percentage: % with hydrocephalus
- intervention.technique: Surgical technique description
- intervention.evdUsed: Whether EVD was used
- intervention.duraplasty: Whether duraplasty was performed
- outcomes.mortality: Mortality rate/count
- outcomes.mRS_favorable: % with favorable mRS (0-2 or 0-3)
- outcomes.lengthOfStay: ICU/hospital stay
- outcomes.complications: List of complications

Respond with structured JSON containing:
1. tableType: The category of this table
2. extractedFields: Array of {field, value, confidence, sourceCell, reasoning}
3. studyArmDetected: If this table represents a treatment group, provide label/size/description
4. warnings: Any ambiguities or potential issues`;

    const response = await ai.generate({
      model: "googleai/gemini-3-pro-preview",
      prompt,
      output: {
        format: "json",
        schema: z.object({
          tableType: z.enum([
            "demographics",
            "baseline",
            "outcomes",
            "complications",
            "flowchart",
            "statistical",
            "imaging",
            "surgical",
            "other",
          ]),
          extractedFields: z.array(
            z.object({
              field: z.string(),
              value: z.any(),
              confidence: z.number(),
              sourceCell: z.string(),
              reasoning: z.string().optional(),
            })
          ),
          studyArmDetected: z
            .object({
              label: z.string(),
              sampleSize: z.number().nullable(),
              description: z.string().nullable(),
            })
            .nullable(),
          warnings: z.array(z.string()),
        }),
      },
    });

    const result = response.output!;
    console.log(`✅ Semantic analysis complete: ${result.extractedFields.length} fields extracted`);

    return result;
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
    inputSchema: z.object({
      extractedData: CerebellarSDCSchema,
      pdfText: z.string().optional().describe("Full PDF text for critique validation"),
      runCritique: z.boolean().default(false).describe("Whether to run critique validation"),
      critiqueMode: z.enum(["AUTO", "REVIEW"]).default("REVIEW").describe("Critique mode: AUTO (auto-correct) or REVIEW (manual review)"),
    }),
    outputSchema: z.object({
      status: z.enum(["saved", "flagged_duplicate", "failed_critique", "error"]),
      docId: z.string().nullable(),
      duplicateReport: DuplicateAssessmentSchema.nullable(),
      critiqueReport: CritiqueReportSchema.nullable(),
      message: z.string(),
    }),
  },
  async ({extractedData, pdfText, runCritique, critiqueMode}) => {
    try {
      // 0. Run critique validation if requested
      let critiqueReport = null;
      let dataToSave = extractedData;

      if (runCritique) {
        console.log(`Running critique validation in ${critiqueMode} mode...`);
        critiqueReport = await critiqueExtraction({
          extractedData,
          pdfText,
          mode: critiqueMode,
        });

        // REVIEW mode: Block saving if validation fails
        if (critiqueMode === "REVIEW" && !critiqueReport.passedValidation) {
          return {
            status: "failed_critique" as const,
            docId: null,
            duplicateReport: null,
            critiqueReport,
            message: `❌ Validation failed: ${critiqueReport.summary}. Please review and fix the ${critiqueReport.issues.filter(i => i.severity === "CRITICAL").length} CRITICAL issues.`,
          };
        }

        // AUTO mode: Apply corrections to data
        if (critiqueMode === "AUTO" && critiqueReport.corrections) {
          console.log(`Applying ${Object.keys(critiqueReport.corrections).length} auto-corrections...`);
          // Apply corrections to extractedData
          dataToSave = {...extractedData};
          Object.entries(critiqueReport.corrections).forEach(([fieldPath, value]) => {
            const keys = fieldPath.split(".");
            let current: any = dataToSave;
            for (let i = 0; i < keys.length - 1; i++) {
              current = current[keys[i]];
            }
            current[keys[keys.length - 1]] = value;
          });
        }
      }

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
            data: dataToSave,
            createdAt: new Date().toISOString(),
          });
          saveLocalStudies(studies);

          // Also index for RAG (use the devLocalVectorstore indexer)
          try {
            await ai.index({
              indexer: "devLocalVectorstore/studyIndex",
              documents: [
                Document.fromText(JSON.stringify(dataToSave), {
                  id: docId,
                  firstAuthor: dataToSave.metadata.firstAuthor,
                  hospital: dataToSave.metadata.hospitalCenter,
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
            ...dataToSave,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        return {
          status: "saved" as const,
          docId,
          duplicateReport: null,
          critiqueReport,
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
- Center: ${dataToSave.metadata.hospitalCenter}
- Period: ${dataToSave.metadata.studyPeriod}
- First Author: ${dataToSave.metadata.firstAuthor}
- Year: ${dataToSave.metadata.publicationYear}
- Sample Size: ${dataToSave.population.sampleSize}
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
          critiqueReport,
          message: `⚠️ Potential duplicate detected (${assessment.confidence} confidence): ${assessment.reasoning}`,
        };
      }

      // 5. No significant duplicate found - save to database
      const docId = generateId();
      if (USE_LOCAL_STORAGE) {
        const studies = loadLocalStudies();
        studies.push({
          id: docId,
          data: dataToSave,
          createdAt: new Date().toISOString(),
          duplicateCheck: assessment,
        });
        saveLocalStudies(studies);

        // Index for RAG
        try {
          await ai.index({
            indexer: "devLocalVectorstore/studyIndex",
            documents: [
              Document.fromText(JSON.stringify(dataToSave), {
                id: docId,
                firstAuthor: dataToSave.metadata.firstAuthor,
                hospital: dataToSave.metadata.hospitalCenter,
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
          ...dataToSave,
          duplicateCheck: assessment,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      return {
        status: "saved" as const,
        docId,
        duplicateReport: assessment,
        critiqueReport,
        message: `✅ Study saved with ID: ${docId} (${USE_LOCAL_STORAGE ? "local" : "Firestore"})`,
      };
    } catch (error) {
      return {
        status: "error" as const,
        docId: null,
        duplicateReport: null,
        critiqueReport: null,
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
// 4b. RAG Chunking for Large PDFs
// ==========================================

/**
 * Chunk PDF text for RAG indexing
 * Uses semantic chunking to preserve context while respecting token limits
 */
export const chunkPdfText = ai.defineFlow(
  {
    name: "chunkPdfText",
    inputSchema: z.object({
      text: z.string().describe("Full PDF text to chunk"),
      strategy: z.enum(["semantic", "medical", "fixed"]).default("medical").describe("Chunking strategy"),
      options: PartialChunkingOptionsSchema.optional().describe("Chunking options"),
    }),
    outputSchema: z.object({
      chunks: z.array(ChunkSchema),
      totalChunks: z.number(),
      averageTokens: z.number(),
      strategy: z.string(),
    }),
  },
  async ({text, strategy = "medical", options = {}}) => {
    let chunks: Chunk[];

    switch (strategy) {
      case "medical":
        // Best for research papers - preserves section structure
        chunks = chunkMedicalPaper(text, options);
        break;
      case "semantic":
        // General-purpose semantic chunking
        chunks = semanticChunk(text, options);
        break;
      case "fixed":
        // Simple fixed-size chunking (fallback)
        const maxTokens = options.maxChunkSize ?? 1500;
        const overlap = options.overlap ?? 200;
        const { fixedSizeChunk } = await import("./chunking.js");
        chunks = fixedSizeChunk(text, maxTokens, overlap);
        break;
      default:
        chunks = chunkMedicalPaper(text, options);
    }

    const totalTokens = chunks.reduce((sum, c) => sum + (c.metadata.tokenCount || 0), 0);
    const averageTokens = chunks.length > 0 ? Math.round(totalTokens / chunks.length) : 0;

    return {
      chunks,
      totalChunks: chunks.length,
      averageTokens,
      strategy,
    };
  }
);

/**
 * Index PDF chunks into vector store for RAG
 * Creates multiple documents from chunked PDF for better retrieval
 */
export const indexChunkedPdf = ai.defineFlow(
  {
    name: "indexChunkedPdf",
    inputSchema: z.object({
      pdfPath: z.string().describe("Path to PDF file"),
      studyId: z.string().describe("Study identifier for the PDF"),
      strategy: z.enum(["semantic", "medical", "fixed"]).default("medical"),
      options: PartialChunkingOptionsSchema.optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      chunksIndexed: z.number(),
      studyId: z.string(),
      message: z.string(),
    }),
  },
  async ({pdfPath, studyId, strategy = "medical", options = {}}) => {
    try {
      // 1. Read and parse PDF
      console.log(`📄 Reading PDF: ${pdfPath}`);
      const pdfBuffer = fs.readFileSync(pdfPath);
      const parsed = await parsePdf(pdfBuffer);

      // 2. Chunk the text
      console.log(`✂️  Chunking with ${strategy} strategy...`);
      const {chunks, totalChunks, averageTokens} = await chunkPdfText({
        text: parsed.text,
        strategy,
        options,
      });
      console.log(`   Created ${totalChunks} chunks (avg ${averageTokens} tokens)`);

      // 3. Create documents from chunks
      const documents = chunks.map((chunk, idx) => {
        return Document.fromText(chunk.text, {
          id: `${studyId}_chunk_${idx}`,
          studyId,
          chunkIndex: idx,
          totalChunks,
          pageStart: chunk.metadata.pageStart,
          pageEnd: chunk.metadata.pageEnd,
          sectionType: chunk.metadata.sectionType || "unknown",
          tokenCount: chunk.metadata.tokenCount,
        });
      });

      // 4. Index all chunks
      console.log(`📥 Indexing ${documents.length} chunks...`);
      await ai.index({
        indexer: "devLocalVectorstore/studyIndex",
        documents,
      });

      return {
        success: true,
        chunksIndexed: documents.length,
        studyId,
        message: `Successfully indexed ${documents.length} chunks from ${pdfPath}`,
      };
    } catch (error) {
      console.error("Chunked indexing failed:", error);
      return {
        success: false,
        chunksIndexed: 0,
        studyId,
        message: `Failed to index: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
);

/**
 * Search with chunked retrieval and context aggregation
 * Retrieves relevant chunks and aggregates context for better answers
 */
export const searchWithContext = ai.defineFlow(
  {
    name: "searchWithContext",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      limit: z.number().default(10).describe("Maximum chunks to retrieve"),
      aggregateByStudy: z.boolean().default(true).describe("Group results by study"),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        studyId: z.string(),
        chunks: z.array(z.object({
          text: z.string(),
          sectionType: z.string(),
          relevanceScore: z.number(),
          pageRange: z.string(),
        })),
        combinedContext: z.string(),
      })),
      totalChunksRetrieved: z.number(),
    }),
  },
  async ({query, limit = 10, aggregateByStudy = true}) => {
    // Retrieve chunks
    const docs = await ai.retrieve({
      retriever: "devLocalVectorstore/studyIndex",
      query,
      options: {k: limit},
    });

    if (!aggregateByStudy) {
      // Return flat list
      return {
        results: docs.map(doc => ({
          studyId: doc.metadata?.studyId as string || "unknown",
          chunks: [{
            text: doc.text,
            sectionType: doc.metadata?.sectionType as string || "unknown",
            relevanceScore: doc.metadata?.score as number || 0,
            pageRange: `${doc.metadata?.pageStart || "?"}-${doc.metadata?.pageEnd || "?"}`,
          }],
          combinedContext: doc.text,
        })),
        totalChunksRetrieved: docs.length,
      };
    }

    // Group by study
    const byStudy = new Map<string, typeof docs>();
    for (const doc of docs) {
      const studyId = doc.metadata?.studyId as string || "unknown";
      if (!byStudy.has(studyId)) {
        byStudy.set(studyId, []);
      }
      byStudy.get(studyId)!.push(doc);
    }

    // Build aggregated results
    const results = Array.from(byStudy.entries()).map(([studyId, studyDocs]) => {
      // Sort by chunk index if available
      studyDocs.sort((a, b) => {
        const idxA = a.metadata?.chunkIndex as number || 0;
        const idxB = b.metadata?.chunkIndex as number || 0;
        return idxA - idxB;
      });

      const chunks = studyDocs.map(doc => ({
        text: doc.text.slice(0, 500) + (doc.text.length > 500 ? "..." : ""),
        sectionType: doc.metadata?.sectionType as string || "unknown",
        relevanceScore: doc.metadata?.score as number || 0,
        pageRange: `${doc.metadata?.pageStart || "?"}-${doc.metadata?.pageEnd || "?"}`,
      }));

      // Combine context from all chunks (deduplicated)
      const combinedContext = studyDocs.map(d => d.text).join("\n\n---\n\n");

      return {studyId, chunks, combinedContext};
    });

    return {
      results,
      totalChunksRetrieved: docs.length,
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

    // Use shared validation utility
    const validation = validateNosScores({selectionScore, comparabilityScore, outcomeScore, totalScore});

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: validation.score,
        details: {
          rangeValid: validation.rangeValid,
          sumMatches: validation.sumMatches,
          expectedTotal: validation.expectedTotal,
          actualTotal: validation.actualTotal,
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

      // Use shared detailed validation utility (includes item-level checks)
      const validation = validateNosScoresDetailed(
        {selectionScore, comparabilityScore, outcomeScore, totalScore},
        quality // Pass domains for item-level validation
      );

      return {
        score: validation.score,
        details: {
          rangeValid: validation.rangeValid,
          sumMatches: validation.sumMatches,
          itemScoresMatch: validation.itemScoresMatch,
          expectedTotal: validation.expectedTotal,
          actualTotal: validation.actualTotal,
        },
      };
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
 * Now includes pageNumber for "Jump to Source" functionality
 */
function flattenVerifiable(
  flatData: Record<string, unknown>,
  prefix: string,
  field: {value: unknown; sourceText: string | null; pageNumber?: number | null} | undefined
) {
  if (!field) {
    flatData[`${prefix}`] = null;
    flatData[`${prefix}_Source`] = null;
    flatData[`${prefix}_Page`] = null;
    return;
  }
  flatData[`${prefix}`] = field.value;
  flatData[`${prefix}_Source`] = field.sourceText;
  flatData[`${prefix}_Page`] = field.pageNumber ?? null;
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

  // Quality Assessment (NOS) - Legacy fields
  flatData["NOS_Selection"] = study.quality.selectionScore;
  flatData["NOS_Comparability"] = study.quality.comparabilityScore;
  flatData["NOS_Outcome"] = study.quality.outcomeScore;
  flatData["NOS_Total"] = study.quality.totalScore;
  flatData["NOS_Rating"] = study.quality.qualityRating || "Not rated";
  flatData["Bias_Notes"] = study.quality.biasNotes;

  // Enhanced NOS item-level data (if available)
  if (study.quality.selection) {
    flatData["NOS_S1_Representativeness"] = study.quality.selection.representativeness?.score ?? null;
    flatData["NOS_S1_Justification"] = study.quality.selection.representativeness?.justification ?? null;
    flatData["NOS_S2_NonExposed"] = study.quality.selection.selectionOfNonExposed?.score ?? null;
    flatData["NOS_S2_Justification"] = study.quality.selection.selectionOfNonExposed?.justification ?? null;
    flatData["NOS_S3_Exposure"] = study.quality.selection.ascertainmentOfExposure?.score ?? null;
    flatData["NOS_S3_Justification"] = study.quality.selection.ascertainmentOfExposure?.justification ?? null;
    flatData["NOS_S4_OutcomeAtStart"] = study.quality.selection.outcomeNotPresentAtStart?.score ?? null;
    flatData["NOS_S4_Justification"] = study.quality.selection.outcomeNotPresentAtStart?.justification ?? null;
  }
  if (study.quality.comparability) {
    flatData["NOS_C1_MostImportant"] = study.quality.comparability.controlForMostImportant?.score ?? null;
    flatData["NOS_C1_Justification"] = study.quality.comparability.controlForMostImportant?.justification ?? null;
    flatData["NOS_C2_Additional"] = study.quality.comparability.controlForAdditional?.score ?? null;
    flatData["NOS_C2_Justification"] = study.quality.comparability.controlForAdditional?.justification ?? null;
  }
  if (study.quality.outcome) {
    flatData["NOS_O1_Assessment"] = study.quality.outcome.assessmentOfOutcome?.score ?? null;
    flatData["NOS_O1_Justification"] = study.quality.outcome.assessmentOfOutcome?.justification ?? null;
    flatData["NOS_O2_FollowUpLength"] = study.quality.outcome.followUpLength?.score ?? null;
    flatData["NOS_O2_Justification"] = study.quality.outcome.followUpLength?.justification ?? null;
    flatData["NOS_O3_FollowUpAdequacy"] = study.quality.outcome.adequacyOfFollowUp?.score ?? null;
    flatData["NOS_O3_Justification"] = study.quality.outcome.adequacyOfFollowUp?.justification ?? null;
  }

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
      failedCritique: z.number(),
      errors: z.number(),
      results: z.array(z.object({
        filename: z.string(),
        status: z.enum(["saved", "flagged_duplicate", "failed_critique", "error"]),
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
      status: "saved" | "flagged_duplicate" | "failed_critique" | "error";
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
        const saveResult = await checkAndSaveStudy({
          extractedData,
          pdfText,
          runCritique: false, // Disable critique in batch mode by default
          critiqueMode: "REVIEW",
        });

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
    const failedCritique = results.filter(r => r.status === "failed_critique").length;
    const errors = results.filter(r => r.status === "error").length;

    console.log(`\n========================================`);
    console.log(`📊 BATCH PROCESSING COMPLETE`);
    console.log(`========================================`);
    console.log(`   Total files: ${files.length}`);
    console.log(`   ✅ Saved: ${saved}`);
    console.log(`   ⚠️  Duplicates: ${duplicates}`);
    console.log(`   🔍 Failed Critique: ${failedCritique}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`========================================\n`);

    return {
      totalFiles: files.length,
      processed: results.length,
      saved,
      duplicates,
      failedCritique,
      errors,
      results,
    };
  }
);

// ==========================================
// 10. Chat Session Store (Moved to src/chat/)
// ==========================================
// Chat functionality has been modularized into src/chat/
// - session-store.ts: SessionStore interface and implementations
// - tools.ts: RAG-powered chat tools
// - flows.ts: Chat flows with tool integration
// - index.ts: Module entry point
//
// Re-exported from ./chat/index.js:
// - createChatSession, sendChatMessage, getChatHistory
// - listChatSessions, deleteChatSession, chat, chatWithPDF
// - SessionData, PDFChatState types
// ==========================================

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
  } else if (command === "annotate") {
    // Ground truth annotation mode
    const studyId = args[1];
    if (!studyId) {
      console.error("Usage: npm run genkit annotate <study_id>");
      console.error("Example: npm run genkit annotate Smith-2022");
      console.error("\nThis will start interactive annotation for creating ground truth.");
      process.exit(1);
    }

    // Load existing ground truth or create new
    const existingGTs = loadGroundTruth();
    let gt = existingGTs.find((g) => g.studyId === studyId);

    if (!gt) {
      console.log(`\n📝 Creating new ground truth for ${studyId}`);
      console.log("Enter PDF path:");
      const rl = readline.createInterface({input: process.stdin, output: process.stdout});
      const pdfPath = await rl.question("> ");
      const annotationType = await rl.question("Type (baseline/ground_truth/challenge): ");
      const difficulty = await rl.question("Difficulty (easy/medium/hard): ");
      const studyDesign = await rl.question("Study design: ");
      const annotatorId = await rl.question("Your annotator ID: ");
      rl.close();

      const result = await createGroundTruth({
        studyId,
        pdfPath: pdfPath.trim(),
        annotationType: annotationType.trim() as "baseline" | "ground_truth" | "challenge",
        annotatorId: annotatorId.trim(),
        difficulty: difficulty.trim() as "easy" | "medium" | "hard",
        studyDesign: studyDesign.trim(),
      });

      console.log(`✅ ${result.message}`);
      gt = loadGroundTruth().find((g) => g.studyId === studyId);
    }

    if (!gt) {
      console.error("Failed to create ground truth");
      process.exit(1);
    }

    // Interactive annotation loop
    console.log(`\n📋 Ground Truth for ${studyId}`);
    console.log(`   Annotations: ${gt.fieldAnnotations.length}`);
    console.log(`   Status: ${gt.metadata.reviewStatus}\n`);

    const rl2 = readline.createInterface({input: process.stdin, output: process.stdout});

    while (true) {
      console.log("Options:");
      console.log("  1. Add/update field annotation");
      console.log("  2. List current annotations");
      console.log("  3. Exit");
      const choice = await rl2.question("> ");

      if (choice.trim() === "3") {
        break;
      } else if (choice.trim() === "1") {
        const field = await rl2.question("Field path (e.g., population.age.mean): ");
        const value = await rl2.question("Ground truth value: ");
        const source = await rl2.question("Source evidence (verbatim quote): ");
        const confidence = await rl2.question("Confidence (0.0-1.0): ");
        const annotator = await rl2.question("Your annotator ID: ");
        const notes = await rl2.question("Notes (optional): ");

        const result = await annotateField({
          studyId,
          field: field.trim(),
          groundTruthValue: value.trim(),
          sourceEvidence: source.trim(),
          annotatorId: annotator.trim(),
          confidence: parseFloat(confidence.trim()),
          notes: notes.trim() || undefined,
        });

        console.log(`✅ ${result.message}\n`);
      } else if (choice.trim() === "2") {
        const updated = loadGroundTruth().find((g) => g.studyId === studyId);
        if (updated) {
          console.log(`\nCurrent annotations (${updated.fieldAnnotations.length}):`);
          updated.fieldAnnotations.forEach((a, i) => {
            console.log(`  ${i + 1}. ${a.field} = ${a.groundTruthValue}`);
            console.log(`     Source: ${a.sourceEvidence.substring(0, 60)}...`);
            console.log(`     Annotator: ${a.annotatorId}, Confidence: ${a.confidence}\n`);
          });
        }
      }
    }

    rl2.close();
    console.log("Annotation session ended.");
  } else if (command === "evaluate-dataset") {
    // Evaluate extraction against ground truth
    const studyId = args[1];
    if (!studyId) {
      console.error("Usage: npm run genkit evaluate-dataset <study_id>");
      console.error("Example: npm run genkit evaluate-dataset Smith-2022");
      console.error("\nThis evaluates an extraction against its ground truth annotation.");
      process.exit(1);
    }

    // Check if ground truth exists
    const groundTruths = loadGroundTruth();
    const gt = groundTruths.find((g) => g.studyId === studyId);

    if (!gt) {
      console.error(`Ground truth not found for ${studyId}`);
      console.error("Create it first with: npm run genkit annotate <study_id>");
      process.exit(1);
    }

    console.log(`\n📊 Evaluating ${studyId} against ground truth...`);

    // Extract data from the PDF
    const pdfPath = path.resolve(gt.pdfPath);
    if (!fs.existsSync(pdfPath)) {
      console.error(`PDF not found: ${pdfPath}`);
      process.exit(1);
    }

    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await parsePdf(dataBuffer);
    const pdfText = pdfData.text;

    console.log("🔄 Running extraction...");
    const extractedData = await extractStudyData({pdfText});

    console.log("📈 Comparing with ground truth...");
    const evalResult = await evaluateAgainstGroundTruth({studyId, extractedData});

    console.log("\n" + "═".repeat(60));
    console.log("📊 EVALUATION RESULTS");
    console.log("═".repeat(60) + "\n");

    console.log("Overall Metrics:");
    console.log(`  Precision:              ${(evalResult.overallMetrics.precision * 100).toFixed(1)}%`);
    console.log(`  Recall:                 ${(evalResult.overallMetrics.recall * 100).toFixed(1)}%`);
    console.log(`  F1 Score:               ${(evalResult.overallMetrics.f1Score * 100).toFixed(1)}%`);
    console.log(`  Source Grounding Rate:  ${(evalResult.overallMetrics.sourceGroundingRate * 100).toFixed(1)}%`);
    console.log(`  NOS Consistency:        ${evalResult.overallMetrics.nosConsistency ? "✅" : "❌"}`);
    console.log(`  Critical Field Accuracy: ${(evalResult.overallMetrics.criticalFieldAccuracy * 100).toFixed(1)}%\n`);

    console.log("Field-Level Results:");
    evalResult.fieldMetrics.forEach((fm) => {
      const icon = fm.match ? "✅" : "❌";
      const errorInfo = fm.errorType ? ` (${fm.errorType})` : "";
      console.log(`  ${icon} ${fm.field}${errorInfo}`);
      if (!fm.match) {
        console.log(`     Extracted: ${JSON.stringify(fm.extractedValue)}`);
        console.log(`     Expected:  ${JSON.stringify(fm.groundTruthValue)}`);
      }
    });

    console.log("\n✅ Evaluation complete. Results saved to evaluation-dataset/evaluation_results.json");
  } else if (command === "report") {
    // Generate evaluation report
    const phase = args[1] as "phase1" | "phase2" | "phase3" | undefined;

    if (phase && !["phase1", "phase2", "phase3"].includes(phase)) {
      console.error("Invalid phase. Must be: phase1, phase2, or phase3");
      process.exit(1);
    }

    console.log(`\n📊 Generating evaluation report${phase ? ` for ${phase}` : " (all phases)"}...\n`);

    const report = await generateEvaluationReport({phase});

    console.log(report.summary);

    if (Object.keys(report.byStudyDesign).length > 0) {
      console.log("\nPerformance by Study Design:");
      Object.entries(report.byStudyDesign).forEach(([design, metrics]: [string, any]) => {
        console.log(`  ${design}: ${metrics.count} studies, Avg F1: ${(metrics.avgF1 * 100).toFixed(1)}%`);
      });
    }

    if (Object.keys(report.byDifficulty).length > 0) {
      console.log("\nPerformance by Difficulty:");
      Object.entries(report.byDifficulty).forEach(([difficulty, metrics]: [string, any]) => {
        console.log(`  ${difficulty}: ${metrics.count} studies, Avg F1: ${(metrics.avgF1 * 100).toFixed(1)}%`);
      });
    }

    if (report.recommendations.length > 0) {
      console.log("\n💡 Recommendations:");
      report.recommendations.forEach((r) => {
        console.log(`  • ${r}`);
      });
    }
  } else if (command === "tables") {
    // Mistral OCR table extraction
    const pdfPath = args[1];
    const outputFormat = args.includes("--json") ? "json" : "markdown";
    const analyzeSemantics = args.includes("--analyze");

    if (!pdfPath) {
      console.error("Usage: npm run genkit tables <pdf_file> [--json] [--analyze]");
      console.error("\nOptions:");
      console.error("  --json     Output as JSON instead of markdown");
      console.error("  --analyze  Run semantic analysis on each table");
      console.error("\nExample:");
      console.error("  npm run genkit tables ./pdfs/smith2022.pdf");
      console.error("  npm run genkit tables ./pdfs/smith2022.pdf --analyze");
      process.exit(1);
    }

    if (!process.env.MISTRAL_API_KEY) {
      console.error("❌ MISTRAL_API_KEY not configured. Add it to .env file.");
      console.error("   Get your key from: https://console.mistral.ai/");
      process.exit(1);
    }

    const absolutePath = path.resolve(pdfPath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`❌ File not found: ${absolutePath}`);
      process.exit(1);
    }

    console.log(`\n📊 Extracting tables from ${path.basename(absolutePath)} with Mistral OCR...\n`);

    const tables = await extractTablesWithMistral({pdfPath: absolutePath});

    if (tables.length === 0) {
      console.log("No tables found in this PDF.");
      process.exit(0);
    }

    console.log(`Found ${tables.length} tables:\n`);

    if (analyzeSemantics) {
      // Run semantic analysis on each table
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        console.log(`\n=== Table ${i + 1} (Page ${table.pageNumber}) ===`);
        console.log(`Type: ${table.tableType || "unknown"}`);
        if (table.caption) console.log(`Caption: ${table.caption}`);

        console.log("\nRunning semantic analysis...");
        const analysis = await analyzeTableSemantically({
          markdownTable: table.markdownTable,
          caption: table.caption || undefined,
        });

        console.log(`Detected type: ${analysis.tableType}`);
        console.log(`\nExtracted fields (${analysis.extractedFields.length}):`);
        analysis.extractedFields.forEach((f) => {
          console.log(`  • ${f.field}: ${f.value} (${(f.confidence * 100).toFixed(0)}%)`);
          if (f.reasoning) console.log(`    Reasoning: ${f.reasoning}`);
        });

        if (analysis.studyArmDetected) {
          console.log(`\nStudy arm detected:`);
          console.log(`  Label: ${analysis.studyArmDetected.label}`);
          console.log(`  N: ${analysis.studyArmDetected.sampleSize}`);
        }

        if (analysis.warnings.length > 0) {
          console.log(`\n⚠️ Warnings:`);
          analysis.warnings.forEach((w) => console.log(`  • ${w}`));
        }
      }
    } else if (outputFormat === "json") {
      console.log(JSON.stringify(tables, null, 2));
    } else {
      // Markdown output
      tables.forEach((table, i) => {
        console.log(`\n=== Table ${i + 1} (Page ${table.pageNumber}) ===`);
        console.log(`Type: ${table.tableType || "unknown"}`);
        if (table.caption) console.log(`Caption: ${table.caption}`);
        console.log(`\n${table.markdownTable}`);
      });
    }
  } else if (command === "figures") {
    // Mistral OCR figure extraction
    const pdfPath = args[1];

    if (!pdfPath) {
      console.error("Usage: npm run genkit figures <pdf_file>");
      console.error("\nExample: npm run genkit figures ./pdfs/smith2022.pdf");
      process.exit(1);
    }

    if (!process.env.MISTRAL_API_KEY) {
      console.error("❌ MISTRAL_API_KEY not configured. Add it to .env file.");
      process.exit(1);
    }

    const absolutePath = path.resolve(pdfPath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`❌ File not found: ${absolutePath}`);
      process.exit(1);
    }

    console.log(`\n📈 Extracting figures from ${path.basename(absolutePath)} with Mistral OCR...\n`);

    const figures = await extractFiguresWithMistral({pdfPath: absolutePath});

    if (figures.length === 0) {
      console.log("No figures found in this PDF.");
      process.exit(0);
    }

    console.log(`Found ${figures.length} figures:\n`);

    figures.forEach((fig, i) => {
      console.log(`\n=== Figure ${i + 1} (Page ${fig.pageNumber}) ===`);
      console.log(`Type: ${fig.figureType}`);
      if (fig.caption) console.log(`Caption: ${fig.caption}`);
      if (fig.summary) console.log(`Summary: ${fig.summary}`);
      if (fig.clinicalRelevance) console.log(`Clinical Relevance: ${fig.clinicalRelevance}`);

      if (fig.extractedValues.length > 0) {
        console.log(`\nExtracted values:`);
        fig.extractedValues.forEach((v) => {
          console.log(`  • ${v.label}: ${v.value} (${(v.confidence * 100).toFixed(0)}%)`);
        });
      }
    });
  } else if (command === "serve") {
    // Start HTTP server exposing Genkit flows
    const port = parseInt(args[1]) || 3400;
    const cors = args.includes("--cors");

    console.log(`
🚀 Starting Genkit Flow Server
   Port: ${port}
   CORS: ${cors ? "enabled" : "disabled"}
   Storage: ${USE_LOCAL_STORAGE ? "LOCAL" : "FIRESTORE"}
`);

    // Start the server with selected flows
    startFlowServer({
      port,
      cors: cors ? {origin: "*"} : undefined,
      flows: [
        // Chat flows
        createChatSession,
        sendChatMessage,
        getChatHistory,
        listChatSessions,
        deleteChatSession,
        // Extraction flows
        extractStudyData,
        checkAndSaveStudy,
        listStudies,
        searchSimilarStudies,
        // Evaluation flows
        evaluateExtraction,
        critiqueExtraction,
        quickCritique,
      ],
    });

    console.log(`\n📡 Available endpoints:`);
    console.log(`   POST /createChatSession   - Create new chat session`);
    console.log(`   POST /sendChatMessage     - Send message and get response`);
    console.log(`   POST /getChatHistory      - Get session history`);
    console.log(`   POST /listChatSessions    - List all sessions`);
    console.log(`   POST /deleteChatSession   - Delete a session`);
    console.log(`   POST /extractStudyData    - Extract structured data from PDF text`);
    console.log(`   POST /checkAndSaveStudy   - Save extracted study with validation`);
    console.log(`   POST /listStudies         - List all stored studies`);
    console.log(`   POST /searchSimilarStudies - Semantic search across studies`);
    console.log(`   POST /evaluateExtraction  - Run quality evaluation`);
    console.log(`   POST /critiqueExtraction  - Run critique/reflector validation`);
    console.log(`   POST /quickCritique       - Real-time validation (for frontend)`);
    console.log(`\n✅ Server running at http://localhost:${port}`);
    console.log(`   Press Ctrl+C to stop\n`);
  } else if (command === "help") {
    console.log(`
🧠 Cerebellar SDC Extraction System
Storage: ${USE_LOCAL_STORAGE ? "LOCAL (./data/studies.json)" : "FIRESTORE"}
MCP: genkit-cerebellar (exposing ${Object.keys({extractStudyData, checkAndSaveStudy, listStudies, searchSimilarStudies, evaluateExtraction}).length} flows)

Commands:
  serve [port] [--cors]    - Start HTTP server for frontend integration
  chat [message]           - Collaborate with Gemini 3 Pro
  pdf <file>               - Interactive chat with a specific PDF
  extract <text>           - Extract structured data from PDF text
  batch <dir> [n]          - Batch process PDFs from directory (n = concurrency)
  search <query>           - RAG semantic search across indexed studies
  eval <file>              - Extract and evaluate quality from a PDF
  export [path]            - Export studies to CSV
  list                     - Show all studies in database
  critique <file> [--mode] - Run critique/validation on extraction
  tables <file> [--json] [--analyze]  - Extract tables with Mistral OCR (96% accuracy)
  figures <file>           - Extract figures/charts with Mistral OCR
  annotate <study_id>      - Create/edit ground truth annotations (interactive)
  evaluate-dataset <id>    - Evaluate extraction against ground truth
  report [phase]           - Generate evaluation dataset report
  help                     - Show this help

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

Evaluation Dataset Workflow:
  Phase 1: Baseline   - 15 papers regression testing + 5 ground truth
  Phase 2: Expanded   - 20 ground truth + 10 challenge cases
  Phase 3: Expert     - 50 papers with inter-rater reliability

Examples:
  npm run genkit serve 3400 --cors   # Start server for frontend
  npm run genkit chat "How should I handle multicenter studies?"
  npm run genkit pdf ./pdfs/smith2022.pdf
  npm run genkit eval ./pdfs/smith2022.pdf
  npm run genkit search "mortality outcomes cerebellar"
  npm run genkit batch ./pdfs 3
  npm run genkit export ./my_dataset.csv
  npm run genkit list
  npm run genkit critique ./pdfs/smith2022.pdf --mode=AUTO
  npm run genkit annotate Smith-2022
  npm run genkit evaluate-dataset Smith-2022
  npm run genkit report phase1
    `);
  } else {
    console.log("Unknown command. Use 'help' for available commands.");
  }
}

main().catch(console.error);

// Exports for use in other modules
export {ai};

// Re-export chat module (modularized into src/chat/)
export {
  createChatSession,
  sendChatMessage,
  getChatHistory,
  listChatSessions,
  deleteChatSession,
  chat,
  chatWithPDF,
  type SessionData,
  type PDFChatState,
} from "./chat/index.js";
