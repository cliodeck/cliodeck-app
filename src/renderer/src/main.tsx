// Console filter must be imported first to filter logs in production
import '@shared/console-filter';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './i18n'; // Initialiser i18next

// Configure Monaco to use local files instead of CDN (required in Electron)
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(window as any).MonacoEnvironment = {
  getWorker(_workerId: string, _label: string) {
    return new editorWorker();
  },
};

loader.config({ monaco });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
