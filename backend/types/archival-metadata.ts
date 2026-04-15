/**
 * Archival metadata for primary sources.
 *
 * Historians citing an archival document need a set of structured fields
 * that generic Dublin Core-ish `creator` / `archive` don't cover cleanly:
 * a repository (where the document lives), a fonds (the archival body it
 * belongs to), a call number / cote (the stable identifier inside that
 * body), a producer (the authority that generated the document — often
 * different from the repository), a production date & place, and some
 * provenance / access info.
 *
 * These fields are first-class on `PrimarySourceItem` /
 * `PrimarySourceDocument` so that:
 *   1. the UI can render a proper "archival card" on each source,
 *   2. the RAG injection can include a full citation string in the
 *      system prompt (so the LLM quotes the cote, not just a title),
 *   3. exports (Word, reveal.js, markdown) can emit proper footnotes.
 *
 * All fields are optional — a source can perfectly well have none of
 * these (web capture, user note, un-curated photo). A follow-up migration
 * may add a light validation layer; for now the schema is intentionally
 * permissive.
 */
export interface ArchivalMetadata {
  /** Institution holding the physical document, e.g. "Archives nationales (Pierrefitte-sur-Seine)". */
  repository?: string;
  /** Fonds / archival group / sous-série, e.g. "Fonds Moscou (19940500)". */
  fonds?: string;
  /** Call number / cote / shelf mark, e.g. "F/7/12345" or "AN 72AJ/43". */
  callNumber?: string;
  /** Producer / records creator, e.g. "Ministère de l'Intérieur, Direction de la Sûreté". */
  producer?: string;
  /** Production date — ISO 8601 point or range ("1939/1945"). Kept as string to allow fuzzy dates. */
  productionDate?: string;
  /** Geographical origin of the document. */
  productionPlace?: string;
  /** Any legal / custodial restrictions ("derogation required", "closed until 2030"). */
  accessRestrictions?: string;
  /** Physical description — "12 ff., 32x25cm, ms.". */
  physicalDescription?: string;
}

/**
 * Map a Tropy item's raw Dublin-Core-ish metadata bag to `ArchivalMetadata`.
 *
 * Tropy stores metadata as `{ property: URI, value: text }` rows. The reader
 * narrows URIs to their last path segment (see `extractPropertyName` in
 * `TropyReader`), giving us keys like `title`, `creator`, `identifier`,
 * `isPartOf`, `spatial`, `temporal`, `rights`, `extent`, etc.
 *
 * This mapping favours precision over coverage: ambiguous DC terms
 * (`subject`, `description`) are left out; the raw bag is still available
 * on `PrimarySourceItem.metadata` if a caller needs them.
 */
export function archivalFromTropyMetadata(
  raw: Record<string, string | undefined> | undefined,
  item?: { archive?: string; collection?: string; creator?: string; date?: string }
): ArchivalMetadata | undefined {
  if (!raw && !item) return undefined;
  const bag = raw ?? {};

  // DC terms used by Tropy templates — pick the first non-empty variant.
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = bag[k];
      if (v && v.trim().length > 0) return v.trim();
    }
    return undefined;
  };

  const out: ArchivalMetadata = {
    // archive is often the institution name in Tropy templates; fall back to publisher.
    repository: pick('repository', 'publisher', 'isHeldBy') ?? item?.archive,
    // Fonds-like: isPartOf / series / collection in DC terms.
    fonds: pick('fonds', 'isPartOf', 'series') ?? item?.collection,
    // Cote: DC identifier is the standard mapping; callNumber / shelfMark used by some templates.
    callNumber: pick('callNumber', 'shelfMark', 'identifier', 'signature'),
    // Producer: DC creator by default, provenance when the template distinguishes.
    producer: pick('producer', 'provenance', 'creator') ?? item?.creator,
    productionDate: pick('productionDate', 'created', 'issued', 'temporal', 'date') ?? item?.date,
    productionPlace: pick('productionPlace', 'spatial', 'coverage'),
    accessRestrictions: pick('accessRights', 'rights'),
    physicalDescription: pick('physicalDescription', 'extent', 'format'),
  };

  // Drop a wholly-empty result so callers can treat `undefined` as "no data".
  const hasAny = Object.values(out).some((v) => v != null && String(v).length > 0);
  return hasAny ? out : undefined;
}

/**
 * Render a short archival citation for a system-prompt injection.
 * Example: "Ministère de l'Intérieur (1939/1945), AN F/7/12345, Fonds Moscou, Archives nationales".
 */
export function formatArchivalCitation(meta: ArchivalMetadata | undefined): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.producer) {
    parts.push(meta.productionDate ? `${meta.producer} (${meta.productionDate})` : meta.producer);
  } else if (meta.productionDate) {
    parts.push(meta.productionDate);
  }
  if (meta.callNumber) parts.push(meta.callNumber);
  if (meta.fonds) parts.push(meta.fonds);
  if (meta.repository) parts.push(meta.repository);
  const joined = parts.filter(Boolean).join(', ');
  return joined.length > 0 ? joined : undefined;
}
