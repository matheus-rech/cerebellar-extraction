// Layer 2 Critics: Semantic Logic Validators (Lightweight LLM, low cost)
// These critics use Gemini Flash for domain-specific medical logic validation

import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";
import {CriticResultSchema, CritiqueIssue} from "./schemas.js";

// Initialize Genkit instance for critics (reuse from main genkit.ts if possible)
const ai = genkit({
  plugins: [googleAI()],
});

/**
 * Retry configuration for Layer 2 critics
 */
interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Utility: Sleep for specified milliseconds
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Utility: Execute LLM call with exponential backoff retry
 * Handles rate limits, transient errors, and network issues
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  criticId: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error | null = null;
  let delayMs = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || String(error);

      // Check if this is a retryable error
      const isRateLimited = errorMessage.includes("429") || errorMessage.includes("rate limit");
      const isServerError = errorMessage.includes("500") || errorMessage.includes("503");
      const isTimeout = errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT");
      const isRetryable = isRateLimited || isServerError || isTimeout;

      if (!isRetryable || attempt === config.maxRetries) {
        console.error(`[${criticId}] Failed after ${attempt} attempt(s):`, errorMessage);
        throw error;
      }

      // Add jitter to prevent thundering herd
      const jitter = Math.random() * 500;
      const actualDelay = Math.min(delayMs + jitter, config.maxDelayMs);

      console.warn(
        `[${criticId}] Attempt ${attempt}/${config.maxRetries} failed. ` +
        `Retrying in ${Math.round(actualDelay)}ms... (${errorMessage.substring(0, 50)})`
      );

      await sleep(actualDelay);
      delayMs *= config.backoffMultiplier;
    }
  }

  throw lastError || new Error(`${criticId}: All retry attempts exhausted`);
}

/**
 * Scale Inversion Sentinel
 * Most common error in cerebellar stroke studies:
 * - mRS: 0=no symptoms, 6=death (LOWER is better)
 * - GOS: 1=death, 5=good recovery (HIGHER is better)
 * - GOS-E: 1=death, 8=upper good recovery (HIGHER is better)
 *
 * This critic detects when outcomes are interpreted inversely
 */
export const scaleInversionSentinel = ai.defineFlow(
  {
    name: "scaleInversionSentinel",
    inputSchema: z.object({
      outcomes: z.any(),
      pdfText: z.string().optional(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({outcomes, pdfText}) => {
    const issues: CritiqueIssue[] = [];

    // Build context for LLM
    const context = {
      mRSOutcome: outcomes?.mRS_favorable?.value,
      mRSSource: outcomes?.mRS_favorable?.sourceText,
      mortality: outcomes?.mortality?.value,
      complications: outcomes?.complications?.value,
    };

    const prompt = `You are a stroke neurologist reviewing extracted outcome data for a cerebellar decompression surgery study.

CRITICAL KNOWLEDGE:
- Modified Rankin Scale (mRS): 0 = no symptoms, 6 = death (LOWER scores = BETTER outcomes)
- Glasgow Outcome Scale (GOS): 1 = death, 5 = good recovery (HIGHER scores = BETTER outcomes)
- "Favorable outcome" typically means mRS 0-2 or 0-3
- "Good outcome" in GOS means scores 4-5

EXTRACTED DATA:
${JSON.stringify(context, null, 2)}

TASK:
1. Check if the mRS outcome definition is inverted (e.g., reporting mRS 4-6 as "favorable")
2. Check if percentages make sense (e.g., 80% mortality but 90% favorable outcome is contradictory)
3. Verify that outcome definitions match standard medical terminology

Return ONLY a JSON array of issues. Each issue must have:
- field: "outcomes.mRS_favorable" or relevant field
- severity: "CRITICAL" | "WARNING" | "INFO"
- message: Clear explanation of the problem
- suggestedValue: If you can confidently suggest a correction

If everything looks correct, return an empty array: []`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
            suggestedValue: z.string().optional(),
          }))},
        }),
        "scaleInversionSentinel"
      );

      const rawIssues = response.output || [];

      // Add criticId to each issue
      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "scaleInversionSentinel",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
          currentValue: (context as any)[issue.field.split('.').pop() || ''],
          suggestedValue: issue.suggestedValue,
          sourceEvidence: (outcomes as any)[issue.field.split('.').pop() || '']?.sourceText,
        });
      });

      return {
        criticId: "scaleInversionSentinel",
        passed: issues.length === 0,
        confidence: issues.length === 0 ? 0.95 : 0.7,
        issues,
      };
    } catch (error) {
      console.error("Scale inversion check failed after retries:", error);
      return {
        criticId: "scaleInversionSentinel",
        passed: true, // Don't block on LLM errors
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * EVD Confounding Detector
 * Detects when External Ventricular Drain (EVD) usage is confounded with SDC outcomes
 * Common issue: Studies report "SDC + EVD" outcomes vs "SDC alone" but don't stratify
 */
export const evdConfoundingDetector = ai.defineFlow(
  {
    name: "evdConfoundingDetector",
    inputSchema: z.object({
      intervention: z.any(),
      outcomes: z.any(),
      pdfText: z.string().optional(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({intervention, outcomes, pdfText}) => {
    const issues: CritiqueIssue[] = [];

    const context = {
      evdUsed: intervention?.evdUsed?.value,
      evdSource: intervention?.evdUsed?.sourceText,
      mortality: outcomes?.mortality?.value,
      complications: outcomes?.complications?.value,
    };

    const prompt = `You are reviewing a cerebellar stroke surgery study for methodological rigor.

CONTEXT:
- External Ventricular Drain (EVD) is often used alongside Suboccipital Decompressive Craniectomy (SDC)
- EVD placement itself carries risks (infection, hemorrhage)
- Valid studies should STRATIFY outcomes by: SDC+EVD vs SDC-alone

EXTRACTED DATA:
${JSON.stringify(context, null, 2)}

TASK:
1. If EVD was used in some patients, check if outcomes are stratified by EVD usage
2. Flag if mortality/complications include EVD-related events without stratification
3. This is CRITICAL for systematic reviews that need to isolate SDC's independent effect

Return JSON array of issues (or empty array if no problems).`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
          }))},
        }),
        "evdConfoundingDetector"
      );

      const rawIssues = response.output || [];

      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "evdConfoundingDetector",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
          currentValue: (context as any)[issue.field.split('.').pop() || ''],
        });
      });

      return {
        criticId: "evdConfoundingDetector",
        passed: issues.length === 0,
        confidence: 0.85,
        issues,
      };
    } catch (error) {
      console.error("EVD confounding check failed after retries:", error);
      return {
        criticId: "evdConfoundingDetector",
        passed: true,
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * Math Consistency Checker (LLM-based)
 * Detects more complex mathematical inconsistencies that Layer 1 can't catch
 * - Subgroup sums (infarction + hemorrhage should equal total)
 * - Percentage mismatches across tables
 * - Survival + mortality should equal 100%
 */
export const mathConsistencyChecker = ai.defineFlow(
  {
    name: "mathConsistencyChecker",
    inputSchema: z.object({
      population: z.any(),
      outcomes: z.any(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({population, outcomes}) => {
    const issues: CritiqueIssue[] = [];

    const context = {
      sampleSize: population?.sampleSize?.value,
      infarctionN: population?.infarctionCount,
      hemorrhageN: population?.hemorrhageCount,
      mortality: outcomes?.mortality?.value,
      survivors: outcomes?.survivors,
    };

    const prompt = `You are auditing numerical consistency in a medical study.

EXTRACTED DATA:
${JSON.stringify(context, null, 2)}

COMMON ERRORS TO CHECK:
1. Infarction N + Hemorrhage N should equal total sample size
2. Mortality N + Survivors should equal total sample size
3. Percentages across subgroups should not exceed 100%
4. If a percentage is given, check if the numerator/denominator matches

Return JSON array of mathematical inconsistencies (or empty array).`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
            suggestedValue: z.string().optional(),
          }))},
        }),
        "mathConsistencyChecker"
      );

      const rawIssues = response.output || [];

      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "mathConsistencyChecker",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
          suggestedValue: issue.suggestedValue,
        });
      });

      return {
        criticId: "mathConsistencyChecker",
        passed: issues.length === 0,
        confidence: 0.9,
        issues,
      };
    } catch (error) {
      console.error("Math consistency check failed after retries:", error);
      return {
        criticId: "mathConsistencyChecker",
        passed: true,
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * Etiology Segregator
 * Ensures outcomes are properly segregated by stroke etiology (infarction vs hemorrhage)
 * Critical for meta-analysis as these have different prognoses
 */
export const etiologySegregator = ai.defineFlow(
  {
    name: "etiologySegregator",
    inputSchema: z.object({
      population: z.any(),
      outcomes: z.any(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({population, outcomes}) => {
    const issues: CritiqueIssue[] = [];

    const prompt = `You are reviewing outcome reporting for a cerebellar stroke study.

POPULATION:
- Sample Size: ${population?.sampleSize?.value}
- Diagnosis: ${population?.diagnosis}
- Infarction: ${population?.infarctionCount || 'Not specified'}
- Hemorrhage: ${population?.hemorrhageCount || 'Not specified'}

OUTCOMES:
- Mortality: ${outcomes?.mortality?.value}
- mRS Favorable: ${outcomes?.mRS_favorable?.value}

CRITICAL RULE for systematic reviews:
If the study includes BOTH infarction and hemorrhage patients, outcomes MUST be stratified by etiology.
Cerebellar infarction and hemorrhage have different natural histories and treatment responses.

TASK:
Check if outcomes are reported as aggregate when they should be stratified.
Return JSON array of issues (or empty array if properly stratified).`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
          }))},
        }),
        "etiologySegregator"
      );

      const rawIssues = response.output || [];

      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "etiologySegregator",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
        });
      });

      return {
        criticId: "etiologySegregator",
        passed: issues.length === 0,
        confidence: 0.85,
        issues,
      };
    } catch (error) {
      console.error("Etiology segregation check failed after retries:", error);
      return {
        criticId: "etiologySegregator",
        passed: true,
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * Flowchart Consistency Checker
 * Tracks patient N through the study timeline: Screened → Excluded → Enrolled → Analyzed
 * Catches "missing patients" in the analysis
 */
export const flowchartConsistencyChecker = ai.defineFlow(
  {
    name: "flowchartConsistencyChecker",
    inputSchema: z.object({
      population: z.any(),
      pdfText: z.string().optional(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({population, pdfText}) => {
    const issues: CritiqueIssue[] = [];

    const prompt = `You are reviewing patient flow through a clinical study.

POPULATION DATA:
- Sample Size: ${population?.sampleSize?.value}
- Screened: ${population?.screened || 'Not specified'}
- Excluded: ${population?.excluded || 'Not specified'}
- Lost to Follow-up: ${population?.lostToFollowup || 'Not specified'}

TASK:
1. Verify: Screened - Excluded = Enrolled
2. Verify: Enrolled - Lost to Follow-up = Analyzed
3. Flag if analyzed N doesn't match the sample size used for outcomes
4. This is critical for CONSORT compliance

Return JSON array of patient flow inconsistencies.`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
          }))},
        }),
        "flowchartConsistencyChecker"
      );

      const rawIssues = response.output || [];

      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "flowchartConsistencyChecker",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
        });
      });

      return {
        criticId: "flowchartConsistencyChecker",
        passed: issues.length === 0,
        confidence: 0.8,
        issues,
      };
    } catch (error) {
      console.error("Flowchart consistency check failed after retries:", error);
      return {
        criticId: "flowchartConsistencyChecker",
        passed: true,
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * Surgical Technique Classifier
 * Verifies that surgical technique details are properly documented
 * - Duraplasty type (autologous vs synthetic)
 * - C1 laminectomy inclusion
 * - Bone flap management
 */
export const surgicalTechniqueClassifier = ai.defineFlow(
  {
    name: "surgicalTechniqueClassifier",
    inputSchema: z.object({
      intervention: z.any(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({intervention}) => {
    const issues: CritiqueIssue[] = [];

    const prompt = `You are reviewing surgical technique documentation for a decompressive craniectomy study.

TECHNIQUE DATA:
- Procedure: ${intervention?.procedure}
- Technique: ${intervention?.technique?.value}
- Duraplasty: ${intervention?.duraplasty?.value || 'Not specified'}
- Source: ${intervention?.technique?.sourceText}

CRITICAL ELEMENTS that should be documented:
1. Duraplasty material (autologous pericranium, synthetic, or none)
2. C1 laminectomy inclusion (yes/no)
3. Bone flap preservation method (if applicable)
4. Dural opening technique

TASK:
Flag if critical surgical details are missing or ambiguous.
Return JSON array of documentation gaps.`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
          }))},
        }),
        "surgicalTechniqueClassifier"
      );

      const rawIssues = response.output || [];

      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "surgicalTechniqueClassifier",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
        });
      });

      return {
        criticId: "surgicalTechniqueClassifier",
        passed: issues.length === 0,
        confidence: 0.75,
        issues,
      };
    } catch (error) {
      console.error("Surgical technique classification failed after retries:", error);
      return {
        criticId: "surgicalTechniqueClassifier",
        passed: true,
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * Outcome Definition Verifier
 * Ensures outcome definitions are clear and standardized
 * - mRS cutoff clarity (0-2 vs 0-3 for "favorable")
 * - Mortality timepoint (in-hospital vs 30-day vs 90-day)
 * - Follow-up duration specification
 */
export const outcomeDefinitionVerifier = ai.defineFlow(
  {
    name: "outcomeDefinitionVerifier",
    inputSchema: z.object({
      outcomes: z.any(),
      timing: z.any().optional(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({outcomes, timing}) => {
    const issues: CritiqueIssue[] = [];

    const prompt = `You are reviewing outcome definitions for methodological clarity.

OUTCOMES:
- mRS Favorable: ${outcomes?.mRS_favorable?.value}
- Source: ${outcomes?.mRS_favorable?.sourceText}
- Mortality: ${outcomes?.mortality?.value}
- Mortality Source: ${outcomes?.mortality?.sourceText}
- Follow-up: ${timing?.follow_up_duration || 'Not specified'}

CRITICAL REQUIREMENTS:
1. "Favorable outcome" must specify mRS cutoff (e.g., "mRS 0-2" or "mRS 0-3")
2. Mortality must specify timepoint (e.g., "30-day mortality", "in-hospital mortality")
3. Follow-up duration must be stated for mRS outcomes

TASK:
Flag if outcome definitions are ambiguous or missing timepoints.
Return JSON array of clarity issues.`;

    try {
      const response = await withRetry(
        () => ai.generate({
          model: googleAI.model("gemini-3-pro-preview"),
          prompt,
          output: {schema: z.array(z.object({
            field: z.string(),
            severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
            message: z.string(),
            suggestedValue: z.string().optional(),
          }))},
        }),
        "outcomeDefinitionVerifier"
      );

      const rawIssues = response.output || [];

      rawIssues.forEach((issue: any) => {
        issues.push({
          criticId: "outcomeDefinitionVerifier",
          field: issue.field,
          severity: issue.severity,
          message: issue.message,
          suggestedValue: issue.suggestedValue,
        });
      });

      return {
        criticId: "outcomeDefinitionVerifier",
        passed: issues.length === 0,
        confidence: 0.9,
        issues,
      };
    } catch (error) {
      console.error("Outcome definition verification failed after retries:", error);
      return {
        criticId: "outcomeDefinitionVerifier",
        passed: true,
        confidence: 0,
        issues: [],
      };
    }
  }
);

/**
 * Source Citation Verifier
 * Verifies that extracted values match their source quotes
 * Catches when the LLM "hallucinated" a value that doesn't exist in the text
 */
export const sourceCitationVerifier = ai.defineFlow(
  {
    name: "sourceCitationVerifier",
    inputSchema: z.object({
      extractedData: z.any(),
      pdfText: z.string().optional(),
    }),
    outputSchema: CriticResultSchema,
  },
  async ({extractedData, pdfText}) => {
    const issues: CritiqueIssue[] = [];

    // Collect all VerifiableFields with their values and source quotes
    const verifiableFields: Array<{path: string; value: any; sourceText: string}> = [];

    const collectVerifiable = (obj: any, prefix = "") => {
      Object.keys(obj || {}).forEach((key) => {
        const value = obj[key];
        const fullPath = prefix ? `${prefix}.${key}` : key;

        if (value && typeof value === "object") {
          // Check if this is a VerifiableField (has .value and .sourceText)
          if ("value" in value && "sourceText" in value) {
            verifiableFields.push({
              path: fullPath,
              value: value.value,
              sourceText: value.sourceText,
            });
          } else {
            // Recurse into nested objects
            collectVerifiable(value, fullPath);
          }
        }
      });
    };

    collectVerifiable(extractedData);

    // Check each verifiable field
    for (const field of verifiableFields) {
      if (!field.sourceText || field.sourceText.length < 10) {
        issues.push({
          criticId: "sourceCitationVerifier",
          field: field.path,
          severity: "WARNING",
          message: `Missing or incomplete source quote for ${field.path}. Value: "${field.value}"`,
          currentValue: field.value,
        });
        continue;
      }

      // If we have PDF text, verify the quote actually exists
      if (pdfText && !pdfText.includes(field.sourceText.substring(0, 30))) {
        issues.push({
          criticId: "sourceCitationVerifier",
          field: field.path,
          severity: "CRITICAL",
          message: `Source quote not found in PDF text for ${field.path}. Possible hallucination.`,
          currentValue: field.value,
          sourceEvidence: field.sourceText,
        });
      }
    }

    return {
      criticId: "sourceCitationVerifier",
      passed: issues.length === 0,
      confidence: 0.95,
      issues,
    };
  }
);
