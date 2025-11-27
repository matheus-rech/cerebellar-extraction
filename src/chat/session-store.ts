/**
 * Chat Session Store Module
 *
 * Provides persistent storage for chat sessions with support for:
 * - Local JSON file storage (development)
 * - Firestore storage (production)
 * - Multi-thread conversations within sessions
 */

import * as fs from "fs";
import * as path from "path";
import {Firestore} from "@google-cloud/firestore";

// ==========================================
// Types
// ==========================================

/**
 * Session data structure for persistent storage
 */
export interface SessionData<S = any> {
  id: string;
  state?: S;
  threads: Record<string, Array<{role: "user" | "model"; content: string}>>;
  createdAt: string;
  updatedAt: string;
}

/**
 * PDF Chat Session State
 */
export interface PDFChatState {
  pdfPath: string;
  pdfFileName: string;
  pdfTextLength: number;
  studyTitle?: string;
  studyId?: string;
  extractedData?: any;
}

/**
 * SessionStore interface for Genkit chat persistence
 */
export interface SessionStore<S = any> {
  get(sessionId: string): Promise<SessionData<S> | undefined>;
  save(sessionId: string, sessionData: SessionData<S>): Promise<void>;
  list?(): Promise<string[]>;
  delete?(sessionId: string): Promise<boolean>;
}

// ==========================================
// Local JSON-based SessionStore
// ==========================================

/**
 * Local JSON-based SessionStore implementation
 * Stores session data in individual JSON files
 * Suitable for development and single-instance deployments
 */
export class LocalSessionStore<S = any> implements SessionStore<S> {
  private sessionsDir: string;

  constructor(baseDir: string = "./data") {
    this.sessionsDir = path.join(baseDir, "sessions");
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, {recursive: true});
    }
  }

  private getFilePath(sessionId: string): string {
    // Sanitize sessionId to prevent path traversal
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  async get(sessionId: string): Promise<SessionData<S> | undefined> {
    try {
      const filePath = this.getFilePath(sessionId);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as SessionData<S>;
    } catch (error) {
      console.error(`Failed to load session ${sessionId}:`, error);
      return undefined;
    }
  }

  async save(sessionId: string, sessionData: SessionData<S>): Promise<void> {
    try {
      const filePath = this.getFilePath(sessionId);
      sessionData.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2));
    } catch (error) {
      console.error(`Failed to save session ${sessionId}:`, error);
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
    } catch (error) {
      console.error("Failed to list sessions:", error);
      return [];
    }
  }

  async delete(sessionId: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Get all sessions with metadata (for listing)
   */
  async getAllWithMetadata(): Promise<Array<{
    id: string;
    state: S | undefined;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
  }>> {
    const sessionIds = await this.list();
    const sessions = await Promise.all(
      sessionIds.map(async (id) => {
        const session = await this.get(id);
        if (!session) return null;
        const mainThread = session.threads["main"] || [];
        return {
          id,
          state: session.state,
          messageCount: mainThread.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        };
      })
    );
    return sessions.filter((s): s is NonNullable<typeof s> => s !== null);
  }
}

// ==========================================
// Firestore-based SessionStore
// ==========================================

/**
 * Firestore-based SessionStore implementation
 * For production deployments with scalability requirements
 */
export class FirestoreSessionStore<S = any> implements SessionStore<S> {
  private db: Firestore | null = null;
  private collection: string;

  constructor(collection: string = "chat_sessions") {
    this.collection = collection;
  }

  private async getDb(): Promise<Firestore> {
    if (!this.db) {
      this.db = new Firestore();
    }
    return this.db;
  }

  async get(sessionId: string): Promise<SessionData<S> | undefined> {
    const db = await this.getDb();
    const doc = await db.collection(this.collection).doc(sessionId).get();
    if (!doc.exists) {
      return undefined;
    }
    return doc.data() as SessionData<S>;
  }

  async save(sessionId: string, sessionData: SessionData<S>): Promise<void> {
    const db = await this.getDb();
    sessionData.updatedAt = new Date().toISOString();
    await db.collection(this.collection).doc(sessionId).set(sessionData);
  }

  async list(): Promise<string[]> {
    const db = await this.getDb();
    const snapshot = await db.collection(this.collection).select().get();
    return snapshot.docs.map((doc) => doc.id);
  }

  async delete(sessionId: string): Promise<boolean> {
    try {
      const db = await this.getDb();
      await db.collection(this.collection).doc(sessionId).delete();
      return true;
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
      return false;
    }
  }
}

// ==========================================
// Factory Function
// ==========================================

/**
 * Create a session store based on environment configuration
 */
export function createSessionStore<S = any>(options?: {
  useFirestore?: boolean;
  baseDir?: string;
  collection?: string;
}): SessionStore<S> {
  const useFirestore = options?.useFirestore ?? process.env.USE_FIRESTORE === "true";

  if (useFirestore) {
    return new FirestoreSessionStore<S>(options?.collection);
  }

  return new LocalSessionStore<S>(options?.baseDir);
}

// ==========================================
// Helper Functions
// ==========================================

/**
 * Generate a unique session ID
 */
export function generateSessionId(prefix: string = "chat"): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Create a new empty session data object
 */
export function createEmptySession<S>(
  sessionId: string,
  state?: S
): SessionData<S> {
  return {
    id: sessionId,
    state,
    threads: {
      main: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
