/**
 * PDF Position Extractor
 *
 * Extracts text from PDFs with character-level position tracking.
 * This enables mapping Claude's citation char indices to PDF coordinates for highlighting.
 *
 * Flow:
 * 1. PDF → pdfjs-dist → text items with positions
 * 2. Build character-to-position index
 * 3. Claude returns {start_char_index, end_char_index}
 * 4. Map to PDF coordinates for highlight rendering
 */

import * as fs from "fs";
import * as path from "path";

// pdfjs-dist types
interface TextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, x, y]
  width?: number;
  height?: number;
}

interface TextMarkedContent {
  type: string;
  id?: string;
}

interface TextContent {
  items: (TextItem | TextMarkedContent)[];
}

export interface TextPosition {
  text: string;
  startChar: number;
  endChar: number;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface PDFTextWithPositions {
  text: string;           // Full concatenated text for Claude
  positions: TextPosition[]; // Position index for mapping
  pageCount: number;
}

export interface CitationHighlight {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  citedText: string;
}

/**
 * Extract text with positions from a PDF file
 */
export async function extractTextWithPositions(pdfPath: string): Promise<PDFTextWithPositions> {
  // Dynamic import for ESM compatibility
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const absolutePath = path.resolve(pdfPath);
  const data = new Uint8Array(fs.readFileSync(absolutePath));
  const doc = await pdfjsLib.getDocument({data}).promise;

  const positions: TextPosition[] = [];
  let fullText = "";
  let globalCharIndex = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent: TextContent = await page.getTextContent();

    for (const item of textContent.items) {
      // Skip TextMarkedContent items
      if (!("str" in item)) continue;
      const textItem = item as TextItem;
      if (!textItem.str) continue;

      const text = textItem.str;
      const startChar = globalCharIndex;
      const endChar = globalCharIndex + text.length;

      positions.push({
        text,
        startChar,
        endChar,
        x: textItem.transform[4],
        y: textItem.transform[5],
        width: textItem.width || 0,
        height: textItem.height || 10,
        page: pageNum,
      });

      fullText += text + " ";
      globalCharIndex = fullText.length;
    }

    // Add page separator
    fullText += "\n\n";
    globalCharIndex = fullText.length;
  }

  return {
    text: fullText.trim(),
    positions,
    pageCount: doc.numPages,
  };
}

/**
 * Map Claude citation char indices to PDF coordinates
 *
 * @param startCharIndex - From Claude's citation response
 * @param endCharIndex - From Claude's citation response
 * @param positions - Position index from extractTextWithPositions
 * @returns Array of highlight rectangles (may span multiple text items)
 */
export function mapCitationToHighlights(
  startCharIndex: number,
  endCharIndex: number,
  positions: TextPosition[]
): CitationHighlight[] {
  const highlights: CitationHighlight[] = [];

  for (const pos of positions) {
    // Check if this text item overlaps with the citation range
    const overlapStart = Math.max(startCharIndex, pos.startChar);
    const overlapEnd = Math.min(endCharIndex, pos.endChar);

    if (overlapStart < overlapEnd) {
      // Calculate what portion of this text item is highlighted
      const charOffset = overlapStart - pos.startChar;
      const charLength = overlapEnd - overlapStart;
      const citedText = pos.text.substring(charOffset, charOffset + charLength);

      // Estimate x offset based on character position (simplified)
      const avgCharWidth = pos.width / pos.text.length;
      const xOffset = charOffset * avgCharWidth;
      const highlightWidth = charLength * avgCharWidth;

      highlights.push({
        page: pos.page,
        x: pos.x + xOffset,
        y: pos.y,
        width: highlightWidth,
        height: pos.height,
        citedText,
      });
    }
  }

  return highlights;
}

/**
 * Find text position by string match (fallback for non-indexed citations)
 */
export function findTextPosition(
  searchText: string,
  positions: TextPosition[]
): CitationHighlight | null {
  const normalizedSearch = searchText.toLowerCase().trim();

  for (const pos of positions) {
    if (pos.text.toLowerCase().includes(normalizedSearch)) {
      const startIdx = pos.text.toLowerCase().indexOf(normalizedSearch);
      const avgCharWidth = pos.width / pos.text.length;

      return {
        page: pos.page,
        x: pos.x + (startIdx * avgCharWidth),
        y: pos.y,
        width: normalizedSearch.length * avgCharWidth,
        height: pos.height,
        citedText: pos.text.substring(startIdx, startIdx + searchText.length),
      };
    }
  }

  return null;
}

/**
 * Refine a broad citation to find specific text within it
 * Useful when Claude cites large chunks but mentions specific values
 */
export function refineCitationForText(
  searchText: string,
  broadStart: number,
  broadEnd: number,
  positions: TextPosition[]
): CitationHighlight[] {
  const normalizedSearch = searchText.toLowerCase().trim();
  const highlights: CitationHighlight[] = [];

  // Only search within the broad citation range
  for (const pos of positions) {
    // Check if this position is within the broad range
    if (pos.startChar >= broadStart && pos.endChar <= broadEnd) {
      const posTextLower = pos.text.toLowerCase();
      const idx = posTextLower.indexOf(normalizedSearch);

      if (idx !== -1) {
        const avgCharWidth = pos.width / pos.text.length;
        highlights.push({
          page: pos.page,
          x: pos.x + (idx * avgCharWidth),
          y: pos.y,
          width: Math.min(searchText.length * avgCharWidth, pos.width - (idx * avgCharWidth)),
          height: pos.height,
          citedText: pos.text.substring(idx, idx + searchText.length),
        });
      }
    }
  }

  return highlights;
}

/**
 * Convert highlight coordinates to PDF.js annotation format
 * (For use with PDF.js viewer's annotation layer)
 */
export function toAnnotationFormat(highlight: CitationHighlight) {
  return {
    type: "highlight",
    page: highlight.page,
    rect: [
      highlight.x,
      highlight.y - highlight.height, // PDF coordinates: y=0 is bottom
      highlight.x + highlight.width,
      highlight.y,
    ],
    color: [255, 255, 0, 0.3], // Yellow with transparency
    contents: highlight.citedText,
  };
}

// CLI test
if (import.meta.url === `file://${process.argv[1]}`) {
  const testPdf = process.argv[2] || "./pdfs/Kim2016.pdf";

  console.log(`\nExtracting positions from: ${testPdf}`);

  extractTextWithPositions(testPdf).then(result => {
    console.log(`\nPages: ${result.pageCount}`);
    console.log(`Total text length: ${result.text.length} chars`);
    console.log(`Position items: ${result.positions.length}`);

    // Test citation mapping
    const testCitation = {
      start_char_index: 7,
      end_char_index: 65,
    };

    console.log("\n=== Test Citation Mapping ===");
    console.log(`Input: char ${testCitation.start_char_index} to ${testCitation.end_char_index}`);

    const highlights = mapCitationToHighlights(
      testCitation.start_char_index,
      testCitation.end_char_index,
      result.positions
    );

    highlights.forEach((h, i) => {
      console.log(`\nHighlight ${i + 1}:`);
      console.log(`  Page: ${h.page}`);
      console.log(`  Position: (${h.x.toFixed(1)}, ${h.y.toFixed(1)})`);
      console.log(`  Size: ${h.width.toFixed(1)} x ${h.height.toFixed(1)}`);
      console.log(`  Text: "${h.citedText}"`);
    });

    // Test string search fallback
    console.log("\n=== Test String Search ===");
    const searchResult = findTextPosition("cerebellar infarction", result.positions);
    if (searchResult) {
      console.log(`Found at page ${searchResult.page}, (${searchResult.x.toFixed(1)}, ${searchResult.y.toFixed(1)})`);
      console.log(`Text: "${searchResult.citedText}"`);
    }
  }).catch(console.error);
}
