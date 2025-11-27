#!/usr/bin/env python3
"""
Demo: PDF Highlights in Cerebellar Extraction App

This script demonstrates:
1. Loading a PDF
2. Using the Fill All feature to extract data
3. Clicking "Locate" buttons to show highlights in the PDF
4. Watching highlights transition from yellow to persistent border
"""

import os
import time
from playwright.sync_api import sync_playwright

# Find a PDF that exists
PDF_CANDIDATES = [
    os.path.expanduser("~/Downloads/111099 english.pdf"),
    os.path.expanduser("~/Downloads/2025.10-deep-research-models.pdf"),
]

TEST_PDF = None
for pdf in PDF_CANDIDATES:
    if os.path.exists(pdf):
        TEST_PDF = pdf
        break

APP_URL = "http://127.0.0.1:5002"

def demo_highlights():
    if not TEST_PDF:
        print("❌ No test PDF found! Please place a PDF in ~/Downloads/")
        return

    print(f"\n{'='*70}")
    print("CEREBELLAR EXTRACTION - PDF HIGHLIGHT DEMO")
    print(f"{'='*70}")
    print(f"PDF: {os.path.basename(TEST_PDF)}")
    print(f"URL: {APP_URL}")
    print(f"{'='*70}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()

        # Capture errors
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" and "404" not in msg.text else None)

        print("1️⃣ Loading application...")
        page.goto(APP_URL, wait_until="networkidle")
        time.sleep(2)
        print("   ✅ App loaded\n")

        print("2️⃣ Uploading PDF...")
        file_input = page.locator("input[type='file']").first
        file_input.set_input_files(TEST_PDF)
        time.sleep(5)

        # Check if PDF loaded
        canvas = page.locator("canvas")
        if canvas.count() > 0:
            print(f"   ✅ PDF rendered ({canvas.count()} canvas elements)\n")
        else:
            print("   ⚠️ PDF may not have rendered\n")

        print("3️⃣ Running 'Fill All' AI extraction...")
        fill_btn = page.locator("button:has-text('Fill All')").first
        if fill_btn.is_visible():
            fill_btn.click()
            print("   ⏳ Waiting for AI extraction (this may take 15-30 seconds)...")
            time.sleep(20)
            print("   ✅ Extraction complete\n")
        else:
            print("   ⚠️ Fill All button not found\n")

        print("4️⃣ Looking for citation 'Locate' buttons...")
        locate_btns = page.locator("button:has-text('📍'), button:has-text('Locate')")
        btn_count = locate_btns.count()
        print(f"   Found {btn_count} locate buttons")

        if btn_count > 0:
            print("\n5️⃣ Clicking first Locate button to show highlight...")
            locate_btns.first.click()
            time.sleep(1)

            # Check for highlight
            highlight = page.locator(".citation-jump-highlight")
            if highlight.count() > 0:
                print("   ✅ YELLOW HIGHLIGHT CREATED!")
                print("   📍 Watch the highlight transition to a dashed border in 3 seconds...")
                time.sleep(4)

                persistent = page.locator(".citation-jump-highlight.persistent")
                if persistent.count() > 0:
                    print("   ✅ HIGHLIGHT TRANSITIONED TO PERSISTENT BORDER!")
                else:
                    print("   ⚠️ Persistent state not detected (highlight may still be visible)")
            else:
                print("   ⚠️ No highlight visible (may need sourceText from extraction)")

            # Try clicking more locate buttons
            if btn_count > 1:
                print(f"\n6️⃣ Clicking more Locate buttons to show multiple highlights...")
                for i in range(min(3, btn_count)):
                    locate_btns.nth(i).click()
                    time.sleep(1)
                    print(f"   Clicked button {i+1}")

                highlights = page.locator(".citation-jump-highlight")
                print(f"   ✅ Total highlights: {highlights.count()}")
        else:
            print("   ℹ️ No Locate buttons found. This means:")
            print("      - The extraction didn't find source citations, OR")
            print("      - The citation cards need to be expanded")

        # Check if there are citation cards to show
        print("\n7️⃣ Checking citation cards...")
        citation_cards = page.locator("[class*='citation'], [class*='source']")
        if citation_cards.count() > 0:
            print(f"   Found {citation_cards.count()} citation-related elements")
        else:
            print("   No citation cards visible")

        # Show any errors
        if errors:
            print("\n⚠️ JavaScript errors detected:")
            for err in errors[:5]:
                print(f"   - {err[:100]}")
        else:
            print("\n✅ No JavaScript errors!")

        print(f"\n{'='*70}")
        print("DEMO COMPLETE - Browser will stay open for 60 seconds for inspection")
        print(f"{'='*70}")
        print("\nTry:")
        print("  - Scroll through the PDF")
        print("  - Click on citation 'Locate' buttons to add more highlights")
        print("  - Hover over highlights to see tooltips")
        print("  - Click on highlights to remove them")

        time.sleep(60)
        browser.close()

if __name__ == "__main__":
    demo_highlights()
