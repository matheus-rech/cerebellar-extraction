import { test, expect } from '@playwright/test';

test('debug page rendering', async ({ page }) => {
  // Collect console messages
  const messages: string[] = [];
  page.on('console', msg => messages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => messages.push(`[ERROR] ${err.message}`));

  await page.goto('http://localhost:5002');
  await page.waitForTimeout(5000);

  // Log all console messages
  console.log('\n=== CONSOLE MESSAGES ===');
  messages.forEach(m => console.log(m));

  // Check what's in the DOM
  const html = await page.evaluate(() => document.body.innerHTML);
  console.log('\n=== BODY LENGTH ===', html.length);

  // Check for React root
  const rootCount = await page.locator('#root').count();
  console.log('=== ROOT COUNT ===', rootCount);

  if (rootCount > 0) {
    const rootContent = await page.locator('#root').innerHTML();
    console.log('=== ROOT CONTENT ===', rootContent.substring(0, 1000));
  }

  // Check for specific elements
  const headerCount = await page.locator('.extraction-header').count();
  const tabCount = await page.locator('.tab-btn').count();
  console.log('=== HEADER COUNT ===', headerCount);
  console.log('=== TAB COUNT ===', tabCount);

  // Snapshot the page
  await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
  console.log('=== Screenshot saved to debug-screenshot.png ===');
});
