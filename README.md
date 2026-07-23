# youtubemusic_toolbox

A Chrome extension that removes thumbs-downed tracks from a YouTube Music
playlist. It drives the actual `music.youtube.com` UI in your already-logged-in
tab — no header copying, no separate auth file, no API keys.

## Install

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder from this repo.

## Use

1. Open the playlist you want to clean up on `music.youtube.com`.
2. Click the extension's icon in the toolbar.
3. Click **Scan for disliked tracks** — this scrolls through the whole
   playlist (may take a bit for large ones) and lists every track marked
   thumbs-down.
4. Review the list, then click **Remove all N**. Keep the popup open until
   it reports "Done" — closing it mid-removal stops the live progress
   updates (the removal itself keeps running in the tab, but you'll lose
   the progress display).

Scoped to the playlist you have open — it doesn't touch other playlists.
Removal isn't undoable, so review the scanned list before confirming.

## How it works

The extension has no special API access — it clicks the same "Action
menu → Remove from playlist" control you'd click by hand, for every row
whose Dislike button is pressed. This means it only breaks if YouTube
Music's UI changes, not if Google's internal API does.
