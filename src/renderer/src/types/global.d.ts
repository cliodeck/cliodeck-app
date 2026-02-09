import type { ElectronAPI } from '../../../preload';

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
