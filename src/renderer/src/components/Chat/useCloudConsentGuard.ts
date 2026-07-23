import { useCallback, useEffect, useState } from 'react';
import {
  isCloudProvider,
  useCloudConsentStore,
} from '../../stores/cloudConsentStore';

/**
 * Garde de consentement cloud (ADR 0005, Phase 4.3) — chemin PARTAGÉ.
 *
 * Historique : le garde ne vivait que dans la coquille BrainstormChat ;
 * le panneau AI Assistant (ChatInterface) envoyait vers un provider cloud
 * sans dialogue (cf. docs/chat-unification-etat-des-lieux.md §2.1). Toute
 * coquille de chat DOIT envoyer via `guardedSend`, jamais via `send`
 * directement, et rendre `CloudConsentDialog` quand `dialog.isOpen`.
 */
export interface CloudConsentGuard {
  /** Envoi gardé : ouvre le dialogue de consentement si cloud non consenti. */
  guardedSend: (text: string) => Promise<void>;
  dialog: {
    isOpen: boolean;
    providerName: string;
    onConsent: () => void;
    onCancel: () => void;
  };
}

export function useCloudConsentGuard(
  send: (text: string) => Promise<void>
): CloudConsentGuard {
  const consented = useCloudConsentStore((s) => s.consented);
  const grant = useCloudConsentStore((s) => s.grant);
  const [cloudCheck, setCloudCheck] = useState<{
    isCloud: boolean;
    providerName: string;
  }>({ isCloud: false, providerName: '' });
  const [isOpen, setIsOpen] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const llm: { backend: string; ollamaURL?: string } | null =
          await window.electron.config.get('llm');
        if (!cancelled && llm) setCloudCheck(isCloudProvider(llm));
      } catch {
        // Pas de config accessible (préload partiel, environnement de
        // test) : on reste considéré local — même défaut qu'avant.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const guardedSend = useCallback(
    async (text: string) => {
      if (cloudCheck.isCloud && !consented) {
        setPendingMessage(text);
        setIsOpen(true);
        return;
      }
      await send(text);
    },
    [send, cloudCheck.isCloud, consented]
  );

  const onConsent = useCallback(() => {
    grant(cloudCheck.providerName);
    // Transmettre l'accord au processus principal, qui porte désormais la
    // garde de l'ADR 0005 : sans cela il poserait sa propre question et
    // l'utilisateur en verrait deux pour un seul envoi. La garde main reste
    // la barrière ; ce dialogue-ci n'est que l'UX.
    void (
      window.electron?.fusion?.consent as
        | { grant?: (provider: string) => Promise<unknown> }
        | undefined
    )?.grant?.(cloudCheck.providerName);
    setIsOpen(false);
    if (pendingMessage) {
      const message = pendingMessage;
      setPendingMessage(null);
      void send(message);
    }
  }, [grant, cloudCheck.providerName, pendingMessage, send]);

  const onCancel = useCallback(() => {
    setIsOpen(false);
    setPendingMessage(null);
  }, []);

  return {
    guardedSend,
    dialog: { isOpen, providerName: cloudCheck.providerName, onConsent, onCancel },
  };
}
