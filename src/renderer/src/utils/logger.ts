// Logger utilitaire pour le debugging
export const logger = {
  ipc: (action: string, ...args: any[]) => {
    console.log(`[IPC] ${action}`, ...args);
  },

  store: (storeName: string, action: string, ...args: any[]) => {
    console.log(`[Store:${storeName}] ${action}`, ...args);
  },

  component: (componentName: string, action: string, ...args: any[]) => {
    console.log(`[${componentName}] ${action}`, ...args);
  },

  error: (context: string, error: any) => {
    console.error(`[ERROR:${context}]`, error);
  },
};
