import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launchApp } from './_helpers/launch';

test('settings modal opens and exposes Vault, Recipes and MCP sections', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;

  try {
    await expect(window.locator('#root')).toBeVisible({ timeout: 20_000 });

    // Open the settings modal via the same custom event the menu shortcut uses.
    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
    });

    // The three new sections must be present.
    await expect(window.getByRole('heading', { name: /Vault Obsidian/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByRole('heading', { name: /Recettes/i })).toBeVisible();
    await expect(window.getByRole('heading', { name: /Clients MCP/i })).toBeVisible();

    // Close via Escape — the modal listens for it.
    await window.keyboard.press('Escape');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
