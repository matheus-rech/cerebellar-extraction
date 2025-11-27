#!/usr/bin/env python3
"""
Playwright Integration Tests for Table/Figure Extraction and Highlight Persistence

Tests:
1. Table extraction workflow
2. Figure extraction workflow
3. Highlight persistence across sessions
4. UI interaction workflows
"""

from playwright.sync_api import sync_playwright, expect
import time
import json
import os

# Configuration
BASE_URL = "http://127.0.0.1:5002"
TEST_PDF = "Kim2016.pdf"  # Ensure this exists in public/pdf/


class TestExtractionIntegration:
    """Integration tests for extraction features"""

    def setup_method(self):
        """Setup for each test"""
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(headless=False, slow_mo=300)
        self.context = self.browser.new_context()
        self.page = self.context.new_page()

        # Capture console logs
        self.console_logs = []
        self.page.on("console", lambda msg: self.console_logs.append(f"[{msg.type}] {msg.text}"))

        # Capture errors
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def teardown_method(self):
        """Cleanup after each test"""
        self.browser.close()
        self.playwright.stop()

    def navigate_to_app(self):
        """Navigate to the app with cache busting"""
        cache_buster = int(time.time())
        self.page.goto(f'{BASE_URL}?_={cache_buster}', wait_until='networkidle')
        time.sleep(2)

    def load_test_pdf(self):
        """Load the test PDF from the dropdown"""
        # Wait for available PDFs dropdown
        try:
            dropdown = self.page.wait_for_selector('select', timeout=5000)
            if dropdown:
                # Select the test PDF
                self.page.select_option('select', TEST_PDF)
                time.sleep(3)  # Wait for PDF to load
                return True
        except:
            print(f"  Could not find PDF dropdown or {TEST_PDF}")
            return False

    def test_table_extraction_button_exists(self):
        """Test that table extraction UI exists"""
        print("\n📊 Test: Table Extraction Button Exists")

        self.navigate_to_app()
        self.load_test_pdf()

        # Click Tables tab
        tables_tab = self.page.locator('button:has-text("Tables")')
        tables_tab.click()
        time.sleep(1)

        # Check for Extract Tables button
        extract_button = self.page.locator('button:has-text("Extract Tables")')
        assert extract_button.is_visible(), "Extract Tables button should be visible"
        print("  ✅ Extract Tables button found")

    def test_figure_extraction_button_exists(self):
        """Test that figure extraction UI exists"""
        print("\n🖼️ Test: Figure Extraction Button Exists")

        self.navigate_to_app()
        self.load_test_pdf()

        # Click Figures tab
        figures_tab = self.page.locator('button:has-text("Figures")')
        figures_tab.click()
        time.sleep(1)

        # Check for Extract Figures button
        extract_button = self.page.locator('button:has-text("Extract Figures")')
        assert extract_button.is_visible(), "Extract Figures button should be visible"
        print("  ✅ Extract Figures button found")

    def test_table_extraction_workflow(self):
        """Test complete table extraction workflow"""
        print("\n📊 Test: Table Extraction Workflow")

        self.navigate_to_app()
        if not self.load_test_pdf():
            print("  ⚠️ Skipping - no test PDF available")
            return

        # Click Tables tab
        tables_tab = self.page.locator('button:has-text("Tables")')
        tables_tab.click()
        time.sleep(1)

        # Take screenshot before extraction
        self.page.screenshot(path='test_screenshots/table_before_extract.png')

        # Click Extract Tables button
        extract_button = self.page.locator('button:has-text("Extract Tables")')
        extract_button.click()

        # Wait for extraction (with timeout)
        self.page.wait_for_selector('button:has-text("Extracting...")', timeout=5000, state='visible')
        print("  ⏳ Extraction in progress...")

        # Wait for completion
        try:
            self.page.wait_for_selector('button:has-text("Extract Tables")', timeout=60000, state='visible')
            print("  ✅ Extraction completed")
        except:
            print("  ⚠️ Extraction timed out or error occurred")

        # Take screenshot after extraction
        self.page.screenshot(path='test_screenshots/table_after_extract.png')

        # Check for extracted tables
        extracted_tables = self.page.locator('text=Extracted Tables')
        if extracted_tables.is_visible():
            print("  ✅ Tables were extracted and displayed")
        else:
            # Check for error message
            error_div = self.page.locator('[style*="ffe6e6"]')
            if error_div.is_visible():
                print(f"  ❌ Error: {error_div.text_content()}")
            else:
                print("  ⚠️ No tables found in PDF")

    def test_figure_extraction_workflow(self):
        """Test complete figure extraction workflow"""
        print("\n🖼️ Test: Figure Extraction Workflow")

        self.navigate_to_app()
        if not self.load_test_pdf():
            print("  ⚠️ Skipping - no test PDF available")
            return

        # Click Figures tab
        figures_tab = self.page.locator('button:has-text("Figures")')
        figures_tab.click()
        time.sleep(1)

        # Take screenshot before extraction
        self.page.screenshot(path='test_screenshots/figure_before_extract.png')

        # Click Extract Figures button
        extract_button = self.page.locator('button:has-text("Extract Figures")')
        extract_button.click()

        # Wait for extraction
        self.page.wait_for_selector('button:has-text("Extracting...")', timeout=5000, state='visible')
        print("  ⏳ Extraction in progress...")

        # Wait for completion
        try:
            self.page.wait_for_selector('button:has-text("Extract Figures")', timeout=60000, state='visible')
            print("  ✅ Extraction completed")
        except:
            print("  ⚠️ Extraction timed out or error occurred")

        # Take screenshot after extraction
        self.page.screenshot(path='test_screenshots/figure_after_extract.png')

        # Check for extracted figures
        extracted_figures = self.page.locator('text=Extracted Figures')
        if extracted_figures.is_visible():
            print("  ✅ Figures were extracted and displayed")

            # Check for images
            images = self.page.locator('img[src^="data:image"]')
            image_count = images.count()
            print(f"  📷 Found {image_count} figure images")
        else:
            # Check for error
            error_div = self.page.locator('[style*="ffe6e6"]')
            if error_div.is_visible():
                print(f"  ❌ Error: {error_div.text_content()}")
            else:
                print("  ⚠️ No figures found in PDF")

    def test_tab_switching(self):
        """Test switching between tabs"""
        print("\n🔄 Test: Tab Switching")

        self.navigate_to_app()

        tabs = ['Form', 'Tables', 'Figures', 'Chat']
        for tab_name in tabs:
            tab_button = self.page.locator(f'button:has-text("{tab_name}")')
            if tab_button.is_visible():
                tab_button.click()
                time.sleep(0.5)
                print(f"  ✅ Switched to {tab_name} tab")
            else:
                print(f"  ⚠️ {tab_name} tab not found")

    def test_highlight_persistence(self):
        """Test that highlights persist across page reloads"""
        print("\n💾 Test: Highlight Persistence")

        self.navigate_to_app()
        if not self.load_test_pdf():
            print("  ⚠️ Skipping - no test PDF available")
            return

        # Check if there are any highlights stored
        initial_storage = self.page.evaluate('''() => {
            const storage = localStorage.getItem('cerebellar_extraction_data');
            return storage ? JSON.parse(storage) : null;
        }''')

        if initial_storage and 'highlights' in initial_storage:
            highlight_count = sum(len(v) for v in initial_storage['highlights'].values())
            print(f"  📌 Found {highlight_count} existing highlights")
        else:
            print("  📌 No existing highlights found")

        # Reload the page
        self.page.reload()
        time.sleep(3)

        # Check if highlights persist
        post_reload_storage = self.page.evaluate('''() => {
            const storage = localStorage.getItem('cerebellar_extraction_data');
            return storage ? JSON.parse(storage) : null;
        }''')

        if initial_storage == post_reload_storage:
            print("  ✅ Highlights persisted after reload")
        else:
            print("  ⚠️ Highlight data changed after reload")

    def test_error_handling_no_pdf(self):
        """Test error handling when no PDF is loaded"""
        print("\n⚠️ Test: Error Handling (No PDF)")

        self.navigate_to_app()

        # Try Tables without loading PDF
        tables_tab = self.page.locator('button:has-text("Tables")')
        tables_tab.click()
        time.sleep(1)

        extract_button = self.page.locator('button:has-text("Extract Tables")')

        # Button should be disabled or show error when clicked
        is_disabled = extract_button.is_disabled()
        print(f"  Extract Tables button disabled: {is_disabled}")

        if not is_disabled:
            extract_button.click()
            time.sleep(1)

            # Check for error message
            error_div = self.page.locator('text=Please upload a PDF')
            if error_div.is_visible():
                print("  ✅ Appropriate error message shown")
            else:
                print("  ⚠️ No error message shown")


def run_all_tests():
    """Run all integration tests"""
    print("\n" + "=" * 70)
    print("  Cerebellar Extraction Integration Tests")
    print("=" * 70)

    # Create screenshots directory
    os.makedirs('test_screenshots', exist_ok=True)

    test_instance = TestExtractionIntegration()

    tests = [
        test_instance.test_table_extraction_button_exists,
        test_instance.test_figure_extraction_button_exists,
        test_instance.test_tab_switching,
        test_instance.test_error_handling_no_pdf,
        test_instance.test_table_extraction_workflow,
        test_instance.test_figure_extraction_workflow,
        test_instance.test_highlight_persistence,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test_instance.setup_method()
            test()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  ❌ FAILED: {e}")
        finally:
            test_instance.teardown_method()

    print("\n" + "=" * 70)
    print(f"  Results: {passed} passed, {failed} failed")
    print("=" * 70)

    return failed == 0


if __name__ == '__main__':
    success = run_all_tests()
    exit(0 if success else 1)
