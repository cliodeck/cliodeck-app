import Database from 'better-sqlite3';
import path from 'path';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { randomUUID } from 'crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface Session {
  id: string;
  projectPath: string;
  startedAt: Date;
  endedAt?: Date;
  totalDurationMs?: number;
  eventCount: number;
  metadata?: Record<string, any>;
}

export interface HistoryEvent {
  id: string;
  sessionId: string;
  eventType: string;
  timestamp: Date;
  eventData?: Record<string, any>;
}

export interface AIOperation {
  id: string;
  sessionId: string;
  operationType: 'rag_query' | 'summarization' | 'citation_extraction' | 'topic_modeling';
  timestamp: Date;
  durationMs?: number;
  inputText?: string;
  inputMetadata?: Record<string, any>;
  modelName?: string;
  modelParameters?: Record<string, any>;
  outputText?: string;
  outputMetadata?: Record<string, any>;
  success: boolean;
  errorMessage?: string;
}

export interface DocumentOperation {
  id: string;
  sessionId: string;
  operationType: 'save' | 'create' | 'delete';
  filePath: string;
  timestamp: Date;
  wordsAdded?: number;
  wordsDeleted?: number;
  charactersAdded?: number;
  charactersDeleted?: number;
  contentHash?: string;
}

export interface PDFOperation {
  id: string;
  sessionId: string;
  operationType: 'import' | 'delete' | 'reindex';
  documentId?: string;
  timestamp: Date;
  durationMs?: number;
  filePath?: string;
  pageCount?: number;
  chunksCreated?: number;
  citationsExtracted?: number;
  metadata?: Record<string, any>;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: any[];
  timestamp: Date;
  modeId?: string;
}

export interface HistoryStatistics {
  totalSessions: number;
  totalEvents: number;
  totalChatMessages: number;
  totalAIOperations: number;
  averageSessionDuration: number;
}

// ============================================================================
// HistoryManager Class
// ============================================================================

export class HistoryManager {
  private db: Database.Database;
  private dbPath: string;
  public readonly projectPath: string;
  private currentSessionId: string | null = null;
  private isOpen: boolean = false;

  constructor(projectPath: string) {
    if (!projectPath) {
      throw new Error('HistoryManager requires a project path');
    }

    this.projectPath = projectPath;
    this.dbPath = path.join(projectPath, '.cliodeck', 'history.db');

    // Create .cliodeck directory if needed
    const cliodeckDir = path.join(projectPath, '.cliodeck');
    if (!existsSync(cliodeckDir)) {
      mkdirSync(cliodeckDir, { recursive: true });
    }

    // S'assurer que le dossier .cliodeck a les bonnes permissions
    try {
      chmodSync(cliodeckDir, 0o755); // rwxr-xr-x
    } catch (error) {
      console.warn(`⚠️  Could not set permissions on ${cliodeckDir}:`, error);
    }

    // Open database
    this.db = new Database(this.dbPath);
    this.isOpen = true;

    // S'assurer que le fichier de base de données a les bonnes permissions
    try {
      if (existsSync(this.dbPath)) {
        chmodSync(this.dbPath, 0o644); // rw-r--r--
      }
    } catch (error) {
      console.warn(`⚠️  Could not set permissions on ${this.dbPath}:`, error);
    }

    this.enableForeignKeys();

    // Initialize schema
    this.createTables();
    this.migrateDatabase();

    console.log(`📝 HistoryManager initialized: ${this.dbPath}`);
  }

  // ==========================================================================
  // Database Setup
  // ==========================================================================

  private enableForeignKeys(): void {
    this.db.pragma('foreign_keys = ON');
  }

  private createTables(): void {
    // Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        total_duration_ms INTEGER,
        event_count INTEGER DEFAULT 0,
        metadata TEXT
      );
    `);

    // Events table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_data TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // Chat messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources_json TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // AI operations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        input_text TEXT,
        input_metadata TEXT,
        model_name TEXT,
        model_parameters TEXT,
        output_text TEXT,
        output_metadata TEXT,
        success INTEGER DEFAULT 1,
        error_message TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // Document operations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        words_added INTEGER,
        words_deleted INTEGER,
        characters_added INTEGER,
        characters_deleted INTEGER,
        content_hash TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // PDF operations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pdf_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        document_id TEXT,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        file_path TEXT,
        page_count INTEGER,
        chunks_created INTEGER,
        citations_extracted INTEGER,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // Metadata table for schema versioning
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Create indexes
    this.createIndexes();

    console.log('📝 History database tables created');
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ai_ops_session ON ai_operations(session_id);
      CREATE INDEX IF NOT EXISTS idx_ai_ops_type ON ai_operations(operation_type);
      CREATE INDEX IF NOT EXISTS idx_ai_ops_timestamp ON ai_operations(timestamp);
      CREATE INDEX IF NOT EXISTS idx_doc_ops_session ON document_operations(session_id);
      CREATE INDEX IF NOT EXISTS idx_doc_ops_timestamp ON document_operations(timestamp);
      CREATE INDEX IF NOT EXISTS idx_pdf_ops_session ON pdf_operations(session_id);
      CREATE INDEX IF NOT EXISTS idx_pdf_ops_timestamp ON pdf_operations(timestamp);
    `);
  }

  private migrateDatabase(): void {
    // Check schema version
    const versionRow = this.db
      .prepare('SELECT value FROM history_metadata WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;

    const currentVersion = versionRow ? parseInt(versionRow.value) : 0;

    // No migrations yet, set initial version
    if (currentVersion === 0) {
      this.db
        .prepare('INSERT OR REPLACE INTO history_metadata (key, value) VALUES (?, ?)')
        .run('schema_version', '1');
      console.log('📝 History database schema version set to 1');
    }

    // Migration v2: Add mode_id to chat_messages and ai_operations
    if (currentVersion < 2) {
      try {
        // Check if column already exists before adding
        const chatColumns = this.db.pragma('table_info(chat_messages)') as any[];
        if (!chatColumns.some((c: any) => c.name === 'mode_id')) {
          this.db.exec('ALTER TABLE chat_messages ADD COLUMN mode_id TEXT');
          console.log('📝 Migration v2: Added mode_id to chat_messages');
        }

        const aiColumns = this.db.pragma('table_info(ai_operations)') as any[];
        if (!aiColumns.some((c: any) => c.name === 'mode_id')) {
          this.db.exec('ALTER TABLE ai_operations ADD COLUMN mode_id TEXT');
          console.log('📝 Migration v2: Added mode_id to ai_operations');
        }

        this.db.exec('CREATE INDEX IF NOT EXISTS idx_chat_mode ON chat_messages(mode_id)');

        this.db
          .prepare('INSERT OR REPLACE INTO history_metadata (key, value) VALUES (?, ?)')
          .run('schema_version', '2');
        console.log('📝 History database migrated to schema version 2');
      } catch (error) {
        console.error('❌ Migration v2 error:', error);
      }
    }
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  startSession(metadata?: Record<string, any>): string {
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, project_path, started_at, metadata)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      sessionId,
      this.projectPath,
      now,
      metadata ? JSON.stringify(metadata) : null
    );

    this.currentSessionId = sessionId;
    console.log(`📝 Session started: ${sessionId}`);
    return sessionId;
  }

  endSession(sessionId?: string): void {
    const id = sessionId || this.currentSessionId;
    if (!id) return;

    const session = this.getSession(id);
    if (!session || session.endedAt) return;

    const now = new Date().toISOString();
    const durationMs = Date.now() - session.startedAt.getTime();

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, total_duration_ms = ?
      WHERE id = ?
    `);

    stmt.run(now, durationMs, id);

    if (this.currentSessionId === id) {
      this.currentSessionId = null;
    }

    console.log(`📝 Session ended: ${id} (${Math.round(durationMs / 1000)}s)`);
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  // ==========================================================================
  // Event Logging
  // ==========================================================================

  logEvent(eventType: string, eventData?: Record<string, any>): string {
    if (!this.currentSessionId) {
      console.warn('⚠️  No active session - event not logged');
      return '';
    }

    const eventId = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO events (id, session_id, event_type, timestamp, event_data)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      eventId,
      this.currentSessionId,
      eventType,
      now,
      eventData ? JSON.stringify(eventData) : null
    );

    // Increment session event count
    this.db
      .prepare('UPDATE sessions SET event_count = event_count + 1 WHERE id = ?')
      .run(this.currentSessionId);

    return eventId;
  }

  // ==========================================================================
  // AI Operations
  // ==========================================================================

  logAIOperation(operation: Omit<AIOperation, 'id' | 'sessionId' | 'timestamp'>): string {
    if (!this.currentSessionId) {
      console.warn('⚠️  No active session - AI operation not logged');
      return '';
    }

    const opId = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO ai_operations (
        id, session_id, operation_type, timestamp, duration_ms,
        input_text, input_metadata, model_name, model_parameters,
        output_text, output_metadata, success, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      opId,
      this.currentSessionId,
      operation.operationType,
      now,
      operation.durationMs || null,
      operation.inputText || null,
      operation.inputMetadata ? JSON.stringify(operation.inputMetadata) : null,
      operation.modelName || null,
      operation.modelParameters ? JSON.stringify(operation.modelParameters) : null,
      operation.outputText || null,
      operation.outputMetadata ? JSON.stringify(operation.outputMetadata) : null,
      operation.success ? 1 : 0,
      operation.errorMessage || null
    );

    this.logEvent('ai_operation', { operationType: operation.operationType, id: opId });
    return opId;
  }

  // ==========================================================================
  // Document Operations
  // ==========================================================================

  logDocumentOperation(
    operation: Omit<DocumentOperation, 'id' | 'sessionId' | 'timestamp'>
  ): string {
    if (!this.currentSessionId) return '';

    const opId = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO document_operations (
        id, session_id, operation_type, file_path, timestamp,
        words_added, words_deleted, characters_added, characters_deleted, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      opId,
      this.currentSessionId,
      operation.operationType,
      operation.filePath,
      now,
      operation.wordsAdded || null,
      operation.wordsDeleted || null,
      operation.charactersAdded || null,
      operation.charactersDeleted || null,
      operation.contentHash || null
    );

    this.logEvent('document_operation', {
      operationType: operation.operationType,
      filePath: operation.filePath,
      id: opId,
    });
    return opId;
  }

  // ==========================================================================
  // PDF Operations
  // ==========================================================================

  logPDFOperation(operation: Omit<PDFOperation, 'id' | 'sessionId' | 'timestamp'>): string {
    if (!this.currentSessionId) return '';

    const opId = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO pdf_operations (
        id, session_id, operation_type, document_id, timestamp,
        duration_ms, file_path, page_count, chunks_created,
        citations_extracted, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      opId,
      this.currentSessionId,
      operation.operationType,
      operation.documentId || null,
      now,
      operation.durationMs || null,
      operation.filePath || null,
      operation.pageCount || null,
      operation.chunksCreated || null,
      operation.citationsExtracted || null,
      operation.metadata ? JSON.stringify(operation.metadata) : null
    );

    this.logEvent('pdf_operation', {
      operationType: operation.operationType,
      documentId: operation.documentId,
      id: opId,
    });
    return opId;
  }

  // ==========================================================================
  // Chat Messages
  // ==========================================================================

  logChatMessage(message: Omit<ChatMessage, 'id' | 'sessionId' | 'timestamp'> & { modeId?: string; queryParams?: any }): string {
    if (!this.currentSessionId) return '';

    const msgId = randomUUID();
    const now = new Date().toISOString();
    const modeId = message.modeId || message.queryParams?.modeId || null;

    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (id, session_id, role, content, sources_json, timestamp, mode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      msgId,
      this.currentSessionId,
      message.role,
      message.content,
      message.sources ? JSON.stringify(message.sources) : null,
      now,
      modeId
    );

    return msgId;
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  getSession(sessionId: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as any;

    if (!row) return null;

    return {
      id: row.id,
      projectPath: row.project_path,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
      totalDurationMs: row.total_duration_ms,
      eventCount: row.event_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  getAllSessions(): Session[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC');
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      projectPath: row.project_path,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
      totalDurationMs: row.total_duration_ms,
      eventCount: row.event_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  getEventsForSession(sessionId: string): HistoryEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      timestamp: new Date(row.timestamp),
      eventData: row.event_data ? JSON.parse(row.event_data) : undefined,
    }));
  }

  getChatMessagesForSession(sessionId: string): ChatMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      sources: row.sources_json ? JSON.parse(row.sources_json) : undefined,
      timestamp: new Date(row.timestamp),
      modeId: row.mode_id || undefined,
    }));
  }

  getAIOperationsForSession(sessionId: string): AIOperation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ai_operations WHERE session_id = ? ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => this.parseAIOperation(row));
  }

  getDocumentOperationsForSession(sessionId: string): DocumentOperation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM document_operations WHERE session_id = ? ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      operationType: row.operation_type,
      filePath: row.file_path,
      timestamp: new Date(row.timestamp),
      wordsAdded: row.words_added,
      wordsDeleted: row.words_deleted,
      charactersAdded: row.characters_added,
      charactersDeleted: row.characters_deleted,
      contentHash: row.content_hash,
    }));
  }

  getPDFOperationsForSession(sessionId: string): PDFOperation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pdf_operations WHERE session_id = ? ORDER BY timestamp ASC
    `);
    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      operationType: row.operation_type,
      documentId: row.document_id,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
      filePath: row.file_path,
      pageCount: row.page_count,
      chunksCreated: row.chunks_created,
      citationsExtracted: row.citations_extracted,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  // ==========================================================================
  // Project-wide Query Methods (all sessions)
  // ==========================================================================

  getAllEvents(): HistoryEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC
    `);
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      timestamp: new Date(row.timestamp),
      eventData: row.event_data ? JSON.parse(row.event_data) : undefined,
    }));
  }

  getAllAIOperations(): AIOperation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ai_operations ORDER BY timestamp DESC
    `);
    const rows = stmt.all() as any[];

    return rows.map((row) => this.parseAIOperation(row));
  }

  getAllChatMessages(): ChatMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM chat_messages ORDER BY timestamp DESC
    `);
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      sources: row.sources_json ? JSON.parse(row.sources_json) : undefined,
      timestamp: new Date(row.timestamp),
      modeId: row.mode_id || undefined,
    }));
  }

  getAllDocumentOperations(): DocumentOperation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM document_operations ORDER BY timestamp DESC
    `);
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      operationType: row.operation_type,
      filePath: row.file_path,
      timestamp: new Date(row.timestamp),
      wordsAdded: row.words_added,
      wordsDeleted: row.words_deleted,
      charactersAdded: row.characters_added,
      charactersDeleted: row.characters_deleted,
      contentHash: row.content_hash,
    }));
  }

  getAllPDFOperations(): PDFOperation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pdf_operations ORDER BY timestamp DESC
    `);
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      operationType: row.operation_type,
      documentId: row.document_id,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
      filePath: row.file_path,
      pageCount: row.page_count,
      chunksCreated: row.chunks_created,
      citationsExtracted: row.citations_extracted,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  private parseAIOperation(row: any): AIOperation {
    return {
      id: row.id,
      sessionId: row.session_id,
      operationType: row.operation_type,
      timestamp: new Date(row.timestamp),
      durationMs: row.duration_ms,
      inputText: row.input_text,
      inputMetadata: row.input_metadata ? JSON.parse(row.input_metadata) : undefined,
      modelName: row.model_name,
      modelParameters: row.model_parameters ? JSON.parse(row.model_parameters) : undefined,
      outputText: row.output_text,
      outputMetadata: row.output_metadata ? JSON.parse(row.output_metadata) : undefined,
      success: row.success === 1,
      errorMessage: row.error_message,
    };
  }

  // ==========================================================================
  // Search/Filter Methods
  // ==========================================================================

  searchEvents(filters: {
    sessionId?: string;
    eventType?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): HistoryEvent[] {
    let query = 'SELECT * FROM events WHERE 1=1';
    const params: any[] = [];

    if (filters.sessionId) {
      query += ' AND session_id = ?';
      params.push(filters.sessionId);
    }

    if (filters.eventType) {
      query += ' AND event_type = ?';
      params.push(filters.eventType);
    }

    if (filters.startDate) {
      query += ' AND timestamp >= ?';
      params.push(filters.startDate.toISOString());
    }

    if (filters.endDate) {
      query += ' AND timestamp <= ?';
      params.push(filters.endDate.toISOString());
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      timestamp: new Date(row.timestamp),
      eventData: row.event_data ? JSON.parse(row.event_data) : undefined,
    }));
  }

  // ==========================================================================
  // Export Methods
  // ==========================================================================

  exportSessionReport(sessionId: string, format: 'markdown' | 'json' | 'latex'): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const events = this.getEventsForSession(sessionId);
    const chatMessages = this.getChatMessagesForSession(sessionId);
    const aiOps = this.getAIOperationsForSession(sessionId);
    const docOps = this.getDocumentOperationsForSession(sessionId);
    const pdfOps = this.getPDFOperationsForSession(sessionId);

    if (format === 'markdown') {
      return this.exportAsMarkdown(session, events, chatMessages, aiOps, docOps, pdfOps);
    } else if (format === 'json') {
      return JSON.stringify(
        {
          session,
          events,
          chatMessages,
          aiOperations: aiOps,
          documentOperations: docOps,
          pdfOperations: pdfOps,
        },
        null,
        2
      );
    } else {
      return this.exportAsLaTeX(session, events, chatMessages, aiOps, docOps, pdfOps);
    }
  }

  private exportAsMarkdown(
    session: Session,
    events: HistoryEvent[],
    chatMessages: ChatMessage[],
    aiOps: AIOperation[],
    docOps: DocumentOperation[],
    pdfOps: PDFOperation[]
  ): string {
    let md = `# Research Session Report\n\n`;
    md += `**Session ID:** ${session.id}\n`;
    md += `**Started:** ${session.startedAt.toLocaleString()}\n`;
    md += `**Ended:** ${session.endedAt ? session.endedAt.toLocaleString() : 'Active'}\n`;
    md += `**Duration:** ${session.totalDurationMs ? Math.round(session.totalDurationMs / 1000 / 60) + ' minutes' : 'N/A'}\n`;
    md += `**Total Events:** ${session.eventCount}\n\n`;
    md += `---\n\n`;

    // Timeline
    md += `## Timeline\n\n`;
    events.forEach((event) => {
      md += `- **${event.timestamp.toLocaleTimeString()}** - ${event.eventType}\n`;
    });
    md += `\n`;

    // PDF Operations
    if (pdfOps.length > 0) {
      md += `## PDF Operations\n\n`;
      pdfOps.forEach((op) => {
        md += `### ${op.operationType} - ${op.filePath || op.documentId}\n`;
        md += `- **Time:** ${op.timestamp.toLocaleString()}\n`;
        if (op.pageCount) md += `- **Pages:** ${op.pageCount}\n`;
        if (op.chunksCreated) md += `- **Chunks Created:** ${op.chunksCreated}\n`;
        if (op.citationsExtracted) md += `- **Citations Extracted:** ${op.citationsExtracted}\n`;
        if (op.durationMs) md += `- **Duration:** ${op.durationMs}ms\n`;
        md += `\n`;
      });
    }

    // Document Operations
    if (docOps.length > 0) {
      md += `## Document Operations\n\n`;
      docOps.forEach((op) => {
        md += `### ${op.operationType} - ${op.filePath}\n`;
        md += `- **Time:** ${op.timestamp.toLocaleString()}\n`;
        if (op.wordsAdded) md += `- **Words Added:** ${op.wordsAdded}\n`;
        if (op.wordsDeleted) md += `- **Words Deleted:** ${op.wordsDeleted}\n`;
        md += `\n`;
      });
    }

    // AI Operations
    if (aiOps.length > 0) {
      md += `## AI Operations Summary\n\n`;
      md += `| Time | Operation | Model | Duration | Success |\n`;
      md += `|------|-----------|-------|----------|----------|\n`;
      aiOps.forEach((op) => {
        md += `| ${op.timestamp.toLocaleTimeString()} | ${op.operationType} | ${op.modelName || 'N/A'} | ${op.durationMs ? op.durationMs + 'ms' : 'N/A'} | ${op.success ? '✓' : '✗'} |\n`;
      });
      md += `\n`;

      // Detailed AI Operations
      md += `### Detailed AI Operations\n\n`;
      aiOps.forEach((op, idx) => {
        md += `#### ${idx + 1}. ${op.operationType} (${op.timestamp.toLocaleTimeString()})\n\n`;
        md += `**Model:** ${op.modelName || 'N/A'}\n\n`;
        if (op.inputText) {
          const preview = op.inputText.substring(0, 200);
          md += `**Input:**\n\`\`\`\n${preview}${op.inputText.length > 200 ? '...' : ''}\n\`\`\`\n\n`;
        }
        if (op.outputText) {
          const preview = op.outputText.substring(0, 200);
          md += `**Output:**\n\`\`\`\n${preview}${op.outputText.length > 200 ? '...' : ''}\n\`\`\`\n\n`;
        }
        if (op.outputMetadata) {
          md += `**Metadata:**\n\`\`\`json\n${JSON.stringify(op.outputMetadata, null, 2)}\n\`\`\`\n\n`;
        }
      });
    }

    // Chat History
    if (chatMessages.length > 0) {
      md += `## Chat History\n\n`;
      chatMessages.forEach((msg) => {
        md += `**${msg.role === 'user' ? 'User' : 'Assistant'}** (${msg.timestamp.toLocaleTimeString()}):\n`;
        md += `${msg.content}\n\n`;
        if (msg.sources && msg.sources.length > 0) {
          md += `*Sources:* ${msg.sources.map((s: any) => s.documentTitle || s.title).join(', ')}\n\n`;
        }
      });
    }

    return md;
  }

  private exportAsLaTeX(
    session: Session,
    events: HistoryEvent[],
    chatMessages: ChatMessage[],
    aiOps: AIOperation[],
    docOps: DocumentOperation[],
    pdfOps: PDFOperation[]
  ): string {
    let latex = `\\section{Research Session Report}\n\n`;
    latex += `\\subsection{Session Information}\n\n`;
    latex += `\\begin{itemize}\n`;
    latex += `  \\item Session ID: \\texttt{${session.id}}\n`;
    latex += `  \\item Started: ${session.startedAt.toLocaleString()}\n`;
    latex += `  \\item Ended: ${session.endedAt ? session.endedAt.toLocaleString() : 'Active'}\n`;
    latex += `  \\item Duration: ${session.totalDurationMs ? Math.round(session.totalDurationMs / 1000 / 60) + ' minutes' : 'N/A'}\n`;
    latex += `  \\item Total Events: ${session.eventCount}\n`;
    latex += `\\end{itemize}\n\n`;

    // AI Operations table
    if (aiOps.length > 0) {
      latex += `\\subsection{AI Operations}\n\n`;
      latex += `\\begin{table}[h]\n`;
      latex += `\\centering\n`;
      latex += `\\begin{tabular}{|l|l|l|l|}\n`;
      latex += `\\hline\n`;
      latex += `Time & Operation & Model & Duration \\\\\\\n`;
      latex += `\\hline\n`;
      aiOps.forEach((op) => {
        latex += `${op.timestamp.toLocaleTimeString()} & ${op.operationType} & ${op.modelName || 'N/A'} & ${op.durationMs ? op.durationMs + 'ms' : 'N/A'} \\\\\\\n`;
      });
      latex += `\\hline\n`;
      latex += `\\end{tabular}\n`;
      latex += `\\caption{AI Operations Log}\n`;
      latex += `\\end{table}\n\n`;
    }

    // Document Operations
    if (docOps.length > 0) {
      latex += `\\subsection{Document Operations}\n\n`;
      latex += `\\begin{itemize}\n`;
      docOps.forEach((op) => {
        latex += `  \\item ${op.operationType}: \\texttt{${op.filePath}} (${op.timestamp.toLocaleString()})`;
        if (op.wordsAdded) latex += ` - +${op.wordsAdded} words`;
        if (op.wordsDeleted) latex += ` -${op.wordsDeleted} words`;
        latex += `\n`;
      });
      latex += `\\end{itemize}\n\n`;
    }

    return latex;
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStatistics(): HistoryStatistics {
    const stats = {
      totalSessions: (
        this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as any
      ).count,
      totalEvents: (this.db.prepare('SELECT COUNT(*) as count FROM events').get() as any)
        .count,
      totalChatMessages: (
        this.db.prepare('SELECT COUNT(*) as count FROM chat_messages').get() as any
      ).count,
      totalAIOperations: (
        this.db.prepare('SELECT COUNT(*) as count FROM ai_operations').get() as any
      ).count,
      averageSessionDuration:
        (
          this.db
            .prepare(
              'SELECT AVG(total_duration_ms) as avg FROM sessions WHERE total_duration_ms IS NOT NULL'
            )
            .get() as any
        ).avg || 0,
    };

    return stats;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Check if the database connection is still open
   */
  public isDatabaseOpen(): boolean {
    return this.isOpen;
  }

  close(): void {
    if (!this.isOpen) {
      console.log('⚠️  HistoryManager already closed');
      return;
    }

    // End current session if active
    if (this.currentSessionId) {
      this.endSession();
    }

    this.db.close();
    this.isOpen = false;
    console.log('✅ HistoryManager closed');
  }
}
