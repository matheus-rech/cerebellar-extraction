#!/usr/bin/env python3
"""
Test script for PDF extraction functions with screenshot capture and HTML reporting.
Demonstrates the complete workflow from PDF to HTML report with highlighted evidence.
"""

import base64
import json
import sys
from pathlib import Path

def load_pdf_as_base64(pdf_path: str) -> str:
    """Load PDF file and encode as base64"""
    with open(pdf_path, 'rb') as f:
        pdf_bytes = f.read()
    return base64.b64encode(pdf_bytes).decode('utf-8')


def test_extract_for_llm(pdf_base64: str):
    """Test pymupdf4llm extraction for LLM-ready Markdown"""
    print("\n" + "="*60)
    print("TEST 1: Extract for LLM (pymupdf4llm)")
    print("="*60)

    # Simulate the request
    from main import extract_for_llm
    from unittest.mock import Mock

    req = Mock()
    req.get_json.return_value = {
        'pdf_base64': pdf_base64,
        'page_chunks': True,
        'embed_images': False
    }

    response = extract_for_llm(req)
    result = json.loads(response.response[0].decode('utf-8'))

    if result.get('success'):
        print(f"✓ Success! Extracted {result['page_count']} pages")
        print(f"✓ Generated {len(result.get('chunks', []))} chunks")
        if result.get('chunks'):
            first_chunk = result['chunks'][0]
            print(f"\nFirst chunk preview:")
            print(f"  Page: {first_chunk['page']}")
            print(f"  Text length: {len(first_chunk['text'])} chars")
            print(f"  Tables: {len(first_chunk.get('tables', []))}")
            print(f"  Images: {first_chunk['images']}")
    else:
        print(f"✗ Error: {result.get('error')}")

    return result


def test_extract_tables(pdf_base64: str):
    """Test table extraction with pdfplumber"""
    print("\n" + "="*60)
    print("TEST 2: Extract Tables (pdfplumber)")
    print("="*60)

    from main import extract_tables
    from unittest.mock import Mock

    req = Mock()
    req.get_json.return_value = {'pdf_base64': pdf_base64}

    response = extract_tables(req)
    result = json.loads(response.response[0].decode('utf-8'))

    if result.get('success'):
        tables = result.get('tables', [])
        print(f"✓ Success! Found {len(tables)} tables")
        for i, table in enumerate(tables):
            print(f"\nTable {i+1}:")
            print(f"  Page: {table['page']}")
            print(f"  Headers: {table['headers']}")
            print(f"  Rows: {len(table['rows'])}")
    else:
        print(f"✗ Error: {result.get('error')}")

    return result


def test_extract_text_with_positions(pdf_base64: str):
    """Test text extraction with character positions"""
    print("\n" + "="*60)
    print("TEST 3: Extract Text with Positions")
    print("="*60)

    from main import extract_text_with_positions
    from unittest.mock import Mock

    req = Mock()
    req.get_json.return_value = {'pdf_base64': pdf_base64}

    response = extract_text_with_positions(req)
    result = json.loads(response.response[0].decode('utf-8'))

    if result.get('success'):
        positions = result.get('positions', [])
        print(f"✓ Success! Extracted {len(positions)} word positions")
        print(f"✓ Total text length: {len(result.get('text', ''))} chars")
        if positions:
            print(f"\nFirst 5 words:")
            for pos in positions[:5]:
                print(f"  '{pos['text']}' at page {pos['page']} (x:{pos['x']:.1f}, y:{pos['y']:.1f})")
    else:
        print(f"✗ Error: {result.get('error')}")

    return result


def test_capture_highlights(pdf_base64: str, highlights_data: list):
    """Test screenshot capture with highlights"""
    print("\n" + "="*60)
    print("TEST 4: Capture Highlights")
    print("="*60)

    from main import capture_highlights
    from unittest.mock import Mock

    req = Mock()
    req.get_json.return_value = {
        'pdf_base64': pdf_base64,
        'highlights': highlights_data,
        'dpi': 200,
        'padding': 15
    }

    response = capture_highlights(req)
    result = json.loads(response.response[0].decode('utf-8'))

    if result.get('success'):
        screenshots = result.get('screenshots', [])
        print(f"✓ Success! Captured {len(screenshots)} screenshots")
        for i, shot in enumerate(screenshots):
            print(f"\nScreenshot {i+1}:")
            print(f"  Page: {shot['page']}")
            print(f"  Label: {shot['label']}")
            print(f"  Size: {shot['width']}x{shot['height']}px")
            print(f"  Text: \"{shot['text'][:50]}...\"")

            # Save screenshot to file
            output_path = f"screenshot_{i+1}_{shot['label'].replace(' ', '_')}.png"
            with open(output_path, 'wb') as f:
                f.write(base64.b64decode(shot['image_base64']))
            print(f"  Saved to: {output_path}")
    else:
        print(f"✗ Error: {result.get('error')}")

    return result


def test_generate_html_report(pdf_base64: str, extraction_data: dict, highlights_data: list):
    """Test HTML report generation"""
    print("\n" + "="*60)
    print("TEST 5: Generate HTML Report")
    print("="*60)

    from main import generate_html_report
    from unittest.mock import Mock

    req = Mock()
    req.get_json.return_value = {
        'pdf_base64': pdf_base64,
        'extraction_data': extraction_data,
        'highlights': highlights_data,
        'title': 'Cerebellar Stroke Study Extraction Report',
        'dpi': 150,
        'padding': 20
    }

    response = generate_html_report(req)
    result = json.loads(response.response[0].decode('utf-8'))

    if result.get('success'):
        print(f"✓ Success! Generated HTML report")
        print(f"✓ Included {result.get('screenshots', 0)} screenshots")
        print(f"✓ Generated at: {result.get('timestamp')}")

        # Save HTML to file
        html_path = "extraction_report.html"
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(result['html'])
        print(f"✓ Saved to: {html_path}")
        print(f"\nOpen the report in your browser:")
        print(f"  open {html_path}")
    else:
        print(f"✗ Error: {result.get('error')}")

    return result


def main():
    """Run all tests"""
    if len(sys.argv) < 2:
        print("Usage: python test_extraction.py <path_to_pdf>")
        print("\nExample:")
        print("  python test_extraction.py ../sample.pdf")
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not Path(pdf_path).exists():
        print(f"Error: PDF file not found: {pdf_path}")
        sys.exit(1)

    print(f"\nLoading PDF: {pdf_path}")
    pdf_base64 = load_pdf_as_base64(pdf_path)
    print(f"✓ Loaded {len(pdf_base64)} bytes (base64 encoded)")

    # Test 1: LLM extraction
    llm_result = test_extract_for_llm(pdf_base64)

    # Test 2: Table extraction
    table_result = test_extract_tables(pdf_base64)

    # Test 3: Position extraction
    position_result = test_extract_text_with_positions(pdf_base64)

    # Create sample highlights (you would normally extract these from position data)
    # For demonstration, we'll create mock highlights
    sample_highlights = [
        {
            "page": 1,
            "text": "mortality rate was 15.3%",
            "x0": 100,
            "y0": 200,
            "x1": 300,
            "y1": 220,
            "label": "Mortality Rate"
        },
        {
            "page": 1,
            "text": "mean age 62.5 years",
            "x0": 100,
            "y0": 250,
            "x1": 280,
            "y1": 270,
            "label": "Mean Age"
        }
    ]

    # Test 4: Screenshot capture
    highlight_result = test_capture_highlights(pdf_base64, sample_highlights)

    # Create sample extraction data (in the format of CerebellarSDCSchema)
    sample_extraction = {
        "metadata": {
            "firstAuthor": "Smith et al.",
            "publicationYear": 2023,
            "hospitalCenter": "Mayo Clinic",
            "studyPeriod": "2018-2022"
        },
        "population": {
            "sampleSize": 156,
            "age": {
                "value": {"mean": 62.5, "sd": 12.3},
                "sourceText": "mean age was 62.5 ± 12.3 years"
            },
            "gcs": {
                "value": {"mean": 11.2, "sd": 3.1},
                "sourceText": "median GCS score was 11.2 (SD 3.1)"
            }
        },
        "outcomes": {
            "mortality": {
                "value": 15.3,
                "sourceText": "Overall mortality rate was 15.3% (24/156 patients)"
            },
            "mRS_favorable": {
                "value": 68.5,
                "sourceText": "68.5% achieved favorable outcome (mRS 0-2)"
            }
        }
    }

    # Test 5: HTML report generation
    report_result = test_generate_html_report(pdf_base64, sample_extraction, sample_highlights)

    print("\n" + "="*60)
    print("ALL TESTS COMPLETED!")
    print("="*60)
    print("\n✓ Check your current directory for:")
    print("  - screenshot_*.png files")
    print("  - extraction_report.html")
    print("\nOpen the HTML report to see the full extraction with highlights!")


if __name__ == "__main__":
    main()
