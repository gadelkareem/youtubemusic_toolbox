# youtubemusic_toolbox

A Chrome extension for YouTube Music playlists: removes thumbs-down tracks,
and moves liked tracks to the top — using your already-logged-in
`music.youtube.com` session, no header copying, no separate auth file, no
API keys to manage.

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

Or click **Sort liked tracks to top** to move every thumbs-up track to the
front of the playlist. Everything else (liked and not) keeps its existing
relative order — this is a stable partition, not a full re-sort.

Scoped to the playlist you have open — it doesn't touch other playlists.
Neither action is undoable, so review before confirming.

## How it works

Scanning reads track state straight off the page's own rendered rows (the
same Dislike/Like button state you see). Removal and reordering both call
YouTube Music's internal API directly — the same requests its own "Remove
from playlist" button and drag-to-reorder send — authenticated by
computing the same session-hash scheme (`SAPISIDHASH`) the site's own web
client uses, from the session cookie already in your tab. Nothing is
copied or stored anywhere; it's computed fresh per request.

An earlier version tried to drive the real UI (clicking each row's menu).
That broke because the row's action menu only opens on genuine mouse
`:hover`, a state no content script can fake — so it's now a direct API
call instead.
