/**
 * La limite de durée d'un export. Elle sert des deux côtés de la frontière : au
 * main pour les outils et les fenêtres (`export-time-limit.ts`), au renderer pour
 * les lectures qui précèdent l'appel au main (`export-read-limit.ts`).
 *
 * Se change ici, en une ligne : aucun réglage visible, rc.6 n'ajoute rien.
 */
export const EXPORT_TIME_LIMIT_MS = 15 * 60 * 1000;
