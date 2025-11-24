/**
 * Imaging Metrics Extractor Module
 * Extracts quantitative neuroimaging data from cerebellar stroke studies
 */

import { BaseModule } from './base.js';
import type { ExtractionOptions, ImagingExtractionResult, ImagingMetrics } from '../types/index.js';

interface ImagingInput {
  fullText: string;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
}

export class ImagingMetricsExtractor extends BaseModule<ImagingInput, ImagingExtractionResult> {
  readonly name = 'Imaging Metrics Extractor';
  readonly description = 'Extracts quantitative neuroimaging data specific to cerebellar stroke';

  // Common imaging metrics in cerebellar stroke literature
  private readonly IMAGING_PATTERNS = {
    infarct_volume: /(?:infarct|lesion)\s+volume.*?(\d+\.?\d*)\s*(ml|cm3)/gi,
    edema_volume: /edema\s+volume.*?(\d+\.?\d*)\s*(ml|cm3)/gi,
    midline_shift: /midline\s+shift.*?(\d+\.?\d*)\s*mm/gi,
    fourth_ventricle: /(fourth ventricle|4th ventricle|IVth ventricle)/gi,
    hydrocephalus: /hydrocephalus/gi,
  };

  async process(input: ImagingInput, options?: ExtractionOptions): Promise<ImagingExtractionResult> {
    this.validate();
    this.log('Extracting imaging metrics...', options?.verbose);

    try {
      const metrics = await this.extractMetrics(input, options);
      const confidence = this.calculateConfidence(metrics);

      return {
        metrics,
        confidence,
        extraction_method: 'pattern-matching-with-llm',
      };
    } catch (error) {
      this.logError(`Imaging extraction failed: ${error}`);
      throw error;
    }
  }

  /**
   * Extract imaging metrics from text and tables
   *
   * TODO: Implement comprehensive imaging extraction
   *
   * This function should:
   * 1. Use regex patterns to find candidate values
   * 2. Use Claude to validate and extract missing metrics
   * 3. Handle different reporting formats (mean ± SD, median [IQR], etc.)
   * 4. Cross-reference tables for structured imaging data
   *
   * Key decisions to make:
   * - Should we extract only baseline imaging or also follow-up scans?
   * - How to handle studies reporting multiple imaging timepoints?
   * - What to do with ranges vs. individual values?
   */
  private async extractMetrics(input: ImagingInput, options?: ExtractionOptions): Promise<ImagingMetrics> {
    const extracted_values: Record<string, string> = {};

    // Pattern-based extraction
    for (const [metric, pattern] of Object.entries(this.IMAGING_PATTERNS)) {
      const matches = [...input.fullText.matchAll(pattern)];
      if (matches.length > 0) {
        this.log(`Found ${matches.length} mentions of ${metric}`, options?.verbose);

        // Store all matches for review
        extracted_values[metric] = matches.map((m) => m[0]).join('; ');
      }
    }

    // Parse numeric values
    const infarctVolumeMatch = input.fullText.match(/infarct\s+volume.*?(\d+\.?\d*)/i);
    const infarctVolume = infarctVolumeMatch ? parseFloat(infarctVolumeMatch[1]) : undefined;

    const edemaVolumeMatch = input.fullText.match(/edema\s+volume.*?(\d+\.?\d*)/i);
    const edemaVolume = edemaVolumeMatch ? parseFloat(edemaVolumeMatch[1]) : undefined;

    const midlineShiftMatch = input.fullText.match(/midline\s+shift.*?(\d+\.?\d*)/i);
    const midlineShift = midlineShiftMatch ? parseFloat(midlineShiftMatch[1]) : undefined;

    // Boolean flags
    const hasHydrocephalus = /hydrocephalus/i.test(input.fullText);
    const hasFourthVentricleCompression = /(fourth ventricle|4th ventricle).*?compres/i.test(input.fullText);

    // TODO: Enhance with Claude Agent SDK for context-aware extraction
    // Example: "The median infarct volume was 25 mL (IQR 18-35)" should extract 25 as primary value

    return {
      infarct_volume_ml: infarctVolume,
      edema_volume_ml: edemaVolume,
      midline_shift_mm: midlineShift,
      hydrocephalus: hasHydrocephalus || undefined,
      fourth_ventricle_compression: hasFourthVentricleCompression || undefined,
      imaging_timepoint: this.extractImagingTimepoint(input.fullText),
      imaging_modality: this.extractImagingModality(input.fullText),
      extracted_values,
    };
  }

  /**
   * Determine the imaging timepoint (baseline, 24h, etc.)
   */
  private extractImagingTimepoint(text: string): string | undefined {
    if (/admission|baseline|initial/i.test(text)) return 'baseline';
    if (/24\s*h|24-h|24\s*hour/i.test(text)) return '24-hour';
    if (/follow-?up/i.test(text)) return 'follow-up';
    return undefined;
  }

  /**
   * Identify imaging modality (CT, MRI, etc.)
   */
  private extractImagingModality(text: string): string | undefined {
    if (/\bCT\b|computed tomography/i.test(text)) return 'CT';
    if (/\bMRI\b|magnetic resonance/i.test(text)) return 'MRI';
    if (/\bDWI\b|diffusion-weighted/i.test(text)) return 'DWI-MRI';
    return undefined;
  }

  /**
   * Calculate confidence score based on how many metrics were found
   */
  private calculateConfidence(metrics: ImagingMetrics): number {
    let score = 0;
    const weights = {
      infarct_volume_ml: 0.3,
      edema_volume_ml: 0.2,
      midline_shift_mm: 0.2,
      imaging_modality: 0.15,
      imaging_timepoint: 0.15,
    };

    for (const [key, weight] of Object.entries(weights)) {
      if (metrics[key as keyof ImagingMetrics] !== undefined) {
        score += weight;
      }
    }

    return Math.min(score, 1.0);
  }
}
