import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStickyWarning } from './useStickyWarning';

/**
 * Prévient, sous macOS 12 ou 13, que l'IA locale n'y fonctionnera pas.
 *
 * ClioDeck y démarre, mais Ollama exige macOS 14 et le moteur des modèles
 * embarqués est construit pour macOS 14 : on ne l'apprenait qu'en cherchant
 * pourquoi rien ne s'indexait. Reste un fournisseur en ligne, ou une mise à
 * jour du système.
 *
 * C'est une limite du système, sans remède dans l'app, et bien des Mac ne
 * peuvent pas dépasser macOS 13 : la redire à chaque lancement n'apprendrait
 * plus rien. Une fois fermé, l'avertissement ne revient donc pas — à la
 * différence de celui du bac à sable.
 */
export function useLocalAiSupportWarning(): void {
  const { t } = useTranslation('common');
  const [macosVersion, setMacosVersion] = useState<string | null>(null);

  useEffect(() => {
    const getLocalAiSupport = window.electron?.system?.getLocalAiSupport;
    if (!getLocalAiSupport) return;
    let cancelled = false;
    getLocalAiSupport()
      .then((support) => {
        if (cancelled || !support.success || !support.limited || support.noticeDismissed) return;
        setMacosVersion(support.macosVersion ?? '');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useStickyWarning(
    macosVersion === null
      ? null
      : {
          title: t('localAiUnsupported.title'),
          message: t('localAiUnsupported.message', { version: macosVersion }),
          details: t('localAiUnsupported.details'),
        },
    () => {
      void window.electron?.config?.set('localAiNoticeDismissed', true);
    }
  );
}
