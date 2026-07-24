const ROW_SELECTOR =
  'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRows() {
  return Array.from(document.querySelectorAll(ROW_SELECTOR));
}

function findButton(row, ariaLabel) {
  return Array.from(
    row.querySelectorAll('button, tp-yt-paper-icon-button, yt-icon-button')
  ).find((b) => (b.getAttribute('aria-label') || '') === ariaLabel);
}

// videoId/setVideoId come straight off the row's own Polymer data object —
// the same identifiers YouTube Music's own UI uses to build its remove
// request. setVideoId is the one that's unique per playlist *entry*; a
// playlist can contain the same song (same videoId) more than once, so
// videoId alone is never enough to identify which row to act on.
function getRowInfo(row) {
  const strings = row.querySelectorAll('yt-formatted-string.complex-string');
  const item = row.data && row.data.playlistItemData;
  return {
    title: strings[0] ? strings[0].textContent.trim() : '(unknown title)',
    artist: strings[1] ? strings[1].textContent.trim() : '',
    videoId: item ? item.videoId : null,
    setVideoId: item ? item.playlistSetVideoId : null,
  };
}

function getDislikedRows() {
  return getRows().filter((row) => {
    const btn = findButton(row, 'Dislike');
    return btn && btn.getAttribute('aria-pressed') === 'true';
  });
}

// Playlists lazy-load rows as you scroll. Repeatedly scroll the last known
// row into view and wait for the row count to stop growing. Needs the tab
// to actually be visible/focused — YT Music's loader appears to stall in a
// backgrounded tab.
async function loadAllRows() {
  let previousCount = -1;
  let stableIterations = 0;
  for (let i = 0; i < 600; i++) {
    const rows = getRows();
    if (rows.length === 0) break;
    rows[rows.length - 1].scrollIntoView({ block: 'end' });
    await sleep(400);
    const newCount = getRows().length;
    if (newCount === previousCount) {
      stableIterations++;
      if (stableIterations >= 4) break;
    } else {
      stableIterations = 0;
    }
    previousCount = newCount;
  }
}

// Ground truth for how many tracks the playlist actually has, read from the
// page header (e.g. "159 tracks"), independent of how many rows are
// currently rendered. Used to detect an incomplete load.
function getExpectedTotal() {
  const header = document.querySelector(
    'ytmusic-responsive-header-renderer, ytmusic-detail-header-renderer'
  );
  if (!header) return null;
  const text = Array.from(header.querySelectorAll('yt-formatted-string, span'))
    .map((e) => e.textContent.trim())
    .find((t) => /\btracks?\b/i.test(t) && /\d/.test(t));
  if (!text) return null;
  const match = text.match(/([\d,]+)\s+tracks?/i);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
}

function getPlaylistId() {
  const match = location.search.match(/[?&]list=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// page_bridge.js (a MAIN-world content script) publishes these; this script
// runs isolated and has no direct access to the page's own ytcfg global.
async function getInnertubeContext() {
  for (let i = 0; i < 50; i++) {
    const raw = document.documentElement.getAttribute(
      'data-ytmt-innertube-context'
    );
    if (raw) return JSON.parse(raw);
    await sleep(100);
  }
  throw new Error('Could not read YouTube Music client context');
}

// Same SAPISIDHASH scheme ytmusicapi's browser-auth mode uses, computed
// fresh per request (it's timestamp-bound) from the session cookie already
// in this tab — no header copy-paste needed.
async function getAuthHeader() {
  const sapisid = document.cookie
    .split('; ')
    .find((c) => c.startsWith('SAPISID='))
    ?.split('=')[1];
  if (!sapisid) throw new Error('Not logged in to YouTube Music (no SAPISID cookie)');
  const origin = 'https://music.youtube.com';
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${timestamp} ${sapisid} ${origin}`)
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

// Removes one playlist entry via YouTube Music's own internal API — the
// same request its "Remove from playlist" button sends. This replaced an
// earlier approach that drove the real UI (clicking the row's menu): that
// row action menu only opens on genuine mouse :hover, a browser-engine
// state no content script can fake, so clicks on it were unreliable.
async function removeTrackViaApi(videoId, setVideoId) {
  const ctx = await getInnertubeContext();
  const auth = await getAuthHeader();
  const playlistId = getPlaylistId();

  const response = await fetch(
    'https://music.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'X-Goog-AuthUser': ctx.authuser,
        'X-Goog-Visitor-Id': ctx.visitorData,
        'X-Origin': 'https://music.youtube.com',
        'X-Youtube-Client-Name': '67',
        'X-Youtube-Client-Version': ctx.clientVersion,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: ctx.clientName,
            clientVersion: ctx.clientVersion,
            hl: 'en',
            gl: 'US',
          },
        },
        actions: [
          {
            setVideoId,
            action: 'ACTION_REMOVE_VIDEO',
            removedVideoId: videoId,
          },
        ],
        playlistId,
      }),
    }
  );

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch (e) {}
    throw new Error(`HTTP ${response.status}${bodySnippet ? ': ' + bodySnippet : ''}`);
  }
  const data = await response.json();
  return data.status === 'STATUS_SUCCEEDED';
}

async function scan() {
  await loadAllRows();
  const total = getRows().length;
  const expectedTotal = getExpectedTotal();
  const disliked = getDislikedRows().map(getRowInfo);
  return {
    total,
    incomplete: expectedTotal !== null && total < expectedTotal,
    expectedTotal,
    disliked,
  };
}

async function removeAll(onProgress) {
  await loadAllRows();
  const expectedTotal = getExpectedTotal();
  const loadedTotal = getRows().length;
  const targets = getDislikedRows().map((row) => ({ row, ...getRowInfo(row) }));
  const total = targets.length;
  let removed = 0;
  let skipped = 0;
  let lastError = null;

  for (const track of targets) {
    if (!track.videoId || !track.setVideoId) {
      skipped++;
      lastError = 'Row had no videoId/setVideoId (unexpected DOM shape)';
      continue;
    }
    try {
      const ok = await removeTrackViaApi(track.videoId, track.setVideoId);
      if (ok) {
        removed++;
        // The API call bypasses YT Music's own UI, so the row won't
        // disappear on its own — remove it here to keep the visible list
        // in sync with what actually happened.
        track.row.remove();
        onProgress(removed, total);
      } else {
        skipped++;
        lastError = 'API responded but status was not STATUS_SUCCEEDED';
      }
    } catch (e) {
      skipped++;
      lastError = e && e.message ? e.message : String(e);
    }
    await sleep(300 + Math.floor(Math.random() * 300));
  }

  return {
    removed,
    total,
    skipped,
    lastError,
    incomplete: expectedTotal !== null && loadedTotal < expectedTotal,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scan') {
    scan().then(sendResponse);
    return true;
  }
  if (message.type === 'removeAll') {
    removeAll((removed, total) => {
      chrome.runtime.sendMessage({ type: 'progress', removed, total }).catch(() => {});
    }).then(sendResponse);
    return true;
  }
  return undefined;
});
