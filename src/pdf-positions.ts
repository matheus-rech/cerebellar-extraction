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
 *
 * Section Detection:
 * - Tracks which section each text belongs to (abstract, methods, results, etc.)
 * - Enables filtering citations to avoid false positives from discussion/abstract
 */

import * as fs from "fs";
import * as path from "path";
import Fuse from "fuse.js";

/**
 * Section types for medical papers
 * 'primary' sections (methods, results, table, figure) are trusted for data extraction
 * 'secondary' sections (abstract, discussion, intro) may have false positives
 */
export type SectionType =
  | 'abstract'
  | 'introduction'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'references'
  | 'table'
  | 'figure'
  | 'unknown';

/** Sections that are safe for data extraction (avoid false positives) */
export const PRIMARY_SECTIONS: SectionType[] = [
  'methods', 'results', 'table', 'figure'
];

/** Section detection patterns - case insensitive */
const SECTION_PATTERNS: Array<{ pattern: RegExp; section: SectionType }> = [
  { pattern: /^abstract$/i, section: 'abstract' },
  { pattern: /^(introduction|background)$/i, section: 'introduction' },
  { pattern: /^(methods|patients|materials|study design|subjects|study population)$/i, section: 'methods' },
  { pattern: /^(patients and methods|materials and methods)$/i, section: 'methods' },
  { pattern: /^results$/i, section: 'results' },
  { pattern: /^discussion$/i, section: 'discussion' },
  { pattern: /^(conclusion|conclusions)$/i, section: 'conclusion' },
  { pattern: /^(references|bibliography)$/i, section: 'references' },
  { pattern: /^table\s*\d/i, section: 'table' },
  { pattern: /^(figure|fig\.?)\s*\d/i, section: 'figure' },
];

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
  section: SectionType;
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
  section?: SectionType;
}

/**
 * Detect section from text (checks if text is a section header)
 * Tables and figures are detected inline and override current section
 */
function detectSection(text: string, currentSection: SectionType): SectionType {
  const trimmed = text.trim();

  // Tables and figures can appear anywhere - check first (override current section)
  if (/^table\s*\d/i.test(trimmed) || /table\s*\d.*[:.]?\s*$/i.test(trimmed)) {
    return 'table';
  }
  if (/^(figure|fig\.?)\s*\d/i.test(trimmed) || /(figure|fig\.?)\s*\d.*[:.]?\s*$/i.test(trimmed)) {
    return 'figure';
  }

  // Check for section headers
  for (const { pattern, section } of SECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return section;
    }
  }

  return currentSection;
}

/**
 * Check if text is inside a table context (common table patterns)
 */
function isTableContent(text: string): boolean {
  // Detect common table cell patterns
  const tablePatterns = [
    /^\d+\s*[±+]\s*\d+/,              // "45 ± 12" or "45 + 12" (mean ± SD)
    /^\d+\s*\(\d+\.?\d*%?\)/,          // "15 (30%)" (count with percentage)
    /^\d+\/\d+/,                        // "5/20" (ratios)
    /^[<>≤≥]\s*\d+/,                   // "<0.05" (p-values)
    /^p\s*[=<>]\s*\d/i,                // "p = 0.03"
    /^n\s*=\s*\d+/i,                   // "n = 45"
  ];

  return tablePatterns.some(p => p.test(text.trim()));
}

/**
 * Filter citations to only include those from primary sections
 * Tables and figures are ALWAYS allowed regardless of surrounding section
 */
export function filterCitationsBySection(
  citations: CitationHighlight[],
  positions: TextPosition[],
  allowedSections: SectionType[] = PRIMARY_SECTIONS
): CitationHighlight[] {
  return citations.filter(cit => {
    // Find the position(s) that contain this citation
    const matchingPos = positions.find(p =>
      p.startChar <= (cit as any).startChar &&
      p.endChar >= (cit as any).endChar
    );

    if (!matchingPos) return true; // If no match, allow it

    // Tables and figures always allowed
    if (matchingPos.section === 'table' || matchingPos.section === 'figure') {
      return true;
    }

    return allowedSections.includes(matchingPos.section);
  });
}

/**
 * Check if a citation is from a primary (trusted) section
 */
export function isFromPrimarySection(
  startChar: number,
  endChar: number,
  positions: TextPosition[]
): boolean {
  const matchingPos = positions.find(p =>
    p.startChar <= startChar && p.endChar >= endChar
  );

  if (!matchingPos) return true; // Default to allowing if not found

  // Tables and figures always trusted
  if (matchingPos.section === 'table' || matchingPos.section === 'figure') {
    return true;
  }

  return PRIMARY_SECTIONS.includes(matchingPos.section);
}

/**
 * Extract text with positions from a PDF file
 * Includes section detection for filtering citations by document structure
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
  let currentSection: SectionType = 'unknown';
  let inTableContext = false;
  let tableContextEndPage = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent: TextContent = await page.getTextContent();

    // Reset table context on new page (tables usually don't span pages)
    if (pageNum > tableContextEndPage) {
      inTableContext = false;
    }

    for (const item of textContent.items) {
      // Skip TextMarkedContent items
      if (!("str" in item)) continue;
      const textItem = item as TextItem;
      if (!textItem.str) continue;

      const text = textItem.str;
      const startChar = globalCharIndex;
      const endChar = globalCharIndex + text.length;

      // Detect section changes
      const detectedSection = detectSection(text, currentSection);

      // Track table/figure context (spans multiple text items)
      if (detectedSection === 'table') {
        inTableContext = true;
        tableContextEndPage = pageNum + 1; // Tables can span to next page
        currentSection = 'table';
      } else if (detectedSection === 'figure') {
        currentSection = 'figure';
      } else if (detectedSection !== currentSection) {
        // New section header detected - exit table context
        inTableContext = false;
        currentSection = detectedSection;
      }

      // Determine final section for this text
      let assignedSection = currentSection;

      // If in table context or text looks like table data, mark as table
      if (inTableContext || isTableContent(text)) {
        assignedSection = 'table';
      }

      positions.push({
        text,
        startChar,
        endChar,
        x: textItem.transform[4],
        y: textItem.transform[5],
        width: textItem.width || 0,
        height: textItem.height || 10,
        page: pageNum,
        section: assignedSection,
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

/**
 * Fuzzy search options for citation matching
 */
interface FuzzySearchOptions {
  threshold?: number;  // 0.0 = exact match, 1.0 = match anything (default: 0.3)
  onlyPrimarySections?: boolean;  // Filter to methods/results/tables/figures
  maxResults?: number;
}

interface FuzzySearchResult {
  position: TextPosition;
  highlight: CitationHighlight;
  score: number;  // Lower is better (0 = exact match)
  matchedText: string;
}

/**
 * Find citation using fuzzy matching
 * Handles minor text differences between Claude's citation and PDF extraction
 *
 * Use cases:
 * - Claude returns "mortality rate was 15%"
 * - PDF has "the mortality rate was found to be 15%"
 * - Fuzzy matching bridges this gap
 */
export function findCitationFuzzy(
  citedText: string,
  positions: TextPosition[],
  options: FuzzySearchOptions = {}
): FuzzySearchResult | null {
  const {
    threshold = 0.3,
    onlyPrimarySections = true,
    maxResults = 1
  } = options;

  // Filter positions by section if requested
  let searchablePositions = positions;
  if (onlyPrimarySections) {
    searchablePositions = positions.filter(p =>
      PRIMARY_SECTIONS.includes(p.section) ||
      p.section === 'table' ||
      p.section === 'figure'
    );
  }

  // Build combined text blocks for better matching
  // (citations often span multiple text items)
  const textBlocks = buildTextBlocks(searchablePositions, 500);

  const fuse = new Fuse(textBlocks, {
    keys: ['text'],
    threshold,
    includeScore: true,
    findAllMatches: true,
    minMatchCharLength: Math.min(citedText.length / 2, 20),
  });

  const results = fuse.search(citedText);

  if (results.length === 0) {
    return null;
  }

  const best = results[0];
  const matchedBlock = best.item;

  // Find the original position(s) that contributed to this match
  const matchPos = matchedBlock.positions[0];

  const avgCharWidth = matchPos.width / (matchPos.text.length || 1);

  return {
    position: matchPos,
    highlight: {
      page: matchPos.page,
      x: matchPos.x,
      y: matchPos.y,
      width: Math.min(citedText.length * avgCharWidth, 500),
      height: matchPos.height,
      citedText: matchedBlock.text.substring(0, 200),
      section: matchPos.section,
    },
    score: best.score || 0,
    matchedText: matchedBlock.text,
  };
}

/**
 * Find all fuzzy matches for a citation (returns multiple results)
 */
export function findAllCitationsFuzzy(
  citedText: string,
  positions: TextPosition[],
  options: FuzzySearchOptions = {}
): FuzzySearchResult[] {
  const {
    threshold = 0.4,
    onlyPrimarySections = true,
    maxResults = 5
  } = options;

  let searchablePositions = positions;
  if (onlyPrimarySections) {
    searchablePositions = positions.filter(p =>
      PRIMARY_SECTIONS.includes(p.section) ||
      p.section === 'table' ||
      p.section === 'figure'
    );
  }

  const textBlocks = buildTextBlocks(searchablePositions, 500);

  const fuse = new Fuse(textBlocks, {
    keys: ['text'],
    threshold,
    includeScore: true,
    findAllMatches: true,
  });

  const results = fuse.search(citedText);

  return results.slice(0, maxResults).map(result => {
    const matchedBlock = result.item;
    const matchPos = matchedBlock.positions[0];
    const avgCharWidth = matchPos.width / (matchPos.text.length || 1);

    return {
      position: matchPos,
      highlight: {
        page: matchPos.page,
        x: matchPos.x,
        y: matchPos.y,
        width: Math.min(citedText.length * avgCharWidth, 500),
        height: matchPos.height,
        citedText: matchedBlock.text.substring(0, 200),
        section: matchPos.section,
      },
      score: result.score || 0,
      matchedText: matchedBlock.text,
    };
  });
}

/**
 * Build larger text blocks from individual positions
 * This helps match citations that span multiple PDF text items
 */
interface TextBlock {
  text: string;
  positions: TextPosition[];
  startChar: number;
  endChar: number;
}

function buildTextBlocks(positions: TextPosition[], maxLength: number): TextBlock[] {
  const blocks: TextBlock[] = [];
  let currentBlock: TextBlock | null = null;

  for (const pos of positions) {
    if (!currentBlock || currentBlock.text.length > maxLength) {
      // Start new block
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = {
        text: pos.text,
        positions: [pos],
        startChar: pos.startChar,
        endChar: pos.endChar,
      };
    } else {
      // Add to current block
      currentBlock.text += ' ' + pos.text;
      currentBlock.positions.push(pos);
      currentBlock.endChar = pos.endChar;
    }
  }

  if (currentBlock) blocks.push(currentBlock);
  return blocks;
}

/**
 * Smart citation finder - tries exact match first, then fuzzy
 * Returns the best available match with confidence score
 */
export function findCitationSmart(
  citedText: string,
  positions: TextPosition[],
  options: FuzzySearchOptions = {}
): { highlight: CitationHighlight | null; method: 'exact' | 'fuzzy' | 'none'; confidence: number } {

  // Try exact match first
  const exactMatch = findTextPosition(citedText, positions);
  if (exactMatch) {
    // Verify it's from a primary section if required
    if (options.onlyPrimarySections) {
      const matchPos = positions.find(p =>
        p.text.toLowerCase().includes(citedText.toLowerCase())
      );
      if (matchPos && !PRIMARY_SECTIONS.includes(matchPos.section) &&
          matchPos.section !== 'table' && matchPos.section !== 'figure') {
        // Continue to fuzzy search in primary sections
      } else {
        return { highlight: exactMatch, method: 'exact', confidence: 1.0 };
      }
    } else {
      return { highlight: exactMatch, method: 'exact', confidence: 1.0 };
    }
  }

  // Try fuzzy match
  const fuzzyResult = findCitationFuzzy(citedText, positions, options);
  if (fuzzyResult && fuzzyResult.score < (options.threshold || 0.3)) {
    return {
      highlight: fuzzyResult.highlight,
      method: 'fuzzy',
      confidence: 1 - fuzzyResult.score, // Convert score to confidence
    };
  }

  return { highlight: null, method: 'none', confidence: 0 };
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
