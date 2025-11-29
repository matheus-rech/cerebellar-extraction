#!/usr/bin/env python3
"""Test PDF dropdown and citation jump"""

import time
from playwright.sync_api import sync_playwright

APP_URL = "http://127.0.0.1:5002"

def test_dropdown():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        page = browser.new_page()

        # Capture console
        page.on("console", lambda msg: print(f"[{msg.type}] {msg.text[:150]}") if "error" in msg.type.lower() else None)

        print("1. Loading app...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(3)

        print("2. Checking for PDF dropdown...")
        dropdown = page.locator("select")
        if dropdown.count() > 0:
            options = dropdown.first.locator("option")
            print(f"   Found dropdown with {options.count()} options")
            for i in range(min(5, options.count())):
                text = options.nth(i).text_content()
                print(f"   - Option {i}: {text}")

            print("3. Selecting first PDF...")
            if options.count() > 1:
                dropdown.first.select_option(index=1)  # Select first actual PDF (index 0 is placeholder)
                print("   Waiting for PDF to load...")
                time.sleep(5)

                canvas = page.locator("canvas")
                if canvas.count() > 0:
                    print(f"   ✓ PDF loaded ({canvas.count()} canvases)")

                    print("4. Testing citation jump directly...")
                    # Get some text from PDF to search for
                    pdf_text = page.evaluate("""async () => {
                        if (!window.pdfDoc) return null;
                        const page = await window.pdfDoc.getPage(1);
                        const textContent = await page.getTextContent();
                        const text = textContent.items.map(item => item.str).join(' ');
                        return text.substring(0, 500);
                    }""")
                    if pdf_text:
                        print(f"   PDF text (first 200): {pdf_text[:200]}")

                        # Find a word to search
                        words = [w for w in pdf_text.split() if len(w) > 4][:5]
                        if words:
                            search_word = words[0]
                            print(f"   Searching for: '{search_word}'")

                            result = page.evaluate(f"""() => {{
                                if (window.jumpToCitation) {{
                                    window.jumpToCitation('{search_word}', 'Test');
                                    return 'called';
                                }}
                                return 'not available';
                            }}""")
                            print(f"   jumpToCitation result: {result}")
                            time.sleep(2)

                            highlights = page.locator(".citation-jump-highlight")
                            print(f"   Highlights created: {highlights.count()}")
                else:
                    print("   ✗ PDF did not load")
        else:
            print("   No dropdown found - check if pdfs.json is accessible")

        print("\nBrowser open for 20s...")
        time.sleep(20)
        browser.close()

if __name__ == "__main__":
    test_dropdown()
