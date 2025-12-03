/**
 * Chat Tools Module
 *
 * Provides tools that the chat model can invoke for:
 * - RAG-based PDF section search
 * - Table data extraction
 * - Section summarization
 * - Study comparison
 */

import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";
import {ChunkSchema, type Chunk} from "../chunking.js";

// Initialize Genkit for tools
const ai = genkit({
  plugins: [googleAI()],
});

// ==========================================
// Tool Schemas
// ==========================================

export const SearchResultSchema = z.object({
  chunks: z.array(ChunkSchema),
  totalMatches: z.number(),
  query: z.string(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const TableDataSchema = z.object({
  tableId: z.string(),
  caption: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  sourceSection: z.string().optional(),
});

export type TableData = z.infer<typeof TableDataSchema>;

export const SectionSummarySchema = z.object({
  sectionName: z.string(),
  summary: z.string(),
  keyFindings: z.array(z.string()),
  dataPoints: z.array(z.object({
    label: z.string(),
    value: z.string(),
    confidence: z.number().optional(),
  })),
});

export type SectionSummary = z.infer<typeof SectionSummarySchema>;

// ==========================================
// Tool Definitions
// ==========================================

/**
 * Search PDF sections using RAG
 * This tool allows the chat model to dynamically retrieve relevant sections
 * instead of having the entire PDF in context
 */
export const searchPdfSectionsTool = ai.defineTool(
  {
    name: "searchPdfSections",
    description: `Search for relevant sections in the PDF document based on a query.
Use this when:
- The user asks about specific topics (e.g., "mortality rates", "surgical technique")
- You need to find supporting evidence for a claim
- You want to cite specific sections of the paper
Returns the most relevant text chunks with page numbers.`,
    inputSchema: z.object({
      query: z.string().describe("Search query to find relevant sections"),
      maxResults: z.number().default(3).describe("Maximum number of chunks to return"),
    }),
    outputSchema: SearchResultSchema,
  },
  async ({query, maxResults}) => {
    // This will be connected to the actual RAG retriever in flows.ts
    // For now, return a placeholder that will be overridden
    console.log(`🔍 Tool: Searching PDF for "${query}" (max ${maxResults} results)`);
    return {
      chunks: [],
      totalMatches: 0,
      query,
    };
  }
);

/**
 * Extract data from a specific table in the PDF
 */
export const extractTableDataTool = ai.defineTool(
  {
    name: "extractTableData",
    description: `Extract structured data from a table in the PDF.
Use this when:
- The user asks about specific data in tables (e.g., "patient demographics", "outcomes by group")
- You need numerical data from the study
- You want to compare values across groups`,
    inputSchema: z.object({
      tableDescription: z.string().describe("Description of the table to find (e.g., 'patient demographics', 'mortality rates')"),
    }),
    outputSchema: z.object({
      found: z.boolean(),
      table: TableDataSchema.optional(),
      message: z.string(),
    }),
  },
  async ({tableDescription}) => {
    console.log(`📊 Tool: Extracting table "${tableDescription}"`);
    return {
      found: false,
      message: "Table extraction pending implementation",
    };
  }
);

/**
 * Summarize a specific section of the paper
 */
export const summarizeSectionTool = ai.defineTool(
  {
    name: "summarizeSection",
    description: `Summarize a specific section of the paper (Abstract, Methods, Results, Discussion, etc.).
Use this when:
- The user asks for a summary of a section
- You need to provide an overview before diving into details
- You want to extract key findings from a section`,
    inputSchema: z.object({
      sectionName: z.enum([
        "abstract",
        "introduction",
        "methods",
        "results",
        "discussion",
        "conclusion",
      ]).describe("Name of the section to summarize"),
    }),
    outputSchema: SectionSummarySchema,
  },
  async ({sectionName}) => {
    console.log(`📝 Tool: Summarizing ${sectionName} section`);
    return {
      sectionName,
      summary: "Section summarization pending implementation",
      keyFindings: [],
      dataPoints: [],
    };
  }
);

/**
 * Get the study's key extracted data points
 */
export const getExtractedDataTool = ai.defineTool(
  {
    name: "getExtractedData",
    description: `Get the structured data that was extracted from this study.
Use this when:
- The user asks about specific extracted fields (mortality, sample size, etc.)
- You need to provide precise data points with source citations
- You want to verify extracted values`,
    inputSchema: z.object({
      fields: z.array(z.string()).optional().describe("Specific fields to retrieve (e.g., ['mortality', 'sampleSize']). Leave empty for all."),
    }),
    outputSchema: z.object({
      data: z.any(),
      availableFields: z.array(z.string()),
    }),
  },
  async ({fields}) => {
    console.log(`📋 Tool: Getting extracted data for fields:`, fields || "all");
    return {
      data: null,
      availableFields: [],
    };
  }
);

/**
 * Compare this study with another in the database
 */
export const compareStudiesTool = ai.defineTool(
  {
    name: "compareStudies",
    description: `Compare this study with another study in the database.
Use this when:
- The user wants to compare outcomes between studies
- You need to contextualize results relative to other research
- You want to identify similarities or differences`,
    inputSchema: z.object({
      otherStudyId: z.string().optional().describe("ID of the other study to compare with"),
      comparisonFields: z.array(z.string()).describe("Fields to compare (e.g., ['mortality', 'sampleSize', 'technique'])"),
    }),
    outputSchema: z.object({
      comparisonAvailable: z.boolean(),
      comparison: z.any().optional(),
      message: z.string(),
    }),
  },
  async ({otherStudyId, comparisonFields}) => {
    console.log(`🔄 Tool: Comparing studies on fields:`, comparisonFields);
    return {
      comparisonAvailable: false,
      message: "Study comparison pending implementation",
    };
  }
);

// ==========================================
// Tool Collection
// ==========================================

/**
 * All available chat tools
 * These are passed to the generate() call in sendChatMessage
 */
export const chatTools = [
  searchPdfSectionsTool,
  extractTableDataTool,
  summarizeSectionTool,
  getExtractedDataTool,
  compareStudiesTool,
];

/**
 * Get tool names for logging/debugging
 */
export function getToolNames(): string[] {
  return chatTools.map((t) => t.__action.name);
}

// ==========================================
// Tool Implementation Helpers
// ==========================================

/**
 * Create a search tool implementation with actual retriever
 * This is called from flows.ts to create a working search tool
 */
export function createSearchToolImpl(
  retrieverFn: (query: string, k: number) => Promise<Chunk[]>
) {
  return ai.defineTool(
    {
      name: "searchPdfSections",
      description: searchPdfSectionsTool.__action.description!,
      inputSchema: z.object({
        query: z.string().describe("Search query to find relevant sections"),
        maxResults: z.number().default(3).describe("Maximum number of chunks to return"),
      }),
      outputSchema: SearchResultSchema,
    },
    async ({query, maxResults}) => {
      console.log(`🔍 Tool: Searching PDF for "${query}"`);
      const chunks = await retrieverFn(query, maxResults);
      return {
        chunks,
        totalMatches: chunks.length,
        query,
      };
    }
  );
}

/**
 * Create an extracted data tool with actual data access
 */
export function createExtractedDataToolImpl(
  getDataFn: (fields?: string[]) => Promise<{data: any; availableFields: string[]}>
) {
  return ai.defineTool(
    {
      name: "getExtractedData",
      description: getExtractedDataTool.__action.description!,
      inputSchema: z.object({
        fields: z.array(z.string()).optional().describe("Specific fields to retrieve"),
      }),
      outputSchema: z.object({
        data: z.any(),
        availableFields: z.array(z.string()),
      }),
    },
    async ({fields}) => {
      console.log(`📋 Tool: Getting extracted data`);
      return await getDataFn(fields);
    }
  );
}
