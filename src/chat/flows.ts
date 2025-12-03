/**
 * Chat Flows Module
 *
 * Provides Genkit flows for PDF chat sessions with:
 * - RAG-based tool integration (dynamic retrieval vs static context)
 * - Persistent session management
 * - Conversation history with sliding window
 * - Quick command shortcuts
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline/promises";
import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";
import {parsePdf} from "./pdf-utils.js";

import {
  SessionStore,
  SessionData,
  PDFChatState,
  LocalSessionStore,
  FirestoreSessionStore,
  createSessionStore,
  generateSessionId,
  createEmptySession,
} from "./session-store.js";

import {
  chatTools,
  createSearchToolImpl,
  createExtractedDataToolImpl,
  getToolNames,
  type SearchResult,
} from "./tools.js";

import {semanticChunk, type Chunk} from "../chunking.js";

import {
  type CitationMetadata,
  type InlineCitation,
  type GroundingChunk,
  CitationMetadataSchema,
  InlineCitationSchema,
  GroundingChunkSchema,
  createCitationMetadata,
  extractInlineCitations,
  formatCitationsForDisplay,
  chunksToGroundingChunks,
  summarizeCitations,
} from "./citations.js";

// ==========================================
// Configuration
// ==========================================

const USE_LOCAL_STORAGE = process.env.USE_FIRESTORE !== "true";
const MAX_CONTEXT_CHARS = 50000;
const SLIDING_WINDOW_MESSAGES = 20; // Limit conversation history

// Initialize Genkit for flows
const ai = genkit({
  plugins: [googleAI()],
});

// Global session store instance
const sessionStore = createSessionStore<PDFChatState>({
  useFirestore: !USE_LOCAL_STORAGE,
});

// ==========================================
// Helper Functions
// ==========================================

/**
 * Build system prompt for chat sessions
 */
function buildSystemPrompt(state: PDFChatState, useTools: boolean): string {
  const basePrompt = `You are an expert neurosurgical researcher assistant analyzing a medical paper about Suboccipital Decompressive Craniectomy (SDC) for cerebellar stroke.

PAPER: ${state.pdfFileName}

Your role is to:
1. Answer questions about this specific paper accurately
2. Extract data points when asked (demographics, outcomes, surgical techniques)
3. Identify limitations or potential biases in the study
4. Compare findings with standard practices when relevant
5. Always cite the specific section or quote from the paper that supports your answer

IMPORTANT: Only answer based on the content of this paper. If information is not in the paper, say so clearly.`;

  if (useTools) {
    return `${basePrompt}

You have access to tools for searching and retrieving information from the paper:
- searchPdfSections: Search for relevant sections by query
- extractTableData: Extract data from specific tables
- summarizeSection: Get summaries of paper sections
- getExtractedData: Access previously extracted structured data
- compareStudies: Compare with other studies in the database

Use these tools to find specific information rather than relying on memory.`;
  }

  return basePrompt;
}

/**
 * Apply sliding window to conversation history
 */
function applySlidingWindow(
  messages: Array<{role: "user" | "model"; content: string}>,
  maxMessages: number = SLIDING_WINDOW_MESSAGES
): Array<{role: "user" | "model"; content: string}> {
  if (messages.length <= maxMessages) {
    return messages;
  }
  // Keep most recent messages, ensure we start with a user message
  const recent = messages.slice(-maxMessages);
  if (recent[0]?.role === "model") {
    return recent.slice(1);
  }
  return recent;
}

// ==========================================
// Chat Session Flows
// ==========================================

/**
 * Create or load a chat session for a PDF
 * Supports both file path (CLI) and direct text (web frontend)
 */
export const createChatSession = ai.defineFlow(
  {
    name: "createChatSession",
    inputSchema: z.object({
      pdfPath: z.string().optional().describe("Path to the PDF file (CLI usage)"),
      pdfText: z.string().optional().describe("Pre-extracted PDF text (web frontend usage)"),
      pdfName: z.string().optional().describe("File name when using pdfText"),
      sessionId: z.string().optional().describe("Optional existing session ID to resume"),
    }),
    outputSchema: z.object({
      sessionId: z.string(),
      isNew: z.boolean(),
      pdfFileName: z.string(),
      messageCount: z.number(),
      chunksCreated: z.number().optional(),
    }),
  },
  async ({pdfPath, pdfText, pdfName, sessionId}) => {
    // Check for existing session
    if (sessionId) {
      const existing = await sessionStore.get(sessionId);
      if (existing) {
        const mainThread = existing.threads["main"] || [];
        console.log(`📂 Resumed session ${sessionId} with ${mainThread.length} messages`);
        return {
          sessionId,
          isNew: false,
          pdfFileName: existing.state?.pdfFileName || pdfName || "unknown.pdf",
          messageCount: mainThread.length,
        };
      }
    }

    // Determine PDF text source
    let finalPdfText: string;
    let fileName: string;

    if (pdfText) {
      // Web frontend mode: text already extracted
      finalPdfText = pdfText;
      fileName = pdfName || "uploaded.pdf";
      console.log(`📄 Using pre-extracted text (${finalPdfText.length} chars) from ${fileName}`);
    } else if (pdfPath) {
      // CLI mode: load from file path
      const absolutePath = path.resolve(pdfPath);
      fileName = path.basename(absolutePath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(`PDF not found: ${absolutePath}`);
      }

      const dataBuffer = fs.readFileSync(absolutePath);
      const pdfData = await parsePdf(dataBuffer);
      finalPdfText = pdfData.text;
      console.log(`📄 Loaded PDF from ${absolutePath} (${finalPdfText.length} chars)`);
    } else {
      throw new Error("Either pdfPath or pdfText must be provided");
    }

    // Create chunks for RAG
    console.log(`📄 Chunking PDF (${finalPdfText.length} chars)...`);
    const chunks = semanticChunk(finalPdfText, {
      maxChunkSize: 1500,
      overlap: 200,
    });
    console.log(`   ✅ Created ${chunks.length} chunks for RAG`);

    // Create new session with chunk metadata
    const newSessionId = sessionId || generateSessionId("chat");
    const newSession = createEmptySession<PDFChatState>(newSessionId, {
      pdfPath: pdfPath ? path.resolve(pdfPath) : "",
      pdfFileName: fileName,
      pdfTextLength: finalPdfText.length,
    });

    // Store chunks and raw text in session state for retrieval
    (newSession.state as any).chunks = chunks;
    (newSession.state as any).pdfText = finalPdfText; // Store for non-tools fallback

    await sessionStore.save(newSessionId, newSession);
    console.log(`📝 Created new session ${newSessionId} for ${fileName}`);

    return {
      sessionId: newSessionId,
      isNew: true,
      pdfFileName: fileName,
      messageCount: 0,
      chunksCreated: chunks.length,
    };
  }
);

/**
 * Send a message in a chat session with RAG tool integration and citations
 *
 * Citations follow Firebase AI GroundingMetadata structure:
 * @see https://firebase.google.com/docs/reference/js/ai.groundingmetadata
 */
export const sendChatMessage = ai.defineFlow(
  {
    name: "sendChatMessage",
    inputSchema: z.object({
      sessionId: z.string().describe("Session ID"),
      message: z.string().describe("User message"),
      threadId: z.string().default("main").describe("Thread ID within the session"),
      useTools: z.boolean().default(true).describe("Enable RAG tool integration"),
      includeCitations: z.boolean().default(true).describe("Include citation metadata in response"),
    }),
    outputSchema: z.object({
      response: z.string(),
      messageCount: z.number(),
      toolsUsed: z.array(z.string()).optional(),
      // Citation metadata (Firebase AI compatible structure)
      citations: z.object({
        groundingChunks: z.array(GroundingChunkSchema).describe("Source chunks used for grounding"),
        inlineCitations: z.array(InlineCitationSchema).describe("Simplified citations for display"),
        retrievalQueries: z.array(z.string()).optional(),
        totalChunksRetrieved: z.number(),
      }).optional().describe("Citation metadata following Firebase GroundingMetadata structure"),
    }),
  },
  async ({sessionId, message, threadId, useTools, includeCitations}) => {
    // Load session
    const session = await sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const state = session.state as PDFChatState & {chunks?: Chunk[]};
    const thread = session.threads[threadId] || [];

    // Track retrieved chunks for citations
    const toolsUsed: string[] = [];
    const retrievedChunks: Array<{chunk: Chunk; score: number; query: string}> = [];
    const retrievalQueries: string[] = [];
    let activeTools: any[] = [];

    if (useTools && state.chunks) {
      // Create search tool with citation tracking
      const searchTool = createSearchToolImpl(async (query: string, k: number) => {
        toolsUsed.push("searchPdfSections");
        retrievalQueries.push(query);

        // Keyword-based retrieval with scoring
        const queryTerms = query.toLowerCase().split(/\s+/);
        const scored = state.chunks!.map((chunk) => {
          const text = chunk.text.toLowerCase();
          const matchCount = queryTerms.reduce((acc, term) => {
            return acc + (text.includes(term) ? 1 : 0);
          }, 0);
          // Normalize score to 0-1
          const score = queryTerms.length > 0 ? matchCount / queryTerms.length : 0;
          return {chunk, score, query};
        });
        scored.sort((a, b) => b.score - a.score);

        // Track retrieved chunks for citations
        const topK = scored.slice(0, k);
        retrievedChunks.push(...topK);

        return topK.map((s) => s.chunk);
      });

      // Create extracted data tool with session data
      const extractedDataTool = createExtractedDataToolImpl(async (fields) => {
        toolsUsed.push("getExtractedData");
        const data = state.extractedData || {};
        const availableFields = Object.keys(data);
        if (fields && fields.length > 0) {
          const filtered: Record<string, any> = {};
          fields.forEach((f) => {
            if (f in data) filtered[f] = (data as any)[f];
          });
          return {data: filtered, availableFields};
        }
        return {data, availableFields};
      });

      activeTools = [searchTool, extractedDataTool];
    } else {
      // Fallback: Use stored PDF text or load from file (max 50k chars)
      let pdfText: string;
      if ((state as any).pdfText) {
        // Web frontend: text was stored at session creation
        pdfText = (state as any).pdfText.slice(0, MAX_CONTEXT_CHARS);
      } else if (state.pdfPath && fs.existsSync(state.pdfPath)) {
        // CLI: load from file path
        const pdfBuffer = fs.readFileSync(state.pdfPath);
        const pdfData = await parsePdf(pdfBuffer);
        pdfText = pdfData.text.slice(0, MAX_CONTEXT_CHARS);
      } else {
        throw new Error("No PDF text available. Session may be corrupted.");
      }

      // Include PDF in system prompt if not using tools
      const systemPrompt = buildSystemPrompt(state, false) +
        `\n\n---\nPAPER CONTENT:\n${pdfText}\n---`;

      // Build conversation with sliding window
      const windowedThread = applySlidingWindow(thread);
      const conversationHistory = windowedThread.map((m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
      ).join("\n\n");

      const fullPrompt = conversationHistory
        ? `${conversationHistory}\n\nUser: ${message}`
        : `User: ${message}`;

      // Generate without tools
      const {text: response} = await ai.generate({
        model: googleAI.model("gemini-3-pro-preview"),
        system: systemPrompt,
        prompt: fullPrompt,
      });

      // Update thread
      thread.push({role: "user", content: message});
      thread.push({role: "model", content: response});
      session.threads[threadId] = thread;
      await sessionStore.save(sessionId, session);

      return {
        response,
        messageCount: thread.length,
      };
    }

    // Generate with RAG tools - instruct model to cite sources
    const systemPromptWithCitations = buildSystemPrompt(state, true) + `

CITATION INSTRUCTIONS:
When you use information from the searchPdfSections tool, cite it using [n] notation where n is the source number.
For example: "The mortality rate was 23.5% [1]" or "According to the Methods section [2], patients were..."
Always cite specific data points, statistics, and direct quotes.`;

    // Build conversation with sliding window
    const windowedThread = applySlidingWindow(thread);
    const conversationHistory = windowedThread.map((m) =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    ).join("\n\n");

    const fullPrompt = conversationHistory
      ? `${conversationHistory}\n\nUser: ${message}`
      : `User: ${message}`;

    const {text: response} = await ai.generate({
      model: googleAI.model("gemini-3-pro-preview"),
      system: systemPromptWithCitations,
      prompt: fullPrompt,
      tools: activeTools,
    });

    // Update thread
    thread.push({role: "user", content: message});
    thread.push({role: "model", content: response});
    session.threads[threadId] = thread;
    await sessionStore.save(sessionId, session);

    // Build citation metadata if requested and chunks were retrieved
    let citations: {
      groundingChunks: GroundingChunk[];
      inlineCitations: InlineCitation[];
      retrievalQueries?: string[];
      totalChunksRetrieved: number;
    } | undefined;

    if (includeCitations && retrievedChunks.length > 0) {
      // Deduplicate chunks by ID
      const uniqueChunks = new Map<string, {chunk: Chunk; score: number}>();
      retrievedChunks.forEach(({chunk, score}) => {
        const existing = uniqueChunks.get(chunk.id);
        if (!existing || score > existing.score) {
          uniqueChunks.set(chunk.id, {chunk, score});
        }
      });

      const chunks = Array.from(uniqueChunks.values()).map((c) => c.chunk);
      const scores = Array.from(uniqueChunks.values()).map((c) => c.score);

      // Create grounding chunks (Firebase AI compatible)
      const groundingChunks = chunksToGroundingChunks(chunks, scores);

      // Extract inline citations from response
      const inlineCitations = extractInlineCitations(response, groundingChunks);

      citations = {
        groundingChunks,
        inlineCitations,
        retrievalQueries: retrievalQueries.length > 0 ? retrievalQueries : undefined,
        totalChunksRetrieved: chunks.length,
      };

      // Log citation summary
      console.log(summarizeCitations(createCitationMetadata(chunks, retrievalQueries, scores)));
    }

    return {
      response,
      messageCount: thread.length,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      citations,
    };
  }
);

/**
 * Get chat history for a session
 */
export const getChatHistory = ai.defineFlow(
  {
    name: "getChatHistory",
    inputSchema: z.object({
      sessionId: z.string(),
      threadId: z.string().default("main"),
    }),
    outputSchema: z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "model"]),
        content: z.string(),
      })),
      state: z.any().nullable(),
    }),
  },
  async ({sessionId, threadId}) => {
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return {messages: [], state: null};
    }

    // Don't expose chunks in state
    const safeState = session.state ? {
      pdfPath: session.state.pdfPath,
      pdfFileName: session.state.pdfFileName,
      pdfTextLength: session.state.pdfTextLength,
      studyTitle: session.state.studyTitle,
      studyId: session.state.studyId,
    } : null;

    return {
      messages: session.threads[threadId] || [],
      state: safeState,
    };
  }
);

/**
 * List all chat sessions
 */
export const listChatSessions = ai.defineFlow(
  {
    name: "listChatSessions",
    inputSchema: z.object({}),
    outputSchema: z.object({
      sessions: z.array(z.object({
        id: z.string(),
        pdfFileName: z.string(),
        messageCount: z.number(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })),
    }),
  },
  async () => {
    if (USE_LOCAL_STORAGE) {
      const store = sessionStore as LocalSessionStore<PDFChatState>;
      const sessionsWithMeta = await store.getAllWithMetadata();
      return {
        sessions: sessionsWithMeta.map((s) => ({
          id: s.id,
          pdfFileName: (s.state as PDFChatState)?.pdfFileName || "Unknown",
          messageCount: s.messageCount,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      };
    }

    // Firestore implementation would list from collection
    return {sessions: []};
  }
);

/**
 * Delete a chat session
 */
export const deleteChatSession = ai.defineFlow(
  {
    name: "deleteChatSession",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    outputSchema: z.object({
      deleted: z.boolean(),
    }),
  },
  async ({sessionId}) => {
    if (sessionStore.delete) {
      const deleted = await sessionStore.delete(sessionId);
      return {deleted};
    }
    return {deleted: false};
  }
);

/**
 * Simple stateless chat flow for interactive collaboration
 */
export const chat = ai.defineFlow(
  {
    name: "chat",
    inputSchema: z.object({
      message: z.string().describe("Your message to Gemini"),
      context: z.string().optional().describe("Optional context about current task"),
    }),
    outputSchema: z.object({
      response: z.string(),
    }),
  },
  async ({message, context}) => {
    const systemContext = context || `You are collaborating with a medical researcher on a systematic review of Suboccipital Decompressive Craniectomy (SDC) for cerebellar stroke.
You have access to a Genkit-powered extraction system with Zod schemas for structured data extraction.
Be helpful, precise, and provide code examples when relevant.`;

    const {text} = await ai.generate({
      model: googleAI.model("gemini-3-pro-preview"),
      prompt: `${systemContext}\n\nUser: ${message}`,
    });
    return {response: text};
  }
);

// ==========================================
// Interactive CLI Chat
// ==========================================

/**
 * Interactive PDF Chat - Query a specific PDF document
 * Based on Genkit chat-with-pdf tutorial pattern
 */
export async function chatWithPDF(pdfPath: string): Promise<void> {
  // 1. Create or resume session
  const {sessionId, isNew, pdfFileName} = await createChatSession({pdfPath});

  console.log(`\n🧠 Chat session ${isNew ? "started" : "resumed"} for ${pdfFileName}`);
  console.log(`   Session ID: ${sessionId}`);
  console.log(`   Type 'exit' or press Ctrl+C to quit.\n`);

  // Quick extraction prompts
  console.log(`💡 Quick commands:`);
  console.log(`   /summary    - Get a brief summary of the study`);
  console.log(`   /pico       - Extract PICO elements`);
  console.log(`   /outcomes   - List all reported outcomes`);
  console.log(`   /quality    - Assess study quality (NOS)`);
  console.log(`   /extract    - Run full structured extraction`);
  console.log(`   /tools      - Toggle RAG tools on/off\n`);

  // Set up readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let useTools = true;

  // Interactive chat loop
  while (true) {
    const userInput = await rl.question("You: ");

    if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log("\n👋 Chat session ended.");
      rl.close();
      break;
    }

    // Handle quick commands
    let prompt = userInput;
    if (userInput === "/summary") {
      prompt = "Provide a brief summary of this study in 3-4 sentences, including: study design, sample size, main intervention, and key findings.";
    } else if (userInput === "/pico") {
      prompt = "Extract the PICO elements from this study: Population (who was studied, inclusion/exclusion criteria), Intervention (what surgical procedure), Comparator (if any control group), Outcomes (primary and secondary outcomes measured).";
    } else if (userInput === "/outcomes") {
      prompt = "List all reported outcomes from this study, including: mortality rates, functional outcomes (GOS, mRS), complications, and any other measured endpoints. Include the specific values and timepoints.";
    } else if (userInput === "/quality") {
      prompt = "Assess the methodological quality of this study using the Newcastle-Ottawa Scale criteria: Selection (4 items), Comparability (2 items), Outcome (3 items). Provide scores and rationale for each.";
    } else if (userInput === "/extract") {
      prompt = `Extract all data fields needed for meta-analysis:
1. Study Metadata: Authors, year, journal, hospital, study period
2. Population: Sample size, age (mean±SD), GCS scores, diagnosis, hydrocephalus %
3. Intervention: Procedure details, timing, EVD use, duraplasty
4. Comparator: If present, describe the control group
5. Outcomes: Mortality (with timepoint), mRS outcomes (with definition), complications, length of stay
6. Quality: Newcastle-Ottawa Scale assessment

For each numeric value, provide the exact quote from the paper.`;
    } else if (userInput === "/tools") {
      useTools = !useTools;
      console.log(`\n🔧 RAG tools ${useTools ? "enabled" : "disabled"}\n`);
      continue;
    }

    try {
      const {response, toolsUsed, citations} = await sendChatMessage({
        sessionId,
        message: prompt,
        threadId: "main",
        useTools,
        includeCitations: true,
      });

      if (toolsUsed && toolsUsed.length > 0) {
        console.log(`\n🔧 Tools used: ${toolsUsed.join(", ")}`);
      }
      console.log(`\nGemini: ${response}`);

      // Display citations if available
      if (citations && citations.inlineCitations.length > 0) {
        console.log(`\n📚 Sources (${citations.totalChunksRetrieved} chunks retrieved):`);
        citations.inlineCitations.forEach((cite) => {
          const location = cite.pageNumber
            ? `Page ${cite.pageNumber}${cite.section ? `, ${cite.section}` : ""}`
            : cite.section || "Source";
          console.log(`   ${cite.id} ${location}:`);
          console.log(`      "${cite.sourceText}"`);
        });
      }
      console.log("");
    } catch (error) {
      console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

// ==========================================
// Exports
// ==========================================

export {
  sessionStore,
  buildSystemPrompt,
  applySlidingWindow,
};
