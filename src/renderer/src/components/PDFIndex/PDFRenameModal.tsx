import React, { useState, useEffect } from 'react';
import { X, FileText, Edit2, Check } from 'lucide-react';
import './PDFRenameModal.css';

interface PDFFile {
  path: string;
  suggestedName: string;
  customName: string;
  pageCount?: number;
}

interface PDFRenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  files: string[];
  onConfirm: (renamedFiles: Map<string, string>) => void;
}

export const PDFRenameModal: React.FC<PDFRenameModalProps> = ({
  isOpen,
  onClose,
  files,
  onConfirm,
}) => {
  const [pdfFiles, setPdfFiles] = useState<PDFFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen && files.length > 0) {
      loadPDFMetadata();
    }
  }, [isOpen, files]);

  const loadPDFMetadata = async () => {
    setIsLoading(true);
    const loadedFiles: PDFFile[] = [];

    for (const filePath of files) {
      try {
        const result = await window.electron.pdf.extractMetadata(filePath);
        if (result.success && result.metadata) {
          loadedFiles.push({
            path: filePath,
            suggestedName: result.metadata.title,
            customName: result.metadata.title,
            pageCount: result.metadata.pageCount,
          });
        } else {
          // Fallback to filename
          const filename = filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled';
          loadedFiles.push({
            path: filePath,
            suggestedName: filename,
            customName: filename,
          });
        }
      } catch (error) {
        console.error('Failed to extract metadata for:', filePath, error);
        const filename = filePath.split('/').pop()?.replace('.pdf', '') || 'Untitled';
        loadedFiles.push({
          path: filePath,
          suggestedName: filename,
          customName: filename,
        });
      }
    }

    setPdfFiles(loadedFiles);
    setIsLoading(false);
  };

  const handleNameChange = (index: number, newName: string) => {
    setPdfFiles(prev => {
      const updated = [...prev];
      updated[index].customName = newName;
      return updated;
    });
  };

  const handleConfirm = () => {
    const renamedMap = new Map<string, string>();
    pdfFiles.forEach(file => {
      renamedMap.set(file.path, file.customName);
    });
    onConfirm(renamedMap);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content pdf-rename-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Rename Documents Before Indexing</h3>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {isLoading ? (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Extracting metadata from PDFs...</p>
            </div>
          ) : (
            <>
              <p className="modal-info">
                Review and customize document names before indexing.
                Names are automatically suggested from PDF metadata or filename.
              </p>

              <div className="pdf-list">
                {pdfFiles.map((file, index) => (
                  <div key={file.path} className="pdf-item">
                    <div className="pdf-icon">
                      <FileText size={24} color="var(--primary-color)" />
                    </div>
                    <div className="pdf-details">
                      {editingIndex === index ? (
                        <div className="edit-mode">
                          <input
                            type="text"
                            value={file.customName}
                            onChange={(e) => handleNameChange(index, e.target.value)}
                            autoFocus
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                setEditingIndex(null);
                              }
                            }}
                          />
                          <button
                            className="save-btn"
                            onClick={() => setEditingIndex(null)}
                            title="Save"
                          >
                            <Check size={16} />
                          </button>
                        </div>
                      ) : (
                        <div className="view-mode">
                          <h4>{file.customName}</h4>
                          <button
                            className="edit-btn"
                            onClick={() => setEditingIndex(index)}
                            title="Edit name"
                          >
                            <Edit2 size={14} />
                          </button>
                        </div>
                      )}
                      <div className="pdf-meta">
                        <span className="filename">{file.path.split('/').pop()}</span>
                        {file.pageCount && (
                          <span className="page-count">{file.pageCount} pages</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleConfirm}
            disabled={isLoading}
          >
            Index {pdfFiles.length} Document{pdfFiles.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
};
