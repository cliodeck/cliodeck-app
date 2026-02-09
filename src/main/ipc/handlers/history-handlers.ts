/**
 * History and session tracking IPC handlers
 */
import { ipcMain } from 'electron';
import { historyService } from '../../services/history-service.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validate, HistoryExportReportSchema, HistorySearchEventsSchema } from '../utils/validation.js';

export function setupHistoryHandlers() {
  ipcMain.handle('history:get-sessions', async () => {
    console.log('📞 IPC Call: history:get-sessions');
    try {
      const hm = historyService.getHistoryManager();
      if (!hm || !hm.isDatabaseOpen()) {
        return { ...errorResponse('No project open or database closed'), sessions: [] };
      }

      const sessions = hm.getAllSessions();
      console.log('📤 IPC Response: history:get-sessions', { count: sessions.length });
      return successResponse({ sessions });
    } catch (error: any) {
      console.error('❌ history:get-sessions error:', error);
      return { ...errorResponse(error), sessions: [] };
    }
  });

  ipcMain.handle('history:get-events', async (_event, sessionId: string) => {
    console.log('📞 IPC Call: history:get-events', { sessionId });
    try {
      const hm = historyService.getHistoryManager();
      if (!hm) {
        return { ...errorResponse('No project open'), events: [] };
      }

      const events = hm.getEventsForSession(sessionId);
      console.log('📤 IPC Response: history:get-events', { count: events.length });
      return successResponse({ events });
    } catch (error: any) {
      console.error('❌ history:get-events error:', error);
      return { ...errorResponse(error), events: [] };
    }
  });

  ipcMain.handle('history:get-chat-history', async (_event, sessionId: string) => {
    console.log('📞 IPC Call: history:get-chat-history', { sessionId });
    try {
      const hm = historyService.getHistoryManager();
      if (!hm) {
        return { ...errorResponse('No project open'), messages: [] };
      }

      const messages = hm.getChatMessagesForSession(sessionId);
      console.log('📤 IPC Response: history:get-chat-history', { count: messages.length });
      return successResponse({ messages });
    } catch (error: any) {
      console.error('❌ history:get-chat-history error:', error);
      return { ...errorResponse(error), messages: [] };
    }
  });

  ipcMain.handle('history:get-ai-operations', async (_event, sessionId: string) => {
    console.log('📞 IPC Call: history:get-ai-operations', { sessionId });
    try {
      const hm = historyService.getHistoryManager();
      if (!hm) {
        return { ...errorResponse('No project open'), operations: [] };
      }

      const operations = hm.getAIOperationsForSession(sessionId);
      console.log('📤 IPC Response: history:get-ai-operations', { count: operations.length });
      return successResponse({ operations });
    } catch (error: any) {
      console.error('❌ history:get-ai-operations error:', error);
      return { ...errorResponse(error), operations: [] };
    }
  });

  ipcMain.handle('history:export-report', async (_event, sessionId: string, format: string) => {
    console.log('📞 IPC Call: history:export-report', { sessionId, format });
    try {
      const validatedData = validate(HistoryExportReportSchema, { sessionId, format });

      const hm = historyService.getHistoryManager();
      if (!hm) {
        return errorResponse('No project open');
      }

      const report = hm.exportSessionReport(
        validatedData.sessionId,
        validatedData.format as 'markdown' | 'json' | 'latex'
      );
      console.log('📤 IPC Response: history:export-report', {
        format: validatedData.format,
        length: report.length,
      });
      return successResponse({ report });
    } catch (error: any) {
      console.error('❌ history:export-report error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('history:get-statistics', async () => {
    console.log('📞 IPC Call: history:get-statistics');
    try {
      const hm = historyService.getHistoryManager();
      if (!hm || !hm.isDatabaseOpen()) {
        return errorResponse('No project open or database closed');
      }

      const statistics = hm.getStatistics();
      console.log('📤 IPC Response: history:get-statistics', statistics);
      return successResponse({ statistics });
    } catch (error: any) {
      console.error('❌ history:get-statistics error:', error);
      return errorResponse(error);
    }
  });

  ipcMain.handle('history:search-events', async (_event, filters: unknown) => {
    console.log('📞 IPC Call: history:search-events', filters);
    try {
      const validatedData = validate(HistorySearchEventsSchema, filters);

      const hm = historyService.getHistoryManager();
      if (!hm) {
        return { ...errorResponse('No project open'), events: [] };
      }

      // Convert date strings to Date objects if present
      const processedFilters = {
        ...validatedData,
        startDate: validatedData.startDate ? new Date(validatedData.startDate) : undefined,
        endDate: validatedData.endDate ? new Date(validatedData.endDate) : undefined,
      };

      const events = hm.searchEvents(processedFilters);
      console.log('📤 IPC Response: history:search-events', { count: events.length });
      return successResponse({ events });
    } catch (error: any) {
      console.error('❌ history:search-events error:', error);
      return { ...errorResponse(error), events: [] };
    }
  });

  // Project-wide data (all sessions aggregated)
  ipcMain.handle('history:get-all-events', async () => {
    console.log('📞 IPC Call: history:get-all-events');
    try {
      const hm = historyService.getHistoryManager();
      if (!hm || !hm.isDatabaseOpen()) {
        return { ...errorResponse('No project open or database closed'), events: [] };
      }

      const events = hm.getAllEvents();
      console.log('📤 IPC Response: history:get-all-events', { count: events.length });
      return successResponse({ events });
    } catch (error: any) {
      console.error('❌ history:get-all-events error:', error);
      return { ...errorResponse(error), events: [] };
    }
  });

  ipcMain.handle('history:get-all-ai-operations', async () => {
    console.log('📞 IPC Call: history:get-all-ai-operations');
    try {
      const hm = historyService.getHistoryManager();
      if (!hm || !hm.isDatabaseOpen()) {
        return { ...errorResponse('No project open or database closed'), operations: [] };
      }

      const operations = hm.getAllAIOperations();
      console.log('📤 IPC Response: history:get-all-ai-operations', { count: operations.length });
      return successResponse({ operations });
    } catch (error: any) {
      console.error('❌ history:get-all-ai-operations error:', error);
      return { ...errorResponse(error), operations: [] };
    }
  });

  ipcMain.handle('history:get-all-chat-messages', async () => {
    console.log('📞 IPC Call: history:get-all-chat-messages');
    try {
      const hm = historyService.getHistoryManager();
      if (!hm || !hm.isDatabaseOpen()) {
        return { ...errorResponse('No project open or database closed'), messages: [] };
      }

      const messages = hm.getAllChatMessages();
      console.log('📤 IPC Response: history:get-all-chat-messages', { count: messages.length });
      return successResponse({ messages });
    } catch (error: any) {
      console.error('❌ history:get-all-chat-messages error:', error);
      return { ...errorResponse(error), messages: [] };
    }
  });

  console.log('✅ History handlers registered');
}
