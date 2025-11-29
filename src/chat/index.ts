/**
 * Chat Module
 *
 * Modular chat backend for PDF conversations with:
 * - Persistent session management (LocalSessionStore, FirestoreSessionStore)
 * - RAG-powered chat tools for dynamic retrieval
 * - Genkit flows for chat operations
 *
 * Usage:
 *   import { createChatSession, sendChatMessage, chatWithPDF } from "./chat/index.js";
 */

// Re-export session store types and classes
export {
  type SessionData,
  type SessionStore,
  type PDFChatState,
  LocalSessionStore,
  FirestoreSessionStore,
  createSessionStore,
  generateSessionId,
  createEmptySession,
} from "./session-store.js";

// Re-export chat tools
export {
  searchPdfSectionsTool,
  extractTableDataTool,
  summarizeSectionTool,
  getExtractedDataTool,
  compareStudiesTool,
  chatTools,
  createSearchToolImpl,
  createExtractedDataToolImpl,
  getToolNames,
  type SearchResult,
  type TableData,
  type SectionSummary,
} from "./tools.js";

// Re-export chat flows
export {
  createChatSession,
  sendChatMessage,
  getChatHistory,
  listChatSessions,
  deleteChatSession,
  chat,
  chatWithPDF,
  sessionStore,
  buildSystemPrompt,
  applySlidingWindow,
} from "./flows.js";

// Re-export citation types and utilities
export {
  type Segment,
  type GroundingChunk,
  type GroundingSupport,
  type CitationMetadata,
  type InlineCitation,
  SegmentSchema,
  GroundingChunkSchema,
  GroundingSupportSchema,
  CitationMetadataSchema,
  InlineCitationSchema,
  chunksToGroundingChunks,
  createCitationMetadata,
  extractInlineCitations,
  formatCitationsForDisplay,
  addCitationMarkers,
  summarizeCitations,
} from "./citations.js";
