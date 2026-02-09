import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type ThemeMode = 'light' | 'dark' | 'auto';

export interface ThemeConfig {
  mode: ThemeMode;
  autoSwitchEnabled: boolean;
  lightModeStart: string; // Format: "HH:MM"
  darkModeStart: string;  // Format: "HH:MM"
}

const DEFAULT_CONFIG: ThemeConfig = {
  mode: 'dark',
  autoSwitchEnabled: false,
  lightModeStart: '06:00',
  darkModeStart: '20:00',
};

// Load config synchronously from localStorage
const loadInitialConfig = (): ThemeConfig => {
  try {
    const saved = localStorage.getItem('theme-config');
    if (saved) {
      return JSON.parse(saved) as ThemeConfig;
    }
  } catch (error) {
    console.error('Failed to parse theme config:', error);
  }
  return DEFAULT_CONFIG;
};

export const useTheme = () => {
  const [config, setConfigState] = useState<ThemeConfig>(loadInitialConfig);
  const [currentTheme, setCurrentTheme] = useState<Theme>('dark');

  // Calculate current theme based on config
  useEffect(() => {
    const calculateTheme = (): Theme => {
      if (config.mode === 'light') return 'light';
      if (config.mode === 'dark') return 'dark';

      // Auto mode
      if (!config.autoSwitchEnabled) {
        return 'dark'; // Default to dark if auto is disabled
      }

      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const currentTime = currentHour * 60 + currentMinute; // Minutes since midnight

      const [lightHour, lightMin] = config.lightModeStart.split(':').map(Number);
      const lightTime = lightHour * 60 + lightMin;

      const [darkHour, darkMin] = config.darkModeStart.split(':').map(Number);
      const darkTime = darkHour * 60 + darkMin;

      // Check if current time is within light mode hours
      if (lightTime < darkTime) {
        // Normal case: light mode during day (e.g., 6:00 - 20:00)
        return (currentTime >= lightTime && currentTime < darkTime) ? 'light' : 'dark';
      } else {
        // Inverted case: light mode crosses midnight (e.g., 20:00 - 6:00 next day)
        return (currentTime >= lightTime || currentTime < darkTime) ? 'light' : 'dark';
      }
    };

    const newTheme = calculateTheme();
    setCurrentTheme(newTheme);

    // Set up interval to check theme every minute if auto mode is enabled
    if (config.mode === 'auto' && config.autoSwitchEnabled) {
      const interval = setInterval(() => {
        const updatedTheme = calculateTheme();
        setCurrentTheme(updatedTheme);
      }, 60000); // Check every minute

      return () => clearInterval(interval);
    }
  }, [config]);

  // Apply theme class to body
  useEffect(() => {
    if (currentTheme === 'light') {
      document.body.classList.add('theme-light');
      document.body.classList.remove('theme-dark');
    } else {
      document.body.classList.add('theme-dark');
      document.body.classList.remove('theme-light');
    }
  }, [currentTheme]);

  // Save config to localStorage when it changes
  const setConfig = (newConfig: ThemeConfig) => {
    setConfigState(newConfig);
    localStorage.setItem('theme-config', JSON.stringify(newConfig));
  };

  return {
    config,
    setConfig,
    currentTheme,
  };
};
