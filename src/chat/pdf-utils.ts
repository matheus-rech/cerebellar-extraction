/**
 * PDF Utilities for Chat Module
 *
 * Provides PDF parsing helpers compatible with pdf-parse v2.x API
 */

import {createRequire} from "module";

const require = createRequire(import.meta.url);
const {PDFParse} = require("pdf-parse");

export interface ParsedPDF {
  text: string;
  numpages: number;
}

/**
 * Parse PDF buffer and extract text
 * Compatible with pdf-parse v2.x API
 */
export async function parsePdf(dataBuffer: Buffer): Promise<ParsedPDF> {
  // Convert Buffer to Uint8Array (required by pdf-parse v2.x)
  const uint8Array = new Uint8Array(dataBuffer);
  const pdfParser = new PDFParse(uint8Array);
  await pdfParser.load();
  const textData = await pdfParser.getText();
  const info = await pdfParser.getInfo();

  // pdf-parse v2.x returns {pages: [{text: string, num: number}...]}
  // Concatenate all page texts into a single string
  let text = "";
  if (textData && typeof textData === "object" && "pages" in textData) {
    const pages = (textData as {pages: Array<{text: string; num: number}>}).pages;
    text = pages.map((p) => p.text).join("\n\n");
  } else if (typeof textData === "string") {
    text = textData;
  }

  return {
    text: text || "",
    numpages: info?.numPages || (textData as {pages: unknown[]})?.pages?.length || 0,
  };
}

/**
 * Extract text from specific pages
 */
export async function parsePdfPages(
  dataBuffer: Buffer,
  startPage?: number,
  endPage?: number
): Promise<ParsedPDF> {
  const uint8Array = new Uint8Array(dataBuffer);
  const pdfParser = new PDFParse(uint8Array);
  await pdfParser.load();
  const textData = await pdfParser.getText();
  const info = await pdfParser.getInfo();

  let text = "";
  if (textData && typeof textData === "object" && "pages" in textData) {
    const pages = (textData as {pages: Array<{text: string; num: number}>}).pages;
    const start = startPage ? startPage - 1 : 0;
    const end = endPage || pages.length;
    text = pages.slice(start, end).map((p) => p.text).join("\n\n");
  } else if (typeof textData === "string") {
    text = textData;
  }

  return {
    text: text || "",
    numpages: info?.numPages || 0,
  };
}
