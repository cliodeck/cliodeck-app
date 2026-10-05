import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStickyWarning } from './useStickyWarning';

/**
 * Prévient, sous macOS 12 ou 13, qu'Ollama ne peut pas y être installé, et
 * dit ce qui reste pour une IA locale.
 *
 * ClioDeck y démarre, mais Ollama exige macOS 14 : on ne l'apprenait qu'en
 * cherchant pourquoi rien ne s'indexait. Restent les modèles embarqués —
 * génération ET embeddings, tous deux rangés dans le mode Expert des
 * paramètres, donc faciles à ne jamais trouver — ou un fournisseur en ligne.
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
          title: t('localAiLimited.title'),
          message: t('localAiLimited.message', { version: macosVersion }),
          details: t('localAiLimited.details'),
        },
    () => {
      void window.electron?.config?.set('localAiNoticeDismissed', true);
    }
  );
}
