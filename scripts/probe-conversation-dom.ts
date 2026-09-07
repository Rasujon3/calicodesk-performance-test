/**
 * One-off diagnostic probe: logs in as the agent, opens the conversations page,
 * finds the conversation containing the given unique message, opens it, and
 * dumps the real DOM structure of the thread area + composer.
 *
 * Run: npx tsx scripts/probe-conversation-dom.ts "<unique message from test>"
 */
import { chromium } from 'playwright';
import { config as loadEnv } from 'dotenv';
import { environment } from '../config/environments.js';
import { loginWithTestUser } from '../shared/playwright/auth.js';
import { findAndOpenConversationByMessage } from '../shared/playwright/agent-conversations.js';

loadEnv();

const targetMessage = process.argv[2] ?? '';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: environment.baseUrl });
  const page = await context.newPage();

  try {
    console.log('Logging in...');
    await loginWithTestUser(page);
    const origin = new URL(page.url()).origin;
    console.log(`Logged in. Origin: ${origin}`);

    console.log('Opening conversations...');
    await page.goto(`${origin}/dashboard/conversations?viewId=mine`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForTimeout(5_000);

    if (targetMessage) {
      console.log(`Finding conversation containing: "${targetMessage}"`);
      const strategy = await findAndOpenConversationByMessage(page, targetMessage);
      console.log(`Opened via: ${strategy}`);
    }

    await page.waitForTimeout(3_000);

    // Dump thread-area candidate HTML
    const areaSelectors = [
      '[data-testid*="conversation" i], [class*="conversation" i]',
      '[data-testid*="thread" i], [class*="thread" i]',
      '[data-testid*="chat-body" i], [class*="chat-body" i]',
      '#feed-container',
      '[role="main"]',
    ];

    for (const sel of areaSelectors) {
      const count = await page.locator(sel).count();
      console.log(`\n=== AREA ${sel} → count=${count} ===`);
      if (count > 0) {
        const html = await page.locator(sel).first().evaluate((el) => el.outerHTML.slice(0, 3000));
        console.log(html);
      }
    }

    // Dump any [data-message-id] elements
    const bubbleCount = await page.locator('[data-message-id]').count();
    console.log(`\n=== [data-message-id] count=${bubbleCount} ===`);
    if (bubbleCount > 0) {
      const html = await page.locator('[data-message-id]').first().evaluate((el) => el.outerHTML.slice(0, 1500));
      console.log(html);
    }

    // Composer candidates
    for (const sel of ['textarea', '[contenteditable="true"]', 'input[type="text"]']) {
      const count = await page.locator(sel).count();
      console.log(`\n=== COMPOSER ${sel} → count=${count} ===`);
      if (count > 0) {
        const html = await page.locator(sel).first().evaluate((el) => el.outerHTML.slice(0, 1000));
        console.log(html);
      }
    }

    // Send button candidates
    for (const sel of ['button[type="submit"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]']) {
      const count = await page.locator(sel).count();
      console.log(`\n=== SEND ${sel} → count=${count} ===`);
      if (count > 0) {
        const html = await page.locator(sel).first().evaluate((el) => el.outerHTML.slice(0, 800));
        console.log(html);
      }
    }

    console.log('\n=== PAGE TEXT SAMPLE (thread area) ===');
    const mainText = await page.locator('[role="main"]').first().innerText().catch(() => '(no main)');
    console.log(mainText.slice(0, 3000));

    await context.storageState({ path: 'scenarios/chat/results/playwright/probe-state.json' });
    console.log('\nStorage state saved to scenarios/chat/results/playwright/probe-state.json');
  } catch (error) {
    console.error('Probe failed:', error instanceof Error ? error.message : error);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main();