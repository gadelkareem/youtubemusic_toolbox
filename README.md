# youtubemusic_toolbox

Small tools for managing YouTube Music playlists via [ytmusicapi](https://github.com/sigma67/ytmusicapi)
— no browser extension, no untrusted third-party JS running against your Google session.

## Setup

```bash
conda env create -f environment.yml
conda activate youtubemusic_toolbox
```

### Authenticate (one-time)

1. Open `music.youtube.com` in Chrome, logged in.
2. DevTools (F12) → Network tab → reload the page → filter for `browse`.
3. Click any matching request → Headers tab → Request Headers section.
4. Copy everything from `accept: */*` to the end of that section.
5. Run:
   ```bash
   ytmusicapi browser
   ```
   Paste the copied headers when prompted. This writes `browser.json` to the
   project root.

**`browser.json` contains live session credentials for your Google account.
It is git-ignored — never commit it, especially since this repo is public.**
Credentials stay valid ~2 years unless you log out of that browser session.

## Scripts

### `remove_disliked_ytmusic.py`

Finds every track marked thumbs-down (`likeStatus == DISLIKE`) in a given
playlist and removes them.

```bash
# Dry run first — always. Lists what WOULD be removed, changes nothing.
python remove_disliked_ytmusic.py PLAYLIST_ID

# Actually remove them once the dry-run list looks right.
python remove_disliked_ytmusic.py PLAYLIST_ID --execute
```

`PLAYLIST_ID` is the `list=` value from the playlist's URL, e.g.
`https://music.youtube.com/playlist?list=PL1234567890` → `PL1234567890`.

Note: YouTube Music's special "Liked Music" auto-playlist (`LM`) has known
quirks with item removal via the API. This is intended for normal, owned
playlists.
