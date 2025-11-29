#!/usr/bin/env python3
"""
Test AI extraction functionality to diagnose issues
"""

from playwright.sync_api import sync_playwright
import time

def test_ai_extraction():
    """Test AI extraction with console logging"""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            slow_mo=500
        )
        context = browser.new_context()
        page = context.new_page()

        # Capture console messages
        console_logs = []
        def log_console(msg):
            log_entry = f"[{msg.type}] {msg.text}"
            console_logs.append(log_entry)
            print(f"  📝 {log_entry}")

        page.on("console", log_console)

        # Capture errors
        errors = []
        def log_error(error):
            errors.append(str(error))
            print(f"  ❌ {error}")

        page.on("pageerror", log_error)

        try:
            print("\n🌐 Navigating to app...")
            cache_buster = int(time.time())
            page.goto(f'http://127.0.0.1:5002?_={cache_buster}', wait_until='networkidle')
            time.sleep(3)

            print("\n📸 Taking initial screenshot...")
            page.screenshot(path='ai_test_01_initial.png')

            # Check if signed in
            try:
                page.wait_for_selector('button:has-text("Sign Out")', timeout=3000)
                print("✅ Already signed in")
            except:
                print("⚠️ Not signed in - trying to sign in first...")
                try:
                    signin_button = page.locator('button:has-text("Sign in with Google")').first
                    if signin_button.is_visible():
                        print("  Clicking Sign In button...")
                        signin_button.click()
                        time.sleep(10)  # Wait for manual sign-in
                        page.screenshot(path='ai_test_02_after_signin.png')
                except Exception as e:
                    print(f"  Sign in failed: {e}")

            # Look for AI extraction UI elements
            print("\n🔍 Looking for AI extraction features...")

            # Check for AI fill button
            try:
                ai_buttons = page.locator('button:has-text("AI Fill")').all()
                print(f"  Found {len(ai_buttons)} 'AI Fill' buttons")

                if len(ai_buttons) > 0:
                    print(f"  ✅ AI Fill buttons found!")
                    # Try clicking the first one
                    print("  🖱️ Clicking first AI Fill button...")
                    ai_buttons[0].click()
                    time.sleep(2)
                    page.screenshot(path='ai_test_03_after_ai_click.png')
                else:
                    print("  ⚠️ No AI Fill buttons found")
            except Exception as e:
                print(f"  ❌ Error checking AI buttons: {e}")

            # Check for Gemini API key
            print("\n🔑 Checking for API key...")
            api_key_check = page.evaluate("""
                () => {
                    const apiKey = typeof apiKey !== 'undefined' ? apiKey : 'NOT_FOUND';
                    return {
                        apiKey: apiKey ? apiKey.substring(0, 10) + '...' : 'undefined',
                        hasGemini: typeof genAI !== 'undefined'
                    };
                }
            """)
            print(f"  API Key: {api_key_check['apiKey']}")
            print(f"  Gemini SDK loaded: {api_key_check['hasGemini']}")

            # Look for any error messages in the UI
            print("\n🔍 Checking for error messages in UI...")
            try:
                error_elements = page.locator('[class*="error"], [class*="toast"]').all()
                for elem in error_elements:
                    if elem.is_visible():
                        text = elem.text_content()
                        if text and text.strip():
                            print(f"  Found UI message: {text}")
            except:
                pass

            print("\n📊 Final state:")
            print(f"  Console logs: {len(console_logs)}")
            print(f"  Errors: {len(errors)}")

            if console_logs:
                print("\n  Last 10 console logs:")
                for log in console_logs[-10:]:
                    print(f"    {log}")

            if errors:
                print("\n  JavaScript Errors:")
                for err in errors:
                    print(f"    {err}")

            print("\n⏳ Keeping browser open for 15 seconds for inspection...")
            time.sleep(15)

        except Exception as e:
            print(f"\n💥 Test failed: {e}")
            page.screenshot(path='ai_test_error.png')
            raise
        finally:
            print("\n🏁 Closing browser...")
            browser.close()


if __name__ == '__main__':
    print("\n" + "="*70)
    print("  AI Extraction Debug Test")
    print("="*70)
    test_ai_extraction()
    print("\n✅ Test complete! Check ai_test_*.png screenshots")
