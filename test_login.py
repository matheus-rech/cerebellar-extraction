#!/usr/bin/env python3
"""
Playwright test for Google Sign-In authentication bug fix
Tests in headed mode (visible browser) to verify popup doesn't close after 3 seconds
"""

from playwright.sync_api import sync_playwright, expect
import time

def test_google_signin_headed():
    """Test Google Sign-In in headed mode to verify popup behavior"""

    with sync_playwright() as p:
        # Launch browser in headed mode (visible)
        browser = p.chromium.launch(
            headless=False,
            slow_mo=500  # Slow down by 500ms for visibility
        )
        context = browser.new_context()
        page = context.new_page()

        print("🌐 Navigating to http://127.0.0.1:5002...")
        # Add cache-busting timestamp to force fresh load
        import time as time_module
        cache_buster = int(time_module.time())
        page.goto(f'http://127.0.0.1:5002?_={cache_buster}', wait_until='networkidle')

        # Wait for React app to render
        print("⏳ Waiting for React app to render...")
        time.sleep(3)

        print("🔍 Looking for Sign In button...")

        # Check if user is already signed in
        try:
            page.wait_for_selector('button:has-text("Sign Out")', timeout=2000)
            print("✅ Already signed in!")
            browser.close()
            return
        except:
            print("👤 Not signed in, proceeding with login test...")

        # Find and click the Sign In button (correct text is "Sign in with Google" - lowercase "in")
        try:
            signin_button = page.wait_for_selector('button:has-text("Sign in with Google")', timeout=5000)
            print(f"✅ Found Sign In button: {signin_button.text_content()}")

            # Click the button
            print("🖱️ Clicking Sign In button...")
            signin_button.click()

            # Wait for popup to appear
            print("⏳ Waiting for Auth popup (this should NOT close after 3 seconds)...")
            time.sleep(1)

            # Check if popup context exists
            popup = None
            start_time = time.time()
            timeout = 30  # 30 second timeout for manual interaction

            print(f"⏲️ Monitoring popup for {timeout} seconds...")
            print("   (If popup closes automatically after 3 seconds, the bug is NOT fixed)")

            while time.time() - start_time < timeout:
                contexts = browser.contexts
                if len(contexts) > 1:
                    # Found popup
                    popup = contexts[-1]
                    elapsed = time.time() - start_time
                    print(f"✅ Popup still open after {elapsed:.1f} seconds")

                    # Check if it's the Auth emulator page
                    if len(popup.pages) > 0:
                        popup_page = popup.pages[0]
                        popup_url = popup_page.url
                        print(f"   Popup URL: {popup_url}")

                        if "127.0.0.1:9099" in popup_url or "localhost:9099" in popup_url:
                            print("✅ SUCCESS: Auth emulator popup is open!")
                            print("   You can now manually complete the sign-in process")
                            print("   (Select/add a test account in the Auth emulator)")

                            # Wait for user to complete sign-in
                            print("\n⏳ Waiting for sign-in completion (max 20 seconds)...")
                            try:
                                page.wait_for_selector('button:has-text("Sign Out")', timeout=20000)
                                print("✅ SIGN-IN SUCCESSFUL!")

                                # Verify user info is displayed
                                time.sleep(1)
                                print("\n📸 Taking screenshot of signed-in state...")
                                page.screenshot(path='test_login_success.png')
                                print("   Screenshot saved: test_login_success.png")

                            except Exception as e:
                                print(f"⏰ Timeout waiting for sign-in completion: {e}")

                            break

                    time.sleep(1)
                else:
                    # Popup closed
                    elapsed = time.time() - start_time
                    if elapsed < 5:
                        print(f"❌ FAILURE: Popup closed after {elapsed:.1f} seconds!")
                        print("   This is the bug - popup should stay open")
                        page.screenshot(path='test_login_failure.png')
                        print("   Screenshot saved: test_login_failure.png")
                        break
                    time.sleep(0.5)

            # Keep browser open for manual inspection
            print("\n🔍 Keeping browser open for 10 seconds for manual inspection...")
            time.sleep(10)

        except Exception as e:
            print(f"❌ Error during test: {e}")
            page.screenshot(path='test_login_error.png')
            print("   Screenshot saved: test_login_error.png")
            raise

        finally:
            print("\n🏁 Test complete. Closing browser...")
            browser.close()


if __name__ == '__main__':
    print("\n" + "="*70)
    print("  Google Sign-In Authentication Test (Headed Mode)")
    print("="*70 + "\n")
    print("This test will:")
    print("  1. Open a visible browser window")
    print("  2. Navigate to http://127.0.0.1:5002")
    print("  3. Click 'Sign In with Google'")
    print("  4. Verify the Auth popup stays open (doesn't close after 3s)")
    print("  5. Wait for you to complete sign-in manually")
    print("\n" + "="*70 + "\n")

    test_google_signin_headed()

    print("\n✅ Test script finished!")
