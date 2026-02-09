import React, { useState, useEffect } from 'react';
import { Folder, FolderOpen, FileText } from 'lucide-react';
import './FileTree.css';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface FileTreeProps {
  rootPath: string;
  onFileSelect?: (filePath: string) => void;
}

interface DirectoryNodeProps {
  item: FileItem;
  level: number;
  onFileSelect?: (filePath: string) => void;
}

const DirectoryNode: React.FC<DirectoryNodeProps> = ({ item, level, onFileSelect }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleToggle = async () => {
    if (!item.isDirectory) return;

    if (!isExpanded && children.length === 0) {
      setIsLoading(true);
      try {
        const result = await window.electron.fs.readDirectory(item.path);
        if (result.success) {
          // Filter to only show .md files and directories
          const filtered = result.items.filter(
            (i: FileItem) => i.isDirectory || i.name.toLowerCase().endsWith('.md')
          );
          setChildren(filtered);
        }
      } catch (error) {
        console.error('Failed to read directory:', error);
      } finally {
        setIsLoading(false);
      }
    }

    setIsExpanded(!isExpanded);
  };

  const handleFileClick = () => {
    if (item.isFile && item.name.toLowerCase().endsWith('.md')) {
      onFileSelect?.(item.path);
    }
  };

  const indent = level * 16;

  return (
    <>
      <div
        className={`file-tree-item ${item.isDirectory ? 'directory' : 'file'}`}
        style={{ paddingLeft: `${indent}px` }}
        onClick={item.isDirectory ? handleToggle : handleFileClick}
      >
        <span className="file-tree-icon">
          {item.isDirectory ? (
            isExpanded ? <FolderOpen size={20} strokeWidth={1} /> : <Folder size={20} strokeWidth={1} />
          ) : (
            <FileText size={20} strokeWidth={1} />
          )}
        </span>
        <span className="file-tree-name">{item.name}</span>
        {isLoading && <span className="file-tree-loading">...</span>}
      </div>

      {isExpanded && children.length > 0 && (
        <div className="file-tree-children">
          {children.map((child) => (
            <DirectoryNode
              key={child.path}
              item={child}
              level={level + 1}
              onFileSelect={onFileSelect}
            />
          ))}
        </div>
      )}
    </>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({ rootPath, onFileSelect }) => {
  const [rootItems, setRootItems] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadRootDirectory = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await window.electron.fs.readDirectory(rootPath);
        if (result.success) {
          // Filter to only show .md files and directories
          const filtered = result.items.filter(
            (item: FileItem) => item.isDirectory || item.name.toLowerCase().endsWith('.md')
          );
          setRootItems(filtered);
        } else {
          setError(result.error || 'Failed to load directory');
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load directory');
        console.error('Failed to load root directory:', err);
      } finally {
        setIsLoading(false);
      }
    };

    if (rootPath) {
      loadRootDirectory();
    }
  }, [rootPath]);

  if (isLoading) {
    return (
      <div className="file-tree-loading-container">
        <p>Chargement des fichiers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-tree-error">
        <p>Erreur: {error}</p>
      </div>
    );
  }

  if (rootItems.length === 0) {
    return (
      <div className="file-tree-empty">
        <p>Aucun fichier Markdown trouvé</p>
      </div>
    );
  }

  return (
    <div className="file-tree">
      {rootItems.map((item) => (
        <DirectoryNode
          key={item.path}
          item={item}
          level={0}
          onFileSelect={onFileSelect}
        />
      ))}
    </div>
  );
};
