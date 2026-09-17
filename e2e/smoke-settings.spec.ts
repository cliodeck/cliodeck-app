/**
 * La fenêtre des réglages s'ouvre, et le mode expert donne accès aux trois
 * sections qui gouvernent les corpus et les outils externes.
 *
 * Écrit en mai sur des `heading` : depuis, ces sections sont des entrées de
 * navigation, et un sélecteur « Simple / Expert » les masque par défaut. Le
 * test suivait donc une interface disparue — invisible, faute de suite e2e en
 * CI (pas d'affichage).
 */

import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launchApp } from './_helpers/launch';

const SECTIONS_EXPERTES = ['Vault Obsidian', 'Recettes', 'Clients MCP'];

test('les réglages s’ouvrent et le mode expert expose Vault, Recettes et MCP', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;

  try {
    await expect(window.locator('#root')).toBeVisible({ timeout: 20_000 });

    // Même événement que le raccourci du menu.
    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
    });

    await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeVisible({ timeout: 15_000 });

    await window.getByRole('button', { name: 'Expert', exact: true }).click();

    for (const section of SECTIONS_EXPERTES) {
      await expect(window.getByRole('button', { name: new RegExp(section, 'i') }).first()).toBeVisible();
    }

    // Fermeture par Échap — la modale l'écoute.
    await window.keyboard.press('Escape');
    await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeHidden();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
