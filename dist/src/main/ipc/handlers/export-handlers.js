/**
 * PDF, Word, and Presentation Export IPC handlers
 */
import { ipcMain, BrowserWindow } from 'electron';
import { pdfExportService } from '../../services/pdf-export.js';
import { wordExportService } from '../../services/word-export.js';
import { revealJsExportService } from '../../services/revealjs-export.js';
import { successResponse, errorResponse } from '../utils/error-handler.js';
import { validate, PDFExportSchema, RevealJSExportSchema } from '../utils/validation.js';
export function setupExportHandlers() {
    // PDF Export handlers
    ipcMain.handle('pdf-export:check-dependencies', async () => {
        console.log('📞 IPC Call: pdf-export:check-dependencies');
        try {
            const result = await pdfExportService.checkDependencies();
            console.log('📤 IPC Response: pdf-export:check-dependencies', result);
            return { ...successResponse(), ...result };
        }
        catch (error) {
            console.error('❌ pdf-export:check-dependencies error:', error);
            return errorResponse(error);
        }
    });
    ipcMain.handle('pdf-export:export', async (event, options) => {
        console.log('📞 IPC Call: pdf-export:export');
        try {
            const validatedData = validate(PDFExportSchema, options);
            console.log('  projectType:', validatedData.projectType, 'hasBibliography:', !!validatedData.bibliographyPath);
            const window = BrowserWindow.fromWebContents(event.sender);
            const result = await pdfExportService.exportToPDF(validatedData, (progress) => {
                if (window) {
                    window.webContents.send('pdf-export:progress', progress);
                }
            });
            console.log('📤 IPC Response: pdf-export:export', {
                success: result.success,
                outputPath: result.outputPath,
            });
            return result;
        }
        catch (error) {
            console.error('❌ pdf-export:export error:', error);
            return errorResponse(error);
        }
    });
    // Word Export handlers
    ipcMain.handle('word-export:export', async (event, options) => {
        console.log('📞 IPC Call: word-export:export', {
            projectType: options.projectType,
            hasBibliography: !!options.bibliographyPath,
            hasTemplate: !!options.templatePath,
        });
        try {
            const window = BrowserWindow.fromWebContents(event.sender);
            const result = await wordExportService.exportToWord(options, (progress) => {
                if (window) {
                    window.webContents.send('word-export:progress', progress);
                }
            });
            console.log('📤 IPC Response: word-export:export', {
                success: result.success,
                outputPath: result.outputPath,
            });
            return result;
        }
        catch (error) {
            console.error('❌ word-export:export error:', error);
            return errorResponse(error);
        }
    });
    ipcMain.handle('word-export:find-template', async (_event, projectPath) => {
        console.log('📞 IPC Call: word-export:find-template', { projectPath });
        try {
            const templatePath = await wordExportService.findTemplate(projectPath);
            console.log('📤 IPC Response: word-export:find-template', { templatePath });
            return { ...successResponse(), templatePath };
        }
        catch (error) {
            console.error('❌ word-export:find-template error:', error);
            return errorResponse(error);
        }
    });
    // Reveal.js Export handlers
    ipcMain.handle('revealjs-export:export', async (event, options) => {
        console.log('📞 IPC Call: revealjs-export:export');
        try {
            const validatedData = validate(RevealJSExportSchema, options);
            console.log('  hasConfig:', !!validatedData.config);
            const window = BrowserWindow.fromWebContents(event.sender);
            const result = await revealJsExportService.exportToRevealJs(validatedData, (progress) => {
                if (window) {
                    window.webContents.send('revealjs-export:progress', progress);
                }
            });
            console.log('📤 IPC Response: revealjs-export:export', {
                success: result.success,
                outputPath: result.outputPath,
            });
            return result;
        }
        catch (error) {
            console.error('❌ revealjs-export:export error:', error);
            return errorResponse(error);
        }
    });
    console.log('✅ Export handlers registered');
}
