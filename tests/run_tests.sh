#!/bin/bash

# Run all integration tests for Cerebellar Extraction

echo "=============================================="
echo "  Cerebellar Extraction Test Suite"
echo "=============================================="
echo ""
echo "Prerequisites:"
echo "  1. Firebase emulators running: firebase emulators:start"
echo "  2. Python dependencies: pip install playwright requests"
echo "  3. Playwright browsers: playwright install chromium"
echo ""

# Create test screenshots directory
mkdir -p test_screenshots

# Check if Firebase emulator is running
if ! curl -s http://127.0.0.1:5002 > /dev/null; then
    echo "ERROR: Firebase hosting emulator not running on port 5002"
    echo "       Run: firebase emulators:start"
    exit 1
fi

echo "Testing Python Cloud Functions..."
python tests/test_html_report.py

echo ""
echo "Testing UI Integration..."
python tests/test_extraction_integration.py

echo ""
echo "=============================================="
echo "  All tests complete!"
echo "  Check test_screenshots/ for screenshots"
echo "=============================================="
