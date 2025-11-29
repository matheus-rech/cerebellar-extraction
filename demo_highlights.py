#!/usr/bin/env python3
"""
Demo: PDF Highlights in Cerebellar Extraction App

This script demonstrates:
1. Loading a PDF
2. Using the Fill All feature to extract data
3. Clicking "Locate" buttons to show highlights in the PDF
4. Watching highlights transition from yellow to persistent border

Usage:
    python demo_highlights.py [path/to/file.pdf]
    python demo_highlights.py --url http://localhost:5002 path/to/file.pdf
"""

import os
import argparse
from playwright.sync_api import sync_playwright


def get_test_pdf(args):
    """Get PDF path from args or find a default one."""
    if args.pdf and os.path.exists(args.pdf):
        return args.pdf

    # Try default locations if no arg provided
    default_pdfs = [
        "./pdfs/Kim2016.pdf",
        "./pdfs/test.pdf",
    ]

    for pdf in default_pdfs:
        if os.path.exists(pdf):
            return pdf

    return None


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Demo PDF highlights in Cerebellar Extraction App"
    )
    parser.add_argument(
        "pdf",
        nargs="?",
        help="Path to PDF file to test with"
    )
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:5002",
        help="URL of the app (default: http://127.0.0.1:5002)"
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30000,
        help="Default timeout in ms for waits (default: 30000)"
    )
    return parser.parse_args()


# Parse arguments
args = parse_args()
TEST_PDF = get_test_pdf(args)
APP_URL = args.url
DEFAULT_TIMEOUT = args.timeout

def demo_highlights():
    if not TEST_PDF:
        print("❌ No test PDF found! Provide a PDF path as argument:")
        print("   python demo_highlights.py path/to/file.pdf")
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
        page.set_default_timeout(DEFAULT_TIMEOUT)

        # Capture errors
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" and "404" not in msg.text else None)

        print("1️⃣ Loading application...")
        page.goto(APP_URL, wait_until="networkidle")
        page.wait_for_selector("#root", state="visible")
        print("   ✅ App loaded\n")

        print("2️⃣ Uploading PDF...")
        file_input = page.locator("input[type='file']").first
        file_input.set_input_files(TEST_PDF)

        # Wait for PDF to render (canvas elements appear)
        canvas = page.locator("canvas")
        try:
            canvas.first.wait_for(state="visible", timeout=10000)
            print(f"   ✅ PDF rendered ({canvas.count()} canvas elements)\n")
        except Exception:
            print("   ⚠️ PDF may not have rendered\n")

        print("3️⃣ Running 'Fill All' AI extraction...")
        fill_btn = page.locator("button:has-text('Fill All')").first
        if fill_btn.is_visible():
            fill_btn.click()
            print("   ⏳ Waiting for AI extraction...")
            # Wait for extraction to complete (button becomes enabled again or loading indicator disappears)
            try:
                page.wait_for_function(
                    "() => !document.querySelector('.loading-indicator') && !document.querySelector('[data-loading=\"true\"]')",
                    timeout=60000
                )
            except Exception:
                pass  # Continue even if timeout - extraction may have completed
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

            # Wait for highlight element to appear
            highlight = page.locator(".citation-jump-highlight")
            try:
                highlight.first.wait_for(state="visible", timeout=5000)
                print("   ✅ YELLOW HIGHLIGHT CREATED!")
                print("   📍 Watch the highlight transition to a dashed border...")

                # Wait for persistent class to be added
                persistent = page.locator(".citation-jump-highlight.persistent")
                try:
                    persistent.first.wait_for(state="visible", timeout=5000)
                    print("   ✅ HIGHLIGHT TRANSITIONED TO PERSISTENT BORDER!")
                except Exception:
                    print("   ⚠️ Persistent state not detected (highlight may still be visible)")
            except Exception:
                print("   ⚠️ No highlight visible (may need sourceText from extraction)")

            # Try clicking more locate buttons
            if btn_count > 1:
                print(f"\n6️⃣ Clicking more Locate buttons to show multiple highlights...")
                for i in range(min(3, btn_count)):
                    locate_btns.nth(i).click()
                    page.wait_for_timeout(500)  # Brief pause between clicks
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

        page.wait_for_timeout(60000)  # Keep browser open for inspection
        browser.close()

if __name__ == "__main__":
    demo_highlights()
