// Console filter must be imported first to filter logs in production
import '@shared/console-filter';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Après index.css et les feuilles des composants : les classes communes des fenêtres
// modales valent dès le démarrage, quel que soit le panneau ouvert avant (H1).
import './components/common/Modal.css';
import './i18n'; // Initialiser i18next

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
