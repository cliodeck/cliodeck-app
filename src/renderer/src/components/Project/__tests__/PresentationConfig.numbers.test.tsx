// @vitest-environment jsdom
/**
 * `parseInt('') * 1000` vaut NaN : vider le défilement automatique écrivait `"autoSlide": null` dans
 * `reveal-config.json`, à la première frappe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PresentationConfig } from '../PresentationConfig';

let exists: boolean;
let content: string;
const writeFile = vi.fn(async (_path: string, _text: string) => undefined);
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const field = () => screen.getByRole('spinbutton') as HTMLInputElement;
const lastWritten = () => JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1]) as { autoSlide: unknown };

beforeEach(() => {
  exists = false;
  content = '{}';
  writeFile.mockClear();
  (window as unknown as { electron: unknown }).electron = {
    fs: { exists: async () => exists, readFile: async () => content, writeFile },
  };
});

afterEach(cleanup);

describe('le défilement automatique', () => {
  it('vidé : rien n’est écrit, et la dernière valeur revient', async () => {
    render(<PresentationConfig projectPath="/projet" />);
    await settle();

    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.blur(field());
    await settle();

    expect(writeFile).not.toHaveBeenCalled();
    expect(field().value).toBe('0');
  });

  it('une valeur tapée s’écrit une fois, au blur, en millisecondes', async () => {
    render(<PresentationConfig projectPath="/projet" />);
    await settle();

    fireEvent.change(field(), { target: { value: '5' } });
    expect(writeFile).not.toHaveBeenCalled();
    fireEvent.blur(field());
    await settle();

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(lastWritten().autoSlide).toBe(5000);
  });

  it.each([[null], ['abc'], [true]])('un fichier où `autoSlide` vaut %j : le défaut, sans planter', async (bad) => {
    exists = true;
    content = JSON.stringify({ autoSlide: bad, theme: 'white' });
    render(<PresentationConfig projectPath="/projet" />);
    await settle();

    expect(field().value).toBe('0');
  });
});
