// Shared Zod schemas for the 3-Layer Critique System
// These schemas standardize the format for critique results across all layers

import {z} from "genkit";

/**
 * Critique Issue Schema
 * Represents a single validation issue found during critique
 */
export const CritiqueIssueSchema = z.object({
  criticId: z.string().describe("Identifier of the critic that found this issue (e.g., 'arithmeticCritic')"),
  field: z.string().describe("JSON path of the field involved (e.g., 'outcomes.mortality')"),
  severity: z.enum(["CRITICAL", "WARNING", "INFO"]).describe("Issue severity level"),
  message: z.string().describe("Human-readable description of the issue"),
  currentValue: z.unknown().optional().describe("The current (potentially incorrect) value"),
  suggestedValue: z.unknown().optional().describe("Suggested correction if available"),
  sourceEvidence: z.string().optional().describe("Direct quote from PDF that relates to this issue"),
  autoCorrectApplied: z.boolean().optional().describe("Whether AUTO mode applied the correction"),
});

/**
 * Layer-specific Result Schema
 * Used by individual critics to report their findings
 */
export const CriticResultSchema = z.object({
  criticId: z.string(),
  passed: z.boolean().describe("Whether this critic found no issues"),
  confidence: z.number().min(0).max(1).optional().describe("Confidence in the validation (0-1)"),
  issues: z.array(CritiqueIssueSchema).default([]),
});

/**
 * Human Review Decision Schema
 * Used in REVIEW mode interrupts for human-in-the-loop validation
 */
export const HumanReviewDecisionSchema = z.object({
  field: z.string().describe("The field being reviewed"),
  action: z.enum(["accept", "reject", "modify"]).describe(
    "accept: Apply suggested value\n" +
    "reject: Keep current value\n" +
    "modify: Apply custom value"
  ),
  customValue: z.unknown().optional().describe("Custom value if action is 'modify'"),
  rationale: z.string().optional().describe("Optional explanation for the decision"),
});

/**
 * Human Review Request Schema
 * Sent to the human reviewer during REVIEW mode interrupt
 */
export const HumanReviewRequestSchema = z.object({
  issues: z.array(CritiqueIssueSchema).describe("Critical issues requiring review"),
  summary: z.string().describe("Summary of what needs review"),
  extractedData: z.unknown().describe("Current extracted data for context"),
  confidence: z.number().describe("Overall confidence before human review"),
});

/**
 * Human Review Response Schema
 * Returned by human reviewer to resume the flow
 */
export const HumanReviewResponseSchema = z.object({
  approved: z.boolean().describe("Whether the reviewer approved proceeding"),
  decisions: z.array(HumanReviewDecisionSchema).describe("Decisions for each critical issue"),
  notes: z.string().optional().describe("Optional notes from reviewer"),
});

/**
 * Complete Critique Report Schema
 * Aggregates results from all layers
 */
export const CritiqueReportSchema = z.object({
  mode: z.enum(["AUTO", "REVIEW"]).describe("Critique mode: AUTO (auto-correct) or REVIEW (manual review)"),
  passedValidation: z.boolean().describe("Overall validation result"),
  overallConfidence: z.number().min(0).max(1).describe("Weighted average confidence across all critics"),
  issues: z.array(CritiqueIssueSchema).describe("All issues found across all layers"),
  corrections: z.record(z.unknown()).optional().describe("Applied corrections (field path -> new value)"),
  summary: z.string().describe("Human-readable summary of critique results"),

  // Layer-specific results for detailed analysis
  layer1Results: z.object({
    passed: z.boolean(),
    errors: z.array(z.string()),
  }),
  layer2Results: z.array(CriticResultSchema),
  layer3Results: z.object({
    evidenceAnchored: z.boolean().describe("Whether all VerifiableFields have source quotes"),
    missingSourceFields: z.array(z.string()),
  }),

  // Human review response (only present in REVIEW mode when interrupt was triggered)
  humanReviewResponse: HumanReviewResponseSchema.optional().describe(
    "Human reviewer response from REVIEW mode interrupt"
  ),
});

/**
 * Critique Mode Configuration
 */
export const CritiqueModeSchema = z.enum(["AUTO", "REVIEW"]).describe(
  "AUTO: Auto-correct CRITICAL issues and continue processing\n" +
  "REVIEW: Block saving if validation fails, provide suggestions for manual review"
);

export type CritiqueIssue = z.infer<typeof CritiqueIssueSchema>;
export type CriticResult = z.infer<typeof CriticResultSchema>;
export type CritiqueReport = z.infer<typeof CritiqueReportSchema>;
export type CritiqueMode = z.infer<typeof CritiqueModeSchema>;
export type HumanReviewDecision = z.infer<typeof HumanReviewDecisionSchema>;
export type HumanReviewRequest = z.infer<typeof HumanReviewRequestSchema>;
export type HumanReviewResponse = z.infer<typeof HumanReviewResponseSchema>;
