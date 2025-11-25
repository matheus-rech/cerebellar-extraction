/**
 * Multi-Source Data Fuser Module
 * Combines data from multiple sources (main paper, supplements, errata, protocols)
 */

import { BaseModule } from './base.js';
import type {
  ExtractionOptions,
  MultiSourceFuserResult,
  CerebellumExtractionData,
  SourceMetadata,
  ConflictResolution,
} from '../types/index.js';

interface FuserInput {
  /** Extraction results from different sources */
  sources: Array<{
    type: 'main-paper' | 'supplement' | 'erratum' | 'protocol' | 'registry';
    data: Partial<CerebellumExtractionData>;
    url?: string;
    file_path?: string;
    extraction_date: string;
  }>;
}

export class MultiSourceFuser extends BaseModule<FuserInput, MultiSourceFuserResult> {
  readonly name = 'Multi-Source Fuser';
  readonly description = 'Intelligently combines data from multiple sources with conflict resolution';

  async process(input: FuserInput, options?: ExtractionOptions): Promise<MultiSourceFuserResult> {
    this.validate();
    this.log(`Fusing data from ${input.sources.length} sources...`, options?.verbose);

    if (input.sources.length === 0) {
      throw new Error('No sources provided for fusion');
    }

    if (input.sources.length === 1) {
      this.log('Only one source, returning as-is', options?.verbose);
      return {
        combined_data: input.sources[0].data,
        sources: [this.createSourceMetadata(input.sources[0])],
        conflicts: [],
      };
    }

    try {
      // Detect conflicts across sources
      const conflicts = this.detectConflicts(input.sources, options);

      if (conflicts.length > 0) {
        this.log(`Found ${conflicts.length} conflicts between sources`, options?.verbose);
      }

      // Resolve conflicts and merge data
      const combined_data = await this.mergeWithConflictResolution(input.sources, conflicts, options);

      // Create source metadata
      const sources = input.sources.map((s) => this.createSourceMetadata(s));

      return {
        combined_data,
        sources,
        conflicts,
      };
    } catch (error) {
      this.logError(`Data fusion failed: ${error}`);
      throw error;
    }
  }

  /**
   * Detect conflicts between different sources
   *
   * TODO: Implement comprehensive conflict detection
   *
   * This should identify when different sources provide different values
   * for the same field. Key scenarios:
   *
   * 1. **Corrected data in errata:**
   *    - Main paper: "Mortality: 15%"
   *    - Erratum: "Mortality: 18% (corrected)"
   *    → Erratum should take precedence
   *
   * 2. **Additional data in supplements:**
   *    - Main paper: Missing subgroup data
   *    - Supplement: Detailed subgroup outcomes
   *    → Supplement provides additional, not conflicting data
   *
   * 3. **Protocol vs. published results:**
   *    - Protocol: "Primary outcome: 90-day mortality"
   *    - Paper: Reports both 30-day and 90-day
   *    → Not a conflict, protocol helps validate primary outcome
   *
   * 4. **Registry vs. publication:**
   *    - ClinicalTrials.gov: Sample size = 120
   *    - Published paper: Sample size = 115
   *    → Potential selective exclusion, needs flagging
   *
   * Decision needed:
   * - What constitutes a "conflict" vs. "complementary data"?
   * - Should numeric differences below a threshold be ignored?
   * - How to handle missing data in one source?
   */
  private detectConflicts(
    sources: FuserInput['sources'],
    options?: ExtractionOptions
  ): ConflictResolution[] {
    const conflicts: ConflictResolution[] = [];

    // Get all unique field paths across sources
    const allFields = new Set<string>();
    for (const source of sources) {
      this.extractFieldPaths(source.data).forEach((path) => allFields.add(path));
    }

    // Check each field for conflicts
    for (const fieldPath of allFields) {
      const values: { source: string; value: any }[] = [];

      for (const source of sources) {
        const value = this.getValueAtPath(source.data, fieldPath);
        if (value !== undefined && value !== null && value !== '') {
          values.push({
            source: source.type,
            value,
          });
        }
      }

      // If multiple different values exist, it's a conflict
      if (values.length > 1) {
        const uniqueValues = [...new Set(values.map((v) => JSON.stringify(v.value)))];
        if (uniqueValues.length > 1) {
          this.log(`Conflict detected in ${fieldPath}: ${uniqueValues.length} different values`, options?.verbose);

          // Determine resolution strategy
          const resolution = this.resolveConflict(fieldPath, values);

          conflicts.push({
            field: fieldPath,
            values,
            resolution: resolution.value,
            resolution_strategy: resolution.strategy,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Resolve a conflict between multiple values
   *
   * TODO: Implement sophisticated conflict resolution strategies
   *
   * Resolution strategies to implement:
   *
   * 1. **Source hierarchy (most-recent):**
   *    Erratum > Supplement > Main Paper > Protocol
   *
   * 2. **Source hierarchy (highest-quality):**
   *    Protocol/Registry > Erratum > Main Paper > Supplement
   *
   * 3. **Data completeness:**
   *    Prefer more detailed value over less detailed
   *    E.g., "18.5%" over "18%", "mRS 0-2: 45%" over "favorable outcome: 45%"
   *
   * 4. **Statistical correction:**
   *    If erratum provides corrected statistics, always use that
   *
   * 5. **Manual review required:**
   *    Flag certain conflicts for human review (e.g., sample size discrepancies)
   *
   * Implementation decision:
   * - Should we allow user to configure resolution strategy?
   * - Should critical conflicts require manual review?
   * - How to document which strategy was used for each field?
   */
  private resolveConflict(
    fieldPath: string,
    values: { source: string; value: any }[]
  ): { value: any; strategy: ConflictResolution['resolution_strategy'] } {
    // Default strategy: most-recent (erratum > supplement > main-paper)
    const sourceRanking = {
      erratum: 4,
      supplement: 3,
      'main-paper': 2,
      protocol: 1,
      registry: 1,
    };

    // Sort by source quality
    const sorted = values.sort((a, b) => {
      return (sourceRanking[b.source as keyof typeof sourceRanking] || 0) -
             (sourceRanking[a.source as keyof typeof sourceRanking] || 0);
    });

    return {
      value: sorted[0].value,
      strategy: 'highest-quality',
    };
  }

  /**
   * Merge all sources with conflict resolution applied
   */
  private async mergeWithConflictResolution(
    sources: FuserInput['sources'],
    conflicts: ConflictResolution[],
    options?: ExtractionOptions
  ): Promise<Partial<CerebellumExtractionData>> {
    // Start with empty merged data
    const merged: any = {};

    // Apply data from each source (will be overwritten by higher-priority sources)
    const sortedSources = this.sortSourcesByPriority(sources);

    for (const source of sortedSources) {
      this.log(`Merging data from ${source.type}`, options?.verbose);
      this.deepMerge(merged, source.data);
    }

    // Apply conflict resolutions (overwrite with resolved values)
    for (const conflict of conflicts) {
      this.setValueAtPath(merged, conflict.field, conflict.resolution);
      this.log(`Resolved conflict in ${conflict.field} using ${conflict.resolution_strategy}`, options?.verbose);
    }

    return merged;
  }

  /**
   * Sort sources by priority (higher priority = merged later, wins conflicts)
   */
  private sortSourcesByPriority(sources: FuserInput['sources']): FuserInput['sources'] {
    const priority = {
      protocol: 1,
      registry: 1,
      'main-paper': 2,
      supplement: 3,
      erratum: 4,
    };

    return [...sources].sort((a, b) => {
      return (priority[a.type as keyof typeof priority] || 0) - (priority[b.type as keyof typeof priority] || 0);
    });
  }

  /**
   * Deep merge two objects
   */
  private deepMerge(target: any, source: any): void {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        this.deepMerge(target[key], source[key]);
      } else if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        target[key] = source[key];
      }
    }
  }

  /**
   * Extract all field paths from a nested object
   */
  private extractFieldPaths(obj: any, prefix = ''): string[] {
    const paths: string[] = [];

    for (const key in obj) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        paths.push(...this.extractFieldPaths(obj[key], path));
      } else {
        paths.push(path);
      }
    }

    return paths;
  }

  /**
   * Get value at a dot-notation path
   */
  private getValueAtPath(obj: any, path: string): any {
    return path.split('.').reduce((curr, key) => curr?.[key], obj);
  }

  /**
   * Set value at a dot-notation path
   */
  private setValueAtPath(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((curr, key) => {
      if (!curr[key]) curr[key] = {};
      return curr[key];
    }, obj);
    target[lastKey] = value;
  }

  /**
   * Create source metadata from a source
   */
  private createSourceMetadata(source: FuserInput['sources'][0]): SourceMetadata {
    return {
      source_type: source.type,
      url: source.url,
      file_path: source.file_path,
      extraction_date: source.extraction_date,
      fields_contributed: this.extractFieldPaths(source.data),
    };
  }
}
