#!/usr/bin/env python3
"""
Purge thumbs-downed tracks from a YouTube Music playlist.

Uses ytmusicapi (https://github.com/sigma67/ytmusicapi) — mature, actively
maintained, MIT-licensed. No random browser extension needed.

SETUP (one-time):
    1. pip install ytmusicapi
    2. Open music.youtube.com in Chrome, logged in.
    3. DevTools (F12) -> Network tab -> reload the page -> filter for
       "browse". Click any matching request -> Headers tab -> Request
       Headers section.
    4. Copy from "accept: */*" to the end of that section.
    5. In a terminal: ytmusicapi browser
       Paste the copied headers when prompted. This writes browser.json
       to the current directory. These credentials stay valid ~2 years
       unless you log out of that browser session.

USAGE:
    # Dry run first — always. Lists what WOULD be removed, changes nothing.
    python remove_disliked_ytmusic.py PLAYLIST_ID

    # Actually remove them once you've reviewed the dry-run list.
    python remove_disliked_ytmusic.py PLAYLIST_ID --execute

PLAYLIST_ID is the "list=" value from the playlist's URL, e.g.
https://music.youtube.com/playlist?list=PL1234567890 -> PL1234567890
"""

import argparse
import sys
import time

from ytmusicapi import YTMusic

AUTH_FILE = "browser.json"  # created by `ytmusicapi browser`, see docstring
BATCH_SIZE = 50             # remove in chunks to avoid one giant request
BATCH_DELAY_SECONDS = 1.5   # brief pause between batches


def get_disliked_tracks(yt: YTMusic, playlist_id: str):
    """Fetch the full playlist and return (all_tracks, disliked_tracks)."""
    # limit=None -> fetch every track, not just the first 100
    playlist = yt.get_playlist(playlist_id, limit=None)
    tracks = playlist.get("tracks", [])
    disliked = [t for t in tracks if t.get("likeStatus") == "DISLIKE"]
    return tracks, disliked


def print_track_list(tracks):
    for t in tracks:
        artists = ", ".join(a["name"] for a in t.get("artists") or [])
        print(f"  - {t.get('title')} — {artists}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("playlist_id", help="Playlist ID from the URL")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually remove the tracks (default is dry-run only)",
    )
    args = parser.parse_args()

    yt = YTMusic(AUTH_FILE)

    tracks, disliked = get_disliked_tracks(yt, args.playlist_id)
    print(f"Playlist has {len(tracks)} tracks total, {len(disliked)} marked DISLIKE.\n")

    if not disliked:
        print("Nothing to remove.")
        return 0

    print_track_list(disliked)

    if not args.execute:
        print("\nDry run only — nothing was removed.")
        print("Re-run with --execute once this list looks right.")
        return 0

    # remove_playlist_items needs each track's setVideoId, which get_playlist()
    # provides automatically for playlists you own.
    removed = 0
    for i in range(0, len(disliked), BATCH_SIZE):
        batch = disliked[i : i + BATCH_SIZE]
        result = yt.remove_playlist_items(args.playlist_id, batch)
        removed += len(batch)
        print(f"Removed batch {i // BATCH_SIZE + 1}: {len(batch)} tracks (response: {result})")
        if i + BATCH_SIZE < len(disliked):
            time.sleep(BATCH_DELAY_SECONDS)

    print(f"\nDone. Removed {removed}/{len(disliked)} disliked tracks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
