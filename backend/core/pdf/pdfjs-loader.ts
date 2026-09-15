/**
 * Chargement unique de pdfjs-dist pour l'extraction de texte.
 *
 * Partagé par `PDFExtractor` et le worker isolé
 * (`src/main/workers/pdf-extract-worker.ts`) : ce module ne doit donc rien
 * importer d'Electron.
 *
 * pdfjs-dist ≥ 4 n'est distribué qu'en ESM (`legacy/build/pdf.mjs`) : l'ancien
 * `require('pdfjs-dist/legacy/build/pdf.js')` n'existe plus. Le build `legacy`
 * reste celui qu'il faut hors navigateur.
 *
 * **Invariant de sécurité — ne jamais rendre une page.** ClioDeck n'utilise que
 * `getDocument`, `getPage`, `getTextContent` et `getMetadata`. Le rendu canvas
 * (`page.render()`) est la voie d'exécution de code des polices piégées
 * (CVE-2024-4367 en 3.x, corrigée depuis : pdfjs ≥ 5 ne contient plus aucun
 * `eval`) ; `__tests__/pdfjs-no-render.test.ts` échoue si un appel apparaît.
 * `disableFontFace` évite en plus de charger les polices du document, inutiles
 * pour du texte.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsLib: PdfjsModule | null = null;

/**
 * Sous Node, pdfjs ≥ 5 exige `DOMMatrix`, `ImageData` et `Path2D` dès son
 * chargement — mesuré : sans eux, **toute** extraction échoue sur « DOMMatrix
 * is not defined ». Il les emprunte sinon à `@napi-rs/canvas`, un module
 * natif précompilé *par architecture* : le DMG Intel construit sur un Mac
 * Apple Silicon n'embarquerait que le binaire arm64, et l'indexation des PDF
 * y casserait sans que le build le voie.
 *
 * On ne rend jamais : des classes vides suffisent au chargement. Elles
 * n'exposent aucune méthode, si bien qu'un rendu introduit un jour échouerait
 * bruyamment au lieu de calculer faux. Posées avant l'import, elles
 * dispensent pdfjs de chercher `@napi-rs/canvas` : le comportement est le
 * même sur toutes les plateformes.
 */
function installRenderingPlaceholders(): void {
  const scope = globalThis as Record<string, unknown>;
  if (typeof scope.DOMMatrix === 'undefined') {
    scope.DOMMatrix = class DOMMatrixPlaceholder {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    };
  }
  if (typeof scope.ImageData === 'undefined') {
    scope.ImageData = class ImageDataPlaceholder {};
  }
  if (typeof scope.Path2D === 'undefined') {
    scope.Path2D = class Path2DPlaceholder {};
  }
}

export async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsLib) {
    installRenderingPlaceholders();
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLib;
}

/** Ouvre un PDF pour en lire le texte et les métadonnées, jamais pour le rendre. */
export async function openPdfForText(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
}

interface TextItemLike {
  str: string;
}

/** Les chaînes d'une page, sans les marqueurs de contenu balisé. */
export async function pageStrings(pdfDocument: PDFDocumentProxy, pageNumber: number): Promise<string[]> {
  const page = await pdfDocument.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const strings: string[] = [];
  for (const item of textContent.items) {
    if ('str' in item) strings.push((item as TextItemLike).str);
  }
  page.cleanup();
  return strings;
}
