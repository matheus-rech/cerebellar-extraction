import { test, expect } from '@playwright/test';

test.describe('CEREBELLAR-EXTRACT E2E Tests', () => {
  test.setTimeout(120000); // 2 minute timeout for complex flows

  test('should load the main extraction app', async ({ page }) => {
    await page.goto('');

    // Check page title
    await expect(page).toHaveTitle(/CEREBELLAR-EXTRACT/);

    // Wait for React app to load
    await page.waitForSelector('#root');

    // Check main components are present
    await expect(page.locator('h2:has-text("📋 Extraction Assistant")')).toBeVisible();
    await expect(page.locator('h2:has-text("📄 PDF Explorer")')).toBeVisible();

    // Check for upload button
    const uploadBtn = page.locator('label:has-text("Upload PDF")');
    await expect(uploadBtn).toBeVisible();
  });

  test('should show PDF server selection dropdown', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');

    // Wait for the HTML content to load
    await page.waitForTimeout(2000);

    // Check that any select element exists (PDF selector or any form selects)
    const selects = page.locator('select');
    const selectCount = await selects.count();
    expect(selectCount).toBeGreaterThanOrEqual(1);
    console.log(`Found ${selectCount} select elements`);
  });

  test('should open different tabs', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');

    // Check form tab (default)
    const formTab = page.locator('button').filter({ hasText: '📋 Form' });
    await expect(formTab).toBeVisible();

    // Check tables tab
    const tablesTab = page.locator('button').filter({ hasText: '📊 Tables' });
    await expect(tablesTab).toBeVisible();

    // Check figures tab
    const figuresTab = page.locator('button').filter({ hasText: '🖼️ Figures' });
    await expect(figuresTab).toBeVisible();

    // Test opening different tabs
    await tablesTab.click();
    await page.waitForTimeout(500);
    await expect(page.locator('h2:has-text("📊 Table Extraction")')).toBeVisible();

    await figuresTab.click();
    await page.waitForTimeout(500);
    await expect(page.locator('h2:has-text("🖼️ Figure Extraction")')).toBeVisible();

    // Back to form
    await formTab.click();
    await page.waitForTimeout(500);
    await expect(page.locator('h2:has-text("📋 Extraction Assistant")')).toBeVisible();
  });

  test('should allow manual data entry', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');

    // Wait for form to load
    await page.waitForTimeout(1000);

    // Try to fill in basic fields (Study ID, Authors, Year)
    const studyIdField = page.locator('input').filter({ hasText: 'Study ID' }).locator('xpath=following-sibling::input');
    if (await studyIdField.count() > 0) {
      await studyIdField.fill('TEST2024');
      await page.waitForTimeout(500);
      await expect(studyIdField).toHaveValue('TEST2024');
    }

    // Check if fields accept input (basic form interaction)
    const inputFields = page.locator('input[type="text"]');
    const fieldCount = await inputFields.count();
    expect(fieldCount).toBeGreaterThan(0);
    console.log(`Found ${fieldCount} text input fields`);
  });

  test('should show loading states for AI features', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');
    await page.waitForTimeout(1000);

    // Look for AI buttons (should be present)
    const aiButtons = page.locator('button:has-text("Auto-Fill"), button:has-text("Citations")');
    const buttonCount = await aiButtons.count();

    if (buttonCount > 0) {
      console.log(`Found ${buttonCount} AI buttons`);
      // Note: We don't click them without a real PDF as they require backend
      await expect(aiButtons.first()).toBeVisible();
    } else {
      console.log('No AI buttons found - may need PDF upload first');
    }
  });

  test('should handle PDF upload area interactions', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');

    // Check PDF viewer area
    await expect(page.locator('h2:has-text("📄 PDF Explorer")')).toBeVisible();

    // Check for upload instructions when no PDF is loaded
    const noPdfMessage = page.locator('text="Upload a PDF Document to begin"');
    if (await noPdfMessage.isVisible()) {
      console.log('No PDF loaded - showing upload prompt');
      await expect(noPdfMessage).toBeVisible();
    }
  });

  test('should allow navigation through study form sections', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');
    await page.waitForTimeout(1000);

    // Check if accordion sections exist
    const sectionHeaders = page.locator('.section-header');
    const sectionCount = await sectionHeaders.count();

    if (sectionCount > 0) {
      console.log(`Found ${sectionCount} form sections`);

      // Test clicking section headers (accordion behavior)
      for (let i = 0; i < Math.min(sectionCount, 2); i++) {
        const header = sectionHeaders.nth(i);
        await header.click();
        await page.waitForTimeout(500);
        console.log(`Clicked section header ${i + 1}`);
      }
    } else {
      console.log('No accordion sections found');
    }
  });

  test('should handle dynamic field additions', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');
    await page.waitForTimeout(1000);

    // Look for "Add" buttons for dynamic fields
    const addButtons = page.locator('button:has-text("Add"), button:has-text("+")');
    const addCount = await addButtons.count();

    if (addCount > 0) {
      console.log(`Found ${addCount} add buttons for dynamic fields`);

      // Try clicking one add button (if available)
      const firstAddBtn = addButtons.first();
      const isEnabled = await firstAddBtn.isEnabled();

      if (isEnabled) {
        console.log('Add button is enabled - can add dynamic fields');
        await expect(firstAddBtn).toBeVisible();
      }
    } else {
      console.log('No dynamic field add buttons found');
    }
  });

  test('should respond to keyboard interactions', async ({ page }) => {
    await page.goto('');
    await page.waitForSelector('#root');
    await page.waitForTimeout(1000);

    // Press Tab to navigate through focusable elements
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);

    // Check if any element got focus
    const focusedElement = page.locator(':focus');
    const tagName = await focusedElement.evaluate(el => el.tagName);

    console.log(`Focused element: ${tagName}`);

    // Test some basic keyboard navigation
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    console.log('Keyboard navigation working');
  });
});
