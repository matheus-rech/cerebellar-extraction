/**
 * Firebase Cloud Functions for Cerebellar Extraction
 *
 * Includes Claude Native Citations API integration for verified
 * source attribution.
 *
 * Optimizations applied per Firebase best practices:
 * - Global client caching to reduce cold start latency
 * - Appropriate memory/timeout for AI API calls
 * - Concurrency settings for instance reuse
 */

import {setGlobalOptions} from "firebase-functions/v2";
import {onRequest, onCall, HttpsError} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";

// Set global options for all functions
setGlobalOptions({
  maxInstances: 10,
  memory: "512MiB", // Adequate for API calls
  timeoutSeconds: 120, // Claude API can be slow
  concurrency: 80, // Allow instance reuse
});

// Define secrets for API keys
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// Global client cache - initialized lazily per warm instance
let anthropicClient: Anthropic | null = null;

// Health check endpoint
export const healthCheck = onRequest((request, response) => {
  logger.info("Health check called", {structuredData: true});
  response.json({
    status: "ok",
    project: "cerebellar-extraction",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Request/Response types for callable function
 */
interface ExtractRequest {
  pdfText: string;
  positions?: Array<{
    startChar: number;
    endChar: number;
    x: number;
    y: number;
    width?: number;
    height?: number;
    page: number;
  }>;
  extractionPrompt?: string;
}

interface ExtractResponse {
  success: boolean;
  extractedText: string;
  citations: CitationHighlight[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Callable function for Claude citation extraction
 * Uses onCall for automatic auth handling and type-safe serialization
 */
export const extractCitations = onCall<
  ExtractRequest,
  Promise<ExtractResponse>
>(
  {secrets: [anthropicApiKey]},
  async (request) => {
    const {pdfText, positions, extractionPrompt} = request.data;

    // Validate input
    if (!pdfText) {
      throw new HttpsError("invalid-argument", "pdfText is required");
    }

    // Optional: Check authentication
    if (!request.auth) {
      logger.warn("Unauthenticated request to extractCitations");
      // Allow for now, but could enforce auth:
      // throw new HttpsError("unauthenticated", "Sign in required");
    }

    try {
      // Use cached client or create new one
      if (!anthropicClient) {
        anthropicClient = new Anthropic({apiKey: anthropicApiKey.value()});
        logger.info("Anthropic client initialized");
      }
      const client = anthropicClient;

      const defaultPrompt = `Extract data from this cerebellar stroke study.
For EACH value, cite the exact source text.

Extract these fields:
1. First author name
2. Publication year
3. Sample size (n)
4. Mean age
5. GCS score
6. Hydrocephalus percentage
7. Surgical technique
8. EVD usage
9. Duraplasty
10. Mortality rate
11. Favorable mRS outcome

Be precise - only include data explicitly stated.`;
      const prompt = extractionPrompt || defaultPrompt;

      logger.info("Claude citation extraction", {
        textLength: pdfText.length,
        hasPositions: !!positions,
        userId: request.auth?.uid,
      });

      const claudeResponse = await client.messages.create({
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
                  data: Buffer.from(pdfText).toString("base64"),
                },
                citations: {enabled: true},
              },
              {type: "text", text: prompt},
            ],
          },
        ],
      });

      // Parse response and extract citations
      const citations: CitationHighlight[] = [];
      let extractedText = "";

      for (const block of claudeResponse.content) {
        if (block.type === "text") {
          extractedText += block.text;

          const citationsArray = (block as {citations?: Array<{
            type: string;
            cited_text: string;
            start_char_index: number;
            end_char_index: number;
          }>}).citations;

          if (citationsArray) {
            for (const cit of citationsArray) {
              if (cit.type === "char_location") {
                const citedText = Buffer.from(cit.cited_text, "base64")
                  .toString("utf-8");

                // Map to PDF coordinates if positions provided
                let page = 1;
                let x = 0;
                let y = 0;
                let width = 100;
                let height = 14;

                if (positions) {
                  for (const pos of positions) {
                    if (pos.startChar <= cit.start_char_index &&
                        pos.endChar >= cit.start_char_index) {
                      page = pos.page;
                      x = pos.x;
                      y = pos.y;
                      width = pos.width || 100;
                      height = pos.height || 14;
                      break;
                    }
                  }
                }

                citations.push({
                  id: `cit-${citations.length}-${cit.start_char_index}`,
                  field: "extracted",
                  value: citedText.substring(0, 100),
                  sourceText: citedText,
                  citedText,
                  startChar: cit.start_char_index,
                  endChar: cit.end_char_index,
                  page,
                  x,
                  y,
                  width,
                  height,
                });
              }
            }
          }
        }
      }

      logger.info("Extraction complete", {citationCount: citations.length});

      return {
        success: true,
        extractedText,
        citations,
        usage: claudeResponse.usage,
      };
    } catch (error) {
      logger.error("Claude API error", {error});
      throw new HttpsError(
        "internal",
        error instanceof Error ? error.message : "Extraction failed"
      );
    }
  }
);

/**
 * Citation highlight structure returned to the frontend
 */
interface CitationHighlight {
  id: string;
  field: string;
  value: string;
  sourceText: string;
  citedText: string;
  startChar: number;
  endChar: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extract data with Claude Native Citations
 *
 * This function:
 * 1. Sends document text to Claude with citations enabled
 * 2. Parses the citation char indices
 * 3. Maps them to positions (if provided)
 * 4. Returns structured data with provenance
 */
export const extractWithCitations = onRequest(
  {secrets: [anthropicApiKey], cors: true},
  async (request, response) => {
    // Only allow POST
    if (request.method !== "POST") {
      response.status(405).json({error: "Method not allowed"});
      return;
    }

    const {pdfText, extractionPrompt, positions} = request.body;

    if (!pdfText) {
      response.status(400).json({error: "pdfText is required"});
      return;
    }

    try {
      // Use cached client or create new one (lazy initialization)
      if (!anthropicClient) {
        anthropicClient = new Anthropic({apiKey: anthropicApiKey.value()});
        logger.info("Anthropic client initialized");
      }
      const client = anthropicClient;

      const httpDefaultPrompt = `Extract the following data from this study.
For EACH value, cite the exact source text.

Extract these fields:
1. First author name
2. Publication year
3. Sample size (n)
4. Mean age
5. GCS score (admission)
6. Hydrocephalus percentage
7. Surgical technique description
8. EVD usage (yes/no/percentage)
9. Duraplasty performed (yes/no)
10. Mortality rate
11. Favorable mRS outcome rate

Be precise - only include data explicitly stated in the text.`;
      const prompt = extractionPrompt || httpDefaultPrompt;

      logger.info("Calling Claude with citations", {
        textLength: pdfText.length,
        promptLength: prompt.length,
      });

      const claudeResponse = await client.messages.create({
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
                  data: Buffer.from(pdfText).toString("base64"),
                },
                citations: {enabled: true},
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      });

      // Parse response and extract citations
      const citations: CitationHighlight[] = [];
      let extractedText = "";

      for (const block of claudeResponse.content) {
        if (block.type === "text") {
          extractedText += block.text;

          // Type assertion for citations
          const citationsArray = (block as {citations?: Array<{
            type: string;
            cited_text: string;
            start_char_index: number;
            end_char_index: number;
          }>}).citations;

          if (citationsArray) {
            for (const cit of citationsArray) {
              if (cit.type === "char_location") {
                // Decode base64 cited_text
                const citedText = Buffer.from(
                  cit.cited_text,
                  "base64"
                ).toString("utf-8");

                // Find page and coordinates if positions provided
                let page = 1;
                let x = 0;
                let y = 0;
                let width = 100;
                let height = 14;

                if (positions && Array.isArray(positions)) {
                  // Find the position that contains this char range
                  for (const pos of positions) {
                    if (
                      pos.startChar <= cit.start_char_index &&
                      pos.endChar >= cit.start_char_index
                    ) {
                      page = pos.page;
                      x = pos.x;
                      y = pos.y;
                      width = pos.width || 100;
                      height = pos.height || 14;
                      break;
                    }
                  }
                }

                citations.push({
                  id: `cit-${citations.length}-${cit.start_char_index}`,
                  field: "extracted",
                  value: citedText.substring(0, 100),
                  sourceText: citedText,
                  citedText: citedText,
                  startChar: cit.start_char_index,
                  endChar: cit.end_char_index,
                  page,
                  x,
                  y,
                  width,
                  height,
                });
              }
            }
          }
        }
      }

      logger.info("Extraction complete", {
        citationCount: citations.length,
        textLength: extractedText.length,
      });

      response.json({
        success: true,
        extractedText,
        citations,
        usage: claudeResponse.usage,
      });
    } catch (error) {
      logger.error("Claude API error", {error});
      response.status(500).json({
        error: "Extraction failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);
