#!/usr/bin/env python3
"""Quick test to capture console errors when loading a PDF"""

import os
import time
from playwright.sync_api import sync_playwright

TEST_PDF = os.path.expanduser("~/Downloads/Kim-2016.pdf")
APP_URL = "http://127.0.0.1:5002"

def test_with_console():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=300)
        page = browser.new_page()

        # Capture console messages
        console_messages = []
        def handle_console(msg):
            console_messages.append(f"[{msg.type}] {msg.text}")
            if msg.type == "error":
                print(f"❌ CONSOLE ERROR: {msg.text}")

        page.on("console", handle_console)

        # Capture page errors
        def handle_error(error):
            print(f"💥 PAGE ERROR: {error}")

        page.on("pageerror", handle_error)

        print("Loading app...")
        page.goto(APP_URL)
        time.sleep(3)

        print("Looking for file input...")
        file_input = page.locator("input[type='file']").first

        print(f"Uploading PDF: {TEST_PDF}")
        try:
            file_input.set_input_files(TEST_PDF)
            print("File input set, waiting for processing...")
            time.sleep(10)
        except Exception as e:
            print(f"Error during upload: {e}")

        print("\n--- Console Messages ---")
        for msg in console_messages[-20:]:
            print(msg)

        print("\nBrowser open for inspection (30s)...")
        time.sleep(30)

        browser.close()

if __name__ == "__main__":
    test_with_console()
