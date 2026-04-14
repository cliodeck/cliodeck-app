import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launchApp } from './_helpers/launch';

test('app launches and shows a main window', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;

  try {
    await expect(window).toHaveTitle(/.+/);
    // The React root should have mounted *something*.
    await expect(window.locator('#root')).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
