/**
 * Newcastle-Ottawa Scale (NOS) Validation Utilities
 *
 * Provides shared validation logic for NOS scores used by:
 * - Genkit evaluators (basic validation)
 * - Internal self-evaluation (detailed with item-level checks)
 */

/**
 * NOS Domain scores (high-level totals)
 */
export interface NosScores {
  selectionScore?: number | null;
  comparabilityScore?: number | null;
  outcomeScore?: number | null;
  totalScore?: number | null;
}

/**
 * NOS Item assessment (individual checklist items)
 */
export interface NosItemAssessment {
  score?: number | null;
  justification?: string | null;
}

/**
 * NOS Domain with individual items (for detailed validation)
 */
export interface NosDomainItems {
  selection?: {
    representativeness?: NosItemAssessment;
    selectionOfNonExposed?: NosItemAssessment;
    ascertainmentOfExposure?: NosItemAssessment;
    outcomeNotPresentAtStart?: NosItemAssessment;
    subtotal?: number;
  };
  comparability?: {
    controlForMostImportant?: NosItemAssessment;
    controlForAdditional?: NosItemAssessment;
    subtotal?: number;
  };
  outcome?: {
    assessmentOfOutcome?: NosItemAssessment;
    followUpLength?: NosItemAssessment;
    adequacyOfFollowUp?: NosItemAssessment;
    subtotal?: number;
  };
}

/**
 * Basic validation result
 */
export interface NosValidationResult {
  isValid: boolean;
  rangeValid: boolean;
  sumMatches: boolean;
  expectedTotal: number;
  actualTotal: number;
  score: number; // 0-1 normalized score
}

/**
 * Detailed validation result (includes item-level checks)
 */
export interface NosDetailedValidationResult extends NosValidationResult {
  itemScoresMatch: boolean;
}

/**
 * Validate NOS scores for basic consistency
 *
 * Checks:
 * - Selection: 0-4
 * - Comparability: 0-2
 * - Outcome: 0-3
 * - Total: should equal sum of above (0-9)
 *
 * @param scores - The NOS domain scores
 * @returns Validation result with score (0.5 for range valid + 0.5 for sum match)
 */
export function validateNosScores(scores: NosScores): NosValidationResult {
  const selection = scores.selectionScore ?? 0;
  const comparability = scores.comparabilityScore ?? 0;
  const outcome = scores.outcomeScore ?? 0;
  const total = scores.totalScore ?? 0;

  // Validate ranges
  const rangeValid =
    selection >= 0 && selection <= 4 &&
    comparability >= 0 && comparability <= 2 &&
    outcome >= 0 && outcome <= 3 &&
    total >= 0 && total <= 9;

  // Validate total equals sum
  const expectedTotal = selection + comparability + outcome;
  const sumMatches = total === expectedTotal;

  const isValid = rangeValid && sumMatches;

  // Score: 0.5 for range valid, 0.5 for sum matches
  let score = 0;
  if (rangeValid) score += 0.5;
  if (sumMatches) score += 0.5;

  return {
    isValid,
    rangeValid,
    sumMatches,
    expectedTotal,
    actualTotal: total,
    score,
  };
}

/**
 * Validate NOS scores with detailed item-level checks
 *
 * Enhanced validation that also verifies:
 * - Individual item scores sum to domain subtotals
 *
 * @param scores - The NOS domain scores
 * @param domains - The NOS domain items (optional)
 * @returns Detailed validation result with score (0.33 each for range, sum, items)
 */
export function validateNosScoresDetailed(
  scores: NosScores,
  domains?: NosDomainItems
): NosDetailedValidationResult {
  const selection = scores.selectionScore ?? 0;
  const comparability = scores.comparabilityScore ?? 0;
  const outcome = scores.outcomeScore ?? 0;
  const total = scores.totalScore ?? 0;

  // Basic validation
  const rangeValid =
    selection >= 0 && selection <= 4 &&
    comparability >= 0 && comparability <= 2 &&
    outcome >= 0 && outcome <= 3 &&
    total >= 0 && total <= 9;

  const expectedTotal = selection + comparability + outcome;
  const sumMatches = total === expectedTotal;

  // Item-level validation (if domains provided)
  let itemScoresMatch = true;

  if (domains) {
    if (domains.selection) {
      const itemSum =
        (domains.selection.representativeness?.score ?? 0) +
        (domains.selection.selectionOfNonExposed?.score ?? 0) +
        (domains.selection.ascertainmentOfExposure?.score ?? 0) +
        (domains.selection.outcomeNotPresentAtStart?.score ?? 0);
      if (domains.selection.subtotal !== undefined && itemSum !== domains.selection.subtotal) {
        itemScoresMatch = false;
      }
    }

    if (domains.comparability) {
      const itemSum =
        (domains.comparability.controlForMostImportant?.score ?? 0) +
        (domains.comparability.controlForAdditional?.score ?? 0);
      if (domains.comparability.subtotal !== undefined && itemSum !== domains.comparability.subtotal) {
        itemScoresMatch = false;
      }
    }

    if (domains.outcome) {
      const itemSum =
        (domains.outcome.assessmentOfOutcome?.score ?? 0) +
        (domains.outcome.followUpLength?.score ?? 0) +
        (domains.outcome.adequacyOfFollowUp?.score ?? 0);
      if (domains.outcome.subtotal !== undefined && itemSum !== domains.outcome.subtotal) {
        itemScoresMatch = false;
      }
    }
  }

  const isValid = rangeValid && sumMatches && itemScoresMatch;

  // Score: 0.33 each for range, sum, items
  let score = 0;
  if (rangeValid) score += 0.33;
  if (sumMatches) score += 0.34;
  if (itemScoresMatch) score += 0.33;

  return {
    isValid,
    rangeValid,
    sumMatches,
    itemScoresMatch,
    expectedTotal,
    actualTotal: total,
    score,
  };
}
