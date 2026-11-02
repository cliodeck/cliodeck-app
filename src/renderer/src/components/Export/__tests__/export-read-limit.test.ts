/**
 * La limite des lectures qui précèdent l'appel au main. Le comportement dans les
 * modales est couvert par `export-modals-escape.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExportReadTimedOutError,
  readOptionalConfig,
  startExportReadLimit,
} from '../export-read-limit';
import { exportThrownMessage } from '../export-error';
import { EXPORT_TIME_LIMIT_MS } from '@backend/types/export-limits';

const NEVER = new Promise<never>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startExportReadLimit', () => {
  it('rend la valeur lue et ne laisse aucune minuterie armée', async () => {
    const within = startExportReadLimit();

    await expect(within(Promise.resolve('texte'))).resolves.toBe('texte');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('laisse passer l’erreur d’une lecture, sans minuterie armée', async () => {
    const within = startExportReadLimit();

    await expect(within(Promise.reject(new Error('EACCES')))).rejects.toThrow('EACCES');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sans limite précisée, rejette après 15 minutes avec ce nombre, pas avant', async () => {
    const reading = startExportReadLimit()(NEVER);
    const verdict = vi.fn();
    reading.catch(verdict);

    await vi.advanceTimersByTimeAsync(EXPORT_TIME_LIMIT_MS - 1);
    expect(verdict).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(verdict).toHaveBeenCalledTimes(1);
    const error = verdict.mock.calls[0][0] as ExportReadTimedOutError;
    expect(error).toBeInstanceOf(ExportReadTimedOutError);
    expect(error.timeLimitMinutes).toBe(15);
    expect(EXPORT_TIME_LIMIT_MS).toBe(15 * 60 * 1000);
  });

  it('plusieurs lectures consomment la même horloge', async () => {
    const within = startExportReadLimit(60_000);
    let finishFirst: (value: string) => void = () => undefined;
    const first = within(new Promise<string>((resolve) => { finishFirst = resolve; }));

    await vi.advanceTimersByTimeAsync(50_000);
    finishFirst('manuscrit');
    await first;

    const verdict = vi.fn();
    within(NEVER).catch(verdict);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(verdict).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(verdict).toHaveBeenCalledTimes(1);
    expect(verdict.mock.calls[0][0]).toBeInstanceOf(ExportReadTimedOutError);
  });

  it('une lecture lancée après l’échéance est refusée aussitôt', async () => {
    const within = startExportReadLimit(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const verdict = vi.fn();
    within(NEVER).catch(verdict);
    await vi.advanceTimersByTimeAsync(0);

    expect(verdict.mock.calls[0][0]).toBeInstanceOf(ExportReadTimedOutError);
  });
});

describe('readOptionalConfig', () => {
  function stubFs(exists: () => Promise<boolean>, readFile: () => Promise<string>) {
    vi.stubGlobal('window', { electron: { fs: { exists, readFile } } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  }

  it('rend le JSON du fichier', async () => {
    stubFs(() => Promise.resolve(true), () => Promise.resolve('{"theme":"black"}'));

    await expect(readOptionalConfig('/p/reveal-config.json')).resolves.toEqual({ theme: 'black' });
  });

  it('absent, illisible ou mal formé : les valeurs par défaut', async () => {
    stubFs(() => Promise.resolve(false), () => Promise.resolve('{}'));
    await expect(readOptionalConfig('/p/c.json')).resolves.toBeUndefined();

    stubFs(() => Promise.resolve(true), () => Promise.reject(new Error('EACCES')));
    await expect(readOptionalConfig('/p/c.json')).resolves.toBeUndefined();

    stubFs(() => Promise.resolve(true), () => Promise.resolve('{pas du json'));
    await expect(readOptionalConfig('/p/c.json')).resolves.toBeUndefined();
  });
});

describe('exportThrownMessage', () => {
  it('traduit la limite des lectures avec ses minutes, garde le repli pour le reste', () => {
    const t = vi.fn((key: string) => `traduit:${key}`);

    expect(exportThrownMessage(t, new ExportReadTimedOutError(15), 'repli')).toBe('traduit:export.timedOut');
    expect(t).toHaveBeenCalledWith('export.timedOut', { minutes: 15 });

    expect(exportThrownMessage(t, new Error('autre'), 'repli')).toBe('repli');
    expect(exportThrownMessage(t, 'pas une erreur', 'repli')).toBe('repli');
  });
});
