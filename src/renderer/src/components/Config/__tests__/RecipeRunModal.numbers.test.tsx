// @vitest-environment jsdom
/**
 * Le paramètre numérique d'une recette. `Number('')` vaut 0 : un champ vidé lançait la recette avec un
 * zéro que personne n'avait demandé. Laissé vide, il partait en `''`, que le runner refuse
 * (« expected number, got string »). Et un `NaN` restait différent de lui-même pour toujours : la
 * fenêtre croyait avoir des saisies à perdre et ne se fermait plus à Échap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

import { RecipeRunModal } from '../RecipeRunModal';
import { validateInputs, type Recipe } from '../../../../../../backend/recipes/schema';

const closeRun = vi.fn();
let recipes: { read: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> };

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const field = () => screen.getByRole('spinbutton') as HTMLInputElement;
const runButton = () => screen.getByText('recipeRun.buttons.run').closest('button') as HTMLButtonElement;
const pressEscape = () =>
  act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
const run = () =>
  act(async () => {
    fireEvent.click(runButton());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

function recipe(input: Record<string, unknown>): Recipe {
  return {
    name: 'ma-recette',
    version: '1',
    description: '',
    inputs: { n: { type: 'number', required: false, ...input } },
    steps: [{ id: 's1', kind: 'write', with: {} }],
    outputs: {},
  } as unknown as Recipe;
}

async function open(input: Record<string, unknown>): Promise<Recipe> {
  const definition = recipe(input);
  recipes.read.mockResolvedValue({ success: true, recipe: definition });
  render(<RecipeRunModal scope="user" fileName="ma-recette.yaml" onClose={closeRun} />);
  await settle();
  return definition;
}

beforeEach(() => {
  closeRun.mockClear();
  recipes = {
    read: vi.fn(),
    run: vi.fn(async () => ({ success: true, ok: true, logPath: '/tmp/j.jsonl' })),
    onEvent: vi.fn(() => () => undefined),
  };
  (window as unknown as { electron: unknown }).electron = { fusion: { recipes } };
});

afterEach(cleanup);

describe('un paramètre numérique vidé', () => {
  it('ne devient pas zéro : le champ reste vide, et un paramètre requis bloque le lancement', async () => {
    await open({ required: true, default: 5 });
    expect(field().value).toBe('5');
    expect(runButton().disabled).toBe(false);

    fireEvent.change(field(), { target: { value: '' } });

    expect(field().value).toBe('');
    expect(runButton().disabled).toBe(true);
  });

  it('optionnel : il part absent, et le vrai validateur du runner l’accepte', async () => {
    const definition = await open({ default: 5 });

    fireEvent.change(field(), { target: { value: '' } });
    await run();

    const sent = recipes.run.mock.calls[0][2] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('n');
    expect(validateInputs(definition, sent)).toEqual([]);
  });

  it('optionnel, jamais rempli : pareil', async () => {
    const definition = await open({});
    await run();

    const sent = recipes.run.mock.calls[0][2] as Record<string, unknown>;
    expect(validateInputs(definition, sent)).toEqual([]);
  });

  it('une valeur tapée part en nombre, zéro compris', async () => {
    const definition = await open({});

    fireEvent.change(field(), { target: { value: '0' } });
    await run();

    const sent = recipes.run.mock.calls[0][2] as Record<string, unknown>;
    expect(sent.n).toBe(0);
    expect(validateInputs(definition, sent)).toEqual([]);
  });
});

// À `1e` ou `-`, le navigateur répond `''` sans effacer ce qu'il montre : le champ disait une chose, et
// Lancer en envoyait une autre. Le geste réel est dans `journey-numeric-fields`.
describe('du texte que le navigateur ne sait pas lire', () => {
  const unreadable = () => {
    fireEvent.change(field(), { target: { value: '' } });
    Object.defineProperty(field(), 'validity', { configurable: true, value: { badInput: true } });
  };

  it('disparaît au blur : le champ montre ce qui partira', async () => {
    await open({ default: 5 });
    unreadable();
    const written = vi.spyOn(field(), 'value', 'set');

    fireEvent.blur(field());

    expect(written).toHaveBeenCalledWith('');
  });

  it('dans un champ requis : le lancement reste bloqué', async () => {
    await open({ required: true });
    unreadable();
    fireEvent.blur(field());
    expect(runButton().disabled).toBe(true);
  });

  it('une valeur lisible ne bouge pas au blur, et protège encore la fenêtre (#196)', async () => {
    await open({ default: 5 });
    fireEvent.change(field(), { target: { value: '12' } });
    const written = vi.spyOn(field(), 'value', 'set');

    fireEvent.blur(field());
    await pressEscape();

    expect(written).not.toHaveBeenCalled();
    expect(field().value).toBe('12');
    expect(closeRun).not.toHaveBeenCalled();
  });
});

describe('Échap', () => {
  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], ['abc']])(
    'un défaut illisible dans la recette (%s) : rien à perdre, la fenêtre se ferme',
    async (bad) => {
      await open({ default: bad });
      expect(field().value).toBe('');

      await pressEscape();

      expect(closeRun).toHaveBeenCalledTimes(1);
    }
  );

  it('une saisie retirée, revenue à sa valeur de départ : rien à perdre', async () => {
    await open({});
    fireEvent.change(field(), { target: { value: '12' } });
    await pressEscape();
    expect(closeRun).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: '' } });
    await pressEscape();
    expect(closeRun).toHaveBeenCalledTimes(1);
  });

  it('une saisie en cours protège encore la fenêtre (#196) : Échap ne la ferme pas', async () => {
    await open({ default: 5 });
    fireEvent.change(field(), { target: { value: '12' } });

    await pressEscape();

    expect(closeRun).not.toHaveBeenCalled();
  });
});

/** D21 : un paramètre numérique peut avoir des décimales, et la virgule y devient un point à la frappe. */
describe('la virgule décimale', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('la virgule ne part pas au navigateur : un point est tapé à sa place', async () => {
    // jsdom n'a pas `execCommand` ; la vraie frappe est dans `journey-numeric-fields`.
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
    await open({ default: 0.5 });

    const event = createEvent.keyDown(field(), { key: ',' });
    fireEvent(field(), event);

    expect(event.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('insertText', false, '.');
  });
});
