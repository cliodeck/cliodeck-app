/**
 * Prise en charge de l'IA locale selon la version de macOS.
 *
 * L'enjeu : sous macOS 12 ou 13, ni Ollama ni le moteur embarqué ne sont pris
 * en charge, et l'utilisateur ne l'apprenait qu'en cherchant pourquoi rien ne
 * s'indexait. L'avertissement ne doit pas manquer là, ni apparaître ailleurs.
 */
import { describe, it, expect } from 'vitest';
import { localAiSupport } from '../local-ai-support.js';

describe('IA locale selon la version de macOS', () => {
  it('signale macOS 12 et 13, en rendant la version telle quelle', () => {
    expect(localAiSupport({ platform: 'darwin', systemVersion: '12.7.6' })).toEqual({
      limited: true,
      macosVersion: '12.7.6',
    });
    expect(localAiSupport({ platform: 'darwin', systemVersion: '13.6' }).limited).toBe(true);
  });

  it('ne dit rien à partir de macOS 14', () => {
    for (const systemVersion of ['14.0', '15.5', '26.5.0', '27.0']) {
      expect(localAiSupport({ platform: 'darwin', systemVersion }).limited).toBe(false);
    }
  });

  it('ne dit rien hors de macOS, quelle que soit la version du système', () => {
    expect(localAiSupport({ platform: 'linux', systemVersion: '6.8.0' })).toEqual({ limited: false, macosVersion: '' });
    expect(localAiSupport({ platform: 'win32', systemVersion: '10.0.22631' }).limited).toBe(false);
  });

  it('n’alarme pas sur une version illisible', () => {
    expect(localAiSupport({ platform: 'darwin', systemVersion: '' }).limited).toBe(false);
    expect(localAiSupport({ platform: 'darwin', systemVersion: 'inconnue' }).limited).toBe(false);
  });
});
