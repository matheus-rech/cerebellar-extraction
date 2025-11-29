#!/usr/bin/env python3
"""Test citation jump directly via console"""

import os
import time
from playwright.sync_api import sync_playwright

TEST_PDF = os.path.expanduser("~/Downloads/111099 english.pdf")
APP_URL = "http://127.0.0.1:5002"

def test_citation_jump():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        page = browser.new_page()

        # Capture console
        page.on("console", lambda msg: print(f"[{msg.type}] {msg.text[:200]}") if "error" in msg.type.lower() else None)

        print("1. Loading app...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(3)

        print("2. Uploading PDF...")
        file_input = page.locator("input[type='file']").first
        file_input.set_input_files(TEST_PDF)
        time.sleep(6)

        print("3. Checking if PDF loaded...")
        canvas = page.locator("canvas")
        print(f"   Canvas count: {canvas.count()}")

        print("4. Testing jumpToCitation directly via console...")
        # Call jumpToCitation directly via JavaScript
        result = page.evaluate("""() => {
            if (window.jumpToCitation) {
                // Try to jump to a word that should be in the PDF
                window.jumpToCitation('cerebellar', 'Test Field');
                return 'jumpToCitation called';
            } else {
                return 'jumpToCitation not available';
            }
        }""")
        print(f"   Result: {result}")
        time.sleep(3)

        print("5. Checking for highlights...")
        highlights = page.locator(".citation-jump-highlight")
        h_count = highlights.count()
        print(f"   Found {h_count} highlights")

        if h_count > 0:
            print("6. Hovering to show tooltip...")
            highlights.first.hover()
            time.sleep(1)

            # Check tooltip
            tooltip_visible = page.evaluate("""() => {
                const tooltip = document.querySelector('.citation-tooltip');
                if (tooltip) {
                    const style = window.getComputedStyle(tooltip);
                    return {
                        visible: style.visibility === 'visible',
                        opacity: style.opacity,
                        text: tooltip.textContent
                    };
                }
                return null;
            }""")
            print(f"   Tooltip: {tooltip_visible}")

            print("7. Waiting for transition to persistent...")
            time.sleep(4)

            persistent = page.locator(".citation-jump-highlight.persistent")
            print(f"   Persistent highlights: {persistent.count()}")

        print("\n8. Testing Locate buttons with filled data...")
        # Fill a field via React state update
        page.evaluate("""() => {
            // Manually update the form input and trigger onChange
            const inputs = document.querySelectorAll('input[type="text"]');
            if (inputs.length > 0) {
                const input = inputs[0];
                // Simulate React-friendly input
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(input, 'cerebellar stroke');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }""")
        time.sleep(1)

        # Check for Locate buttons again
        locate_btns = page.locator("button.btn-citation")
        print(f"   Locate buttons after fill: {locate_btns.count()}")

        print("\nBrowser open for 30s for inspection...")
        print("Try hovering over a yellow highlight to see the tooltip!")
        time.sleep(30)
        browser.close()

if __name__ == "__main__":
    test_citation_jump()
