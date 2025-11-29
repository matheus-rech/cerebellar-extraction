/**
 * Citation Module
 *
 * Provides citation tracking for RAG-based chat responses.
 * Structure inspired by Firebase AI Citation interface and
 * Google Gemini GroundingMetadata.
 *
 * @see https://firebase.google.com/docs/reference/js/ai.citation
 * @see https://ai.google.dev/gemini-api/docs/google-search
 */

import {z} from "genkit";
import {type Chunk} from "../chunking.js";

// ==========================================
// Citation Schemas (Firebase AI compatible)
// ==========================================

/**
 * A segment of text in the response that is supported by a citation
 */
export const SegmentSchema = z.object({
  startIndex: z.number().describe("Start character index in response text"),
  endIndex: z.number().describe("End character index in response text"),
  text: z.string().describe("The text segment being cited"),
});

export type Segment = z.infer<typeof SegmentSchema>;

/**
 * A grounding chunk - the source that supports a claim
 * Compatible with Firebase GroundingChunk structure
 */
export const GroundingChunkSchema = z.object({
  // Web-like source (for our PDF chunks)
  source: z.object({
    uri: z.string().optional().describe("Source URI or page reference"),
    title: z.string().describe("Source title or section header"),
    content: z.string().describe("The actual source text"),
  }),
  // PDF-specific metadata
  metadata: z.object({
    chunkId: z.string().describe("Unique chunk identifier"),
    pageNumber: z.number().optional().describe("Page number in PDF"),
    section: z.string().optional().describe("Section name (Abstract, Methods, etc.)"),
    charStart: z.number().optional().describe("Character start position in original PDF"),
    charEnd: z.number().optional().describe("Character end position in original PDF"),
  }),
});

export type GroundingChunk = z.infer<typeof GroundingChunkSchema>;

/**
 * Links response segments to their supporting sources
 * Compatible with Firebase GroundingSupport structure
 */
export const GroundingSupportSchema = z.object({
  segment: SegmentSchema.describe("The response text segment"),
  groundingChunkIndices: z.array(z.number()).describe("Indices into groundingChunks array"),
  confidenceScores: z.array(z.number()).optional().describe("Confidence scores (0-1) for each source"),
});

export type GroundingSupport = z.infer<typeof GroundingSupportSchema>;

/**
 * Complete citation metadata for a response
 * Compatible with Firebase CitationMetadata / GroundingMetadata
 */
export const CitationMetadataSchema = z.object({
  // The chunks that were retrieved to answer the query
  groundingChunks: z.array(GroundingChunkSchema).describe("Source chunks used for grounding"),

  // Links between response segments and source chunks
  groundingSupports: z.array(GroundingSupportSchema).optional()
    .describe("Mappings from response text to source chunks"),

  // The search queries that were used
  retrievalQueries: z.array(z.string()).optional()
    .describe("Search queries executed against the PDF"),

  // Summary statistics
  totalChunksRetrieved: z.number().describe("Total number of chunks retrieved"),
  avgRelevanceScore: z.number().optional().describe("Average relevance score of retrieved chunks"),
});

export type CitationMetadata = z.infer<typeof CitationMetadataSchema>;

/**
 * A single inline citation (simplified for UI display)
 */
export const InlineCitationSchema = z.object({
  id: z.string().describe("Citation ID (e.g., [1], [2])"),
  sourceText: z.string().describe("The quoted source text"),
  pageNumber: z.number().optional().describe("Page number"),
  section: z.string().optional().describe("Section name"),
  relevanceScore: z.number().optional().describe("How relevant this source was (0-1)"),
});

export type InlineCitation = z.infer<typeof InlineCitationSchema>;

// ==========================================
// Citation Utilities
// ==========================================

/**
 * Convert retrieved chunks to grounding chunks
 */
export function chunksToGroundingChunks(
  chunks: Chunk[],
  scores?: number[]
): GroundingChunk[] {
  return chunks.map((chunk, i) => ({
    source: {
      uri: chunk.metadata?.pageStart
        ? `page:${chunk.metadata.pageStart}`
        : `chunk:${chunk.id}`,
      title: chunk.metadata?.sectionType || `Chunk ${i + 1}`,
      content: chunk.text,
    },
    metadata: {
      chunkId: chunk.id,
      pageNumber: chunk.metadata?.pageStart,
      section: chunk.metadata?.sectionType,
      charStart: chunk.metadata?.charStart,
      charEnd: chunk.metadata?.charEnd,
    },
  }));
}

/**
 * Create citation metadata from retrieved chunks
 */
export function createCitationMetadata(
  chunks: Chunk[],
  queries: string[],
  scores?: number[]
): CitationMetadata {
  const groundingChunks = chunksToGroundingChunks(chunks, scores);

  return {
    groundingChunks,
    retrievalQueries: queries,
    totalChunksRetrieved: chunks.length,
    avgRelevanceScore: scores?.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined,
  };
}

/**
 * Extract inline citations from response text
 * Looks for patterns like [1], [2], or "According to..." patterns
 */
export function extractInlineCitations(
  responseText: string,
  groundingChunks: GroundingChunk[]
): InlineCitation[] {
  const citations: InlineCitation[] = [];

  // Look for [n] citation markers
  const citationPattern = /\[(\d+)\]/g;
  let match;

  while ((match = citationPattern.exec(responseText)) !== null) {
    const index = parseInt(match[1], 10) - 1; // Citations are 1-indexed
    if (index >= 0 && index < groundingChunks.length) {
      const chunk = groundingChunks[index];
      citations.push({
        id: match[0],
        sourceText: truncateText(chunk.source.content, 200),
        pageNumber: chunk.metadata.pageNumber,
        section: chunk.metadata.section,
      });
    }
  }

  // If no explicit citations found, create citations from all chunks
  if (citations.length === 0 && groundingChunks.length > 0) {
    groundingChunks.forEach((chunk, i) => {
      citations.push({
        id: `[${i + 1}]`,
        sourceText: truncateText(chunk.source.content, 200),
        pageNumber: chunk.metadata.pageNumber,
        section: chunk.metadata.section,
      });
    });
  }

  return citations;
}

/**
 * Format citations for display in chat
 */
export function formatCitationsForDisplay(citations: InlineCitation[]): string {
  if (citations.length === 0) return "";

  const lines = citations.map((c) => {
    const location = c.pageNumber
      ? `Page ${c.pageNumber}${c.section ? `, ${c.section}` : ""}`
      : c.section || "Source";
    return `${c.id} ${location}: "${c.sourceText}"`;
  });

  return `\n\n📚 Sources:\n${lines.join("\n")}`;
}

/**
 * Add citation markers to response text based on chunk matches
 */
export function addCitationMarkers(
  responseText: string,
  groundingChunks: GroundingChunk[]
): {text: string; supports: GroundingSupport[]} {
  const supports: GroundingSupport[] = [];
  let markedText = responseText;
  let offset = 0;

  // Find text segments that match source chunks
  groundingChunks.forEach((chunk, chunkIndex) => {
    // Extract key phrases from the chunk (first sentence or first 100 chars)
    const keyPhrases = extractKeyPhrases(chunk.source.content);

    keyPhrases.forEach((phrase) => {
      const lowerResponse = markedText.toLowerCase();
      const lowerPhrase = phrase.toLowerCase();
      let searchStart = 0;

      while (true) {
        const foundIndex = lowerResponse.indexOf(lowerPhrase, searchStart);
        if (foundIndex === -1) break;

        // Check if this segment is already cited
        const alreadyCited = supports.some(
          (s) => s.segment.startIndex <= foundIndex && s.segment.endIndex >= foundIndex + phrase.length
        );

        if (!alreadyCited) {
          // Add citation marker after the phrase
          const insertPos = foundIndex + phrase.length + offset;
          const marker = `[${chunkIndex + 1}]`;

          // Only add if not already has a citation marker
          if (!markedText.slice(insertPos, insertPos + 5).match(/^\[\d+\]/)) {
            markedText = markedText.slice(0, insertPos) + marker + markedText.slice(insertPos);
            offset += marker.length;
          }

          supports.push({
            segment: {
              startIndex: foundIndex,
              endIndex: foundIndex + phrase.length,
              text: phrase,
            },
            groundingChunkIndices: [chunkIndex],
          });
        }

        searchStart = foundIndex + phrase.length;
      }
    });
  });

  return {text: markedText, supports};
}

/**
 * Extract key phrases from source text for matching
 */
function extractKeyPhrases(text: string): string[] {
  const phrases: string[] = [];

  // Extract numbers with context (e.g., "23.5%", "n=42", "p<0.05")
  const numberPatterns = [
    /\d+\.?\d*\s*%/g, // Percentages
    /n\s*=\s*\d+/gi, // Sample sizes
    /p\s*[<>=]\s*0\.\d+/gi, // P-values
    /\d+\s*±\s*\d+\.?\d*/g, // Mean ± SD
    /\d+\.?\d*\s*-\s*\d+\.?\d*/g, // Ranges
    /\d+\.?\d*\s*\(\s*\d+\.?\d*\s*-\s*\d+\.?\d*\s*\)/g, // Values with CI
  ];

  numberPatterns.forEach((pattern) => {
    const matches = text.match(pattern) || [];
    phrases.push(...matches);
  });

  // Extract medical terms (simplified - in production use NLP)
  const medicalTerms = [
    "mortality", "mRS", "GCS", "GOS", "hydrocephalus", "craniectomy",
    "decompressive", "infarction", "hemorrhage", "EVD", "duraplasty",
    "hematoma", "edema", "herniation", "outcome", "complication",
  ];

  medicalTerms.forEach((term) => {
    const regex = new RegExp(`[^.]*\\b${term}\\b[^.]*\\.?`, "gi");
    const matches = text.match(regex) || [];
    phrases.push(...matches.filter((m) => m.length > 10 && m.length < 150));
  });

  // Remove duplicates and very short phrases
  return [...new Set(phrases)].filter((p) => p.length > 3);
}

/**
 * Truncate text to max length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3).trim() + "...";
}

/**
 * Create a citation summary for logging
 */
export function summarizeCitations(metadata: CitationMetadata): string {
  const lines = [
    `📚 Citations: ${metadata.groundingChunks.length} sources`,
  ];

  if (metadata.retrievalQueries?.length) {
    lines.push(`   Queries: ${metadata.retrievalQueries.join(", ")}`);
  }

  if (metadata.avgRelevanceScore) {
    lines.push(`   Avg relevance: ${(metadata.avgRelevanceScore * 100).toFixed(1)}%`);
  }

  metadata.groundingChunks.slice(0, 3).forEach((chunk, i) => {
    const loc = chunk.metadata.pageNumber
      ? `p.${chunk.metadata.pageNumber}`
      : chunk.metadata.section || "source";
    lines.push(`   [${i + 1}] ${loc}: "${truncateText(chunk.source.content, 60)}"`);
  });

  if (metadata.groundingChunks.length > 3) {
    lines.push(`   ... and ${metadata.groundingChunks.length - 3} more`);
  }

  return lines.join("\n");
}
