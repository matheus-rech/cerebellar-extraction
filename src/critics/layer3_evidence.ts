// Layer 3 Critics: Evidence Verification (Heavy LLM + Context, moderate cost)
// These critics perform deep verification against the original PDF text

import {CritiqueIssue} from "./schemas";

/**
 * Evidence Anchoring Checker
 * Verifies that all VerifiableFields have proper source quotes
 * This is the minimum requirement for trustworthy extraction
 */
export function evidenceAnchoringChecker(data: any): {
  evidenceAnchored: boolean;
  missingSourceFields: string[];
  issues: CritiqueIssue[];
} {
  const missingSourceFields: string[] = [];
  const issues: CritiqueIssue[] = [];

  // List of critical VerifiableFields that MUST have source quotes
  const criticalFields = [
    "population.age.mean",
    "population.age.sd",
    "intervention.technique",
    "intervention.evdUsed",
    "intervention.duraplasty",
    "outcomes.mortality",
    "outcomes.mRS_favorable",
    "outcomes.lengthOfStay",
    "outcomes.complications",
  ];

  // Helper to get nested value
  const getNestedValue = (obj: any, path: string): any => {
    const keys = path.split(".");
    let current = obj;
    for (const key of keys) {
      current = current?.[key];
      if (current === undefined) return undefined;
    }
    return current;
  };

  criticalFields.forEach((fieldPath) => {
    const field = getNestedValue(data, fieldPath);

    if (field && typeof field === "object" && "value" in field) {
      // This is a VerifiableField
      const sourceText = field.sourceText;

      if (!sourceText || sourceText.length < 10) {
        missingSourceFields.push(fieldPath);
        issues.push({
          criticId: "evidenceAnchoringChecker",
          field: fieldPath,
          severity: "WARNING",
          message: `Missing source quote for critical field: ${fieldPath}`,
          currentValue: field.value,
        });
      }
    } else if (field !== undefined && field !== null && field !== "") {
      // Field has a value but is not a VerifiableField
      issues.push({
        criticId: "evidenceAnchoringChecker",
        field: fieldPath,
        severity: "INFO",
        message: `Field ${fieldPath} is not using VerifiableField pattern (no source quote)`,
        currentValue: field,
      });
    }
  });

  const evidenceAnchored = missingSourceFields.length <= 2; // Allow up to 2 missing sources

  return {
    evidenceAnchored,
    missingSourceFields,
    issues,
  };
}

/**
 * Hallucination Hunter
 * Verifies that extracted numbers actually exist in the PDF text
 * Catches LLM "hallucinations" where values are made up
 *
 * This is a simplified version. A full implementation would use fuzzy matching
 * and allow for OCR errors, but this catches the most egregious hallucinations.
 */
export function hallucinationHunter(data: any, pdfText: string): CritiqueIssue[] {
  if (!pdfText) return []; // Can't check without PDF text

  const issues: CritiqueIssue[] = [];

  // Helper to extract numeric values from VerifiableFields
  const checkNumericField = (fieldPath: string, field: any) => {
    if (!field || typeof field !== "object" || !("value" in field)) return;

    const value = field.value;
    const sourceText = field.sourceText;

    // Extract numbers from the value
    const numbers = value?.toString().match(/\d+\.?\d*/g);
    if (!numbers || numbers.length === 0) return;

    // Check if these numbers appear in the source quote
    numbers.forEach((num: string) => {
      if (sourceText && !sourceText.includes(num)) {
        issues.push({
          criticId: "hallucinationHunter",
          field: fieldPath,
          severity: "CRITICAL",
          message: `Potential hallucination: Value "${num}" from ${fieldPath} not found in source quote`,
          currentValue: value,
          sourceEvidence: sourceText,
        });
      }
    });

    // Also check if the source quote exists in the PDF text
    if (sourceText && sourceText.length > 20) {
      // Use a substring to account for minor OCR variations
      const snippet = sourceText.substring(0, 30);
      if (!pdfText.includes(snippet)) {
        issues.push({
          criticId: "hallucinationHunter",
          field: fieldPath,
          severity: "WARNING",
          message: `Source quote for ${fieldPath} not found in PDF text (possible OCR mismatch)`,
          sourceEvidence: snippet,
        });
      }
    }
  };

  // Check all numeric fields
  const numericFields = [
    "population.sampleSize",
    "population.age.mean",
    "population.age.sd",
    "outcomes.mortality",
    "outcomes.mRS_favorable",
    "outcomes.lengthOfStay",
  ];

  numericFields.forEach((fieldPath) => {
    const keys = fieldPath.split(".");
    let current = data;
    for (const key of keys) {
      current = current?.[key];
    }
    checkNumericField(fieldPath, current);
  });

  return issues;
}

/**
 * Criteria Auditor
 * Verifies that the study meets inclusion criteria for SDC systematic reviews
 * - Must involve cerebellar pathology
 * - Must involve decompressive surgery
 * - Must report clinical outcomes (not just imaging)
 */
export function criteriaAuditor(data: any): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];

  // 1. Check for cerebellar involvement
  const diagnosis = data.population?.diagnosis?.toLowerCase() || "";
  if (!diagnosis.includes("cerebellar") && !diagnosis.includes("cerebellum")) {
    issues.push({
      criticId: "criteriaAuditor",
      field: "population.diagnosis",
      severity: "CRITICAL",
      message: "Study does not clearly involve cerebellar pathology",
      currentValue: data.population?.diagnosis,
    });
  }

  // 2. Check for decompressive surgery
  const procedure = data.intervention?.procedure?.toLowerCase() || "";
  const technique = data.intervention?.technique?.value?.toLowerCase() || "";
  const hasDecompression =
    procedure.includes("decompres") ||
    procedure.includes("craniectomy") ||
    technique.includes("decompres") ||
    technique.includes("craniectomy");

  if (!hasDecompression) {
    issues.push({
      criticId: "criteriaAuditor",
      field: "intervention.procedure",
      severity: "CRITICAL",
      message: "Study does not clearly involve decompressive surgery",
      currentValue: data.intervention?.procedure,
    });
  }

  // 3. Check for clinical outcomes (must have mortality OR mRS OR complications)
  const hasClinicalOutcomes =
    data.outcomes?.mortality?.value ||
    data.outcomes?.mRS_favorable?.value ||
    data.outcomes?.complications?.value;

  if (!hasClinicalOutcomes) {
    issues.push({
      criticId: "criteriaAuditor",
      field: "outcomes",
      severity: "CRITICAL",
      message: "Study does not report clinical outcomes (mortality, mRS, or complications)",
      currentValue: null,
    });
  }

  // 4. Check for sample size (must have at least 5 patients for case series)
  const sampleSize = parseInt(data.population?.sampleSize?.value || data.population?.sample_size || "0");
  if (sampleSize < 5) {
    issues.push({
      criticId: "criteriaAuditor",
      field: "population.sampleSize",
      severity: "WARNING",
      message: `Small sample size (n=${sampleSize}). Consider excluding from meta-analysis if n<10.`,
      currentValue: sampleSize,
    });
  }

  return issues;
}

/**
 * Layer 3 Main Function
 * Runs all evidence verification critics and returns aggregated results
 */
export function runLayer3Critics(
  data: any,
  pdfText?: string
): {
  evidenceAnchored: boolean;
  missingSourceFields: string[];
  allIssues: CritiqueIssue[];
} {
  const allIssues: CritiqueIssue[] = [];

  // 1. Evidence Anchoring (critical)
  const anchoringResult = evidenceAnchoringChecker(data);
  allIssues.push(...anchoringResult.issues);

  // 2. Hallucination Hunter (if PDF text available)
  if (pdfText) {
    const hallucinationIssues = hallucinationHunter(data, pdfText);
    allIssues.push(...hallucinationIssues);
  }

  // 3. Criteria Auditor
  const criteriaIssues = criteriaAuditor(data);
  allIssues.push(...criteriaIssues);

  return {
    evidenceAnchored: anchoringResult.evidenceAnchored,
    missingSourceFields: anchoringResult.missingSourceFields,
    allIssues,
  };
}
