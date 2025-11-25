/**
 * Outcome Harmonizer Module
 * Standardizes heterogeneous outcome definitions across studies
 */

import { BaseModule } from './base.js';
import type { ExtractionOptions, OutcomeHarmonizerResult, HarmonizedOutcomes } from '../types/index.js';

interface HarmonizerInput {
  /** Raw outcome data from the study */
  outcomes: {
    mortality?: string;
    mRS_favorable?: string;
    mRS_distribution?: string;
    follow_up_duration?: string;
  };
  /** Full text for context */
  fullText?: string;
}

export class OutcomeHarmonizer extends BaseModule<HarmonizerInput, OutcomeHarmonizerResult> {
  readonly name = 'Outcome Harmonizer';
  readonly description = 'Standardizes outcome measures across different timepoints and definitions';

  // Standard timepoints for harmonization (in days)
  private readonly STANDARD_TIMEPOINTS = [30, 90, 180, 365];

  // mRS dichotomization schemes
  private readonly MRS_DEFINITIONS = {
    favorable_0_2: [0, 1, 2],
    favorable_0_3: [0, 1, 2, 3],
    unfavorable_4_6: [4, 5, 6],
  };

  async process(input: HarmonizerInput, options?: ExtractionOptions): Promise<OutcomeHarmonizerResult> {
    this.validate();
    this.log('Harmonizing outcomes...', options?.verbose);

    try {
      const originalOutcomes = this.identifyOriginalOutcomes(input);
      const harmonized = await this.harmonizeToStandardTimepoints(input, options);
      const transformations = this.documentTransformations(input, harmonized);

      return {
        harmonized,
        original_outcomes: originalOutcomes,
        transformations,
      };
    } catch (error) {
      this.logError(`Harmonization failed: ${error}`);
      throw error;
    }
  }

  /**
   * Identify what outcomes are reported in the original study
   */
  private identifyOriginalOutcomes(input: HarmonizerInput): string[] {
    const outcomes: string[] = [];

    if (input.outcomes.mortality) outcomes.push('mortality');
    if (input.outcomes.mRS_favorable) outcomes.push('mRS favorable outcome');
    if (input.outcomes.mRS_distribution) outcomes.push('mRS distribution');

    return outcomes;
  }

  /**
   * Harmonize outcomes to standard timepoints
   *
   * TODO: Implement sophisticated harmonization logic
   *
   * This is the core of the harmonizer. You need to decide:
   *
   * 1. **Timepoint mapping strategy:**
   *    - If study reports 3-month outcomes, should that map to 90-day?
   *    - What about 1-year vs. 12-month vs. 365-day?
   *    - How to handle "median follow-up"?
   *
   * 2. **Outcome definition conversion:**
   *    - Study reports mRS 0-2 as favorable, but you want mRS 0-3?
   *    - Can you mathematically convert if you have mRS distribution?
   *    - What assumptions are acceptable?
   *
   * 3. **Missing data handling:**
   *    - Study only reports 6-month outcomes, but you need 90-day?
   *    - Can you impute? Should you flag as "unavailable"?
   *
   * 4. **Confidence scoring:**
   *    - Direct extraction = high confidence
   *    - Converted from distribution = medium
   *    - Imputed or extrapolated = low
   *
   * Implementation approach:
   * - Use Claude to parse natural language outcome descriptions
   * - Apply mathematical conversions where possible
   * - Document all assumptions and transformations
   */
  private async harmonizeToStandardTimepoints(
    input: HarmonizerInput,
    options?: ExtractionOptions
  ): Promise<HarmonizedOutcomes> {
    const timepoints = [];
    const conversions_applied: string[] = [];

    // Extract timepoint from follow-up duration
    const timepointDays = this.parseTimepointToDays(input.outcomes.follow_up_duration);

    if (timepointDays) {
      // Map to nearest standard timepoint
      const standardTimepoint = this.mapToStandardTimepoint(timepointDays);
      this.log(`Mapped ${timepointDays} days to standard ${standardTimepoint} days`, options?.verbose);

      // Parse mortality
      const mortality = this.parseMortality(input.outcomes.mortality);

      // Parse mRS outcomes
      const mrsData = this.parseMrsOutcome(input.outcomes.mRS_favorable, input.outcomes.mRS_distribution);

      if (timepointDays !== standardTimepoint) {
        conversions_applied.push(`Mapped ${timepointDays}-day to ${standardTimepoint}-day timepoint`);
      }

      timepoints.push({
        days: standardTimepoint,
        mortality: mortality,
        mRS_0_2: mrsData.mRS_0_2,
        mRS_0_3: mrsData.mRS_0_3,
        mRS_distribution: mrsData.distribution,
      });
    }

    // Determine confidence based on transformations applied
    const confidence = conversions_applied.length === 0 ? 'high' : conversions_applied.length <= 2 ? 'medium' : 'low';

    return {
      timepoints,
      conversions_applied,
      confidence,
    };
  }

  /**
   * Parse timepoint string to days
   * Examples: "90 days", "3 months", "1 year", "median 6 months"
   */
  private parseTimepointToDays(timepoint?: string): number | undefined {
    if (!timepoint) return undefined;

    // Days
    const daysMatch = timepoint.match(/(\d+)\s*d(ay)?s?/i);
    if (daysMatch) return parseInt(daysMatch[1]);

    // Months (assume 30 days/month)
    const monthsMatch = timepoint.match(/(\d+)\s*m(onth)?s?/i);
    if (monthsMatch) return parseInt(monthsMatch[1]) * 30;

    // Years (assume 365 days/year)
    const yearsMatch = timepoint.match(/(\d+)\s*y(ea)?r?s?/i);
    if (yearsMatch) return parseInt(yearsMatch[1]) * 365;

    return undefined;
  }

  /**
   * Map an actual timepoint to the nearest standard timepoint
   */
  private mapToStandardTimepoint(days: number): number {
    return this.STANDARD_TIMEPOINTS.reduce((nearest, standard) => {
      return Math.abs(standard - days) < Math.abs(nearest - days) ? standard : nearest;
    });
  }

  /**
   * Parse mortality percentage from text
   * Examples: "15%", "15/100", "15 of 100 patients died"
   */
  private parseMortality(text?: string): number | undefined {
    if (!text) return undefined;

    // Percentage
    const percentMatch = text.match(/(\d+\.?\d*)%/);
    if (percentMatch) return parseFloat(percentMatch[1]) / 100;

    // Fraction
    const fractionMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (fractionMatch) {
      return parseInt(fractionMatch[1]) / parseInt(fractionMatch[2]);
    }

    return undefined;
  }

  /**
   * Parse mRS outcome data
   *
   * TODO: Implement mRS distribution parsing and conversion
   *
   * If the study provides full mRS distribution (% at each mRS level 0-6),
   * you can convert between different favorable outcome definitions:
   * - mRS 0-2 vs mRS 0-3
   * - Calculate expected proportions
   */
  private parseMrsOutcome(
    favorable?: string,
    distribution?: string
  ): {
    mRS_0_2?: number;
    mRS_0_3?: number;
    distribution?: number[];
  } {
    // TODO: Implement sophisticated mRS parsing
    // This should handle various formats and convert between definitions

    return {};
  }

  /**
   * Document all transformations applied during harmonization
   */
  private documentTransformations(input: HarmonizerInput, harmonized: HarmonizedOutcomes): string[] {
    return harmonized.conversions_applied;
  }
}
