"""
Loads the real unpacked extension in a real Chrome instance (via
--load-extension) and drives it against a real playlist, so content_script.js
and page_bridge.js run exactly as they do in production -- unlike testing via
injected JS in a page context, which only reaches the MAIN world and can't
see what an isolated-world content script actually experiences.

Usage: conda run -n youtubemusic_toolbox python test/e2e_test.py <playlist_url>

Auth: a fresh profile normally can't log in at all -- Google blocks sign-in
for automation-controlled browsers. The fix (found in ../docu-sweeper's
bots/browser.py, which already solved this for its own web bots) is the
playwright-stealth library, which patches far more automation fingerprints
than a single --disable-blink-features flag. Combined with a plain local
profile directory (never copied from a real profile -- Chrome disables all
extensions if it detects a profile was relocated) that gets logged into
once and reused, this avoids every blocker hit before: no live profile
touched, no "non-default data directory" CDP refusal, no disabled
extensions.
"""

import asyncio
import pathlib
import re
import sys

from playwright.async_api import async_playwright
from playwright_stealth import Stealth

ROOT = pathlib.Path(__file__).parent.parent
EXTENSION_PATH = str(ROOT / "extension")

# Plain local profile, never derived from a real one. Logged into once
# interactively; the session persists here for subsequent runs.
USER_DATA_DIR = str(ROOT / "test" / ".chrome-profile")


async def find_extension_id(context) -> str:
    page = await context.new_page()
    await page.goto("chrome://extensions")
    await page.wait_for_timeout(3000)

    items = page.locator("extensions-item")
    count = await items.count()
    print(f"  extensions-item count: {count}")
    for i in range(count):
        item = items.nth(i)
        item_id = await item.get_attribute("id")
        try:
            name_text = await item.locator("#name").inner_text()
        except Exception:
            name_text = ""
        print(f"  found extension: id={item_id} name={name_text!r}")
        if "Dislike Purger" in name_text:
            await page.close()
            return item_id

    manager_count = await page.locator("extensions-manager").count()
    toolbar_text = ""
    try:
        toolbar_text = await page.locator("extensions-toolbar").inner_text(timeout=2000)
    except Exception as e:
        toolbar_text = f"(error reading toolbar: {e})"
    print(f"  extensions-manager count: {manager_count}")
    print(f"  toolbar text: {toolbar_text!r}")
    await page.screenshot(path=str(pathlib.Path(__file__).parent / "debug_extensions_page.png"))
    print("  saved screenshot to test/debug_extensions_page.png")

    await page.close()
    raise RuntimeError(f"Could not find our extension among {count} extensions-item elements")


async def main():
    if len(sys.argv) < 2:
        print("Usage: python test/e2e_test.py <playlist_url>")
        sys.exit(1)
    playlist_url = sys.argv[1]

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            channel="chrome",
            headless=False,
            ignore_default_args=["--enable-automation"],
            args=[
                f"--disable-extensions-except={EXTENSION_PATH}",
                f"--load-extension={EXTENSION_PATH}",
                "--disable-blink-features=AutomationControlled",
                # Keep the window off-screen instead of stealing focus/mouse
                # on launch. (--start-minimized still flashes onscreen briefly.)
                "--window-position=-32000,-32000",
            ],
        )
        await Stealth().apply_stealth_async(context)

        yt_page = context.pages[0] if context.pages else await context.new_page()
        yt_page.on("console", lambda msg: print(f"[yt console] {msg.text}"))

        await yt_page.goto("https://music.youtube.com")
        await yt_page.wait_for_timeout(2000)

        signed_in = await yt_page.evaluate(
            "() => /(^|; )SAPISID=/.test(document.cookie)"
        )
        if not signed_in:
            print(
                "Not logged in. Please log in to YouTube Music in the opened "
                "browser window -- polling for login, up to 5 minutes..."
            )
            for _ in range(300):
                await asyncio.sleep(1)
                try:
                    signed_in = await yt_page.evaluate(
                        "() => /(^|; )SAPISID=/.test(document.cookie)"
                    )
                except Exception:
                    # Page mid-navigation (e.g. login redirect) -- transient, retry.
                    continue
                if signed_in:
                    print("Logged in, continuing.")
                    break
            else:
                print("Timed out waiting for login.")
                await context.close()
                return
        else:
            print("Already logged in via existing profile session.")

        print(f"Finding extension ID...")
        ext_id = await find_extension_id(context)
        print(f"Extension ID: {ext_id}")

        print(f"Navigating to playlist: {playlist_url}")
        await yt_page.goto(playlist_url)
        await yt_page.wait_for_load_state("networkidle")
        await yt_page.wait_for_timeout(2000)

        popup = await context.new_page()
        await popup.goto(f"chrome-extension://{ext_id}/popup.html")

        print("\n=== Running scan() via the real content script ===")
        scan_result = await popup.evaluate(
            """async () => {
                const tabs = await chrome.tabs.query({url: 'https://music.youtube.com/playlist*'});
                if (tabs.length === 0) return {error: 'no playlist tab found'};
                return await chrome.tabs.sendMessage(tabs[0].id, {type: 'scan'});
            }"""
        )
        print("scan() result:", scan_result)

        disliked = scan_result.get("disliked", [])
        if not disliked:
            print("No disliked tracks found. Nothing to remove. Exiting.")
            await context.close()
            return

        print(f"\n=== Running removeAll() for {len(disliked)} tracks ===")
        remove_result = await popup.evaluate(
            """async () => {
                const tabs = await chrome.tabs.query({url: 'https://music.youtube.com/playlist*'});
                return await chrome.tabs.sendMessage(tabs[0].id, {type: 'removeAll'});
            }"""
        )
        print("removeAll() result:", remove_result)

        print("\n=== Verifying with a fresh reload ===")
        await yt_page.reload()
        await yt_page.wait_for_load_state("networkidle")
        await yt_page.wait_for_timeout(2000)
        verify = await yt_page.evaluate(
            """(removedSetVideoIds) => {
                const rows = Array.from(document.querySelectorAll(
                    'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer'
                ));
                const stillPresent = removedSetVideoIds.filter(svid =>
                    rows.some(r => r.data?.playlistItemData?.playlistSetVideoId === svid)
                );
                return {checked: removedSetVideoIds.length, stillPresent};
            }""",
            [t["setVideoId"] for t in disliked if t.get("setVideoId")],
        )
        print("Post-reload verification:", verify)

        await context.close()


if __name__ == "__main__":
    asyncio.run(main())
