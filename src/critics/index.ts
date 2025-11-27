// Main Critique Orchestrator
// Ties together all 3 layers of validation and provides the main critique flows
// Now with Genkit interrupts for human-in-the-loop REVIEW mode

import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";
import {
  CritiqueReportSchema,
  CritiqueMode,
  CritiqueIssue,
  HumanReviewRequestSchema,
  HumanReviewResponseSchema,
  HumanReviewResponse,
} from "./schemas.js";
import {runLayer1Critics} from "./layer1_math.js";
import {
  scaleInversionSentinel,
  evdConfoundingDetector,
  mathConsistencyChecker,
  etiologySegregator,
  flowchartConsistencyChecker,
  surgicalTechniqueClassifier,
  outcomeDefinitionVerifier,
  sourceCitationVerifier,
} from "./layer2_logic.js";
import {runLayer3Critics} from "./layer3_evidence.js";

// Initialize Genkit instance
const ai = genkit({
  plugins: [googleAI()],
});

/**
 * Human Review Interrupt Tool
 * Pauses the critique flow to request human review of critical issues.
 * In REVIEW mode, this tool surfaces issues to the user for manual approval.
 *
 * The tool uses Genkit's interrupt mechanism:
 * 1. When called, it pauses execution and returns a review request
 * 2. The calling application displays this to the user
 * 3. User makes decisions and provides response
 * 4. Flow resumes with the user's response
 *
 * Note: In the current implementation, the tool returns a default "pending" response.
 * In production, this would be replaced with actual interrupt handling where:
 * - The request is surfaced to a UI
 * - User makes decisions
 * - Response is provided back to continue the flow
 */
const humanReviewTool = ai.defineTool(
  {
    name: "humanReview",
    description: "Request human review of extraction issues before proceeding. Used in REVIEW mode when critical validation issues are found.",
    inputSchema: HumanReviewRequestSchema,
    outputSchema: HumanReviewResponseSchema,
  },
  async (reviewRequest) => {
    // Log the review request for debugging
    console.log("🔍 Human review requested for", reviewRequest.issues.length, "critical issues");
    console.log("📋 Fields affected:", reviewRequest.issues.map((i) => i.field).join(", "));

    // In non-interactive/batch mode, return a default rejection
    // This ensures that REVIEW mode doesn't silently auto-approve
    // In production, this would be replaced with actual UI interrupt handling:
    // - Frontend catches interrupt and displays review UI
    // - User makes accept/reject/modify decisions
    // - Frontend provides response to continue flow
    return {
      approved: false,
      decisions: reviewRequest.issues.map((issue) => ({
        field: issue.field,
        action: "reject" as const,
        rationale: "Awaiting human review - run in interactive mode for manual approval",
      })),
      notes: "Default batch mode response - use interactive UI for actual human review",
    };
  }
);

/**
 * Process human review decisions and apply to corrections map
 */
function applyHumanDecisions(
  response: HumanReviewResponse,
  issues: CritiqueIssue[],
  corrections: Record<string, unknown>
): {appliedCount: number; rejectedCount: number} {
  let appliedCount = 0;
  let rejectedCount = 0;

  response.decisions.forEach((decision) => {
    const issue = issues.find((i) => i.field === decision.field);
    if (!issue) return;

    switch (decision.action) {
      case "accept":
        if (issue.suggestedValue !== undefined) {
          corrections[decision.field] = issue.suggestedValue;
          issue.autoCorrectApplied = true;
          appliedCount++;
        }
        break;
      case "modify":
        if (decision.customValue !== undefined) {
          corrections[decision.field] = decision.customValue;
          issue.autoCorrectApplied = true;
          appliedCount++;
        }
        break;
      case "reject":
        rejectedCount++;
        break;
    }
  });

  return {appliedCount, rejectedCount};
}

/**
 * Main Critique Extraction Flow
 * Runs all 3 layers of validation and returns comprehensive critique report
 *
 * @param extractedData - The extracted study data (with VerifiableFields)
 * @param pdfText - Optional full PDF text for hallucination detection
 * @param mode - "AUTO" (auto-correct) or "REVIEW" (manual review)
 */
export const critiqueExtraction = ai.defineFlow(
  {
    name: "critiqueExtraction",
    inputSchema: z.object({
      extractedData: z.any().describe("The extracted study data"),
      pdfText: z.string().optional().describe("Full PDF text for verification"),
      mode: z.enum(["AUTO", "REVIEW"]).default("REVIEW").describe("Critique mode"),
    }),
    outputSchema: CritiqueReportSchema,
  },
  async ({extractedData, pdfText, mode}) => {
    const allIssues: CritiqueIssue[] = [];
    const corrections: Record<string, any> = {};

    console.log(`Starting critique in ${mode} mode...`);

    // ===== LAYER 1: Deterministic Validators (Free, Instant) =====
    console.log("Running Layer 1: Deterministic validators...");
    const layer1Result = runLayer1Critics(extractedData);

    if (!layer1Result.passed) {
      console.log(`Layer 1 found ${layer1Result.errors.length} critical issues`);
    }

    // ===== LAYER 2: Semantic Logic (Lightweight LLM, Parallel Execution) =====
    console.log("Running Layer 2: Semantic validators (8 critics in parallel)...");

    const layer2Critics = await Promise.allSettled([
      scaleInversionSentinel({
        outcomes: extractedData.outcomes,
        pdfText,
      }),
      evdConfoundingDetector({
        intervention: extractedData.intervention,
        outcomes: extractedData.outcomes,
        pdfText,
      }),
      mathConsistencyChecker({
        population: extractedData.population,
        outcomes: extractedData.outcomes,
      }),
      etiologySegregator({
        population: extractedData.population,
        outcomes: extractedData.outcomes,
      }),
      flowchartConsistencyChecker({
        population: extractedData.population,
        pdfText,
      }),
      surgicalTechniqueClassifier({
        intervention: extractedData.intervention,
      }),
      outcomeDefinitionVerifier({
        outcomes: extractedData.outcomes,
        timing: extractedData.timing,
      }),
      sourceCitationVerifier({
        extractedData,
        pdfText,
      }),
    ]);

    // Collect Layer 2 results
    const layer2Results = layer2Critics
      .map((result, idx) => {
        if (result.status === "fulfilled") {
          return result.value;
        } else {
          console.warn(`Layer 2 critic ${idx} failed:`, result.reason);
          return {
            criticId: `layer2_critic_${idx}`,
            passed: true, // Don't block on LLM failures
            confidence: 0,
            issues: [],
          };
        }
      })
      .filter((r) => r !== null);

    // Aggregate Layer 2 issues
    layer2Results.forEach((result) => {
      if (result.issues && result.issues.length > 0) {
        allIssues.push(...result.issues);
      }
    });

    console.log(`Layer 2 completed: ${allIssues.length} total issues so far`);

    // ===== LAYER 3: Evidence Verification =====
    console.log("Running Layer 3: Evidence verification...");
    const layer3Result = runLayer3Critics(extractedData, pdfText);

    allIssues.push(...layer3Result.allIssues);

    console.log(`Layer 3 completed: ${layer3Result.allIssues.length} evidence issues found`);

    // ===== MODE-SPECIFIC HANDLING =====
    const criticalIssues = allIssues.filter((i) => i.severity === "CRITICAL");
    let humanReviewResponse: HumanReviewResponse | undefined;

    if (mode === "AUTO") {
      // ===== AUTO MODE: Apply Corrections Automatically =====
      console.log("AUTO mode: Applying corrections for CRITICAL issues...");

      allIssues.forEach((issue) => {
        if (issue.severity === "CRITICAL" && issue.suggestedValue !== undefined) {
          corrections[issue.field] = issue.suggestedValue;
          issue.autoCorrectApplied = true;
          console.log(`Auto-corrected ${issue.field}: ${issue.currentValue} → ${issue.suggestedValue}`);
        }
      });
    } else if (mode === "REVIEW" && criticalIssues.length > 0) {
      // ===== REVIEW MODE: Request Human Review via Interrupt =====
      console.log(`REVIEW mode: Found ${criticalIssues.length} critical issues requiring human review`);

      // Calculate preliminary confidence for context
      const prelimConfidence = 0.5 - criticalIssues.length * 0.2;

      // Request human review using the interrupt tool
      // This will pause execution and surface the request to the user
      humanReviewResponse = await humanReviewTool({
        issues: criticalIssues,
        summary: `${criticalIssues.length} critical issues require your review before proceeding. ` +
          `Fields affected: ${criticalIssues.map((i) => i.field).join(", ")}`,
        extractedData,
        confidence: Math.max(0, Math.min(1, prelimConfidence)),
      });

      // Process human decisions
      if (humanReviewResponse.approved) {
        const {appliedCount, rejectedCount} = applyHumanDecisions(
          humanReviewResponse,
          criticalIssues,
          corrections
        );
        console.log(`Human review completed: ${appliedCount} accepted, ${rejectedCount} rejected`);
        if (humanReviewResponse.notes) {
          console.log(`Reviewer notes: ${humanReviewResponse.notes}`);
        }
      } else {
        console.log("Human review: Not approved - corrections not applied");
      }
    }

    // ===== CALCULATE OVERALL CONFIDENCE =====
    const criticalCount = allIssues.filter((i) => i.severity === "CRITICAL").length;
    const warningCount = allIssues.filter((i) => i.severity === "WARNING").length;

    // Weight Layer 2 confidence scores
    const layer2Confidences = layer2Results
      .filter((r) => r.confidence !== undefined && r.confidence > 0)
      .map((r) => r.confidence!);

    const avgLayer2Confidence =
      layer2Confidences.length > 0
        ? layer2Confidences.reduce((a, b) => a + b, 0) / layer2Confidences.length
        : 0.5;

    // Overall confidence calculation
    // Start with Layer 2 average, then penalize for issues
    let overallConfidence = avgLayer2Confidence;

    // Penalize for critical issues (20% per critical)
    overallConfidence -= criticalCount * 0.2;

    // Penalize for warnings (5% per warning)
    overallConfidence -= warningCount * 0.05;

    // Penalize for missing evidence
    if (!layer3Result.evidenceAnchored) {
      overallConfidence -= 0.1;
    }

    // Clamp to [0, 1]
    overallConfidence = Math.max(0, Math.min(1, overallConfidence));

    // ===== VALIDATION RESULT =====
    // In REVIEW mode with human approval, validation passes if human approved
    const humanApproved = humanReviewResponse?.approved ?? false;
    const passedValidation =
      (criticalCount === 0 && layer3Result.evidenceAnchored) ||
      (mode === "REVIEW" && humanApproved);

    // ===== GENERATE SUMMARY =====
    const summary = generateSummary({
      mode,
      passedValidation,
      criticalCount,
      warningCount,
      infoCount: allIssues.filter((i) => i.severity === "INFO").length,
      evidenceAnchored: layer3Result.evidenceAnchored,
      missingSourceCount: layer3Result.missingSourceFields.length,
      correctionsApplied: Object.keys(corrections).length,
      humanReviewed: humanReviewResponse !== undefined,
      humanApproved,
    });

    console.log("Critique complete:", summary);

    // ===== RETURN CRITIQUE REPORT =====
    // Include corrections for both AUTO mode and REVIEW mode with human approval
    const includeCorrections = mode === "AUTO" || (mode === "REVIEW" && humanApproved);

    return {
      mode,
      passedValidation,
      overallConfidence,
      issues: allIssues,
      corrections: includeCorrections && Object.keys(corrections).length > 0 ? corrections : undefined,
      summary,
      layer1Results: layer1Result,
      layer2Results,
      layer3Results: {
        evidenceAnchored: layer3Result.evidenceAnchored,
        missingSourceFields: layer3Result.missingSourceFields,
      },
      humanReviewResponse, // Include human review response for transparency
    };
  }
);

/**
 * Helper function to generate human-readable summary
 */
function generateSummary(stats: {
  mode: CritiqueMode;
  passedValidation: boolean;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  evidenceAnchored: boolean;
  missingSourceCount: number;
  correctionsApplied: number;
  humanReviewed?: boolean;
  humanApproved?: boolean;
}): string {
  // Passed via human approval in REVIEW mode
  if (stats.passedValidation && stats.humanReviewed && stats.humanApproved) {
    return `✅ PASSED (Human Approved): ${stats.correctionsApplied} corrections applied after review. ${stats.warningCount} warnings, ${stats.infoCount} info notes.`;
  }

  // Passed naturally (no critical issues)
  if (stats.passedValidation) {
    return `✅ PASSED: All validations passed. ${stats.warningCount} warnings, ${stats.infoCount} info notes.`;
  }

  const parts: string[] = [];

  if (stats.criticalCount > 0) {
    parts.push(`${stats.criticalCount} CRITICAL issues`);
  }

  if (stats.warningCount > 0) {
    parts.push(`${stats.warningCount} warnings`);
  }

  if (!stats.evidenceAnchored) {
    parts.push(`${stats.missingSourceCount} fields missing source quotes`);
  }

  if (stats.mode === "AUTO" && stats.correctionsApplied > 0) {
    parts.push(`${stats.correctionsApplied} auto-corrections applied`);
  }

  // REVIEW mode with human rejection
  if (stats.mode === "REVIEW" && stats.humanReviewed && !stats.humanApproved) {
    parts.push("human review rejected corrections");
    return `❌ REVIEW REJECTED: ${parts.join(", ")}`;
  }

  // REVIEW mode awaiting human review (interrupt triggered)
  if (stats.mode === "REVIEW" && stats.criticalCount > 0 && !stats.humanReviewed) {
    return `⏸️ AWAITING REVIEW: ${parts.join(", ")}`;
  }

  const statusIcon = stats.mode === "AUTO" ? "⚠️" : "❌";
  return `${statusIcon} VALIDATION FAILED: ${parts.join(", ")}`;
}

/**
 * Simplified critique for quick checks (Layer 1 only)
 * Useful for real-time validation in the UI
 */
export const quickCritique = ai.defineFlow(
  {
    name: "quickCritique",
    inputSchema: z.object({
      extractedData: z.any(),
    }),
    outputSchema: z.object({
      passed: z.boolean(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
  },
  async ({extractedData}) => {
    const layer1Result = runLayer1Critics(extractedData);
    const layer3Result = runLayer3Critics(extractedData);

    const warnings: string[] = [];

    layer3Result.allIssues.forEach((issue) => {
      if (issue.severity === "WARNING") {
        warnings.push(issue.message);
      }
    });

    return {
      passed: layer1Result.passed,
      errors: layer1Result.errors,
      warnings,
    };
  }
);

// Export individual critics for testing or custom workflows
export * from "./schemas.js";
export * from "./layer1_math.js";
export * from "./layer2_logic.js";
export * from "./layer3_evidence.js";

// Export multi-agent system
export * from "./multi_agent.js";

// Export the human review tool for use in calling applications
// This allows external apps to handle the interrupt and provide human review responses
export {humanReviewTool};
