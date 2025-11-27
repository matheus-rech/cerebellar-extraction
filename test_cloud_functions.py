#!/usr/bin/env python3
"""Test the deployed Cloud Functions"""

import time
from playwright.sync_api import sync_playwright

APP_URL = "http://127.0.0.1:5002"

def test_tables_and_figures():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        page = browser.new_page()

        # Capture console messages
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if "error" in msg.type.lower() else print(f"[{msg.type}] {msg.text[:150]}"))

        print("1. Loading app...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(2)

        print("2. Checking for PDF dropdown...")
        dropdown = page.locator("select")
        if dropdown.count() > 0:
            options = dropdown.first.locator("option")
            print(f"   Found dropdown with {options.count()} options")

            # Select first PDF
            if options.count() > 1:
                dropdown.first.select_option(index=1)
                print("   Selected first PDF, waiting for load...")
                time.sleep(5)

                canvas = page.locator("canvas")
                if canvas.count() > 0:
                    print(f"   ✓ PDF loaded ({canvas.count()} canvases)")

                    # Test Tables Tab
                    print("3. Testing Tables extraction...")
                    tabs = page.locator("button")
                    for i in range(tabs.count()):
                        if "Tables" in (tabs.nth(i).text_content() or ""):
                            tabs.nth(i).click()
                            break
                    time.sleep(1)

                    extract_tables_btn = page.locator("button:has-text('Extract Tables')")
                    if extract_tables_btn.count() > 0:
                        print("   Clicking Extract Tables...")
                        extract_tables_btn.first.click()
                        time.sleep(10)

                        # Check for results
                        table_results = page.locator("text=Found")
                        if table_results.count() > 0:
                            print(f"   ✓ Table extraction result: {table_results.first.text_content()}")
                        else:
                            print("   ✗ No tables found or extraction failed")

                    # Test Figures Tab
                    print("4. Testing Figures extraction...")
                    for i in range(tabs.count()):
                        if "Figures" in (tabs.nth(i).text_content() or ""):
                            tabs.nth(i).click()
                            break
                    time.sleep(1)

                    extract_figures_btn = page.locator("button:has-text('Extract Figures')")
                    if extract_figures_btn.count() > 0:
                        print("   Clicking Extract Figures...")
                        extract_figures_btn.first.click()
                        time.sleep(10)

                        # Check for results
                        figure_results = page.locator("text=Found")
                        if figure_results.count() > 0:
                            print(f"   ✓ Figure extraction result: {figure_results.first.text_content()}")
                        else:
                            print("   ✗ No figures found or extraction failed")

                else:
                    print("   ✗ PDF did not load")
        else:
            print("   No dropdown found")

        if errors:
            print(f"\nConsole errors: {len(errors)}")
            for e in errors[:5]:
                print(f"   - {e[:100]}")

        print("\nBrowser open for 20s for inspection...")
        time.sleep(20)
        browser.close()

if __name__ == "__main__":
    test_tables_and_figures()
