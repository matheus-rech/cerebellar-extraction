/**
 * Smart PDF Chunking for RAG
 *
 * Implements semantic chunking strategies for large PDFs:
 * 1. Paragraph-based chunking with sentence boundary respect
 * 2. Overlapping windows for context preservation
 * 3. Token-aware splitting to fit LLM context windows
 * 4. Metadata preservation (page numbers, positions)
 */

import { z } from "genkit";

// ==========================================
// Schemas
// ==========================================

export const ChunkSchema = z.object({
  id: z.string().describe("Unique chunk identifier"),
  text: z.string().describe("Chunk text content"),
  metadata: z.object({
    pageStart: z.number().describe("Starting page number"),
    pageEnd: z.number().describe("Ending page number"),
    charStart: z.number().describe("Starting character position"),
    charEnd: z.number().describe("Ending character position"),
    sectionType: z.string().optional().describe("Detected section type (Abstract, Methods, Results, etc.)"),
    tokenCount: z.number().optional().describe("Estimated token count"),
  }),
});

export type Chunk = z.infer<typeof ChunkSchema>;

export const ChunkingOptionsSchema = z.object({
  maxChunkSize: z.number().default(1500).describe("Maximum tokens per chunk"),
  minChunkSize: z.number().default(100).describe("Minimum tokens per chunk"),
  overlap: z.number().default(200).describe("Token overlap between chunks"),
  respectSentenceBoundaries: z.boolean().default(true),
  respectParagraphBoundaries: z.boolean().default(true),
  preserveSections: z.boolean().default(true).describe("Keep section headers with their content"),
});

export type ChunkingOptions = z.infer<typeof ChunkingOptionsSchema>;

// Partial version for function parameters that accept partial options
export type PartialChunkingOptions = Partial<ChunkingOptions>;

// Partial schema for Genkit flows that accept partial options
export const PartialChunkingOptionsSchema = z.object({
  maxChunkSize: z.number().optional().describe("Maximum tokens per chunk"),
  minChunkSize: z.number().optional().describe("Minimum tokens per chunk"),
  overlap: z.number().optional().describe("Token overlap between chunks"),
  respectSentenceBoundaries: z.boolean().optional(),
  respectParagraphBoundaries: z.boolean().optional(),
  preserveSections: z.boolean().optional().describe("Keep section headers with their content"),
});

// Default options constant
export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxChunkSize: 1500,
  minChunkSize: 100,
  overlap: 200,
  respectSentenceBoundaries: true,
  respectParagraphBoundaries: true,
  preserveSections: true,
};

// ==========================================
// Token Estimation
// ==========================================

/**
 * Estimate token count from text
 * Uses simple heuristic: ~4 characters per token for English
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ==========================================
// Text Segmentation
// ==========================================

/**
 * Split text into sentences
 * Handles abbreviations, decimal numbers, and academic citations
 */
export function splitIntoSentences(text: string): string[] {
  // Patterns that look like sentence endings but aren't
  const placeholders: Map<string, string> = new Map();
  let processedText = text;

  // Preserve common abbreviations
  const abbreviations = [
    "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "et al.", "vs.", "i.e.", "e.g.",
    "Fig.", "Tab.", "Ref.", "No.", "Vol.", "pp.", "Inc.", "Ltd.", "Corp.",
    "Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec.",
  ];

  abbreviations.forEach((abbr, idx) => {
    const placeholder = `__ABBR_${idx}__`;
    placeholders.set(placeholder, abbr);
    processedText = processedText.split(abbr).join(placeholder);
  });

  // Preserve decimal numbers (e.g., "3.5", "p<0.001")
  processedText = processedText.replace(/(\d+)\.(\d+)/g, "$1__DOT__$2");

  // Split on sentence-ending punctuation followed by space/newline and capital letter
  const sentencePattern = /([.!?])\s+(?=[A-Z])/g;
  const rawSentences = processedText.split(sentencePattern);

  // Reconstruct sentences (pattern splits removes the punctuation)
  const sentences: string[] = [];
  for (let i = 0; i < rawSentences.length; i += 2) {
    let sentence = rawSentences[i];
    if (i + 1 < rawSentences.length) {
      sentence += rawSentences[i + 1];
    }

    // Restore abbreviations and decimal points
    placeholders.forEach((abbr, placeholder) => {
      sentence = sentence.split(placeholder).join(abbr);
    });
    sentence = sentence.replace(/__DOT__/g, ".");

    if (sentence.trim()) {
      sentences.push(sentence.trim());
    }
  }

  return sentences;
}

/**
 * Split text into paragraphs
 */
export function splitIntoParagraphs(text: string): string[] {
  // Split on double newlines or single newline followed by indent
  return text
    .split(/\n\s*\n|\n(?=\s{2,})/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ==========================================
// Section Detection
// ==========================================

const SECTION_PATTERNS = [
  { type: "abstract", pattern: /^abstract[:\s]/i },
  { type: "introduction", pattern: /^(introduction|background)[:\s]/i },
  { type: "methods", pattern: /^(methods|materials and methods|methodology|study design)[:\s]/i },
  { type: "results", pattern: /^results[:\s]/i },
  { type: "discussion", pattern: /^discussion[:\s]/i },
  { type: "conclusion", pattern: /^(conclusion|conclusions|summary)[:\s]/i },
  { type: "references", pattern: /^(references|bibliography)[:\s]/i },
  { type: "tables", pattern: /^table\s+\d+/i },
  { type: "figures", pattern: /^(figure|fig\.?)\s+\d+/i },
];

/**
 * Detect section type from text
 */
export function detectSectionType(text: string): string | undefined {
  const firstLine = text.split("\n")[0].trim();
  for (const { type, pattern } of SECTION_PATTERNS) {
    if (pattern.test(firstLine)) {
      return type;
    }
  }
  return undefined;
}

// ==========================================
// Chunking Algorithms
// ==========================================

/**
 * Basic fixed-size chunking with overlap
 */
export function fixedSizeChunk(
  text: string,
  maxTokens: number,
  overlapTokens: number
): Chunk[] {
  const chunks: Chunk[] = [];
  const textLength = text.length;
  const charsPerToken = 4;
  const maxChars = maxTokens * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;

  let start = 0;
  let chunkIndex = 0;

  while (start < textLength) {
    const end = Math.min(start + maxChars, textLength);
    const chunkText = text.substring(start, end);

    chunks.push({
      id: `chunk_${chunkIndex}`,
      text: chunkText,
      metadata: {
        pageStart: 1,
        pageEnd: 1,
        charStart: start,
        charEnd: end,
        tokenCount: estimateTokens(chunkText),
      },
    });

    // Move start position, accounting for overlap
    start = end - overlapChars;
    if (start >= textLength) break;
    chunkIndex++;
  }

  return chunks;
}

/**
 * Semantic chunking that respects sentence and paragraph boundaries
 */
export function semanticChunk(
  text: string,
  options: PartialChunkingOptions = {}
): Chunk[] {
  const opts: Required<ChunkingOptions> = {
    maxChunkSize: options.maxChunkSize ?? 1500,
    minChunkSize: options.minChunkSize ?? 100,
    overlap: options.overlap ?? 200,
    respectSentenceBoundaries: options.respectSentenceBoundaries ?? true,
    respectParagraphBoundaries: options.respectParagraphBoundaries ?? true,
    preserveSections: options.preserveSections ?? true,
  };

  const chunks: Chunk[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;
  let charPosition = 0;

  // Split into paragraphs first
  const paragraphs = splitIntoParagraphs(text);

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);

    // Check if adding this paragraph exceeds max size
    if (currentTokens + paragraphTokens > opts.maxChunkSize && currentChunk.length > 0) {
      // Finalize current chunk
      const chunkText = currentChunk.join("\n\n");
      chunks.push({
        id: `chunk_${chunkIndex}`,
        text: chunkText,
        metadata: {
          pageStart: 1,
          pageEnd: 1,
          charStart: charPosition - chunkText.length,
          charEnd: charPosition,
          sectionType: detectSectionType(chunkText),
          tokenCount: currentTokens,
        },
      });
      chunkIndex++;

      // Start new chunk with overlap from previous
      if (opts.overlap > 0 && chunks.length > 0) {
        const overlapText = getOverlapText(chunks[chunks.length - 1].text, opts.overlap);
        currentChunk = overlapText ? [overlapText] : [];
        currentTokens = estimateTokens(currentChunk.join(""));
      } else {
        currentChunk = [];
        currentTokens = 0;
      }
    }

    // Handle paragraphs larger than max chunk size
    if (paragraphTokens > opts.maxChunkSize) {
      // Need to split the paragraph by sentences
      const sentences = splitIntoSentences(paragraph);
      for (const sentence of sentences) {
        const sentenceTokens = estimateTokens(sentence);

        if (currentTokens + sentenceTokens > opts.maxChunkSize && currentChunk.length > 0) {
          // Finalize chunk
          const chunkText = currentChunk.join(" ");
          chunks.push({
            id: `chunk_${chunkIndex}`,
            text: chunkText,
            metadata: {
              pageStart: 1,
              pageEnd: 1,
              charStart: charPosition - chunkText.length,
              charEnd: charPosition,
              sectionType: detectSectionType(chunkText),
              tokenCount: currentTokens,
            },
          });
          chunkIndex++;

          // Overlap handling
          if (opts.overlap > 0) {
            const overlapText = getOverlapText(chunkText, opts.overlap);
            currentChunk = overlapText ? [overlapText] : [];
            currentTokens = estimateTokens(currentChunk.join(""));
          } else {
            currentChunk = [];
            currentTokens = 0;
          }
        }

        currentChunk.push(sentence);
        currentTokens += sentenceTokens;
        charPosition += sentence.length + 1;
      }
    } else {
      currentChunk.push(paragraph);
      currentTokens += paragraphTokens;
      charPosition += paragraph.length + 2; // +2 for paragraph separator
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0 && currentTokens >= opts.minChunkSize) {
    const chunkText = currentChunk.join("\n\n");
    chunks.push({
      id: `chunk_${chunkIndex}`,
      text: chunkText,
      metadata: {
        pageStart: 1,
        pageEnd: 1,
        charStart: charPosition - chunkText.length,
        charEnd: charPosition,
        sectionType: detectSectionType(chunkText),
        tokenCount: currentTokens,
      },
    });
  }

  return chunks;
}

/**
 * Get overlap text from the end of a chunk
 */
function getOverlapText(text: string, overlapTokens: number): string {
  const sentences = splitIntoSentences(text);
  const result: string[] = [];
  let tokens = 0;

  // Work backwards through sentences
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentenceTokens = estimateTokens(sentences[i]);
    if (tokens + sentenceTokens > overlapTokens) {
      break;
    }
    result.unshift(sentences[i]);
    tokens += sentenceTokens;
  }

  return result.join(" ");
}

// ==========================================
// Page-Aware Chunking
// ==========================================

export interface PageText {
  pageNumber: number;
  text: string;
}

/**
 * Chunk text with page number awareness
 * Preserves page boundaries in metadata
 */
export function chunkWithPages(
  pages: PageText[],
  options: PartialChunkingOptions = {}
): Chunk[] {
  const opts: Required<ChunkingOptions> = {
    maxChunkSize: options.maxChunkSize ?? 1500,
    minChunkSize: options.minChunkSize ?? 100,
    overlap: options.overlap ?? 200,
    respectSentenceBoundaries: options.respectSentenceBoundaries ?? true,
    respectParagraphBoundaries: options.respectParagraphBoundaries ?? true,
    preserveSections: options.preserveSections ?? true,
  };

  const chunks: Chunk[] = [];
  let currentChunk: Array<{ text: string; page: number }> = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  for (const page of pages) {
    const paragraphs = splitIntoParagraphs(page.text);

    for (const paragraph of paragraphs) {
      const paragraphTokens = estimateTokens(paragraph);

      if (currentTokens + paragraphTokens > opts.maxChunkSize && currentChunk.length > 0) {
        // Finalize current chunk
        const chunkText = currentChunk.map((c) => c.text).join("\n\n");
        const pageStart = currentChunk[0].page;
        const pageEnd = currentChunk[currentChunk.length - 1].page;

        chunks.push({
          id: `chunk_${chunkIndex}`,
          text: chunkText,
          metadata: {
            pageStart,
            pageEnd,
            charStart: 0,
            charEnd: chunkText.length,
            sectionType: detectSectionType(chunkText),
            tokenCount: currentTokens,
          },
        });
        chunkIndex++;

        // Overlap handling
        if (opts.overlap > 0) {
          const overlapItems = getOverlapItems(currentChunk, opts.overlap);
          currentChunk = overlapItems;
          currentTokens = overlapItems.reduce((sum, item) => sum + estimateTokens(item.text), 0);
        } else {
          currentChunk = [];
          currentTokens = 0;
        }
      }

      currentChunk.push({ text: paragraph, page: page.pageNumber });
      currentTokens += paragraphTokens;
    }
  }

  // Final chunk
  if (currentChunk.length > 0 && currentTokens >= opts.minChunkSize) {
    const chunkText = currentChunk.map((c) => c.text).join("\n\n");
    const pageStart = currentChunk[0].page;
    const pageEnd = currentChunk[currentChunk.length - 1].page;

    chunks.push({
      id: `chunk_${chunkIndex}`,
      text: chunkText,
      metadata: {
        pageStart,
        pageEnd,
        charStart: 0,
        charEnd: chunkText.length,
        sectionType: detectSectionType(chunkText),
        tokenCount: currentTokens,
      },
    });
  }

  return chunks;
}

/**
 * Get overlap items from the end of chunk
 */
function getOverlapItems(
  items: Array<{ text: string; page: number }>,
  overlapTokens: number
): Array<{ text: string; page: number }> {
  const result: Array<{ text: string; page: number }> = [];
  let tokens = 0;

  for (let i = items.length - 1; i >= 0; i--) {
    const itemTokens = estimateTokens(items[i].text);
    if (tokens + itemTokens > overlapTokens) {
      break;
    }
    result.unshift(items[i]);
    tokens += itemTokens;
  }

  return result;
}

// ==========================================
// Medical Paper Specific Chunking
// ==========================================

/**
 * Chunk medical papers with section awareness
 * Keeps Methods, Results, and other sections together when possible
 */
export function chunkMedicalPaper(
  text: string,
  options: PartialChunkingOptions = {}
): Chunk[] {
  const opts: Required<ChunkingOptions> = {
    maxChunkSize: options.maxChunkSize ?? 2000,
    minChunkSize: options.minChunkSize ?? 100,
    overlap: options.overlap ?? 150,
    respectSentenceBoundaries: true,
    respectParagraphBoundaries: true,
    preserveSections: options.preserveSections ?? true,
  };

  // Try to identify major sections
  const sectionMarkers = [
    { pattern: /\b(abstract|summary)\b/i, priority: 1 },
    { pattern: /\b(introduction|background)\b/i, priority: 2 },
    { pattern: /\b(methods|materials and methods|patients and methods)\b/i, priority: 3 },
    { pattern: /\b(results)\b/i, priority: 4 },
    { pattern: /\b(discussion)\b/i, priority: 5 },
    { pattern: /\b(conclusion|conclusions)\b/i, priority: 6 },
    { pattern: /\b(references|bibliography)\b/i, priority: 7 },
  ];

  // Split by section headers
  const sections: Array<{ type: string; text: string; priority: number }> = [];
  let currentSection = { type: "preamble", text: "", priority: 0 };
  let remainingText = text;

  for (const marker of sectionMarkers) {
    const match = remainingText.match(marker.pattern);
    if (match && match.index !== undefined) {
      // Save previous section
      if (currentSection.text.trim()) {
        sections.push({ ...currentSection, text: currentSection.text.trim() });
      }

      // Find the end of this section (next section header or end of text)
      const startIdx = match.index;
      let endIdx = remainingText.length;

      for (const nextMarker of sectionMarkers) {
        if (nextMarker.priority > marker.priority) {
          const nextMatch = remainingText.slice(startIdx + match[0].length).match(nextMarker.pattern);
          if (nextMatch && nextMatch.index !== undefined) {
            endIdx = Math.min(endIdx, startIdx + match[0].length + nextMatch.index);
          }
        }
      }

      currentSection = {
        type: marker.pattern.source.replace(/\\b|\(|\)/g, "").split("|")[0],
        text: remainingText.slice(startIdx, endIdx),
        priority: marker.priority,
      };
    }
  }

  // Add last section
  if (currentSection.text.trim()) {
    sections.push({ ...currentSection, text: currentSection.text.trim() });
  }

  // If no sections detected, fall back to semantic chunking
  if (sections.length === 0) {
    return semanticChunk(text, opts);
  }

  // Chunk each section, preserving section type
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const sectionChunks = semanticChunk(section.text, opts);
    for (const chunk of sectionChunks) {
      chunks.push({
        ...chunk,
        id: `chunk_${chunkIndex}`,
        metadata: {
          ...chunk.metadata,
          sectionType: section.type,
        },
      });
      chunkIndex++;
    }
  }

  return chunks;
}

// ==========================================
// Exports
// ==========================================

export default {
  estimateTokens,
  splitIntoSentences,
  splitIntoParagraphs,
  detectSectionType,
  fixedSizeChunk,
  semanticChunk,
  chunkWithPages,
  chunkMedicalPaper,
};
