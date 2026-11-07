import type { TFunction } from 'i18next';
import type { TropySyncIssue } from '@backend/integrations/tropy/TropySync';

/**
 * Le texte, dans la langue de l'interface, de ce qui a empêché une passe
 * Tropy. Le main ne renvoie qu'un code et ses paramètres ; `errors` reste
 * pour la console.
 */
export function describeSyncIssue(t: TFunction, issue: TropySyncIssue): string {
  switch (issue.code) {
    case 'different-project':
      return issue.linkedName
        ? t('primarySources.issues.differentProject', {
            candidateName: issue.candidateName,
            linkedName: issue.linkedName,
            sourceCount: issue.sourceCount,
          })
        : t('primarySources.issues.differentProjectUnnamed', {
            candidateName: issue.candidateName,
            sourceCount: issue.sourceCount,
          });
  }
}
