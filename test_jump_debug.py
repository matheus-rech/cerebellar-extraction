#!/usr/bin/env python3
"""Test citation jump with console debug output"""

import time
from playwright.sync_api import sync_playwright

APP_URL = "http://127.0.0.1:5002"

def test_jump():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        page = browser.new_page()

        # Capture ALL console messages
        def handle_console(msg):
            if 'jumpToCitation' in msg.text or 'error' in msg.type.lower():
                print(f"[CONSOLE {msg.type}] {msg.text[:300]}")

        page.on("console", handle_console)

        print("1. Loading app...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(3)

        print("2. Selecting PDF from dropdown...")
        dropdown = page.locator("select").first
        dropdown.select_option(index=1)
        time.sleep(5)

        print("3. Calling jumpToCitation...")
        # Call jumpToCitation with a word that should be in the PDF
        page.evaluate("""() => {
            if (window.jumpToCitation) {
                window.jumpToCitation('patients', 'Test Search');
            }
        }""")
        time.sleep(3)

        print("4. Checking highlights...")
        highlights = page.locator(".citation-jump-highlight")
        print(f"   Highlights: {highlights.count()}")

        print("\nBrowser open for 15s...")
        time.sleep(15)
        browser.close()

if __name__ == "__main__":
    test_jump()
