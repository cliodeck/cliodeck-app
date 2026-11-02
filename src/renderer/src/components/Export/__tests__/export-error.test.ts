/**
 * Le message d'un export arrêté par la limite de durée : les minutes viennent du
 * résultat rendu par le main, jamais d'un nombre écrit dans les locales.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { exportErrorMessage } from '../export-error';

describe('exportErrorMessage', () => {
  it('traduit export_timed_out avec les minutes transportées par le résultat', () => {
    const t = vi.fn((key: string) => `traduit:${key}`);

    const message = exportErrorMessage(
      t,
      { error: 'Export arrêté', errorCode: 'export_timed_out', timeLimitMinutes: 15 },
      'repli'
    );

    expect(message).toBe('traduit:export.timedOut');
    expect(t).toHaveBeenCalledWith('export.timedOut', { minutes: 15 });
  });

  it('laisse les autres erreurs telles quelles, et le repli quand il n’y en a pas', () => {
    const t = vi.fn((key: string) => key);

    expect(exportErrorMessage(t, { error: 'xelatex a échoué' }, 'repli')).toBe('xelatex a échoué');
    expect(exportErrorMessage(t, {}, 'repli')).toBe('repli');
    expect(t).not.toHaveBeenCalled();
  });
});

describe.each(['fr', 'en', 'de'])('locale %s', (language) => {
  it('dit le nombre de minutes par la variable, sans l’écrire en dur', () => {
    const file = join(process.cwd(), 'public', 'locales', language, 'common.json');
    const locale = JSON.parse(readFileSync(file, 'utf8')) as { export: { timedOut?: string } };

    expect(locale.export.timedOut).toContain('{{minutes}}');
    expect(locale.export.timedOut).not.toMatch(/\d/);
  });
});
