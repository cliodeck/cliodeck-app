import { useEffect, useState } from 'react';

export type Density = 'comfortable' | 'compact';

export const useDensity = () => {
  const [density, setDensity] = useState<Density>('comfortable');

  useEffect(() => {
    // Load density from localStorage
    const saved = localStorage.getItem('ui-density') as Density;
    if (saved === 'compact' || saved === 'comfortable') {
      setDensity(saved);
    }
  }, []);

  useEffect(() => {
    // Apply density class to body
    if (density === 'compact') {
      document.body.classList.add('density-compact');
    } else {
      document.body.classList.remove('density-compact');
    }

    // Save to localStorage
    localStorage.setItem('ui-density', density);
  }, [density]);

  return { density, setDensity };
};
