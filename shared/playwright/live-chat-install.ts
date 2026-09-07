import { expect, type Page } from '@playwright/test';

export const LIVE_CHAT_INSTALL_PATH =
  '/admin/settings/livechat?tab=install';

/**
 * Opens the Live Chat Install settings page on the current workspace host.
 * Call after a successful login (workspace origin comes from page.url()).
 */
export async function openLiveChatInstallPage(page: Page): Promise<void> {
  const workspaceOrigin = new URL(page.url()).origin;
  const installUrl = `${workspaceOrigin}${LIVE_CHAT_INSTALL_PATH}`;

  // The settings SPA can be slow to respond on dev (same behaviour as the
  // login page), so use a generous timeout instead of the default 30s.
  await page.goto(installUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  await expect(
    page,
    'Live Chat Install page should load under /admin/settings/livechat',
  ).toHaveURL(/\/admin\/settings\/livechat/, {
    timeout: 90_000,
  });

  await expect(
    page.getByRole('heading', {
      name: 'Livechat',
      level: 1,
    }),
    'Livechat settings heading should be visible',
  ).toBeVisible({
    timeout: 90_000,
  });

  const installTab = page.getByRole('tab', {
    name: 'Install',
  });

  await expect(
    installTab,
    'Install tab should be visible',
  ).toBeVisible({
    timeout: 90_000,
  });

  await expect(
    installTab,
    'Install tab should be selected',
  ).toHaveAttribute('aria-selected', 'true', {
    timeout: 90_000,
  });

  await expect(
    page.getByText(/To install livechat widget on your site/i),
    'Live Chat install instructions should be visible',
  ).toBeVisible({
    timeout: 90_000,
  });
}

/**
 * Reads the live chat installation script from the Install tab DOM (not clipboard).
 */
export async function extractLiveChatInstallationScript(
  page: Page
): Promise<string> {
  const scriptBlock = page.locator('pre').filter({
    hasText: /<script\b/i,
  });

  await expect(
    scriptBlock,
    'Live Chat installation script block should be visible',
  ).toBeVisible({
    timeout: 30_000,
  });

  const installationScript = (await scriptBlock.innerText()).trim();

  if (!installationScript) {
    throw new Error(
      'Live Chat installation script was found but is empty.'
    );
  }

  expect(
    installationScript,
    'installation script should include a <script> tag',
  ).toMatch(/<script\b/i);

  expect(
    installationScript,
    'installation script should reference livechat-loader',
  ).toMatch(/livechat-loader/i);

  expect(
    installationScript,
    'installation script should look like a complete script element',
  ).toMatch(/<\/script>/i);

  return installationScript;
}
