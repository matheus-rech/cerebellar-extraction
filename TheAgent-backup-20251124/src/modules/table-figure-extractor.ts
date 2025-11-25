/**
 * Table & Figure Extractor Module
 * Vision-based extraction of tables and figures using Docling MCP
 */

import { BaseModule } from './base.js';
import type { ExtractionOptions, TableExtractionResult, TableData, FigureData } from '../types/index.js';
import { getDoclingClient, DoclingMcpClient, type DoclingTable } from '../utils/docling-mcp-client.js';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

interface TableFigureInput {
  pdfPath: string;
  /** Specific pages to extract from (optional) */
  pages?: number[];
  /** Extract images/figures in addition to tables */
  extractFigures?: boolean;
  /** Output directory for extracted images */
  imageOutputDir?: string;
}

export class TableFigureExtractor extends BaseModule<TableFigureInput, TableExtractionResult> {
  readonly name = 'Table & Figure Extractor';
  readonly description = 'Extracts tables and figures using vision-based document understanding';

  async process(input: TableFigureInput, options?: ExtractionOptions): Promise<TableExtractionResult> {
    this.validate();
    this.log('Starting table and figure extraction...', options?.verbose);

    try {
      // Check if Docling MCP is available
      const useDocling = process.env.DOCLING_MCP_ENABLED === 'true';

      if (useDocling) {
        return await this.extractWithDocling(input, options);
      } else {
        this.log('Docling MCP not enabled, using fallback method', options?.verbose);
        return await this.extractWithVision(input, options);
      }
    } catch (error) {
      this.logError(`Extraction failed: ${error}`);
      throw error;
    }
  }

  /**
   * Extract tables using Docling MCP server
   *
   * Docling MCP provides advanced document layout understanding:
   * - Accurate table structure extraction (headers, merged cells)
   * - Vision-first approach for complex layouts
   * - High accuracy on medical/scientific tables
   *
   * See: https://glama.ai/mcp/servers/@zanetworker/mcp-docling
   */
  private async extractWithDocling(
    input: TableFigureInput,
    options?: ExtractionOptions
  ): Promise<TableExtractionResult> {
    this.log('Using Docling MCP for table extraction', options?.verbose);

    try {
      // Get Docling MCP client
      const docling = await getDoclingClient();

      // Extract tables using Docling
      const doclingTables = await docling.extractTables(input.pdfPath);

      this.log(`Docling extracted ${doclingTables.length} tables`, options?.verbose);

      // Convert to our TableData format
      const tables: TableData[] = doclingTables.map((docTable, index) =>
        this.parseDoclingTable(docTable, index + 1)
      );

      // Optionally extract figures/images
      let figures: FigureData[] = [];
      if (input.extractFigures) {
        const imageDir = input.imageOutputDir || join(dirname(input.pdfPath), 'extracted_images');

        // Ensure output directory exists
        if (!existsSync(imageDir)) {
          mkdirSync(imageDir, { recursive: true });
        }

        const doclingImages = await docling.extractImages(input.pdfPath, imageDir);

        this.log(`Docling extracted ${doclingImages.length} images`, options?.verbose);

        figures = doclingImages.map((img, index) => ({
          figure_number: img.image_number,
          title: img.caption || `Figure ${img.image_number}`,
          page: img.page || 0,
          type: this.mapImageTypeToFigureType(img.type),
          caption: img.caption,
          data_points: [] // TODO: Extract data points from charts if needed
        }));
      }

      return {
        tables,
        figures: figures.length > 0 ? figures : undefined,
        extraction_method: 'docling',
        confidence: 0.95, // Docling has high accuracy
      };
    } catch (error) {
      this.logError(`Docling extraction failed: ${error}`);

      // Fallback to vision API if Docling fails
      this.log('Falling back to vision-based extraction', options?.verbose);
      return await this.extractWithVision(input, options);
    }
  }

  /**
   * Fallback: Extract tables using Claude vision API
   *
   * TODO: Implement vision-based table extraction
   *
   * This fallback method should:
   * 1. Convert PDF pages to images
   * 2. Use Claude vision to identify table regions
   * 3. Extract table content via vision API
   * 4. Structure the data into TableData format
   *
   * Trade-offs to consider:
   * - Vision is slower but works without Docling
   * - May have lower accuracy on complex tables
   * - Better for figures and charts
   */
  private async extractWithVision(
    input: TableFigureInput,
    options?: ExtractionOptions
  ): Promise<TableExtractionResult> {
    this.log('Using Claude vision API for extraction', options?.verbose);

    // Placeholder implementation
    const tables: TableData[] = [];

    return {
      tables,
      extraction_method: 'vision',
      confidence: 0.80,
    };
  }

  /**
   * Extract figures and charts from PDF
   *
   * TODO: Implement figure extraction
   *
   * Key considerations:
   * - How to identify different chart types (Kaplan-Meier, forest plots, etc.)?
   * - Should we extract data points from charts for IPD reconstruction?
   * - How to handle image quality and resolution?
   */
  async extractFigures(input: TableFigureInput, options?: ExtractionOptions): Promise<FigureData[]> {
    this.log('Extracting figures...', options?.verbose);

    // TODO: Implement figure extraction logic
    return [];
  }

  /**
   * Parse a table extracted by Docling into our TableData format
   */
  private parseDoclingTable(doclingTable: DoclingTable, tableNumber: number): TableData {
    const data = doclingTable.data || [];

    // First row is typically headers (if not explicitly provided)
    const headers = doclingTable.headers || (data.length > 0 ? data[0] : []);

    // Remaining rows are data (skip first row if it was used for headers)
    const rows = doclingTable.headers ? data : data.slice(1);

    return {
      table_number: tableNumber,
      title: doclingTable.caption || `Table ${tableNumber}`,
      page: doclingTable.page || 0,
      headers: headers,
      rows: rows,
      caption: doclingTable.caption,
      extracted_type: 'docling',
    };
  }

  /**
   * Map Docling image type to FigureData type
   */
  private mapImageTypeToFigureType(
    doclingType?: 'figure' | 'chart' | 'diagram' | 'photo'
  ): 'kaplan-meier' | 'forest-plot' | 'bar-chart' | 'scatter' | 'other' {
    // Default mapping (can be enhanced with Claude vision for precise classification)
    switch (doclingType) {
      case 'chart':
        return 'bar-chart'; // Could be any chart type
      case 'diagram':
      case 'figure':
      case 'photo':
      default:
        return 'other';
    }
  }
}
