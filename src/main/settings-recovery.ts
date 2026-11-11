/**
 * Ce que l'auteur apprend, au démarrage, d'un fichier de réglages illisible (S11-1-10).
 *
 * `configManager.init` met de côté un `cliodeck-config.json` ou un `cliodeck-secrets.json` qui ne
 * se lit pas comme du JSON (`openStoreResilient`) : après `createWindow`, un message nomme la copie.
 * Une autre erreur (droits, disque) empêche le démarrage : une boîte d'erreur, puis l'app sort.
 */
import { t } from './i18n.js';
import type { RecoveredSettingsFile } from './services/config-manager.js';

/** Un paragraphe par copie : son chemin et, pour les clés, qu'elles sont à ressaisir. */
export function recoveredSettingsDetail(recovered: readonly RecoveredSettingsFile[]): string {
  return recovered
    .map(({ kind, copy }) =>
      t(kind === 'config' ? 'settingsRecoveredConfig' : 'settingsRecoveredSecrets').replace('{{path}}', () => copy)
    )
    .join('\n\n');
}

/**
 * La boîte d'erreur d'un démarrage impossible. Elle nomme aussi les copies que `init` a déjà faites
 * avant d'échouer : une configuration illisible est mise de côté avant l'ouverture des clés, et si
 * celles-ci échouent ensuite (droits), le lancement suivant lit les défauts sans plus rien nommer.
 * C'est la seule occasion de dire où sont les réglages de l'auteur.
 */
export function settingsFailureMessage(
  error: unknown,
  recovered: readonly RecoveredSettingsFile[]
): { title: string; content: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = t('settingsUnreadableMessage').replace('{{error}}', () => detail);
  return {
    title: t('settingsUnreadableTitle'),
    content: recovered.length > 0 ? `${failure}\n\n${recoveredSettingsDetail(recovered)}` : failure,
  };
}
