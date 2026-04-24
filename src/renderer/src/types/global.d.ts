/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

import type { ElectronAPI } from '../../../preload';

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
