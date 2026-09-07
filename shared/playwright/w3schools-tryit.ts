import { expect, type FrameLocator, type Page } from '@playwright/test';

export const W3SCHOOLS_TRYIT_URL =
  'https://www.w3schools.com/html/tryit.asp?filename=tryhtml_default';

async function dismissW3SchoolsConsentIfPresent(page: Page): Promise<void> {
  const candidates = [
    page.locator('#accept-choices'),
    page.getByRole('button', { name: /^accept all$/i }),
    page.getByRole('button', { name: /^accept$/i }),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.first().isVisible()) {
        await candidate.first().click();
        return;
      }
    } catch {
      // Consent UI varies by region; ignore if not interactable.
    }
  }
}

/**
 * Opens the W3Schools HTML TryIt playground.
 */
export async function openW3SchoolsTryItPage(page: Page): Promise<void> {
  await page.goto(W3SCHOOLS_TRYIT_URL, {
    waitUntil: 'domcontentloaded',
  });

  await expect(
    page,
    'W3Schools TryIt page should load',
  ).toHaveURL(/tryit\.asp/i, {
    timeout: 30_000,
  });

  await dismissW3SchoolsConsentIfPresent(page);

  await expect(
    page.locator('#textareaCode'),
    'TryIt HTML textarea should be present',
  ).toBeAttached({
    timeout: 30_000,
  });

  await expect(
    page.locator('.CodeMirror').first(),
    'TryIt CodeMirror editor should be visible',
  ).toBeVisible({
    timeout: 30_000,
  });

  await expect(
    page.locator('#runbtn'),
    'TryIt Run button should be visible',
  ).toBeVisible({
    timeout: 30_000,
  });

  await expect(
    page.locator('iframe[name="iframeResult"]'),
    'TryIt preview iframe should be attached',
  ).toBeAttached({
    timeout: 30_000,
  });
}

/**
 * Reads the current HTML from the TryIt CodeMirror editor.
 */
export async function getTryItHtml(page: Page): Promise<string> {
  const html = await page.evaluate(() => {
    const cmEl = document.querySelector('.CodeMirror') as
      | (HTMLElement & {
        CodeMirror?: { getValue: () => string };
      })
      | null;

    if (cmEl?.CodeMirror) {
      return cmEl.CodeMirror.getValue();
    }

    const textarea = document.getElementById(
      'textareaCode'
    ) as HTMLTextAreaElement | null;

    return textarea?.value ?? '';
  });

  if (!html.trim()) {
    throw new Error('W3Schools TryIt editor HTML is empty.');
  }

  return html;
}

/**
 * Writes HTML into the TryIt CodeMirror editor (and backing textarea).
 */
export async function setTryItHtml(page: Page, html: string): Promise<void> {
  await page.evaluate((nextHtml) => {
    const cmEl = document.querySelector('.CodeMirror') as
      | (HTMLElement & {
        CodeMirror?: { setValue: (value: string) => void };
      })
      | null;

    if (cmEl?.CodeMirror) {
      cmEl.CodeMirror.setValue(nextHtml);
      return;
    }

    const textarea = document.getElementById(
      'textareaCode'
    ) as HTMLTextAreaElement | null;

    if (!textarea) {
      throw new Error('W3Schools TryIt editor was not found.');
    }

    textarea.value = nextHtml;
  }, html);

  const current = await getTryItHtml(page);

  expect(
    current,
    'TryIt editor should contain the HTML that was set',
  ).toContain(html.trim().slice(0, 40));
}

/**
 * Inserts the live chat installation script before </body>, preserving HTML.
 */
export function injectScriptIntoHtml(
  html: string,
  installationScript: string
): string {
  const script = installationScript.trim();

  if (!script) {
    throw new Error('Cannot inject an empty installation script.');
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}\n</body>`);
  }

  return `${html.trimEnd()}\n${script}\n`;
}

/**
 * Clicks the TryIt Run button.
 */
export async function runTryItEditor(page: Page): Promise<void> {
  const runButton = page.locator('#runbtn');

  await expect(
    runButton,
    'TryIt Run button should be visible before clicking',
  ).toBeVisible();

  await runButton.click();
}

/**
 * Returns a FrameLocator for the TryIt preview/output iframe.
 */
export function getTryItPreviewFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="iframeResult"]');
}

/**
 * Waits until the preview document shows the default TryIt heading (refresh signal).
 */
export async function waitForTryItPreviewRefresh(
  page: Page
): Promise<FrameLocator> {
  const preview = getTryItPreviewFrame(page);

  await expect(
    preview.getByRole('heading', {
      name: 'This is a Heading',
    }),
    'TryIt preview should refresh with the sample heading',
  ).toBeVisible({
    timeout: 30_000,
  });

  return preview;
}

/**
 * Waits for the CalicoDesk chat widget iframe to render inside the TryIt preview.
 */
export async function waitForChatWidgetInPreview(page: Page): Promise<void> {
  const preview = getTryItPreviewFrame(page);
  const chatWidget = preview.locator('#be-chat-iframe');

  await expect(
    chatWidget,
    'CalicoDesk chat widget iframe (#be-chat-iframe) should attach in the preview',
  ).toBeAttached({
    timeout: 30_000,
  });

  /*
   * The loader mounts #be-chat-iframe hidden (display:none, 0x0) until the
   * widget posts a bootstrap/resize message. Playwright's frame-aware
   * toBeVisible waits for the real visible box without needing same-origin
   * contentDocument access from the page context (the preview iframe is
   * cross-origin/srcdoc).
   */
  await expect(
    chatWidget,
    'CalicoDesk chat widget iframe should become visible in the preview',
  ).toBeVisible({
    timeout: 60_000,
  });

  await expect(
    chatWidget,
    'CalicoDesk chat widget iframe should remain attached after becoming visible',
  ).toBeAttached();
}

/**
 * Injects the installation script into TryIt, runs it, and waits for the widget.
 */
export async function renderChatWidgetInW3SchoolsTryIt(
  page: Page,
  installationScript: string
): Promise<void> {
  await openW3SchoolsTryItPage(page);

  const existingHtml = await getTryItHtml(page);
  const htmlWithScript = injectScriptIntoHtml(
    existingHtml,
    installationScript
  );

  await setTryItHtml(page, htmlWithScript);
  await runTryItEditor(page);
  await waitForTryItPreviewRefresh(page);
  await waitForChatWidgetInPreview(page);
}
