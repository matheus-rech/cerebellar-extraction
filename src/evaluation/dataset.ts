/**
 * Evaluation Dataset Management
 *
 * Implements the Hybrid Approach for building evaluation datasets:
 * - Phase 1: Regression baseline + initial ground truth
 * - Phase 2: Expanded ground truth + challenge cases
 * - Phase 3: Expert annotations with inter-rater reliability
 */

import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";
import * as fs from "fs";
import * as path from "path";

const ai = genkit({
  plugins: [googleAI()],
});

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Ground truth annotation for a single field
 */
const FieldAnnotationSchema = z.object({
  field: z.string().describe("Field path (e.g., 'population.age.mean')"),
  groundTruthValue: z.any().describe("The correct value for this field"),
  sourceEvidence: z.string().describe("Verbatim quote from PDF supporting this value"),
  annotatorId: z.string().describe("ID of the person who annotated"),
  annotationDate: z.string().describe("ISO timestamp of annotation"),
  confidence: z.number().min(0).max(1).describe("Annotator confidence (0-1)"),
  notes: z.string().optional().describe("Additional notes or rationale"),
});

/**
 * Complete ground truth for a study
 */
const GroundTruthSchema = z.object({
  studyId: z.string().describe("Unique ID for the study (firstAuthor-year)"),
  pdfPath: z.string().describe("Path to the PDF file"),
  pdfChecksum: z.string().describe("SHA-256 checksum of PDF for verification"),
  annotationType: z.enum(["baseline", "ground_truth", "challenge"]).describe("Dataset phase"),
  fieldAnnotations: z.array(FieldAnnotationSchema),
  metadata: z.object({
    difficulty: z.enum(["easy", "medium", "hard"]).describe("Subjective difficulty"),
    studyDesign: z.string().describe("Study type for stratification"),
    annotatedBy: z.array(z.string()).describe("All annotators (for inter-rater reliability)"),
    completionDate: z.string().describe("When annotation was completed"),
    reviewStatus: z.enum(["pending", "reviewed", "approved"]).describe("QA status"),
  }),
});

/**
 * Evaluation result for a single extraction
 */
const EvaluationResultSchema = z.object({
  studyId: z.string(),
  extractedData: z.any(),
  groundTruth: GroundTruthSchema,
  fieldMetrics: z.array(z.object({
    field: z.string(),
    match: z.boolean().describe("Did extracted value match ground truth?"),
    extractedValue: z.any(),
    groundTruthValue: z.any(),
    hasSourceEvidence: z.boolean().describe("Did extraction include source text?"),
    sourceGroundingScore: z.number().min(0).max(1).describe("Quality of source text match"),
    errorType: z.enum(["missing", "hallucination", "inaccurate", "partial", "correct"]).optional(),
  })),
  overallMetrics: z.object({
    precision: z.number().describe("Correct fields / extracted fields"),
    recall: z.number().describe("Correct fields / total fields"),
    f1Score: z.number(),
    sourceGroundingRate: z.number().describe("% of VerifiableFields with valid source quotes"),
    nosConsistency: z.boolean().describe("Newcastle-Ottawa scores mathematically consistent"),
    criticalFieldAccuracy: z.number().describe("Accuracy on high-importance fields"),
  }),
});

/**
 * Dataset metadata
 */
const DatasetMetadataSchema = z.object({
  version: z.string(),
  creationDate: z.string(),
  phase: z.enum(["phase1", "phase2", "phase3"]),
  totalStudies: z.number(),
  breakdown: z.object({
    baseline: z.number(),
    groundTruth: z.number(),
    challenge: z.number(),
  }),
  stratification: z.record(z.number()).describe("Count by study design"),
  annotators: z.array(z.string()),
});

// ============================================================================
// DATASET STORAGE
// ============================================================================

const DATASET_DIR = "./evaluation-dataset";
const GROUND_TRUTH_FILE = path.join(DATASET_DIR, "ground_truth.json");
const RESULTS_FILE = path.join(DATASET_DIR, "evaluation_results.json");
const METADATA_FILE = path.join(DATASET_DIR, "dataset_metadata.json");

/**
 * Initialize dataset directory structure
 */
function initializeDatasetDir() {
  if (!fs.existsSync(DATASET_DIR)) {
    fs.mkdirSync(DATASET_DIR, {recursive: true});
  }

  // Create phase directories
  ["phase1", "phase2", "phase3"].forEach((phase) => {
    const phaseDir = path.join(DATASET_DIR, phase);
    if (!fs.existsSync(phaseDir)) {
      fs.mkdirSync(phaseDir, {recursive: true});
    }
  });
}

/**
 * Load ground truth annotations
 */
function loadGroundTruth(): z.infer<typeof GroundTruthSchema>[] {
  initializeDatasetDir();

  if (!fs.existsSync(GROUND_TRUTH_FILE)) {
    return [];
  }

  const data = fs.readFileSync(GROUND_TRUTH_FILE, "utf-8");
  return JSON.parse(data);
}

/**
 * Save ground truth annotation
 */
function saveGroundTruth(groundTruth: z.infer<typeof GroundTruthSchema>) {
  initializeDatasetDir();

  const existing = loadGroundTruth();
  const idx = existing.findIndex((gt) => gt.studyId === groundTruth.studyId);

  if (idx >= 0) {
    existing[idx] = groundTruth;
  } else {
    existing.push(groundTruth);
  }

  fs.writeFileSync(GROUND_TRUTH_FILE, JSON.stringify(existing, null, 2));
}

/**
 * Load evaluation results
 */
function loadEvaluationResults(): z.infer<typeof EvaluationResultSchema>[] {
  initializeDatasetDir();

  if (!fs.existsSync(RESULTS_FILE)) {
    return [];
  }

  const data = fs.readFileSync(RESULTS_FILE, "utf-8");
  return JSON.parse(data);
}

/**
 * Save evaluation result
 */
function saveEvaluationResult(result: z.infer<typeof EvaluationResultSchema>) {
  initializeDatasetDir();

  const existing = loadEvaluationResults();
  const idx = existing.findIndex((r) => r.studyId === result.studyId);

  if (idx >= 0) {
    existing[idx] = result;
  } else {
    existing.push(result);
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2));
}

// ============================================================================
// FLOWS
// ============================================================================

/**
 * Create ground truth annotation for a study
 */
export const createGroundTruth = ai.defineFlow(
  {
    name: "createGroundTruth",
    inputSchema: z.object({
      studyId: z.string(),
      pdfPath: z.string(),
      annotationType: z.enum(["baseline", "ground_truth", "challenge"]),
      annotatorId: z.string(),
      difficulty: z.enum(["easy", "medium", "hard"]),
      studyDesign: z.string(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      groundTruthId: z.string(),
      message: z.string(),
    }),
  },
  async (input) => {
    // Calculate PDF checksum
    const pdfBuffer = fs.readFileSync(input.pdfPath);
    const crypto = await import("crypto");
    const checksum = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

    // Create empty ground truth template
    const groundTruth: z.infer<typeof GroundTruthSchema> = {
      studyId: input.studyId,
      pdfPath: input.pdfPath,
      pdfChecksum: checksum,
      annotationType: input.annotationType,
      fieldAnnotations: [],
      metadata: {
        difficulty: input.difficulty,
        studyDesign: input.studyDesign,
        annotatedBy: [input.annotatorId],
        completionDate: new Date().toISOString(),
        reviewStatus: "pending",
      },
    };

    saveGroundTruth(groundTruth);

    return {
      success: true,
      groundTruthId: input.studyId,
      message: `Ground truth template created for ${input.studyId}. Use annotateField flow to add field annotations.`,
    };
  }
);

/**
 * Annotate a single field with ground truth value
 */
export const annotateField = ai.defineFlow(
  {
    name: "annotateField",
    inputSchema: z.object({
      studyId: z.string(),
      field: z.string(),
      groundTruthValue: z.any(),
      sourceEvidence: z.string(),
      annotatorId: z.string(),
      confidence: z.number().min(0).max(1),
      notes: z.string().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async (input) => {
    const groundTruths = loadGroundTruth();
    const gt = groundTruths.find((g) => g.studyId === input.studyId);

    if (!gt) {
      return {
        success: false,
        message: `Ground truth not found for study ${input.studyId}. Create it first with createGroundTruth.`,
      };
    }

    const annotation: z.infer<typeof FieldAnnotationSchema> = {
      field: input.field,
      groundTruthValue: input.groundTruthValue,
      sourceEvidence: input.sourceEvidence,
      annotatorId: input.annotatorId,
      annotationDate: new Date().toISOString(),
      confidence: input.confidence,
      notes: input.notes,
    };

    // Remove existing annotation for this field if present
    gt.fieldAnnotations = gt.fieldAnnotations.filter((a) => a.field !== input.field);
    gt.fieldAnnotations.push(annotation);

    // Add annotator to metadata if not present
    if (!gt.metadata.annotatedBy.includes(input.annotatorId)) {
      gt.metadata.annotatedBy.push(input.annotatorId);
    }

    saveGroundTruth(gt);

    return {
      success: true,
      message: `Field ${input.field} annotated successfully for ${input.studyId}`,
    };
  }
);

/**
 * Evaluate extraction against ground truth
 */
export const evaluateAgainstGroundTruth = ai.defineFlow(
  {
    name: "evaluateAgainstGroundTruth",
    inputSchema: z.object({
      studyId: z.string(),
      extractedData: z.any().describe("The extraction to evaluate"),
    }),
    outputSchema: EvaluationResultSchema,
  },
  async ({studyId, extractedData}) => {
    const groundTruths = loadGroundTruth();
    const gt = groundTruths.find((g) => g.studyId === studyId);

    if (!gt) {
      throw new Error(`Ground truth not found for study ${studyId}`);
    }

    // Critical fields (weighted higher in evaluation)
    const criticalFields = [
      "population.sampleSize",
      "population.age.mean",
      "intervention.technique",
      "outcomes.mortality",
      "outcomes.mRS_favorable",
      "quality.totalScore",
    ];

    // Evaluate each field
    const fieldMetrics: z.infer<typeof EvaluationResultSchema>["fieldMetrics"] = [];

    for (const annotation of gt.fieldAnnotations) {
      const extractedValue = getNestedValue(extractedData, annotation.field);
      const match = deepEqual(extractedValue, annotation.groundTruthValue);

      // Check if VerifiableField has source evidence
      const hasSourceEvidence = annotation.field.includes(".") &&
        extractedValue?.sourceText &&
        typeof extractedValue.sourceText === "string" &&
        extractedValue.sourceText.length >= 10;

      // Calculate source grounding score
      let sourceGroundingScore = 0;
      if (hasSourceEvidence && annotation.sourceEvidence) {
        // Simple fuzzy match between extracted source and ground truth source
        const similarity = calculateSimilarity(extractedValue.sourceText, annotation.sourceEvidence);
        sourceGroundingScore = similarity;
      }

      let errorType: "missing" | "hallucination" | "inaccurate" | "partial" | "correct" = "correct";
      if (!match) {
        if (!extractedValue || extractedValue === null) {
          errorType = "missing";
        } else if (!hasSourceEvidence || sourceGroundingScore < 0.3) {
          errorType = "hallucination";
        } else if (sourceGroundingScore >= 0.3 && sourceGroundingScore < 0.7) {
          errorType = "partial";
        } else {
          errorType = "inaccurate";
        }
      }

      fieldMetrics.push({
        field: annotation.field,
        match,
        extractedValue,
        groundTruthValue: annotation.groundTruthValue,
        hasSourceEvidence,
        sourceGroundingScore,
        errorType,
      });
    }

    // Calculate overall metrics
    const totalFields = fieldMetrics.length;
    const correctFields = fieldMetrics.filter((m) => m.match).length;
    const fieldsWithSource = fieldMetrics.filter((m) => m.hasSourceEvidence).length;
    const criticalFieldsCorrect = fieldMetrics
      .filter((m) => criticalFields.includes(m.field) && m.match)
      .length;
    const totalCriticalFields = fieldMetrics.filter((m) => criticalFields.includes(m.field)).length;

    const precision = totalFields > 0 ? correctFields / totalFields : 0;
    const recall = totalFields > 0 ? correctFields / totalFields : 0; // Assuming all fields should be extracted
    const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const sourceGroundingRate = totalFields > 0 ? fieldsWithSource / totalFields : 0;
    const criticalFieldAccuracy = totalCriticalFields > 0 ? criticalFieldsCorrect / totalCriticalFields : 1;

    // Check NOS consistency
    const nosConsistent = checkNOSConsistency(extractedData.quality);

    const result: z.infer<typeof EvaluationResultSchema> = {
      studyId,
      extractedData,
      groundTruth: gt,
      fieldMetrics,
      overallMetrics: {
        precision,
        recall,
        f1Score,
        sourceGroundingRate,
        nosConsistency: nosConsistent,
        criticalFieldAccuracy,
      },
    };

    saveEvaluationResult(result);

    return result;
  }
);

/**
 * Generate evaluation report
 */
export const generateEvaluationReport = ai.defineFlow(
  {
    name: "generateEvaluationReport",
    inputSchema: z.object({
      phase: z.enum(["phase1", "phase2", "phase3"]).optional(),
    }),
    outputSchema: z.object({
      summary: z.string(),
      aggregateMetrics: z.object({
        averagePrecision: z.number(),
        averageRecall: z.number(),
        averageF1: z.number(),
        sourceGroundingRate: z.number(),
        nosConsistencyRate: z.number(),
        criticalFieldAccuracy: z.number(),
      }),
      byStudyDesign: z.record(z.any()),
      byDifficulty: z.record(z.any()),
      errorBreakdown: z.record(z.number()),
      recommendations: z.array(z.string()),
    }),
  },
  async ({phase}) => {
    const results = loadEvaluationResults();
    const groundTruths = loadGroundTruth();

    // Filter by phase if specified
    let filteredResults = results;
    if (phase) {
      const phaseGTIds = groundTruths
        .filter((gt) => {
          if (phase === "phase1") return gt.annotationType === "baseline";
          if (phase === "phase2") return gt.annotationType === "ground_truth";
          if (phase === "phase3") return gt.annotationType === "challenge";
          return false;
        })
        .map((gt) => gt.studyId);

      filteredResults = results.filter((r) => phaseGTIds.includes(r.studyId));
    }

    if (filteredResults.length === 0) {
      return {
        summary: "No evaluation results found for the specified phase.",
        aggregateMetrics: {
          averagePrecision: 0,
          averageRecall: 0,
          averageF1: 0,
          sourceGroundingRate: 0,
          nosConsistencyRate: 0,
          criticalFieldAccuracy: 0,
        },
        byStudyDesign: {},
        byDifficulty: {},
        errorBreakdown: {},
        recommendations: [],
      };
    }

    // Aggregate metrics
    const totalResults = filteredResults.length;
    const avgPrecision = filteredResults.reduce((sum, r) => sum + r.overallMetrics.precision, 0) / totalResults;
    const avgRecall = filteredResults.reduce((sum, r) => sum + r.overallMetrics.recall, 0) / totalResults;
    const avgF1 = filteredResults.reduce((sum, r) => sum + r.overallMetrics.f1Score, 0) / totalResults;
    const avgSourceGrounding = filteredResults.reduce((sum, r) => sum + r.overallMetrics.sourceGroundingRate, 0) / totalResults;
    const nosConsistencyRate = filteredResults.filter((r) => r.overallMetrics.nosConsistency).length / totalResults;
    const avgCriticalAccuracy = filteredResults.reduce((sum, r) => sum + r.overallMetrics.criticalFieldAccuracy, 0) / totalResults;

    // Error breakdown
    const errorBreakdown: Record<string, number> = {
      missing: 0,
      hallucination: 0,
      inaccurate: 0,
      partial: 0,
      correct: 0,
    };

    filteredResults.forEach((r) => {
      r.fieldMetrics.forEach((fm) => {
        if (fm.errorType) {
          errorBreakdown[fm.errorType]++;
        }
      });
    });

    // Stratify by study design
    const byStudyDesign: Record<string, any> = {};
    filteredResults.forEach((r) => {
      const design = r.groundTruth.metadata.studyDesign;
      if (!byStudyDesign[design]) {
        byStudyDesign[design] = {count: 0, avgF1: 0};
      }
      byStudyDesign[design].count++;
      byStudyDesign[design].avgF1 += r.overallMetrics.f1Score;
    });

    Object.keys(byStudyDesign).forEach((design) => {
      byStudyDesign[design].avgF1 /= byStudyDesign[design].count;
    });

    // Stratify by difficulty
    const byDifficulty: Record<string, any> = {};
    filteredResults.forEach((r) => {
      const difficulty = r.groundTruth.metadata.difficulty;
      if (!byDifficulty[difficulty]) {
        byDifficulty[difficulty] = {count: 0, avgF1: 0};
      }
      byDifficulty[difficulty].count++;
      byDifficulty[difficulty].avgF1 += r.overallMetrics.f1Score;
    });

    Object.keys(byDifficulty).forEach((difficulty) => {
      byDifficulty[difficulty].avgF1 /= byDifficulty[difficulty].count;
    });

    // Generate recommendations
    const recommendations: string[] = [];
    if (avgF1 < 0.7) {
      recommendations.push("Overall F1 score below 0.7 - consider improving extraction prompts or model");
    }
    if (avgSourceGrounding < 0.5) {
      recommendations.push("Low source grounding rate - extraction may be hallucinating data");
    }
    if (nosConsistencyRate < 0.8) {
      recommendations.push("Newcastle-Ottawa scores frequently inconsistent - add validation checks");
    }
    if (errorBreakdown.hallucination > totalResults * 5) {
      recommendations.push("High hallucination error count - strengthen source text verification");
    }
    if (avgCriticalAccuracy < 0.85) {
      recommendations.push("Critical field accuracy below 85% - focus on improving high-importance field extraction");
    }

    const summary = `
Evaluation Report (${phase || "All Phases"}):
- Total studies evaluated: ${totalResults}
- Average Precision: ${(avgPrecision * 100).toFixed(1)}%
- Average Recall: ${(avgRecall * 100).toFixed(1)}%
- Average F1 Score: ${(avgF1 * 100).toFixed(1)}%
- Source Grounding Rate: ${(avgSourceGrounding * 100).toFixed(1)}%
- NOS Consistency Rate: ${(nosConsistencyRate * 100).toFixed(1)}%
- Critical Field Accuracy: ${(avgCriticalAccuracy * 100).toFixed(1)}%

Error Breakdown:
- Correct: ${errorBreakdown.correct}
- Missing: ${errorBreakdown.missing}
- Hallucination: ${errorBreakdown.hallucination}
- Inaccurate: ${errorBreakdown.inaccurate}
- Partial: ${errorBreakdown.partial}
`;

    return {
      summary,
      aggregateMetrics: {
        averagePrecision: avgPrecision,
        averageRecall: avgRecall,
        averageF1: avgF1,
        sourceGroundingRate: avgSourceGrounding,
        nosConsistencyRate,
        criticalFieldAccuracy: avgCriticalAccuracy,
      },
      byStudyDesign,
      byDifficulty,
      errorBreakdown,
      recommendations,
    };
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

/**
 * Deep equality check
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return a === b;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }

  return true;
}

/**
 * Calculate similarity between two strings (simple Jaccard)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/));
  const words2 = new Set(str2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Check Newcastle-Ottawa Scale consistency
 */
function checkNOSConsistency(quality: any): boolean {
  if (!quality) return false;

  const selection = quality.selectionScore ?? 0;
  const comparability = quality.comparabilityScore ?? 0;
  const outcome = quality.outcomeScore ?? 0;
  const total = quality.totalScore ?? 0;

  // Check component bounds
  if (selection < 0 || selection > 4) return false;
  if (comparability < 0 || comparability > 2) return false;
  if (outcome < 0 || outcome > 3) return false;

  // Check total matches sum
  return Math.abs(total - (selection + comparability + outcome)) < 0.01;
}

// ============================================================================
// EXPORT
// ============================================================================

export {
  FieldAnnotationSchema,
  GroundTruthSchema,
  EvaluationResultSchema,
  DatasetMetadataSchema,
  loadGroundTruth,
  saveGroundTruth,
  loadEvaluationResults,
  saveEvaluationResult,
};
