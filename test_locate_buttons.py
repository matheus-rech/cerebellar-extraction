#!/usr/bin/env python3
"""Test Locate buttons in form fields"""

import os
import time
from playwright.sync_api import sync_playwright

TEST_PDF = os.path.expanduser("~/Downloads/111099 english.pdf")
APP_URL = "http://127.0.0.1:5002"

def test_locate():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        page = browser.new_page()

        # Capture console errors
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        print("1. Loading app...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(2)

        print("2. Uploading PDF...")
        file_input = page.locator("input[type='file']").first
        file_input.set_input_files(TEST_PDF)
        time.sleep(5)

        print("3. Manually filling a field to test Locate button...")
        # Find the Study ID input and enter a test value
        study_id_input = page.locator("input").first
        # The form might have multiple inputs, let's find the Authors field
        authors_input = page.locator("input[type='text']").nth(1)
        if authors_input.is_visible():
            authors_input.fill("Kim")  # Type author name
            print("   Filled Authors field with 'Kim'")
            time.sleep(1)

        print("4. Looking for Locate buttons (MapPin icon)...")
        locate_btns = page.locator("button.btn-citation")
        count = locate_btns.count()
        print(f"   Found {count} Locate buttons")

        if count > 0:
            print("5. Clicking first Locate button...")
            locate_btns.first.click()
            time.sleep(2)

            print("6. Checking for citation highlights...")
            highlights = page.locator(".citation-jump-highlight")
            h_count = highlights.count()
            print(f"   Found {h_count} highlights")

            if h_count > 0:
                print("7. Hovering over highlight for tooltip...")
                highlights.first.hover()
                time.sleep(1)

                tooltip = page.locator(".citation-tooltip")
                if tooltip.count() > 0 and tooltip.first.is_visible():
                    text = tooltip.first.text_content()
                    print(f"   Tooltip visible: {text}")
                else:
                    print("   Tooltip not visible")

                print("8. Waiting 4s for highlight transition to persistent...")
                time.sleep(4)

                persistent = page.locator(".citation-jump-highlight.persistent")
                if persistent.count() > 0:
                    print("   Highlight transitioned to persistent state")

        if errors:
            print(f"\n Console errors: {len(errors)}")
            for e in errors[:5]:
                print(f"   - {e[:100]}")

        print("\nBrowser open for 30s for inspection...")
        time.sleep(30)
        browser.close()

if __name__ == "__main__":
    test_locate()
