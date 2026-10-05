import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStickyWarning } from './useStickyWarning';

/**
 * Prévient quand l'application tourne sans le bac à sable de Chromium (#151).
 *
 * Sous Linux, l'AppImage se lance d'elle-même avec `--no-sandbox` quand le
 * système ne permet pas le bac à sable (Ubuntu 24.04 par défaut). Tout
 * fonctionne, mais une protection manque : l'utilisateur doit le savoir, et
 * savoir que le paquet `.deb` la rétablit.
 *
 * La situation dure tant que le système n'est pas réglé autrement, et elle a
 * un remède : l'avertissement revient donc à chaque lancement.
 */
export function useSandboxWarning(): void {
  const { t } = useTranslation('common');
  const [appImage, setAppImage] = useState<boolean | null>(null);

  useEffect(() => {
    const getSandboxStatus = window.electron?.system?.getSandboxStatus;
    if (!getSandboxStatus) return;
    let cancelled = false;
    getSandboxStatus()
      .then((status) => {
        if (!cancelled && status.success && status.disabled) setAppImage(Boolean(status.appImage));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useStickyWarning(
    appImage === null
      ? null
      : {
          title: t('sandboxDisabled.title'),
          message: t(appImage ? 'sandboxDisabled.messageAppImage' : 'sandboxDisabled.message'),
          details: appImage ? t('sandboxDisabled.detailsAppImage') : undefined,
        }
  );
}
