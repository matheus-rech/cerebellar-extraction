#!/usr/bin/env python3
"""
Debug test for Google Sign-In - captures console logs and screenshots
"""

from playwright.sync_api import sync_playwright
import time
import json

def test_signin_with_debug():
    """Test with full debugging - console logs, screenshots, and step-by-step validation"""

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
            print(f"  📝 Console: {log_entry}")

        page.on("console", log_console)

        # Capture errors
        errors = []
        def log_error(error):
            errors.append(str(error))
            print(f"  ❌ Error: {error}")

        page.on("pageerror", log_error)

        try:
            print("\n🌐 Step 1: Navigate to app...")
            cache_buster = int(time.time())
            page.goto(f'http://127.0.0.1:5002?_={cache_buster}', wait_until='networkidle')
            time.sleep(2)

            print("\n📸 Step 2: Take screenshot of initial page...")
            page.screenshot(path='debug_01_initial.png')

            print("\n🔍 Step 3: Check page content...")
            body_text = page.locator('body').text_content()
            print(f"  Page has {len(body_text)} characters")
            if "Sign in with Google" in body_text:
                print("  ✅ Found 'Sign in with Google' text")
            else:
                print("  ⚠️ 'Sign in with Google' not found")
                print(f"  Body preview: {body_text[:200]}...")

            print("\n🖱️ Step 4: Try to find and click Sign In button...")
            try:
                signin_button = page.wait_for_selector('button:has-text("Sign in with Google")', timeout=10000)
                print(f"  ✅ Found button: {signin_button.text_content()}")

                page.screenshot(path='debug_02_before_click.png')
                print("  📸 Screenshot saved: debug_02_before_click.png")

                print("\n🖱️ Step 5: Click Sign In button...")
                signin_button.click()
                time.sleep(2)

                page.screenshot(path='debug_03_after_click.png')
                print("  📸 Screenshot saved: debug_03_after_click.png")

                print("\n🪟 Step 6: Check for popup or new page...")
                contexts = browser.contexts
                pages = sum(len(c.pages) for c in contexts)
                print(f"  Total contexts: {len(contexts)}")
                print(f"  Total pages: {pages}")

                if pages > 1:
                    print("  ✅ New page/popup opened!")
                    for i, ctx in enumerate(contexts):
                        for j, pg in enumerate(ctx.pages):
                            print(f"    Page {i}-{j}: {pg.url}")
                else:
                    print("  ⚠️ No popup detected - checking current page URL...")
                    print(f"    Current URL: {page.url}")

                # Wait for any auth flow
                print("\n⏳ Step 7: Wait 15 seconds for manual auth interaction...")
                time.sleep(15)

                page.screenshot(path='debug_04_after_wait.png')
                print("  📸 Screenshot saved: debug_04_after_wait.png")

                print("\n🔍 Step 8: Check final state...")
                print(f"  URL: {page.url}")

                # Check if signed in
                try:
                    page.wait_for_selector('button:has-text("Sign Out")', timeout=3000)
                    print("  ✅ Successfully signed in! (Sign Out button visible)")
                except:
                    print("  ⚠️ Not signed in (no Sign Out button)")

                    # Check if still on login screen
                    if page.locator('button:has-text("Sign in with Google")').is_visible():
                        print("  ℹ️ Still on login screen")
                    else:
                        print("  ℹ️ Not on login screen - checking page content...")
                        content = page.content()
                        print(f"  Page HTML length: {len(content)} chars")
                        if "Cerebellar" in content:
                            print("  ✅ Page contains 'Cerebellar' - app is loaded")
                        else:
                            print("  ⚠️ Page doesn't contain expected content")

            except Exception as e:
                print(f"  ❌ Error finding button: {e}")
                page.screenshot(path='debug_error.png')

            # Final summary
            print("\n" + "="*70)
            print("SUMMARY")
            print("="*70)
            print(f"Console logs: {len(console_logs)}")
            print(f"Errors: {len(errors)}")
            print(f"Final URL: {page.url}")

            if console_logs:
                print("\nLast 10 console logs:")
                for log in console_logs[-10:]:
                    print(f"  {log}")

            if errors:
                print("\nErrors:")
                for err in errors:
                    print(f"  {err}")

            print("\n⏳ Keeping browser open for 10 seconds...")
            time.sleep(10)

        except Exception as e:
            print(f"\n💥 Test failed with exception: {e}")
            page.screenshot(path='debug_exception.png')
            raise
        finally:
            print("\n🏁 Closing browser...")
            browser.close()


if __name__ == '__main__':
    print("\n" + "="*70)
    print("  Google Sign-In Debug Test")
    print("="*70)
    test_signin_with_debug()
    print("\n✅ Debug test complete! Check debug_*.png screenshots")
