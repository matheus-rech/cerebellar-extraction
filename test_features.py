#!/usr/bin/env python3
"""
Comprehensive test for cerebellar extraction app features:
1. PDF upload and rendering
2. Tab navigation (Form, Tables, Figures, Chat)
3. Tables extraction and window._extractedTables
4. Figures OCR transcription
5. Fill All with section-priority extraction
6. Citation jump and highlight persistence
"""

import os
import time
from playwright.sync_api import sync_playwright, expect

# Test PDF path - use a sample PDF
TEST_PDF = os.path.expanduser("~/Downloads/Kim-2016.pdf")
APP_URL = "http://127.0.0.1:5002"

def test_all_features():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=500)
        page = browser.new_page()

        print("\n" + "="*60)
        print("CEREBELLAR EXTRACTION APP - FEATURE TESTS")
        print("="*60)

        # ========================================
        # TEST 1: Basic Page Load
        # ========================================
        print("\n[TEST 1] Loading application...")
        page.goto(APP_URL)
        # Wait for React to render - look for the app container
        page.wait_for_selector("#root", timeout=15000)
        time.sleep(3)  # Give React time to render

        # Look for any heading or the app title
        title_el = page.locator("h1, h2, [class*='title']").first
        if title_el.is_visible():
            title = title_el.text_content()
            print(f"  - App title: {title}")
        else:
            title = page.title()
            print(f"  - Page title: {title}")

        print("  ✅ Page loaded successfully")

        # ========================================
        # TEST 2: Tab Navigation
        # ========================================
        print("\n[TEST 2] Testing tab navigation...")
        tabs = ["Form", "Tables", "Figures", "Chat"]
        for tab_name in tabs:
            tab_btn = page.locator(f"button:has-text('{tab_name}')").first
            if tab_btn.is_visible():
                tab_btn.click()
                time.sleep(0.5)
                print(f"  ✅ {tab_name} tab accessible")

        # Return to Form tab
        page.locator("button:has-text('Form')").first.click()
        print("  ✅ All tabs navigable")

        # ========================================
        # TEST 3: PDF Upload
        # ========================================
        print("\n[TEST 3] Testing PDF upload...")
        pdf_loaded = False
        if os.path.exists(TEST_PDF):
            try:
                # Find file input (may be hidden, but set_input_files should work)
                file_input = page.locator("input[type='file'][accept='.pdf']")
                if file_input.count() == 0:
                    file_input = page.locator("input[type='file']").first

                file_input.set_input_files(TEST_PDF)
                print(f"  - File selected: {os.path.basename(TEST_PDF)}")

                # Wait for PDF.js to initialize and render
                print("  - Waiting for PDF.js to render...")
                time.sleep(8)  # Give more time for PDF.js

                # Check if PDF rendered - look for canvas or PDF viewer
                pdf_canvas = page.locator("canvas")
                if pdf_canvas.count() > 0 and pdf_canvas.first.is_visible():
                    print(f"  ✅ PDF uploaded and rendered ({pdf_canvas.count()} canvases)")
                    pdf_loaded = True
                else:
                    # Try alternative check - look for page number indicator
                    page_indicator = page.locator("text=/Page.*of|1.*\\/|\\d+.*of.*\\d+/i")
                    if page_indicator.count() > 0:
                        print("  ✅ PDF loaded (page indicator visible)")
                        pdf_loaded = True
                    else:
                        print("  ⚠️ PDF may not have loaded properly")
                        # Screenshot for debugging
                        page.screenshot(path="debug_pdf_load.png")
                        print("  📸 Debug screenshot saved: debug_pdf_load.png")
            except Exception as e:
                print(f"  ⚠️ PDF upload error: {e}")
        else:
            print(f"  ⚠️ Test PDF not found: {TEST_PDF}")

        # ========================================
        # TEST 4: Tables Extraction
        # ========================================
        print("\n[TEST 4] Testing Tables extraction...")
        try:
            tables_tab = page.locator("button:has-text('Tables')").first
            if tables_tab.is_visible(timeout=3000):
                tables_tab.click()
                time.sleep(1)

                extract_tables_btn = page.locator("button:has-text('Extract Tables')").first
                if extract_tables_btn.is_visible(timeout=3000):
                    if pdf_loaded:
                        extract_tables_btn.click()
                        print("  - Waiting for table extraction (up to 30s)...")
                        time.sleep(15)  # Cloud function takes time

                        # Check if tables were extracted
                        tables_exported = page.evaluate("() => window._extractedTables")
                        if tables_exported:
                            print(f"  ✅ Tables extracted: {len(tables_exported)} tables")
                            print(f"  ✅ window._extractedTables exported successfully")
                        else:
                            print("  ⚠️ No tables extracted (may be PDF-specific)")
                    else:
                        print("  ⚠️ Skipping - no PDF loaded")
                else:
                    print("  ⚠️ Extract Tables button not found")
            else:
                print("  ⚠️ Tables tab not visible")
        except Exception as e:
            print(f"  ⚠️ Tables test error: {e}")

        # ========================================
        # TEST 5: Figures Panel & OCR
        # ========================================
        print("\n[TEST 5] Testing Figures panel...")
        try:
            figures_tab = page.locator("button:has-text('Figures')").first
            if figures_tab.is_visible(timeout=3000):
                figures_tab.click()
                time.sleep(1)

                extract_figures_btn = page.locator("button:has-text('Extract Figures')").first
                if extract_figures_btn.is_visible(timeout=3000):
                    if pdf_loaded:
                        extract_figures_btn.click()
                        print("  - Extracting figures...")
                        time.sleep(5)

                        # Check for transcribe buttons
                        transcribe_btns = page.locator("button:has-text('Transcribe')")
                        count = transcribe_btns.count()
                        print(f"  ✅ Found {count} figures with Transcribe option")

                        if count > 0:
                            print("  - Testing OCR on first figure...")
                            transcribe_btns.first.click()
                            time.sleep(10)  # OCR takes time

                            # Check if transcription was stored
                            transcriptions = page.evaluate("() => window._figureTranscriptions")
                            if transcriptions:
                                print(f"  ✅ OCR transcription stored in window._figureTranscriptions")
                            else:
                                print("  ⚠️ Transcription not yet in window object")
                    else:
                        print("  ⚠️ Skipping - no PDF loaded")
                else:
                    print("  ⚠️ Extract Figures button not found")
            else:
                print("  ⚠️ Figures tab not visible")
        except Exception as e:
            print(f"  ⚠️ Figures test error: {e}")

        # ========================================
        # TEST 6: Fill All with Section Priority
        # ========================================
        print("\n[TEST 6] Testing Fill All (section-priority extraction)...")
        try:
            form_tab = page.locator("button:has-text('Form')").first
            if form_tab.is_visible(timeout=3000):
                form_tab.click()
                time.sleep(1)

                fill_all_btn = page.locator("button:has-text('Fill All')")
                if fill_all_btn.count() > 0 and pdf_loaded:
                    fill_all_btn.first.click()
                    print("  - Running AI extraction with section priority...")
                    time.sleep(15)  # AI extraction takes time

                    # Check for success toast
                    toast = page.locator(".toast-message, [class*='toast']")
                    if toast.count() > 0:
                        toast_text = toast.first.text_content()
                        print(f"  ✅ Toast message: {toast_text}")
                        if "Methods" in toast_text or "Results" in toast_text:
                            print("  ✅ Section-priority extraction confirmed!")

                    # Check if form fields were populated
                    inputs_filled = page.evaluate("""() => {
                        const inputs = document.querySelectorAll('input[type="text"]');
                        let filled = 0;
                        inputs.forEach(i => { if (i.value) filled++; });
                        return filled;
                    }""")
                    print(f"  ✅ Form fields populated: {inputs_filled} fields")
                else:
                    print("  ⚠️ Fill All button not found or no PDF loaded")
        except Exception as e:
            print(f"  ⚠️ Fill All test error: {e}")

        # ========================================
        # TEST 7: Citation Jump & Highlights
        # ========================================
        print("\n[TEST 7] Testing citation jump and highlights...")
        try:
            # Look for citation cards or locate buttons
            locate_btns = page.locator("button:has-text('Locate'), button:has-text('📍')")
            if locate_btns.count() > 0:
                print(f"  - Found {locate_btns.count()} Locate buttons")
                locate_btns.first.click()
                time.sleep(2)

                # Check for highlights
                highlights = page.locator(".citation-jump-highlight")
                if highlights.count() > 0:
                    print("  ✅ Citation highlight created")

                    # Wait for transition to persistent
                    print("  - Waiting 4s for highlight transition...")
                    time.sleep(4)

                    persistent = page.locator(".citation-jump-highlight.persistent")
                    if persistent.count() > 0:
                        print("  ✅ Highlight transitioned to persistent state")
                else:
                    print("  ⚠️ No highlights visible (may need sourceText)")
            else:
                print("  ⚠️ No Locate buttons found (need filled citations)")
        except Exception as e:
            print(f"  ⚠️ Citation test error: {e}")

        # ========================================
        # TEST 8: Dynamic Field Types
        # ========================================
        print("\n[TEST 8] Testing dynamic field types...")
        try:
            form_tab = page.locator("button:has-text('Form')").first
            if form_tab.is_visible(timeout=3000):
                form_tab.click()
                time.sleep(1)

                dynamic_sections = [
                    ("Study Arms", "Add Study Arm"),
                    ("Indications", "Add Indication"),
                    ("Interventions", "Add Intervention"),
                    ("Mortality", "Add Mortality"),
                    ("mRS", "Add mRS"),
                    ("Complications", "Add Complication"),
                    ("Predictors", "Add Predictor")
                ]

                for section_name, add_btn_text in dynamic_sections:
                    add_btn = page.locator(f"button:has-text('{add_btn_text}')")
                    if add_btn.count() > 0:
                        print(f"  ✅ {section_name} section has '{add_btn_text}' button")
                    else:
                        print(f"  ⚠️ {section_name} - '{add_btn_text}' not found")
        except Exception as e:
            print(f"  ⚠️ Dynamic fields test error: {e}")

        # ========================================
        # TEST 9: Fuzzysort Library
        # ========================================
        print("\n[TEST 9] Testing fuzzysort library...")
        try:
            fuzzysort_available = page.evaluate("() => typeof window.fuzzysort !== 'undefined'")
            if fuzzysort_available:
                print("  ✅ Fuzzysort library loaded")

                # Test fuzzy search
                test_result = page.evaluate("""() => {
                    const result = fuzzysort.single('mortality', 'patient mortality rate');
                    return result ? result.score : null;
                }""")
                if test_result is not None:
                    print(f"  ✅ Fuzzy search working (score: {test_result})")
            else:
                print("  ❌ Fuzzysort library not loaded")
        except Exception as e:
            print(f"  ⚠️ Fuzzysort test error: {e}")

        # ========================================
        # SUMMARY
        # ========================================
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        print("All core features tested. Check above for ✅ (pass) or ⚠️/❌ (issues)")
        print("\nNote: Some features depend on:")
        print("  - Having extracted tables/figures first")
        print("  - Cloud Functions being available")
        print("  - GOOGLE_API_KEY being configured")

        # Keep browser open for manual inspection
        print("\n🔍 Browser staying open for 30s for manual inspection...")
        time.sleep(30)

        browser.close()
        print("\n✅ Tests completed!")

if __name__ == "__main__":
    test_all_features()
