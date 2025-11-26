/**
 * Claude Native Citations Extractor
 *
 * Uses Claude's built-in citation system for verified source attribution.
 * Returns character-level positions that can be mapped to PDF coordinates.
 *
 * Key advantage: Citations are extracted by Claude, not hallucinated.
 * The API guarantees valid character indices within the source document.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  extractTextWithPositions,
  mapCitationToHighlights,
  CitationHighlight,
  PDFTextWithPositions,
} from "./pdf-positions.js";

// Types for Claude's citation response
interface CharLocationCitation {
  type: "char_location";
  cited_text: string;
  document_index: number;
  start_char_index: number;
  end_char_index: number;
}

interface TextBlockWithCitations {
  type: "text";
  text: string;
  citations?: CharLocationCitation[];
}

interface ContentBlock {
  type: string;
  text?: string;
  citations?: CharLocationCitation[];
}

export interface ExtractedFieldWithCitation {
  field: string;
  value: string | number | boolean | null;
  citation: {
    text: string;
    startChar: number;
    endChar: number;
  } | null;
  highlights: CitationHighlight[];
}

export interface ExtractionResult {
  fields: ExtractedFieldWithCitation[];
  rawResponse: ContentBlock[];
  pdfPositions: PDFTextWithPositions;
}

/**
 * Initialize Anthropic client
 */
function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable required");
  }
  return new Anthropic({apiKey});
}

/**
 * Extract data from PDF with native Claude citations
 */
export async function extractWithCitations(
  pdfPath: string,
  extractionPrompt: string
): Promise<ExtractionResult> {
  const client = getClient();

  // 1. Extract text with positions
  console.log("📄 Extracting text with positions...");
  const pdfData = await extractTextWithPositions(pdfPath);
  console.log(`   ✅ ${pdfData.text.length} chars, ${pdfData.positions.length} position items`);

  // 2. Call Claude with citations enabled
  console.log("🤖 Calling Claude with native citations...");
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: Buffer.from(pdfData.text).toString("base64"),
            },
            citations: {enabled: true},
          },
          {
            type: "text",
            text: extractionPrompt,
          },
        ],
      },
    ],
  });

  // 3. Parse response and extract citations
  const fields: ExtractedFieldWithCitation[] = [];
  const rawContent = response.content as ContentBlock[];

  for (const block of rawContent) {
    if (block.type === "text" && block.citations) {
      for (const citation of block.citations) {
        if (citation.type === "char_location") {
          // Decode base64 cited_text
          const decodedCitedText = Buffer.from(citation.cited_text, "base64").toString("utf-8");

          // Map citation to PDF highlights using char indices
          const highlights = mapCitationToHighlights(
            citation.start_char_index,
            citation.end_char_index,
            pdfData.positions
          );

          fields.push({
            field: "extracted_value",
            value: block.text || null,
            citation: {
              text: decodedCitedText,
              startChar: citation.start_char_index,
              endChar: citation.end_char_index,
            },
            highlights,
          });
        }
      }
    }
  }

  return {
    fields,
    rawResponse: rawContent,
    pdfPositions: pdfData,
  };
}

/**
 * Structured extraction with specific fields and citations
 */
export async function extractCerebellarDataWithCitations(pdfPath: string): Promise<ExtractionResult> {
  const prompt = `Extract the following data from this cerebellar stroke study. For EACH value, cite the exact source text.

Extract these fields:
1. First author name
2. Publication year
3. Hospital/institution
4. Sample size (n)
5. Mean age
6. GCS score (admission)
7. Hydrocephalus percentage
8. Surgical technique description
9. EVD usage (yes/no/percentage)
10. Duraplasty performed (yes/no)
11. Mortality rate
12. Favorable mRS outcome rate
13. Newcastle-Ottawa Scale total score

Format each extraction as:
**[Field Name]**: [Value]
Source: [exact quote from text]

Be precise - only include data explicitly stated in the text.`;

  return extractWithCitations(pdfPath, prompt);
}

/**
 * Parse structured response into field-value pairs with citations
 */
export function parseStructuredResponse(result: ExtractionResult): Map<string, ExtractedFieldWithCitation> {
  const fieldMap = new Map<string, ExtractedFieldWithCitation>();

  // Parse the text response to extract field-value pairs
  for (const block of result.rawResponse) {
    if (block.type === "text" && block.text) {
      const lines = block.text.split("\n");
      let currentField = "";

      for (const line of lines) {
        const fieldMatch = line.match(/\*\*\[?(.+?)\]?\*\*:\s*(.+)/);
        if (fieldMatch) {
          currentField = fieldMatch[1].toLowerCase().replace(/\s+/g, "_");
          const value = fieldMatch[2].trim();

          fieldMap.set(currentField, {
            field: currentField,
            value,
            citation: null,
            highlights: [],
          });
        }
      }
    }
  }

  // Attach citations to fields
  for (const field of result.fields) {
    if (field.citation) {
      // Find matching field by comparing cited text
      for (const [key, value] of fieldMap) {
        if (field.citation.text.toLowerCase().includes(String(value.value).toLowerCase())) {
          value.citation = field.citation;
          value.highlights = field.highlights;
        }
      }
    }
  }

  return fieldMap;
}

// CLI test
if (import.meta.url === `file://${process.argv[1]}`) {
  const testPdf = process.argv[2] || "./pdfs/Kim2016.pdf";

  console.log(`\n🔬 Testing Claude Citations on: ${testPdf}\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ Set ANTHROPIC_API_KEY environment variable");
    console.log("   export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  extractCerebellarDataWithCitations(testPdf)
    .then(result => {
      console.log("\n=== EXTRACTION RESULTS ===\n");

      // Show raw response
      for (const block of result.rawResponse) {
        if (block.type === "text") {
          console.log(block.text);
        }
      }

      // Show citations with highlights
      console.log("\n=== CITATIONS WITH HIGHLIGHTS ===\n");
      for (const field of result.fields) {
        if (field.citation) {
          console.log(`Citation: "${field.citation.text.substring(0, 80)}..."`);
          console.log(`  Chars: ${field.citation.startChar} - ${field.citation.endChar}`);

          for (const h of field.highlights) {
            console.log(`  📍 Page ${h.page}: (${h.x.toFixed(1)}, ${h.y.toFixed(1)}) - "${h.citedText.substring(0, 40)}..."`);
          }
          console.log();
        }
      }
    })
    .catch(err => {
      console.error("❌ Error:", err.message);
      if (err.message.includes("401")) {
        console.log("   Check your ANTHROPIC_API_KEY");
      }
    });
}
