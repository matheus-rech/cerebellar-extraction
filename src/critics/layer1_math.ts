// Layer 1 Critics: Deterministic Validators (Pure TypeScript, $0 cost, instant)
// These critics perform mathematical and logical validation without LLM calls

import {CritiqueIssue} from "./schemas.js";

/**
 * Arithmetic Critic
 * Validates mathematical consistency in extracted data
 * - Percentage calculations (n/total = %)
 * - Sum validations (n1 + n2 = total)
 * - Fraction consistency
 */
export function arithmeticCritic(data: any): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];

  // Helper function to parse percentage strings like "45%", "45", "45.5%"
  const parsePercentage = (val: any): number | null => {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const num = parseFloat(val.replace("%", "").trim());
      return isNaN(num) ? null : num;
    }
    return null;
  };

  // Helper function to parse count strings like "12/20", "12", "45 patients"
  const parseCount = (val: any): {numerator: number | null; denominator: number | null} => {
    if (typeof val === "number") return {numerator: val, denominator: null};
    if (typeof val === "string") {
      // Try fraction format: "12/20"
      const fractionMatch = val.match(/(\d+)\s*\/\s*(\d+)/);
      if (fractionMatch) {
        return {
          numerator: parseInt(fractionMatch[1]),
          denominator: parseInt(fractionMatch[2]),
        };
      }
      // Try simple number: "12" or "45 patients"
      const numMatch = val.match(/\d+/);
      if (numMatch) {
        return {numerator: parseInt(numMatch[0]), denominator: null};
      }
    }
    return {numerator: null, denominator: null};
  };

  // 1. Check mortality percentage calculation
  if (data.outcomes?.mortality?.value) {
    const mortalityStr = data.outcomes.mortality.value;
    const {numerator: deaths, denominator: total} = parseCount(mortalityStr);
    const percentage = parsePercentage(mortalityStr);

    if (deaths !== null && total !== null && percentage !== null) {
      const calculated = (deaths / total) * 100;
      if (Math.abs(calculated - percentage) > 1.0) {
        // Allow 1% rounding error
        issues.push({
          criticId: "arithmeticCritic",
          field: "outcomes.mortality",
          severity: "CRITICAL",
          message: `Mortality math mismatch: ${deaths}/${total} = ${calculated.toFixed(1)}%, but stated as ${percentage}%`,
          currentValue: mortalityStr,
          suggestedValue: `${deaths}/${total} (${calculated.toFixed(1)}%)`,
        });
      }
    }
  }

  // 2. Check mRS percentage calculation
  if (data.outcomes?.mRS_favorable?.value) {
    const mrsStr = data.outcomes.mRS_favorable.value;
    const {numerator: favorable, denominator: total} = parseCount(mrsStr);
    const percentage = parsePercentage(mrsStr);

    if (favorable !== null && total !== null && percentage !== null) {
      const calculated = (favorable / total) * 100;
      if (Math.abs(calculated - percentage) > 1.0) {
        issues.push({
          criticId: "arithmeticCritic",
          field: "outcomes.mRS_favorable",
          severity: "CRITICAL",
          message: `mRS math mismatch: ${favorable}/${total} = ${calculated.toFixed(1)}%, but stated as ${percentage}%`,
          currentValue: mrsStr,
          suggestedValue: `${favorable}/${total} (${calculated.toFixed(1)}%)`,
        });
      }
    }
  }

  // 3. Check sample size consistency
  const sampleSize = data.population?.sampleSize?.value || data.population?.sample_size;
  if (sampleSize) {
    const n = parseInt(sampleSize);
    if (isNaN(n) || n <= 0) {
      issues.push({
        criticId: "arithmeticCritic",
        field: "population.sampleSize",
        severity: "CRITICAL",
        message: `Invalid sample size: "${sampleSize}" is not a positive integer`,
        currentValue: sampleSize,
      });
    }
  }

  return issues;
}

/**
 * Range Sentinel
 * Validates that extracted values fall within humanly possible or medically valid bounds
 */
export function rangeSentinel(data: any): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];

  // 1. Age validation (0-120 years)
  if (data.population?.age?.mean?.value !== undefined) {
    const age = parseFloat(data.population.age.mean.value);
    if (!isNaN(age) && (age < 0 || age > 120)) {
      issues.push({
        criticId: "rangeSentinel",
        field: "population.age.mean",
        severity: "CRITICAL",
        message: `Impossible mean age: ${age} years (valid range: 0-120)`,
        currentValue: age,
      });
    }
  }

  // 2. GCS validation (3-15)
  const gcsFields = ["preOpGCS", "postOpGCS", "admissionGCS"];
  gcsFields.forEach((field) => {
    const gcsValue = data.population?.[field];
    if (gcsValue !== undefined) {
      const gcs = parseFloat(gcsValue);
      if (!isNaN(gcs) && (gcs < 3 || gcs > 15)) {
        issues.push({
          criticId: "rangeSentinel",
          field: `population.${field}`,
          severity: "CRITICAL",
          message: `Invalid GCS score: ${gcs} (valid range: 3-15)`,
          currentValue: gcs,
        });
      }
    }
  });

  // 3. Percentage validation (0-100%)
  const percentageFields = [
    {path: "population.hydrocephalusPercentage", label: "Hydrocephalus percentage"},
    {path: "outcomes.mortalityRate", label: "Mortality rate"},
    {path: "outcomes.complicationRate", label: "Complication rate"},
  ];

  percentageFields.forEach(({path, label}) => {
    const keys = path.split(".");
    let value = data;
    for (const key of keys) {
      value = value?.[key];
    }

    if (value !== undefined) {
      const num = parseFloat(value.toString().replace("%", ""));
      if (!isNaN(num) && (num < 0 || num > 100)) {
        issues.push({
          criticId: "rangeSentinel",
          field: path,
          severity: "CRITICAL",
          message: `Invalid ${label}: ${num}% (valid range: 0-100%)`,
          currentValue: value,
        });
      }
    }
  });

  // 4. Publication year validation (1900 to current year + 1)
  if (data.metadata?.publicationYear) {
    const year = parseInt(data.metadata.publicationYear);
    const currentYear = new Date().getFullYear();
    if (!isNaN(year) && (year < 1900 || year > currentYear + 1)) {
      issues.push({
        criticId: "rangeSentinel",
        field: "metadata.publicationYear",
        severity: "WARNING",
        message: `Unusual publication year: ${year} (expected range: 1900-${currentYear + 1})`,
        currentValue: year,
      });
    }
  }

  // 5. Newcastle-Ottawa Scale validation (0-9)
  if (data.quality?.totalScore !== undefined) {
    const nos = parseFloat(data.quality.totalScore);
    if (!isNaN(nos) && (nos < 0 || nos > 9)) {
      issues.push({
        criticId: "rangeSentinel",
        field: "quality.totalScore",
        severity: "CRITICAL",
        message: `Invalid NOS total score: ${nos} (valid range: 0-9)`,
        currentValue: nos,
      });
    }
  }

  // Check individual NOS component scores
  if (data.quality?.selectionScore !== undefined) {
    const sel = parseFloat(data.quality.selectionScore);
    if (!isNaN(sel) && (sel < 0 || sel > 4)) {
      issues.push({
        criticId: "rangeSentinel",
        field: "quality.selectionScore",
        severity: "CRITICAL",
        message: `Invalid NOS selection score: ${sel} (valid range: 0-4)`,
        currentValue: sel,
      });
    }
  }

  if (data.quality?.comparabilityScore !== undefined) {
    const comp = parseFloat(data.quality.comparabilityScore);
    if (!isNaN(comp) && (comp < 0 || comp > 2)) {
      issues.push({
        criticId: "rangeSentinel",
        field: "quality.comparabilityScore",
        severity: "CRITICAL",
        message: `Invalid NOS comparability score: ${comp} (valid range: 0-2)`,
        currentValue: comp,
      });
    }
  }

  if (data.quality?.outcomeScore !== undefined) {
    const out = parseFloat(data.quality.outcomeScore);
    if (!isNaN(out) && (out < 0 || out > 3)) {
      issues.push({
        criticId: "rangeSentinel",
        field: "quality.outcomeScore",
        severity: "CRITICAL",
        message: `Invalid NOS outcome score: ${out} (valid range: 0-3)`,
        currentValue: out,
      });
    }
  }

  // 6. NOS component sum validation
  if (
    data.quality?.selectionScore !== undefined &&
    data.quality?.comparabilityScore !== undefined &&
    data.quality?.outcomeScore !== undefined &&
    data.quality?.totalScore !== undefined
  ) {
    const sel = parseFloat(data.quality.selectionScore);
    const comp = parseFloat(data.quality.comparabilityScore);
    const out = parseFloat(data.quality.outcomeScore);
    const total = parseFloat(data.quality.totalScore);

    if (!isNaN(sel) && !isNaN(comp) && !isNaN(out) && !isNaN(total)) {
      const calculated = sel + comp + out;
      if (Math.abs(calculated - total) > 0.1) {
        issues.push({
          criticId: "rangeSentinel",
          field: "quality.totalScore",
          severity: "CRITICAL",
          message: `NOS score sum mismatch: ${sel} + ${comp} + ${out} = ${calculated}, but total is ${total}`,
          currentValue: total,
          suggestedValue: calculated,
        });
      }
    }
  }

  return issues;
}

/**
 * Completeness Checker
 * Flags missing critical fields that are required for systematic review
 */
export function completenessChecker(data: any): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];

  // Critical fields that must be present
  const criticalFields = [
    {path: "metadata.firstAuthor", label: "First author"},
    {path: "metadata.publicationYear", label: "Publication year"},
    {path: "population.sampleSize", label: "Sample size", alt: "population.sample_size"},
    {path: "intervention.procedure", label: "Surgical procedure"},
    {path: "outcomes.mortality", label: "Mortality data"},
  ];

  criticalFields.forEach(({path, label, alt}) => {
    const keys = path.split(".");
    let value = data;
    for (const key of keys) {
      value = value?.[key];
    }

    // Check alternative path if provided
    if ((value === undefined || value === null || value === "") && alt) {
      const altKeys = alt.split(".");
      let altValue = data;
      for (const key of altKeys) {
        altValue = altValue?.[key];
      }
      value = altValue;
    }

    if (value === undefined || value === null || value === "") {
      issues.push({
        criticId: "completenessChecker",
        field: path,
        severity: "WARNING",
        message: `Missing critical field: ${label}`,
        currentValue: null,
      });
    }
  });

  // Check if comparator exists when comparator.exists is true
  if (data.comparator?.exists === true && !data.comparator?.sampleSize) {
    issues.push({
      criticId: "completenessChecker",
      field: "comparator.sampleSize",
      severity: "WARNING",
      message: "Comparator group reported as existing but sample size is missing",
      currentValue: null,
    });
  }

  return issues;
}

/**
 * Layer 1 Main Function
 * Runs all deterministic critics and returns aggregated results
 */
export function runLayer1Critics(data: any): {passed: boolean; errors: string[]} {
  const allIssues: CritiqueIssue[] = [];

  // Run all Layer 1 critics
  allIssues.push(...arithmeticCritic(data));
  allIssues.push(...rangeSentinel(data));
  allIssues.push(...completenessChecker(data));

  // Extract error messages from critical issues
  const errors = allIssues.filter((i) => i.severity === "CRITICAL").map((i) => i.message);

  return {
    passed: errors.length === 0,
    errors,
  };
}
