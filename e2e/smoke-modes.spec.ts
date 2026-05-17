import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launchApp } from './_helpers/launch';

const MODES = ['Brainstorm', 'Write', 'Analyze', 'Export'] as const;

test('four-mode tab bar switches active mode on click', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;

  try {
    const bar = window.locator('.workspace-mode-bar');
    await expect(bar).toBeVisible({ timeout: 20_000 });

    for (const label of MODES) {
      const tab = bar.getByRole('button', { name: label });
      await tab.click();
      await expect(tab).toHaveClass(/workspace-mode-bar__tab--active/);
      await expect(tab).toHaveAttribute('aria-pressed', 'true');
    }
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
