/**
 * La provenance d'une transcription importée d'un fichier, d'après son format.
 *
 * PAGE XML est le format d'export de Transkribus ; ALTO et le texte brut
 * viennent d'ailleurs (OCR d'une bibliothèque, transcription saisie hors de
 * ClioDeck). Tout import était étiqueté 'transkribus' (S15-1-36), alors que
 * l'historien a besoin de la vraie provenance pour la critique de ses sources.
 *
 * Une seule règle pour les deux chemins d'import : un fichier sur une carte
 * (renderer, `importTranscription`) et un dossier entier pendant la synchro
 * (`TropySync.processItem`). Pas de dépendance ici : le renderer importe ce
 * module.
 */
import type { TranscriptionFormat } from './TropyOCRPipeline';

/** Un format inconnu ou absent ne prétend pas venir de Transkribus. */
export function transcriptionSourceOfFormat(
  format: TranscriptionFormat | undefined
): 'transkribus' | 'imported' {
  return format === 'transkribus' || format === 'page-xml' ? 'transkribus' : 'imported';
}
