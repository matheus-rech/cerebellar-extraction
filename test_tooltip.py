#!/usr/bin/env python3
"""Test citation jump tooltip visibility"""

import os
import time
from playwright.sync_api import sync_playwright

TEST_PDF = os.path.expanduser("~/Downloads/111099 english.pdf")
APP_URL = "http://127.0.0.1:5002"

def test_tooltip():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        page = browser.new_page()

        # Capture console
        page.on("console", lambda msg: print(f"[{msg.type}] {msg.text[:200]}") if "error" in msg.type.lower() else None)

        print("1. Loading app...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(2)

        print("2. Uploading PDF...")
        file_input = page.locator("input[type='file']").first
        file_input.set_input_files(TEST_PDF)
        time.sleep(5)

        print("3. Checking if PDF loaded...")
        canvas = page.locator("canvas")
        print(f"   Canvas count: {canvas.count()}")

        print("4. Looking for extraction button...")
        # Look for any button that might trigger AI extraction
        buttons = page.locator("button")
        for i in range(buttons.count()):
            btn = buttons.nth(i)
            if btn.is_visible():
                text = btn.text_content()
                if text:
                    print(f"   Button {i}: {text[:50]}")

        # Look for AI magic button
        ai_btn = page.locator("button.btn-ai-magic").first
        if ai_btn.is_visible():
            print("5. Found AI magic button, clicking...")
            ai_btn.click()
            print("   Waiting 20s for extraction...")
            time.sleep(20)

            print("6. Checking for Locate buttons...")
            locate_btns = page.locator("button.btn-citation")
            print(f"   Found {locate_btns.count()} citation buttons")

            if locate_btns.count() > 0:
                print("7. Clicking first Locate button...")
                locate_btns.first.click()
                time.sleep(2)

                print("8. Checking for highlights...")
                highlights = page.locator(".citation-jump-highlight")
                print(f"   Found {highlights.count()} highlights")

                if highlights.count() > 0:
                    print("9. Hovering over highlight to show tooltip...")
                    highlights.first.hover()
                    time.sleep(1)

                    # Check tooltip visibility
                    tooltip = page.locator(".citation-tooltip")
                    if tooltip.count() > 0:
                        is_visible = tooltip.first.is_visible()
                        print(f"   Tooltip visible: {is_visible}")

                        # Get tooltip text
                        if is_visible:
                            text = tooltip.first.text_content()
                            print(f"   Tooltip text: {text}")
        else:
            print("5. AI magic button not found")

        print("\nBrowser open for 30s for manual inspection...")
        time.sleep(30)
        browser.close()

if __name__ == "__main__":
    test_tooltip()
