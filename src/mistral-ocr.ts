/**
 * Mistral OCR Integration for Cerebellar Extraction System
 *
 * Leverages Mistral's Document AI suite:
 * 1. Basic OCR - Markdown output with table structure preserved
 * 2. BBox Annotations - Structured JSON from figures/charts
 * 3. Document Annotations - Extract directly to schema
 *
 * Performance: 96.12% table accuracy, 94.29% math comprehension
 * Cost: $0.001/page, Speed: 2,000 pages/minute
 */

import { Mistral } from "@mistralai/mistralai";
import { z } from "genkit";
import * as fs from "fs";
import * as path from "path";

// ==========================================
// Mistral Client Initialization (Lazy)
// ==========================================

let _mistralClient: Mistral | null = null;

/**
 * Get the Mistral client (lazy initialization)
 * This ensures dotenv has loaded before we read MISTRAL_API_KEY
 */
function getMistralClient(): Mistral {
  if (!_mistralClient) {
    if (!process.env.MISTRAL_API_KEY) {
      throw new Error(
        "MISTRAL_API_KEY not configured. Add it to .env file.\n" +
        "Get your key from: https://console.mistral.ai/"
      );
    }
    _mistralClient = new Mistral({
      apiKey: process.env.MISTRAL_API_KEY,
    });
  }
  return _mistralClient;
}

// ==========================================
// Output Schemas
// ==========================================

/**
 * Schema for extracted table data
 */
export const ExtractedTableSchema = z.object({
  pageNumber: z.number().int().positive(),
  tableIndex: z.number().int().nonnegative().describe("0-based index of table on page"),
  caption: z.string().nullable().describe("Table caption if found"),
  markdownTable: z.string().describe("Table in markdown format"),
  headers: z.array(z.string()).describe("Column headers"),
  rows: z.array(z.array(z.string())).describe("Table data rows"),
  tableType: z
    .enum([
      "demographics",
      "baseline",
      "outcomes",
      "complications",
      "flowchart",
      "statistical",
      "imaging",
      "surgical",
      "other",
    ])
    .nullable()
    .describe("Detected table type for schema mapping"),
  confidence: z.number().min(0).max(1).describe("Extraction confidence"),
});

export type ExtractedTable = z.infer<typeof ExtractedTableSchema>;

/**
 * Schema for extracted figure/chart data
 * Uses BBox annotations for structured extraction
 */
export const ExtractedFigureSchema = z.object({
  pageNumber: z.number().int().positive(),
  figureIndex: z.number().int().nonnegative(),
  caption: z.string().nullable(),
  figureType: z
    .enum([
      "flowchart",
      "bar_chart",
      "line_chart",
      "kaplan_meier",
      "forest_plot",
      "ct_scan",
      "mri",
      "scatter_plot",
      "pie_chart",
      "box_plot",
      "histogram",
      "heatmap",
      "diagram",
      "other",
    ])
    .describe("Type of figure"),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  extractedValues: z
    .array(
      z.object({
        label: z.string().describe("Data point label (e.g., 'Mortality at 30 days')"),
        value: z.string().describe("Extracted value (e.g., '12.5%')"),
        confidence: z.number().min(0).max(1),
      })
    )
    .describe("Values extracted from charts/graphs"),
  summary: z.string().nullable().describe("Brief description of the figure content"),
  clinicalRelevance: z.string().nullable().describe("Relevance to SDC outcomes"),
});

export type ExtractedFigure = z.infer<typeof ExtractedFigureSchema>;

/**
 * Complete OCR result schema
 */
export const MistralOCRResultSchema = z.object({
  markdown: z.string().describe("Full document as markdown"),
  pageCount: z.number().int().positive(),
  tables: z.array(ExtractedTableSchema),
  figures: z.array(ExtractedFigureSchema),
  metadata: z.object({
    processingTimeMs: z.number(),
    modelVersion: z.string(),
    documentSizeBytes: z.number().nullable(),
  }),
});

export type MistralOCRResult = z.infer<typeof MistralOCRResultSchema>;

// ==========================================
// BBox Annotation Schemas (for figure extraction)
// ==========================================

/**
 * Schema for Mistral BBox annotation - defines what to extract from images
 */
const FigureAnnotationSchema = {
  type: "object",
  properties: {
    figure_type: {
      type: "string",
      enum: [
        "flowchart",
        "bar_chart",
        "line_chart",
        "kaplan_meier",
        "forest_plot",
        "ct_scan",
        "mri",
        "scatter_plot",
        "other",
      ],
      description: "Type of the figure or chart",
    },
    description: {
      type: "string",
      description: "Brief description of what the figure shows",
    },
    extracted_data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
        },
      },
      description: "Key data points extracted from the figure",
    },
    clinical_relevance: {
      type: "string",
      description: "Relevance to cerebellar stroke or SDC outcomes",
    },
  },
  required: ["figure_type", "description"],
};

// ==========================================
// Core OCR Functions
// ==========================================

/**
 * Upload a PDF file to Mistral and get a fileId
 * Required for OCR on local files
 */
async function uploadPdfToMistral(pdfBuffer: Buffer, filename: string): Promise<string> {
  const client = getMistralClient();

  // Create a Blob from the buffer (convert to Uint8Array for type compatibility)
  const uint8Array = new Uint8Array(pdfBuffer);
  const blob = new Blob([uint8Array], { type: "application/pdf" });

  // Upload the file
  const uploadResponse = await client.files.upload({
    file: {
      fileName: filename,
      content: blob,
    },
    purpose: "ocr" as any, // OCR purpose for document processing
  });

  if (!uploadResponse.id) {
    throw new Error("Failed to upload file to Mistral - no fileId returned");
  }

  return uploadResponse.id;
}

/**
 * Process a PDF with Mistral OCR
 * Returns markdown with preserved structure + table/figure extraction
 *
 * For URLs: Uses DocumentURLChunk directly
 * For local files/base64: Uploads file first, then uses FileChunk
 */
export async function extractWithMistralOCR(
  input: { pdfPath?: string; pdfBase64?: string; pdfUrl?: string },
  options: { includeFigureAnalysis?: boolean; includeTableParsing?: boolean } = {}
): Promise<MistralOCRResult> {
  const startTime = Date.now();
  const { includeFigureAnalysis = true, includeTableParsing = true } = options;

  const client = getMistralClient();
  let documentInput: any;
  let uploadedFileId: string | null = null;

  if (input.pdfUrl) {
    // Use DocumentURLChunk for public URLs
    documentInput = {
      type: "document_url",
      documentUrl: input.pdfUrl,
    };
  } else {
    // For local files or base64, upload first and use FileChunk
    let pdfBuffer: Buffer;
    let filename: string;

    if (input.pdfBase64) {
      pdfBuffer = Buffer.from(input.pdfBase64, "base64");
      filename = `document_${Date.now()}.pdf`;
    } else if (input.pdfPath) {
      pdfBuffer = fs.readFileSync(input.pdfPath);
      filename = path.basename(input.pdfPath);
    } else {
      throw new Error("Must provide pdfPath, pdfBase64, or pdfUrl");
    }

    // Upload file to Mistral
    console.log(`   📤 Uploading ${filename} to Mistral...`);
    uploadedFileId = await uploadPdfToMistral(pdfBuffer, filename);
    console.log(`   ✅ Upload complete (fileId: ${uploadedFileId.substring(0, 8)}...)`);

    documentInput = {
      type: "file",
      fileId: uploadedFileId,
    };
  }

  // Call Mistral OCR API
  const ocrResponse = await client.ocr.process({
    model: "mistral-ocr-latest",
    document: documentInput,
    includeImageBase64: includeFigureAnalysis,
  });

  // Parse OCR response
  const pages = ocrResponse.pages || [];
  const fullMarkdown = pages.map((p: any) => p.markdown || "").join("\n\n---\n\n");

  // Extract tables from markdown
  const tables: ExtractedTable[] = includeTableParsing ? parseTablesFromMarkdown(fullMarkdown, pages) : [];

  // Extract figures from bounding boxes
  const figures: ExtractedFigure[] = includeFigureAnalysis
    ? await extractFiguresFromPages(pages, ocrResponse)
    : [];

  return {
    markdown: fullMarkdown,
    pageCount: pages.length,
    tables,
    figures,
    metadata: {
      processingTimeMs: Date.now() - startTime,
      modelVersion: ocrResponse.model || "mistral-ocr-latest",
      documentSizeBytes: (ocrResponse as any).usageInfo?.docSizeBytes || null,
    },
  };
}

/**
 * Extract only tables from a PDF (faster, no figure analysis)
 */
export async function extractTablesWithMistral(input: {
  pdfPath?: string;
  pdfBase64?: string;
  pdfUrl?: string;
}): Promise<ExtractedTable[]> {
  const result = await extractWithMistralOCR(input, {
    includeFigureAnalysis: false,
    includeTableParsing: true,
  });
  return result.tables;
}

/**
 * Extract figures with BBox annotations for structured data
 */
export async function extractFiguresWithMistral(input: {
  pdfPath?: string;
  pdfBase64?: string;
  pdfUrl?: string;
}): Promise<ExtractedFigure[]> {
  const client = getMistralClient();
  let documentInput: any;

  if (input.pdfUrl) {
    // Use DocumentURLChunk for public URLs
    documentInput = {
      type: "document_url",
      documentUrl: input.pdfUrl,
    };
  } else {
    // For local files or base64, upload first and use FileChunk
    let pdfBuffer: Buffer;
    let filename: string;

    if (input.pdfBase64) {
      pdfBuffer = Buffer.from(input.pdfBase64, "base64");
      filename = `document_${Date.now()}.pdf`;
    } else if (input.pdfPath) {
      pdfBuffer = fs.readFileSync(input.pdfPath);
      filename = path.basename(input.pdfPath);
    } else {
      throw new Error("Must provide pdfPath, pdfBase64, or pdfUrl");
    }

    // Upload file to Mistral
    const uploadedFileId = await uploadPdfToMistral(pdfBuffer, filename);

    documentInput = {
      type: "file",
      fileId: uploadedFileId,
    };
  }

  // Call Mistral OCR with BBox annotations
  const ocrResponse = await client.ocr.process({
    model: "mistral-ocr-latest",
    document: documentInput,
    includeImageBase64: true,
    bboxAnnotationFormat: FigureAnnotationSchema as any,
  });

  return extractFiguresFromPages(ocrResponse.pages || [], ocrResponse);
}

// ==========================================
// Table Parsing Utilities
// ==========================================

/**
 * Parse markdown tables into structured data
 */
function parseTablesFromMarkdown(markdown: string, pages: any[]): ExtractedTable[] {
  const tables: ExtractedTable[] = [];

  // Split by page markers to track page numbers
  const pageTexts = markdown.split(/\n---\n/);

  pageTexts.forEach((pageText, pageIdx) => {
    // Match markdown tables: lines starting with |
    const tableRegex = /(\|[^\n]+\|\n)+/g;
    let match: RegExpExecArray | null;
    let tableIndex = 0;

    while ((match = tableRegex.exec(pageText)) !== null) {
      const tableMarkdown = match[0].trim();
      const lines = tableMarkdown.split("\n").filter((l) => l.trim());

      if (lines.length < 2) continue; // Need at least header + separator

      // Parse headers (first row)
      const headers = parseTableRow(lines[0]);

      // Check for separator row (|---|---|)
      const hasSeparator = lines[1]?.includes("---");
      const dataStartIdx = hasSeparator ? 2 : 1;

      // Parse data rows
      const rows = lines.slice(dataStartIdx).map(parseTableRow);

      // Detect table type based on headers
      const tableType = detectTableType(headers);

      // Find caption (look for text before table)
      const caption = findTableCaption(pageText, match.index);

      tables.push({
        pageNumber: pageIdx + 1,
        tableIndex: tableIndex++,
        caption,
        markdownTable: tableMarkdown,
        headers,
        rows,
        tableType,
        confidence: 0.95, // High confidence for clean markdown tables
      });
    }
  });

  return tables;
}

/**
 * Parse a single table row from markdown
 */
function parseTableRow(row: string): string[] {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell && !cell.match(/^-+$/)); // Remove empty cells and separator cells
}

/**
 * Detect table type based on column headers
 */
function detectTableType(
  headers: string[]
): ExtractedTable["tableType"] {
  const headerText = headers.join(" ").toLowerCase();

  if (headerText.match(/age|sex|gender|male|female|baseline/)) return "demographics";
  if (headerText.match(/gcs|admission|diagnosis|etiology|infarction|hemorrhage/)) return "baseline";
  if (headerText.match(/mortality|death|mrs|rankin|outcome|favorable/)) return "outcomes";
  if (headerText.match(/complication|infection|reoperation|hydrocephalus/)) return "complications";
  if (headerText.match(/screened|enrolled|excluded|analyzed|follow-up/)) return "flowchart";
  if (headerText.match(/odds ratio|hazard|ci|p-value|significant/)) return "statistical";
  if (headerText.match(/volume|lesion|edema|swelling|midline/)) return "imaging";
  if (headerText.match(/surgical|evd|duraplasty|craniectomy|technique/)) return "surgical";

  return "other";
}

/**
 * Find table caption by looking at text before the table
 */
function findTableCaption(pageText: string, tableStartIndex: number): string | null {
  // Look for "Table X" or "Table X." pattern before the table
  const textBefore = pageText.substring(Math.max(0, tableStartIndex - 200), tableStartIndex);
  const captionMatch = textBefore.match(/Table\s+\d+\.?\s*[^\n]*/i);

  if (captionMatch) {
    return captionMatch[0].trim();
  }

  return null;
}

// ==========================================
// Figure Extraction Utilities
// ==========================================

/**
 * Extract figures from OCR page data with bounding boxes
 */
async function extractFiguresFromPages(pages: any[], ocrResponse: any): Promise<ExtractedFigure[]> {
  const figures: ExtractedFigure[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    const images = page.images || [];

    for (let figIdx = 0; figIdx < images.length; figIdx++) {
      const img = images[figIdx];

      // Get bbox annotation if available
      const annotation = img.annotation || {};

      figures.push({
        pageNumber: pageIdx + 1,
        figureIndex: figIdx,
        caption: findFigureCaption(page.markdown, figIdx),
        figureType: mapFigureType(annotation.figure_type) || "other",
        boundingBox: img.bbox
          ? {
              x: img.bbox.x || 0,
              y: img.bbox.y || 0,
              width: img.bbox.width || 0,
              height: img.bbox.height || 0,
            }
          : null,
        extractedValues: (annotation.extracted_data || []).map((d: any) => ({
          label: d.label || "",
          value: d.value || "",
          confidence: 0.9,
        })),
        summary: annotation.description || null,
        clinicalRelevance: annotation.clinical_relevance || null,
      });
    }
  }

  return figures;
}

/**
 * Map annotation figure type to our schema
 */
function mapFigureType(annotationType: string | undefined): ExtractedFigure["figureType"] | null {
  if (!annotationType) return null;

  const typeMap: Record<string, ExtractedFigure["figureType"]> = {
    flowchart: "flowchart",
    bar_chart: "bar_chart",
    line_chart: "line_chart",
    kaplan_meier: "kaplan_meier",
    forest_plot: "forest_plot",
    ct_scan: "ct_scan",
    mri: "mri",
    scatter_plot: "scatter_plot",
    other: "other",
  };

  return typeMap[annotationType.toLowerCase()] || "other";
}

/**
 * Find figure caption from page markdown
 */
function findFigureCaption(markdown: string, figureIndex: number): string | null {
  // Look for "Figure X" or "Fig. X" patterns
  const captionRegex = /(?:Figure|Fig\.?)\s*\d+\.?\s*[^\n]*/gi;
  const matches = markdown.match(captionRegex);

  if (matches && matches[figureIndex]) {
    return matches[figureIndex].trim();
  }

  return null;
}

// ==========================================
// Schema Mapping Utilities
// ==========================================

/**
 * Map extracted table to CerebellarSDCSchema fields
 * Returns field paths and values that can be applied to the schema
 */
export function mapTableToSchemaFields(
  table: ExtractedTable
): Array<{ field: string; value: any; sourceText: string }> {
  const mappings: Array<{ field: string; value: any; sourceText: string }> = [];

  switch (table.tableType) {
    case "demographics":
      mappings.push(...mapDemographicsTable(table));
      break;
    case "outcomes":
      mappings.push(...mapOutcomesTable(table));
      break;
    case "baseline":
      mappings.push(...mapBaselineTable(table));
      break;
    case "complications":
      mappings.push(...mapComplicationsTable(table));
      break;
    case "flowchart":
      mappings.push(...mapFlowchartTable(table));
      break;
    default:
      // Generic mapping for unknown table types
      break;
  }

  return mappings;
}

/**
 * Map demographics table to population schema fields
 */
function mapDemographicsTable(
  table: ExtractedTable
): Array<{ field: string; value: any; sourceText: string }> {
  const mappings: Array<{ field: string; value: any; sourceText: string }> = [];
  const headerLower = table.headers.map((h) => h.toLowerCase());

  // Find relevant columns
  const ageIdx = headerLower.findIndex((h) => h.includes("age"));
  const nIdx = headerLower.findIndex((h) => h === "n" || h.includes("patients"));
  const maleIdx = headerLower.findIndex((h) => h.includes("male"));
  const gcsIdx = headerLower.findIndex((h) => h.includes("gcs"));

  for (const row of table.rows) {
    // Extract age if found (look for mean ± SD pattern)
    if (ageIdx >= 0 && row[ageIdx]) {
      const ageMatch = row[ageIdx].match(/(\d+\.?\d*)\s*[±+]\s*(\d+\.?\d*)/);
      if (ageMatch) {
        mappings.push({
          field: "population.age.mean.value",
          value: parseFloat(ageMatch[1]),
          sourceText: row[ageIdx],
        });
        mappings.push({
          field: "population.age.sd.value",
          value: parseFloat(ageMatch[2]),
          sourceText: row[ageIdx],
        });
      }
    }

    // Extract sample size
    if (nIdx >= 0 && row[nIdx]) {
      const n = parseInt(row[nIdx].replace(/[^\d]/g, ""), 10);
      if (!isNaN(n)) {
        mappings.push({
          field: "population.sampleSize",
          value: n,
          sourceText: row[nIdx],
        });
      }
    }

    // Extract GCS
    if (gcsIdx >= 0 && row[gcsIdx]) {
      const gcsMatch = row[gcsIdx].match(/(\d+\.?\d*)/);
      if (gcsMatch) {
        mappings.push({
          field: "population.gcs.median.value",
          value: parseFloat(gcsMatch[1]),
          sourceText: row[gcsIdx],
        });
      }
    }
  }

  return mappings;
}

/**
 * Map outcomes table to outcomes schema fields
 */
function mapOutcomesTable(
  table: ExtractedTable
): Array<{ field: string; value: any; sourceText: string }> {
  const mappings: Array<{ field: string; value: any; sourceText: string }> = [];
  const headerLower = table.headers.map((h) => h.toLowerCase());

  const mortalityIdx = headerLower.findIndex((h) => h.includes("mortality") || h.includes("death"));
  const mrsIdx = headerLower.findIndex((h) => h.includes("mrs") || h.includes("rankin"));

  for (const row of table.rows) {
    // Extract mortality
    if (mortalityIdx >= 0 && row[mortalityIdx]) {
      const percentMatch = row[mortalityIdx].match(/(\d+\.?\d*)\s*%/);
      const countMatch = row[mortalityIdx].match(/(\d+)\s*\/\s*(\d+)/);

      if (percentMatch) {
        mappings.push({
          field: "outcomes.mortality.value",
          value: parseFloat(percentMatch[1]),
          sourceText: row[mortalityIdx],
        });
      } else if (countMatch) {
        const percentage = (parseInt(countMatch[1]) / parseInt(countMatch[2])) * 100;
        mappings.push({
          field: "outcomes.mortality.value",
          value: parseFloat(percentage.toFixed(1)),
          sourceText: row[mortalityIdx],
        });
      }
    }

    // Extract mRS favorable
    if (mrsIdx >= 0 && row[mrsIdx]) {
      const percentMatch = row[mrsIdx].match(/(\d+\.?\d*)\s*%/);
      if (percentMatch) {
        mappings.push({
          field: "outcomes.mRS_favorable.value",
          value: parseFloat(percentMatch[1]),
          sourceText: row[mrsIdx],
        });
      }
    }
  }

  return mappings;
}

/**
 * Map baseline characteristics table
 */
function mapBaselineTable(
  table: ExtractedTable
): Array<{ field: string; value: any; sourceText: string }> {
  const mappings: Array<{ field: string; value: any; sourceText: string }> = [];
  const headerLower = table.headers.map((h) => h.toLowerCase());

  const hydroIdx = headerLower.findIndex((h) => h.includes("hydrocephalus"));
  const infarctIdx = headerLower.findIndex((h) => h.includes("infarct"));
  const hemorrhageIdx = headerLower.findIndex((h) => h.includes("hemorrhage") || h.includes("bleed"));

  for (const row of table.rows) {
    // Extract hydrocephalus percentage
    if (hydroIdx >= 0 && row[hydroIdx]) {
      const percentMatch = row[hydroIdx].match(/(\d+\.?\d*)\s*%/);
      if (percentMatch) {
        mappings.push({
          field: "population.hydrocephalus.percentage.value",
          value: parseFloat(percentMatch[1]),
          sourceText: row[hydroIdx],
        });
      }
    }
  }

  return mappings;
}

/**
 * Map complications table
 */
function mapComplicationsTable(
  table: ExtractedTable
): Array<{ field: string; value: any; sourceText: string }> {
  // Complications are free-form, return as array of strings
  const complications: string[] = [];

  for (const row of table.rows) {
    if (row[0]) {
      complications.push(row.join(" - "));
    }
  }

  if (complications.length > 0) {
    return [
      {
        field: "outcomes.complications.value",
        value: complications,
        sourceText: table.markdownTable,
      },
    ];
  }

  return [];
}

/**
 * Map flowchart/patient flow table
 */
function mapFlowchartTable(
  table: ExtractedTable
): Array<{ field: string; value: any; sourceText: string }> {
  const mappings: Array<{ field: string; value: any; sourceText: string }> = [];

  // Look for enrollment/sample size in flowchart
  for (const row of table.rows) {
    const rowText = row.join(" ").toLowerCase();

    if (rowText.includes("enrolled") || rowText.includes("included")) {
      const nMatch = row.join(" ").match(/(\d+)/);
      if (nMatch) {
        mappings.push({
          field: "population.sampleSize",
          value: parseInt(nMatch[1]),
          sourceText: row.join(" "),
        });
      }
    }
  }

  return mappings;
}

// ==========================================
// Export for Genkit Integration
// ==========================================

export const mistralOCR = {
  extract: extractWithMistralOCR,
  extractTables: extractTablesWithMistral,
  extractFigures: extractFiguresWithMistral,
  mapTableToSchema: mapTableToSchemaFields,
  schemas: {
    table: ExtractedTableSchema,
    figure: ExtractedFigureSchema,
    result: MistralOCRResultSchema,
  },
};
