import { expect, type Page } from '@playwright/test';

export function getRequiredCredential(
  name: 'TEST_USER_EMAIL' | 'TEST_USER_PASSWORD'
): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is not configured. Set it in .env before running Playwright scenarios that require authentication.`
    );
  }

  return value;
}

async function dismissAcceptAllIfPresent(page: Page): Promise<void> {
  const acceptAll = page.getByRole('button', { name: 'Accept All' });

  if (await acceptAll.isVisible()) {
    await acceptAll.click();
  }
}

async function confirmRecaptchaIfPresent(page: Page): Promise<void> {
  const recaptchaPrompt = page.getByText(/let us know you're human/i);

  try {
    await expect(recaptchaPrompt).toBeVisible({
      timeout: 5_000,
    });
  } catch {
    return;
  }

  await page
    .locator('iframe[src*="recaptcha"], iframe[title="reCAPTCHA"]')
    .first()
    .waitFor({
      timeout: 10_000,
    })
    .catch(() => undefined);

  for (const frame of page.frames()) {
    const checkbox = frame.getByRole('checkbox', {
      name: /i'm not a robot/i,
    });

    if ((await checkbox.count()) === 0) {
      continue;
    }

    await checkbox.click();

    try {
      await expect(checkbox).toBeChecked({
        timeout: 10_000,
      });

      return;
    } catch {
      break;
    }
  }

  throw new Error(
    'Login is blocked by Google reCAPTCHA. Disable captcha on the login page for the test environment, or configure Google reCAPTCHA test keys, then re-run the scenario.'
  );
}

/**
 * CalicoDesk browser login used by authentication and chat scenarios.
 * Credentials come from TEST_USER_EMAIL / TEST_USER_PASSWORD (never logged).
 */
export async function loginWithTestUser(page: Page): Promise<void> {
  // The dev login page can take a long time to fully load (observed > 30s),
  // so use domcontentloaded with a generous timeout instead of waiting on
  // every subresource. Heading/field assertions below still gate the flow.
  const response = await page.goto('/login', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  expect(response, 'login page should return an HTTP response').not.toBeNull();
  expect(response?.status(), 'login page should return HTTP 200').toBe(200);

  await dismissAcceptAllIfPresent(page);

  await expect(
    page.getByRole('heading', {
      name: 'Welcome back',
    }),
    'login heading should be visible',
  ).toBeVisible({
    timeout: 60_000,
  });

  const emailField = page.getByRole('textbox', { name: 'Email' });
  const continueButton = page.getByRole('button', {
    name: 'Continue',
    exact: true,
  });

  await expect(emailField, 'email field should be visible').toBeVisible({
    timeout: 30_000,
  });
  await expect(continueButton, 'continue button should be visible').toBeVisible({
    timeout: 30_000,
  });

  const email = getRequiredCredential('TEST_USER_EMAIL');
  const password = getRequiredCredential('TEST_USER_PASSWORD');

  await emailField.fill(email);
  await continueButton.click();

  await page.waitForURL(/step=password/, {
    timeout: 60_000,
    waitUntil: 'domcontentloaded',
  });

  await expect(
    page.getByRole('heading', {
      name: 'Welcome back',
    }),
    'password step should finish loading',
  ).toBeVisible({
    timeout: 60_000,
  });

  await dismissAcceptAllIfPresent(page);

  const passwordField = page.getByRole('textbox', {
    name: 'Password',
  });

  await expect(
    passwordField,
    'password field should appear after submitting a valid email',
  ).toBeVisible({
    timeout: 60_000,
  });

  await passwordField.fill(password);
  await confirmRecaptchaIfPresent(page);

  await page
    .getByRole('button', {
      name: 'Sign in',
      exact: true,
    })
    .click();

  await expect(
    page,
    'successful login should navigate to the dashboard',
  ).toHaveURL(/\/dashboard/, {
    timeout: 90_000,
  });

  await expect(
    page.getByRole('button', {
      name: 'toggle authentication menu',
    }),
    'authenticated dashboard should show the authentication menu control',
  ).toBeVisible({
    timeout: 60_000,
  });
}
