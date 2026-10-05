import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '../stores/notificationStore';

/**
 * Prévient quand l'application tourne sans le bac à sable de Chromium (#151).
 *
 * Sous Linux, l'AppImage se lance d'elle-même avec `--no-sandbox` quand le
 * système ne permet pas le bac à sable (Ubuntu 24.04 par défaut). Tout
 * fonctionne, mais une protection manque : l'utilisateur doit le savoir, et
 * savoir que le paquet `.deb` la rétablit.
 *
 * L'avertissement reste affiché jusqu'à ce qu'on le ferme : un message qui
 * s'efface seul au démarrage passerait inaperçu.
 */
export function useSandboxWarning(): void {
  const { t } = useTranslation('common');
  const notify = useNotificationStore((s) => s.notify);
  const [appImage, setAppImage] = useState<boolean | null>(null);
  const shownId = useRef<string | null>(null);

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

  useEffect(() => {
    if (appImage === null) return;
    const store = useNotificationStore.getState();
    // La langue enregistrée s'applique après le premier rendu : tant que
    // l'avertissement est à l'écran, on le réécrit dans la nouvelle langue.
    // Une fois fermé par l'utilisateur, il le reste.
    if (shownId.current) {
      if (!store.notifications.some((n) => n.id === shownId.current)) return;
      store.dismiss(shownId.current);
    }
    shownId.current = notify({
      level: 'warning',
      title: t('sandboxDisabled.title'),
      message: t(appImage ? 'sandboxDisabled.messageAppImage' : 'sandboxDisabled.message'),
      details: appImage ? t('sandboxDisabled.detailsAppImage') : undefined,
      duration: 0,
    });
  }, [appImage, notify, t]);
}
