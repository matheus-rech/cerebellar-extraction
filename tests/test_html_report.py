#!/usr/bin/env python3
"""
Test HTML Report Generation Cloud Function

Tests the capture_highlights and generate_html_report Python Cloud Functions
"""

import base64
import json
import requests
import os
from pathlib import Path

# Configuration
FUNCTIONS_URL = "http://127.0.0.1:5001/cerebellar-sdc/us-central1"


def load_test_pdf():
    """Load a test PDF from public/pdf directory"""
    pdf_dir = Path(__file__).parent.parent / "public" / "pdf"

    # Find first PDF file
    pdf_files = list(pdf_dir.glob("*.pdf"))
    if not pdf_files:
        print("❌ No PDF files found in public/pdf/")
        return None

    pdf_path = pdf_files[0]
    print(f"📄 Loading test PDF: {pdf_path.name}")

    with open(pdf_path, 'rb') as f:
        pdf_bytes = f.read()

    return base64.b64encode(pdf_bytes).decode('utf-8')


def test_extract_tables_enhanced():
    """Test enhanced table extraction"""
    print("\n" + "=" * 60)
    print("TEST: extract_tables_enhanced")
    print("=" * 60)

    pdf_base64 = load_test_pdf()
    if not pdf_base64:
        return False

    try:
        response = requests.post(
            f"{FUNCTIONS_URL}/extract_tables_enhanced",
            json={"pdf_base64": pdf_base64, "detect_captions": True},
            timeout=120
        )

        result = response.json()

        if result.get('success'):
            print(f"✅ Success! Found {result.get('table_count', 0)} tables")
            for i, table in enumerate(result.get('tables', [])[:3]):  # Show first 3
                print(f"\n  Table {i+1}:")
                print(f"    Page: {table.get('page')}")
                print(f"    Caption: {table.get('caption', 'No caption')[:50]}...")
                print(f"    Rows: {table.get('row_count')}, Columns: {table.get('column_count')}")
                if table.get('headers'):
                    print(f"    Headers: {table.get('headers')[:3]}...")
            return True
        else:
            print(f"❌ Error: {result.get('error')}")
            return False

    except requests.exceptions.ConnectionError:
        print("❌ Connection refused - is the Firebase emulator running?")
        print("   Run: firebase emulators:start")
        return False
    except Exception as e:
        print(f"❌ Exception: {e}")
        return False


def test_extract_figures_enhanced():
    """Test enhanced figure extraction"""
    print("\n" + "=" * 60)
    print("TEST: extract_figures_enhanced")
    print("=" * 60)

    pdf_base64 = load_test_pdf()
    if not pdf_base64:
        return False

    try:
        response = requests.post(
            f"{FUNCTIONS_URL}/extract_figures_enhanced",
            json={"pdf_base64": pdf_base64, "min_size": 50, "dpi": 150},
            timeout=180
        )

        result = response.json()

        if result.get('success'):
            print(f"✅ Success! Found {result.get('figure_count', 0)} figures")
            for i, figure in enumerate(result.get('figures', [])[:3]):  # Show first 3
                print(f"\n  Figure {i+1}:")
                print(f"    Page: {figure.get('page')}")
                print(f"    Caption: {figure.get('caption', 'No caption')[:50]}...")
                print(f"    Size: {figure.get('width')}x{figure.get('height')} px")
                print(f"    Format: {figure.get('format')}")
                print(f"    Has image data: {'Yes' if figure.get('image_base64') else 'No'}")
            return True
        else:
            print(f"❌ Error: {result.get('error')}")
            return False

    except requests.exceptions.ConnectionError:
        print("❌ Connection refused - is the Firebase emulator running?")
        return False
    except Exception as e:
        print(f"❌ Exception: {e}")
        return False


def test_capture_highlights():
    """Test highlight capture"""
    print("\n" + "=" * 60)
    print("TEST: capture_highlights")
    print("=" * 60)

    pdf_base64 = load_test_pdf()
    if not pdf_base64:
        return False

    # Create sample highlights
    highlights = [
        {
            "page": 1,
            "text": "Test highlight text",
            "x0": 100, "y0": 200, "x1": 300, "y1": 220,
            "label": "Test Label"
        }
    ]

    try:
        response = requests.post(
            f"{FUNCTIONS_URL}/capture_highlights",
            json={
                "pdf_base64": pdf_base64,
                "highlights": highlights,
                "dpi": 200,
                "padding": 15
            },
            timeout=180
        )

        result = response.json()

        if result.get('success'):
            screenshots = result.get('screenshots', [])
            print(f"✅ Success! Captured {len(screenshots)} screenshots")
            for shot in screenshots:
                print(f"\n  Screenshot:")
                print(f"    Label: {shot.get('label')}")
                print(f"    Page: {shot.get('page')}")
                print(f"    Size: {shot.get('width')}x{shot.get('height')} px")
                print(f"    Has image data: {'Yes' if shot.get('image_base64') else 'No'}")

            # Save first screenshot
            if screenshots and screenshots[0].get('image_base64'):
                os.makedirs('test_screenshots', exist_ok=True)
                with open('test_screenshots/highlight_capture.png', 'wb') as f:
                    f.write(base64.b64decode(screenshots[0]['image_base64']))
                print("\n  💾 Saved screenshot to test_screenshots/highlight_capture.png")

            return True
        else:
            print(f"❌ Error: {result.get('error')}")
            return False

    except requests.exceptions.ConnectionError:
        print("❌ Connection refused - is the Firebase emulator running?")
        return False
    except Exception as e:
        print(f"❌ Exception: {e}")
        return False


def test_generate_html_report():
    """Test HTML report generation"""
    print("\n" + "=" * 60)
    print("TEST: generate_html_report")
    print("=" * 60)

    pdf_base64 = load_test_pdf()
    if not pdf_base64:
        return False

    # Sample extraction data
    extraction_data = {
        "metadata": {
            "firstAuthor": "Kim et al.",
            "publicationYear": 2016,
            "hospitalCenter": "Test Hospital",
            "studyPeriod": "2010-2015"
        },
        "population": {
            "sampleSize": 100,
            "age": {
                "value": 62.5,
                "sourceText": "mean age was 62.5 years"
            }
        },
        "outcomes": {
            "mortality": {
                "value": 15.3,
                "sourceText": "mortality rate was 15.3%"
            }
        }
    }

    highlights = [
        {
            "page": 1,
            "text": "mortality rate was 15.3%",
            "x0": 100, "y0": 200, "x1": 300, "y1": 220,
            "label": "Mortality"
        }
    ]

    try:
        response = requests.post(
            f"{FUNCTIONS_URL}/generate_html_report",
            json={
                "pdf_base64": pdf_base64,
                "extraction_data": extraction_data,
                "highlights": highlights,
                "title": "Test Extraction Report",
                "dpi": 150,
                "padding": 20
            },
            timeout=300
        )

        result = response.json()

        if result.get('success'):
            print(f"✅ Success!")
            print(f"  Screenshots included: {result.get('screenshots')}")
            print(f"  Timestamp: {result.get('timestamp')}")

            # Save HTML report
            os.makedirs('test_screenshots', exist_ok=True)
            with open('test_screenshots/test_report.html', 'w', encoding='utf-8') as f:
                f.write(result.get('html', ''))
            print("\n  💾 Saved HTML report to test_screenshots/test_report.html")
            print("     Open in browser: open test_screenshots/test_report.html")

            return True
        else:
            print(f"❌ Error: {result.get('error')}")
            return False

    except requests.exceptions.ConnectionError:
        print("❌ Connection refused - is the Firebase emulator running?")
        return False
    except Exception as e:
        print(f"❌ Exception: {e}")
        return False


def run_all_tests():
    """Run all tests"""
    print("\n" + "=" * 70)
    print("  HTML Report Generation Tests")
    print("  Make sure Firebase emulators are running!")
    print("=" * 70)

    tests = [
        ("Table Extraction Enhanced", test_extract_tables_enhanced),
        ("Figure Extraction Enhanced", test_extract_figures_enhanced),
        ("Capture Highlights", test_capture_highlights),
        ("Generate HTML Report", test_generate_html_report),
    ]

    passed = 0
    failed = 0

    for name, test_func in tests:
        try:
            if test_func():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            failed += 1
            print(f"  ❌ {name} raised exception: {e}")

    print("\n" + "=" * 70)
    print(f"  Results: {passed} passed, {failed} failed")
    print("=" * 70)

    return failed == 0


if __name__ == '__main__':
    success = run_all_tests()
    exit(0 if success else 1)
