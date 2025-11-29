#!/usr/bin/env python3
"""Test with browser cache disabled"""

import os
import time
from playwright.sync_api import sync_playwright

TEST_PDF = os.path.expanduser("~/Downloads/111099 english.pdf")
APP_URL = "http://127.0.0.1:5002"

def test_nocache():
    with sync_playwright() as p:
        # Launch with cache disabled
        browser = p.chromium.launch(headless=False, args=['--disable-cache'])
        context = browser.new_context(bypass_csp=True)
        page = context.new_page()

        console_errors = []
        def handle_console(msg):
            if msg.type == "error":
                console_errors.append(msg.text)
                print(f"❌ ERROR: {msg.text[:200]}")

        page.on("console", handle_console)

        print("Loading app (cache disabled)...")
        page.goto(APP_URL, wait_until="networkidle")

        # Hard refresh
        page.evaluate("() => location.reload(true)")
        time.sleep(3)

        print("Uploading PDF...")
        file_input = page.locator("input[type='file']").first
        file_input.set_input_files(TEST_PDF)

        print("Waiting 10s for PDF to load...")
        time.sleep(10)

        if console_errors:
            print(f"\n❌ Found {len(console_errors)} console errors!")
            for err in console_errors[:5]:
                print(f"  - {err[:150]}")
        else:
            print("\n✅ No console errors!")

        # Check if PDF canvas is visible
        canvas = page.locator("canvas")
        if canvas.count() > 0:
            print(f"✅ PDF rendered ({canvas.count()} canvases)")
        else:
            print("❌ PDF did not render")

        print("\nBrowser open for 20s...")
        time.sleep(20)

        browser.close()

if __name__ == "__main__":
    test_nocache()
