/**
 * La cause d'un refus HTTP d'un fournisseur, telle que l'historien la lira dans le chat (L09-7).
 *
 * Anthropic, OpenAI et Gemini rangent l'explication dans `error.message`, Mistral dans `message`,
 * certains serveurs locaux dans `error` tout court. Sans cette lecture, une clé expirée arrivait
 * au chat comme « le fournisseur a interrompu la réponse sans donner de cause » (S05-1-5).
 */

/** Longueur au-delà de laquelle le message est coupé : une page HTML d'erreur n'a rien à faire dans le chat. */
const MAX_LENGTH = 500;

/** Une clé passée dans l'URL (`?key=…`, Gemini) ne doit pas finir à l'écran ni dans un journal. */
function maskKeys(text: string): string {
  return text.replace(/([?&]key=)[^&\s"'<>]+/gi, '$1***');
}

function pick(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
    };
    const { error } = parsed;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error === 'object') {
      const nested = (error as { message?: unknown }).message;
      if (typeof nested === 'string' && nested) return nested;
    }
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // texte brut
  }
  return undefined;
}

/** Le message d'erreur d'une réponse non-2xx : celui de l'API, sinon le texte brut, sinon le code HTTP. */
export async function readProviderError(res: Response): Promise<string> {
  let text = '';
  try {
    text = (await res.text()).trim();
  } catch {
    // corps illisible : le code HTTP suffira
  }
  const message = maskKeys(pick(text) ?? text);
  if (!message) return `HTTP ${res.status}`;
  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}…` : message;
}
