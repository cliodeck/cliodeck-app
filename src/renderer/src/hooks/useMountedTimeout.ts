import { useCallback, useEffect, useRef } from 'react';

/**
 * Une minuterie qui ne survit pas à son composant : annulée au démontage, et
 * jamais armée après. La seconde moitié compte autant que la première : un
 * travail lancé avant le démontage peut très bien se terminer après, et armer
 * alors une minuterie que plus aucun nettoyage n'annulera.
 */
export function useMountedTimeout(): (run: () => void, ms: number) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    // StrictMode rejoue l'effet au montage : le nettoyage a déjà tourné une fois.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return useCallback((run, ms) => {
    if (mounted.current) timer.current = setTimeout(run, ms);
  }, []);
}
