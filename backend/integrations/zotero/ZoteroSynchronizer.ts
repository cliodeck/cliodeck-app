import type { Citation } from '../../types/citation';
import { createCitation } from '../../types/citation';
import { BibTeXExporter } from '../../core/bibliography/BibTeXExporter';
import { assignCiteKeys, isPreservableCiteKey } from '../../core/bibliography/citekey';
import { findDuplicateWorks, type DuplicateWork } from '../../core/bibliography/duplicates';
import type { IZoteroDataSource } from './IZoteroDataSource';
import type { ZoteroItem } from './ZoteroAPI';
import { listCollectionItems } from './collectionItems';
import { ZoteroDiffEngine } from './ZoteroDiffEngine';
import { ZoteroSyncResolver } from './ZoteroSyncResolver';

/**
 * Synchronisation d'une bibliographie de projet avec **sa** collection Zotero.
 *
 * Un seul moteur, là où il y avait « Importer » et « Mettre à jour depuis
 * Zotero ». Les deux produisaient le même fichier depuis #92–#94, mais
 * divergeaient ailleurs : l'import écrasait les entrées sans lien Zotero et
 * ne lisait pas les mêmes collections que la mise à jour, qui ne signalait
 * ni les doublons ni les pertes. L'utilisateur, lui, devait savoir dans quel
 * état était son projet pour choisir le bon bouton.
 *
 * Le premier import n'est qu'une synchronisation contre une bibliographie
 * vide : tout est « ajouté ».
 *
 * Règles :
 * - **Zotero fait foi** pour ce qu'il sait d'une notice ; ce que seul le
 *   projet connaît (notes, champs ajoutés à la main, PDF téléchargés,
 *   entrées sans lien Zotero) est conservé.
 * - **Rien de destructeur sans accord** : ajouts et compléments s'appliquent
 *   directement ; retirer une référence ou changer de collection demande
 *   confirmation. L'accord vaut pour le rapport lu, pas pour ce que Zotero
 *   contient au moment de l'appliquer.
 * - **Nos clés, jamais celles de Better BibTeX** : une clé déjà écrite est
 *   reconduite si elle reste valide ; une clé invalide ou portée par deux
 *   entrées est refaite, et signalée.
 */

/** Écart constaté entre la collection Zotero et la bibliographie produite. */
export interface SyncWarning {
  kind: 'count-mismatch';
  /** Notices de la collection (sous-collections comprises). */
  expected: number;
  /** Entrées liées à ces notices dans la bibliographie produite. */
  written: number;
}

export interface SyncEntry {
  id: string;
  title: string;
}

/**
 * Ce que l'auteur a lu dans la boîte et accepté. Un booléen valait pour tout ce que le second
 * appel trouverait : une notice retirée de Zotero pendant la lecture, ou les entrées d'un autre
 * projet ouvert entre-temps, partaient sans avoir été montrées (S07-1-0).
 */
export interface SyncConfirmation {
  collectionKey: string;
  collectionChange: { from: string; to: string } | null;
  /** Clés Zotero des références retirées. */
  deletedKeys: string[];
}

export interface SyncReport {
  collectionKey: string;
  /** Changement de collection : la bibliographie en suivait une autre. */
  collectionChange: { from: string; to: string } | null;
  added: SyncEntry[];
  modified: Array<SyncEntry & { fields: string[] }>;
  /** Références dont la notice n'est plus dans la collection. */
  deleted: Array<SyncEntry & { zoteroKey: string }>;
  unchangedCount: number;
  /** Entrées sans lien Zotero, laissées telles quelles. */
  localOnlyCount: number;
  /** Clés refaites parce qu'invalides ou portées par deux entrées. */
  renamedKeys: Array<{ from: string; to: string; title: string; zoteroKey: string }>;
  duplicates: DuplicateWork[];
  warnings: SyncWarning[];
  /** L'accord à renvoyer pour appliquer exactement ce rapport. */
  confirmation: SyncConfirmation;
}

export type SynchronizeResult =
  | { status: 'needs-confirmation'; report: SyncReport }
  | {
      status: 'applied';
      report: SyncReport;
      citations: Citation[];
      bibtex: string;
      /** Faux quand la bibliographie était déjà à jour : rien à écrire. */
      changed: boolean;
      /** Notices lues, pour relier documents et collections. */
      items: ZoteroItem[];
    };

export interface SynchronizeInput {
  /** Bibliographie actuelle du projet (fichier + métadonnées), vide au premier import. */
  local: Citation[];
  collectionKey: string;
  /** Collection que le projet suivait jusqu'ici, s'il y en avait une. */
  savedCollectionKey?: string;
  /** Accord donné sur un rapport : il ne couvre que ce que ce rapport montrait. */
  confirmation?: SyncConfirmation;
}

const entry = (c: Citation): SyncEntry => ({ id: c.id, title: c.title });

/**
 * L'accord couvre-t-il ce qui va être détruit ? Même collection, même changement de collection,
 * et aucune suppression qu'il n'ait vue. Une suppression vue qui n'a plus lieu (la notice est
 * revenue) ne le rend pas caduc.
 */
function covers(given: SyncConfirmation | undefined, needed: SyncConfirmation): boolean {
  if (!given || given.collectionKey !== needed.collectionKey) return false;
  const a = given.collectionChange;
  const b = needed.collectionChange;
  const sameChange = a === null || b === null ? a === b : a.from === b.from && a.to === b.to;
  if (!sameChange) return false;
  const seen = new Set(given.deletedKeys);
  return needed.deletedKeys.every((key) => seen.has(key));
}

export class ZoteroSynchronizer {
  constructor(private readonly source: IZoteroDataSource) {}

  async synchronize(input: SynchronizeInput): Promise<SynchronizeResult> {
    const items = await this.withChildren(
      await listCollectionItems(this.source, input.collectionKey)
    );

    const diff = await new ZoteroDiffEngine().detectChanges(input.local, items, {
      compareAttachments: true,
    });

    const collectionChange =
      input.savedCollectionKey && input.savedCollectionKey !== input.collectionKey
        ? { from: input.savedCollectionKey, to: input.collectionKey }
        : null;

    // Le diff ne retire que des entrées liées à Zotero (`ZoteroDiffEngine`) : la clé est là.
    const deleted = diff.deleted.map((c) => ({ ...entry(c), zoteroKey: c.zoteroKey! }));
    const report: SyncReport = {
      collectionKey: input.collectionKey,
      collectionChange,
      added: diff.added.map(entry),
      modified: diff.modified.map((m) => ({ ...entry(m.local), fields: m.modifiedFields })),
      deleted,
      unchangedCount: diff.unchanged.length,
      localOnlyCount: input.local.filter((c) => !c.zoteroKey).length,
      renamedKeys: [],
      duplicates: findDuplicateWorks(items),
      warnings: [],
      confirmation: {
        collectionKey: input.collectionKey,
        collectionChange,
        deletedKeys: deleted.map((d) => d.zoteroKey),
      },
    };

    if ((deleted.length > 0 || collectionChange) && !covers(input.confirmation, report.confirmation)) {
      return { status: 'needs-confirmation', report };
    }

    const merged = await new ZoteroSyncResolver().resolveConflicts(diff, input.local, 'remote');
    const { citations, renamed } = repairKeys(merged.finalCitations, items);
    report.renamedKeys = renamed;
    report.warnings = countWarnings(items, citations);

    const changed =
      diff.added.length + diff.modified.length + diff.deleted.length + renamed.length > 0 ||
      collectionChange !== null;

    return {
      status: 'applied',
      report,
      citations,
      bibtex: new BibTeXExporter().exportToString(citations),
      changed,
      items,
    };
  }

  /**
   * Joint à chaque notice ses pièces jointes et ses notes. Un échec de
   * lecture laisse le champ absent — « non lu », et non « aucun » : la
   * fusion garde alors ce que le projet connaissait.
   */
  private async withChildren(items: ZoteroItem[]): Promise<ZoteroItem[]> {
    const result: ZoteroItem[] = [];
    for (const item of items) {
      const data: ZoteroItem['data'] = { ...item.data };
      try {
        data.attachments = await this.source.getItemAttachments(item.key);
      } catch (error) {
        console.warn(`⚠️ Pièces jointes illisibles pour ${item.key}:`, error);
      }
      try {
        data.notes = await this.source.getItemNotes(item.key);
      } catch (error) {
        console.warn(`⚠️ Notes illisibles pour ${item.key}:`, error);
      }
      result.push({ ...item, data });
    }
    return result;
  }
}

/**
 * Refait les clés qui ne tiennent pas : invalides pour pandoc, héritées de
 * l'ancien générateur (`Unknown_…`, `Nom_`), ou portées par deux entrées —
 * la première, par ordre d'ajout dans Zotero, garde la sienne. Les clés
 * valides et uniques ne bougent jamais : l'auteur les a écrites dans son
 * texte.
 */
function repairKeys(
  citations: Citation[],
  items: ZoteroItem[]
): { citations: Citation[]; renamed: SyncReport['renamedKeys'] } {
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const addedAt = (c: Citation) => (c.zoteroKey && itemByKey.get(c.zoteroKey)?.data.dateAdded) || '';

  // Ordre de priorité : entrées locales d'abord (on ne sait pas les
  // renommer), puis notices Zotero par date d'ajout.
  const ordered = [...citations.keys()].sort((a, b) => {
    const ca = citations[a];
    const cb = citations[b];
    if (!ca.zoteroKey !== !cb.zoteroKey) return ca.zoteroKey ? 1 : -1;
    const da = addedAt(ca);
    const db = addedAt(cb);
    return da === db ? a - b : da < db ? -1 : 1;
  });

  const taken = new Set<string>();
  const toRepair: number[] = [];
  for (const index of ordered) {
    const c = citations[index];
    const canRename = !!c.zoteroKey && itemByKey.has(c.zoteroKey);
    const keeps = !canRename || (isPreservableCiteKey(c.id) && !taken.has(c.id));
    if (keeps) taken.add(c.id);
    else toRepair.push(index);
  }

  if (toRepair.length === 0) return { citations, renamed: [] };

  const newKeys = assignCiteKeys(
    toRepair.map((index) => itemByKey.get(citations[index].zoteroKey!)!),
    taken
  );

  const repaired = [...citations];
  const renamed: SyncReport['renamedKeys'] = [];
  for (const index of toRepair) {
    const c = citations[index];
    const to = newKeys.get(c.zoteroKey!)!;
    repaired[index] = createCitation({ ...c, id: to, key: to });
    renamed.push({ from: c.id, to, title: c.title, zoteroKey: c.zoteroKey! });
  }
  return { citations: repaired, renamed };
}

/**
 * Une notice de la collection absente de la bibliographie produite est une
 * référence perdue en silence : on le dit.
 */
function countWarnings(items: ZoteroItem[], citations: Citation[]): SyncWarning[] {
  const itemKeys = new Set(items.map((item) => item.key));
  const written = new Set(
    citations.filter((c) => c.zoteroKey && itemKeys.has(c.zoteroKey)).map((c) => c.zoteroKey)
  ).size;
  return written === items.length ? [] : [{ kind: 'count-mismatch', expected: items.length, written }];
}
