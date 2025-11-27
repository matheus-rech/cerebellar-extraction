/**
 * Genkit Evaluators for Cerebellar Extraction
 *
 * Uses Genkit's defineEvaluator API for standardized evaluation metrics.
 * These evaluators can be run via `genkit eval` CLI or programmatically.
 */

import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";

// Initialize Genkit instance for evaluators
const ai = genkit({
  plugins: [googleAI()],
});

// ============================================================================
// CUSTOM EVALUATION RESULT TYPE
// ============================================================================

interface EvaluationScore {
  score: number;
  details: Record<string, unknown>;
}

// ============================================================================
// FAITHFULNESS EVALUATOR
// ============================================================================

/**
 * Faithfulness Evaluator
 *
 * Measures how faithful the extracted value is to the source text.
 * Returns a score from 0-1 indicating:
 * - 1.0: Perfectly faithful - exact match or direct paraphrase
 * - 0.7-0.9: Mostly faithful - minor interpretation differences
 * - 0.4-0.6: Partially faithful - some unsupported claims
 * - 0.0-0.3: Unfaithful - hallucinated or contradictory
 */
export async function evaluateFaithfulness(
  extractedValue: unknown,
  sourceText: string
): Promise<EvaluationScore> {
  if (!extractedValue || !sourceText) {
    return {
      score: 0,
      details: {reasoning: "Missing output or context for faithfulness evaluation"},
    };
  }

  try {
    const {output: result} = await ai.generate({
      model: googleAI.model("gemini-2.5-flash"),
      prompt: `You are evaluating faithfulness of extracted data to source text.

TASK: Determine how faithfully the extracted value represents the source text.

EXTRACTED VALUE:
${JSON.stringify(extractedValue, null, 2)}

SOURCE TEXT:
${sourceText.slice(0, 8000)}

SCORING CRITERIA:
- 1.0: Perfectly faithful - exact match or direct quote
- 0.8-0.9: Highly faithful - accurate paraphrase, no additions
- 0.6-0.7: Mostly faithful - minor interpretation, no contradictions
- 0.4-0.5: Partially faithful - some unsupported inferences
- 0.2-0.3: Weakly faithful - significant unsupported claims
- 0.0-0.1: Unfaithful - contradicts source or hallucinated

Return JSON with your evaluation:`,
      output: {
        schema: z.object({
          score: z.number().min(0).max(1),
          reasoning: z.string(),
          supportedClaims: z.array(z.string()),
          unsupportedClaims: z.array(z.string()),
        }),
      },
    });

    return {
      score: result?.score ?? 0,
      details: {
        reasoning: result?.reasoning ?? "Evaluation failed",
        supportedClaims: result?.supportedClaims ?? [],
        unsupportedClaims: result?.unsupportedClaims ?? [],
      },
    };
  } catch (error) {
    return {
      score: 0,
      details: {reasoning: `Faithfulness evaluation failed: ${error}`},
    };
  }
}

// ============================================================================
// ANSWER RELEVANCY EVALUATOR
// ============================================================================

/**
 * Answer Relevancy Evaluator
 *
 * Measures how relevant the extracted data is to the extraction schema/query.
 * For SDC extractions, this checks if the right type of data was extracted.
 */
export async function evaluateRelevancy(
  extractedData: unknown
): Promise<EvaluationScore> {
  if (!extractedData) {
    return {
      score: 0,
      details: {reasoning: "No output to evaluate"},
    };
  }

  const schemaDescription = `
SDC Study Extraction Schema:
- metadata: firstAuthor, publicationYear, hospitalCenter, studyPeriod, studyDesign
- population: sampleSize, age, gcs, hydrocephalus, diagnosis
- intervention: procedure, technique, evdUsed, duraplasty
- comparator: exists, type, description, sampleSize
- outcomes: mortality, mRS_favorable, lengthOfStay, complications
- quality: Newcastle-Ottawa Scale scores (selection 0-4, comparability 0-2, outcome 0-3)
`;

  try {
    const {output: result} = await ai.generate({
      model: googleAI.model("gemini-2.5-flash"),
      prompt: `You are evaluating whether extracted data is relevant to the expected schema.

EXPECTED SCHEMA:
${schemaDescription}

EXTRACTED DATA:
${JSON.stringify(extractedData, null, 2)}

SCORING CRITERIA:
- 1.0: All fields relevant to SDC study extraction
- 0.8-0.9: Most fields relevant, minor off-topic data
- 0.6-0.7: Mostly relevant but missing key sections
- 0.4-0.5: Partially relevant - mixed with irrelevant data
- 0.2-0.3: Mostly irrelevant to SDC extraction
- 0.0-0.1: Completely off-topic

Return JSON with your evaluation:`,
      output: {
        schema: z.object({
          score: z.number().min(0).max(1),
          reasoning: z.string(),
          relevantFields: z.array(z.string()),
          missingFields: z.array(z.string()),
          irrelevantFields: z.array(z.string()),
        }),
      },
    });

    return {
      score: result?.score ?? 0,
      details: {
        reasoning: result?.reasoning ?? "Evaluation failed",
        relevantFields: result?.relevantFields ?? [],
        missingFields: result?.missingFields ?? [],
        irrelevantFields: result?.irrelevantFields ?? [],
      },
    };
  } catch (error) {
    return {
      score: 0,
      details: {reasoning: `Relevancy evaluation failed: ${error}`},
    };
  }
}

// ============================================================================
// HALLUCINATION DETECTOR EVALUATOR
// ============================================================================

/**
 * Hallucination Detector Evaluator
 *
 * Specifically designed to detect hallucinated medical data.
 * Critical for ensuring extraction accuracy in clinical research.
 */
export async function evaluateHallucination(
  extractedData: unknown,
  sourceText: string
): Promise<EvaluationScore> {
  if (!extractedData || !sourceText) {
    return {
      score: 1, // No hallucination if nothing to compare
      details: {reasoning: "Insufficient data for hallucination check"},
    };
  }

  try {
    const {output: result} = await ai.generate({
      model: googleAI.model("gemini-2.5-flash"),
      prompt: `You are a medical research expert detecting hallucinated data in study extractions.

CRITICAL: Medical data hallucinations can lead to incorrect systematic review conclusions.

EXTRACTED DATA:
${JSON.stringify(extractedData, null, 2)}

SOURCE TEXT:
${sourceText.slice(0, 15000)}

CHECK FOR HALLUCINATIONS:
1. Numbers not in source (sample sizes, percentages, scores)
2. Medical terms/procedures not mentioned
3. Outcome values without source evidence
4. Scale scores that don't match source description
5. Patient demographics fabricated

SCORING (1.0 = no hallucination, 0.0 = severe hallucination):
- 1.0: All data directly supported by source
- 0.7-0.9: Minor inferences, no fabricated numbers
- 0.4-0.6: Some unsupported numerical data
- 0.1-0.3: Significant fabrication detected
- 0.0: Severe hallucination - key data fabricated

Return JSON:`,
      output: {
        schema: z.object({
          score: z.number().min(0).max(1),
          hallucinatedFields: z.array(z.object({
            field: z.string(),
            extractedValue: z.string(),
            issue: z.string(),
            severity: z.enum(["MINOR", "MODERATE", "SEVERE"]),
          })),
          verifiedFields: z.array(z.string()),
          reasoning: z.string(),
        }),
      },
    });

    return {
      score: result?.score ?? 0,
      details: {
        reasoning: result?.reasoning ?? "Evaluation failed",
        hallucinatedFields: result?.hallucinatedFields ?? [],
        verifiedFields: result?.verifiedFields ?? [],
      },
    };
  } catch (error) {
    return {
      score: 0.5, // Neutral if evaluation fails
      details: {reasoning: `Hallucination check failed: ${error}`},
    };
  }
}

// ============================================================================
// CLINICAL ACCURACY EVALUATOR
// ============================================================================

/**
 * Clinical Accuracy Evaluator
 *
 * Checks domain-specific accuracy for neurosurgical/SDC data.
 * Validates medical terminology, scale interpretations, and clinical logic.
 */
export async function evaluateClinicalAccuracy(
  extractedData: unknown
): Promise<EvaluationScore> {
  if (!extractedData) {
    return {
      score: 0,
      details: {reasoning: "No output to evaluate"},
    };
  }

  try {
    const {output: result} = await ai.generate({
      model: googleAI.model("gemini-2.5-flash"),
      prompt: `You are a neurosurgical expert validating SDC (Suboccipital Decompressive Craniectomy) study extraction.

EXTRACTED DATA:
${JSON.stringify(extractedData, null, 2)}

VALIDATE CLINICAL ACCURACY:

1. SCALE INTERPRETATION:
   - mRS: 0=no symptoms, 6=death (lower is better)
   - GOS: 1=death, 5=good recovery (higher is better)
   - GCS: 3-15 (higher is better)
   - Check favorable outcome definitions match scale direction

2. MEDICAL TERMINOLOGY:
   - SDC/SOC (Suboccipital Craniectomy) terminology correct
   - EVD (External Ventricular Drain) usage appropriate
   - Cerebellar stroke vs infarction vs hemorrhage distinctions

3. CLINICAL LOGIC:
   - Hydrocephalus rates typically 50-80% in cerebellar stroke
   - Mortality rates typically 10-40% for SDC patients
   - Follow-up periods appropriate for outcome measures

4. NEWCASTLE-OTTAWA SCALE:
   - Selection: 0-4 stars (4 items, 1 star each)
   - Comparability: 0-2 stars
   - Outcome: 0-3 stars (3 items, 1 star each)
   - Total: sum of domains

SCORING:
- 1.0: Clinically accurate, correct scale usage
- 0.7-0.9: Minor clinical inconsistencies
- 0.4-0.6: Some clinical errors or scale confusion
- 0.1-0.3: Significant clinical inaccuracies
- 0.0: Fundamental clinical errors

Return JSON:`,
      output: {
        schema: z.object({
          score: z.number().min(0).max(1),
          scaleValidation: z.object({
            mrsCorrect: z.boolean(),
            gosCorrect: z.boolean(),
            gcsCorrect: z.boolean(),
            issues: z.array(z.string()),
          }),
          terminologyCorrect: z.boolean(),
          clinicalLogicValid: z.boolean(),
          nosValid: z.boolean(),
          reasoning: z.string(),
        }),
      },
    });

    return {
      score: result?.score ?? 0,
      details: {
        reasoning: result?.reasoning ?? "Evaluation failed",
        scaleValidation: result?.scaleValidation,
        terminologyCorrect: result?.terminologyCorrect,
        clinicalLogicValid: result?.clinicalLogicValid,
        nosValid: result?.nosValid,
      },
    };
  } catch (error) {
    return {
      score: 0.5,
      details: {reasoning: `Clinical accuracy evaluation failed: ${error}`},
    };
  }
}

// ============================================================================
// COMPOSITE EVALUATOR FLOW
// ============================================================================

/**
 * Run all evaluators and produce composite score
 */
export const runAllEvaluators = ai.defineFlow(
  {
    name: "runAllEvaluators",
    inputSchema: z.object({
      extractedData: z.any().describe("The extracted study data"),
      pdfText: z.string().describe("Source PDF text"),
    }),
    outputSchema: z.object({
      compositeScore: z.number(),
      evaluatorResults: z.array(z.object({
        evaluator: z.string(),
        score: z.number(),
        weight: z.number(),
        details: z.record(z.unknown()),
      })),
      passesThreshold: z.boolean(),
      recommendations: z.array(z.string()),
    }),
  },
  async ({extractedData, pdfText}) => {
    console.log("🔍 Running all evaluators...");

    // Run all evaluators in parallel
    const [faithfulness, relevancy, hallucination, clinical] = await Promise.all([
      evaluateFaithfulness(extractedData, pdfText),
      evaluateRelevancy(extractedData),
      evaluateHallucination(extractedData, pdfText),
      evaluateClinicalAccuracy(extractedData),
    ]);

    // Define weights
    const weights = {
      faithfulness: 0.30,
      relevancy: 0.15,
      hallucination: 0.30,
      clinical: 0.25,
    };

    // Calculate composite score
    const compositeScore =
      faithfulness.score * weights.faithfulness +
      relevancy.score * weights.relevancy +
      hallucination.score * weights.hallucination +
      clinical.score * weights.clinical;

    // Generate recommendations based on low scores
    const recommendations: string[] = [];

    if (faithfulness.score < 0.7) {
      recommendations.push("Improve source text verification - some claims lack direct evidence");
    }
    if (relevancy.score < 0.7) {
      recommendations.push("Review extraction focus - some data may not be relevant to SDC schema");
    }
    if (hallucination.score < 0.7) {
      recommendations.push("CRITICAL: Hallucinated data detected - verify all numerical values");
    }
    if (clinical.score < 0.7) {
      recommendations.push("Clinical accuracy issues - verify scale interpretations and medical terminology");
    }

    const evaluatorResults = [
      {
        evaluator: "Faithfulness",
        score: faithfulness.score,
        weight: weights.faithfulness,
        details: faithfulness.details,
      },
      {
        evaluator: "Answer Relevancy",
        score: relevancy.score,
        weight: weights.relevancy,
        details: relevancy.details,
      },
      {
        evaluator: "Hallucination Detection",
        score: hallucination.score,
        weight: weights.hallucination,
        details: hallucination.details,
      },
      {
        evaluator: "Clinical Accuracy",
        score: clinical.score,
        weight: weights.clinical,
        details: clinical.details,
      },
    ];

    console.log(`✅ Composite evaluation score: ${(compositeScore * 100).toFixed(1)}%`);

    return {
      compositeScore,
      evaluatorResults,
      passesThreshold: compositeScore >= 0.7,
      recommendations,
    };
  }
);

// Export ai instance for use elsewhere
export {ai as evaluatorAi};
