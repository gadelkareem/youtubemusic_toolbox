const ROW_SELECTOR =
  'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer';

const log = (...args) => console.log('[YTMT]', ...args);
log('content_script.js loaded');

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

// videoId/setVideoId are read off data-ytmt-* attributes that page_bridge.js
// (a MAIN-world content script) tags onto each row — the raw values live on
// row.data (Polymer's data binding), a plain JS property invisible from this
// isolated-world script even though it's the same DOM node. setVideoId is
// the one that's unique per playlist *entry*; a playlist can contain the
// same song (same videoId) more than once, so videoId alone is never enough
// to identify which row to act on.
function getRowInfo(row) {
  const strings = row.querySelectorAll('yt-formatted-string.complex-string');
  const dislikeBtn = findButton(row, 'Dislike');
  const likeBtn = findButton(row, 'Like');
  return {
    row,
    title: strings[0] ? strings[0].textContent.trim() : '(unknown title)',
    artist: strings[1] ? strings[1].textContent.trim() : '',
    videoId: row.getAttribute('data-ytmt-video-id'),
    setVideoId: row.getAttribute('data-ytmt-set-video-id'),
    liked: Boolean(likeBtn && likeBtn.getAttribute('aria-pressed') === 'true'),
    disliked: Boolean(dislikeBtn && dislikeBtn.getAttribute('aria-pressed') === 'true'),
  };
}

// Ground truth for how many tracks the playlist actually has, read from the
// page header (e.g. "159 tracks"), independent of how many rows are
// currently rendered. Used as a sanity check against the API-fetched count.
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
    if (raw) {
      log('innertube context found after', i * 100, 'ms:', JSON.parse(raw));
      return JSON.parse(raw);
    }
    await sleep(100);
  }
  log('ERROR: innertube context never appeared after 5s — is page_bridge.js running?');
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
  if (!sapisid) {
    log('ERROR: no SAPISID cookie found. document.cookie names:', document.cookie.split(';').map(c => c.trim().split('=')[0]));
    throw new Error('Not logged in to YouTube Music (no SAPISID cookie)');
  }
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

function buildInnertubeHeaders(ctx, auth) {
  return {
    'Content-Type': 'application/json',
    Authorization: auth,
    'X-Goog-AuthUser': ctx.authuser,
    'X-Goog-Visitor-Id': ctx.visitorData,
    'X-Origin': 'https://music.youtube.com',
    'X-Youtube-Client-Name': '67',
    'X-Youtube-Client-Version': ctx.clientVersion,
  };
}

function buildInnertubeContext(ctx) {
  return {
    client: {
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      hl: 'en',
      gl: 'US',
    },
  };
}

// A stalled fetch() with no timeout can hang a whole batch operation
// forever — observed directly in testing (progress stuck for minutes on
// one track, never erroring, never continuing). Every internal API call
// goes through this wrapper for that reason.
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: abortController.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Calls YouTube Music's own internal playlist-edit API directly — the same
// request its UI sends for actions like "Remove from playlist" or
// drag-to-reorder. An earlier version drove the real UI (clicking menus /
// simulating drag), which was unreliable: row menus only open on genuine
// mouse :hover, a browser-engine state no content script can fake.
async function callEditPlaylist(actions) {
  const ctx = await getInnertubeContext();
  const auth = await getAuthHeader();
  const playlistId = getPlaylistId();
  log('calling edit_playlist', { actions, playlistId, authuser: ctx.authuser });

  const response = await fetchWithTimeout(
    'https://music.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false',
    {
      method: 'POST',
      headers: buildInnertubeHeaders(ctx, auth),
      body: JSON.stringify({
        context: buildInnertubeContext(ctx),
        actions,
        playlistId,
      }),
    }
  );

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch (e) {}
    log('ERROR: edit_playlist HTTP', response.status, bodySnippet);
    throw new Error(`HTTP ${response.status}${bodySnippet ? ': ' + bodySnippet : ''}`);
  }
  const data = await response.json();
  log('edit_playlist response status:', data.status);
  return data.status === 'STATUS_SUCCEEDED';
}

async function removeTrackViaApi(videoId, setVideoId) {
  return callEditPlaylist([
    { setVideoId, action: 'ACTION_REMOVE_VIDEO', removedVideoId: videoId },
  ]);
}

// Moves the track identified by setVideoId to be immediately before the
// track identified by beforeSetVideoId. This is the exact action YT Music's
// own drag-to-reorder sends (captured live from a real drag gesture).
async function moveTrackViaApi(setVideoId, beforeSetVideoId) {
  return callEditPlaylist([
    {
      setVideoId,
      action: 'ACTION_MOVE_VIDEO_BEFORE',
      movedSetVideoIdSuccessor: beforeSetVideoId,
    },
  ]);
}

// page_bridge.js publishes the continuation token sitting in the initially
// rendered page's DOM (see its comments for why), plus how many rows were
// rendered at that exact moment. Returns null if the whole playlist fit in
// the first render (nothing to continue).
async function getInitialContinuation() {
  for (let i = 0; i < 50; i++) {
    const raw = document.documentElement.getAttribute('data-ytmt-continuation-token');
    if (raw !== null) {
      const afterCount = parseInt(
        document.documentElement.getAttribute('data-ytmt-continuation-after-count') || '0',
        10
      );
      return raw ? { token: raw, afterCount } : null;
    }
    await sleep(100);
  }
  log('ERROR: continuation token never appeared after 5s — is page_bridge.js running?');
  return null;
}

function parseBrowseItem(item) {
  const r = item.musicResponsiveListItemRenderer;
  if (!r) return null;
  const flexCols = (r.flexColumns || []).map((c) => {
    const runs = c.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
    return runs ? runs.map((run) => run.text).join('') : '';
  });
  const endpoint =
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint;
  const likeStatus = r.menu?.menuRenderer?.topLevelButtons?.[0]?.likeButtonRenderer?.likeStatus;
  return {
    row: null,
    title: flexCols[0] || '(unknown title)',
    artist: flexCols[1] || '',
    videoId: endpoint?.videoId || null,
    setVideoId: endpoint?.playlistSetVideoId || null,
    liked: likeStatus === 'LIKE',
    disliked: likeStatus === 'DISLIKE',
  };
}

// Fetches every track from `token` onward via YouTube Music's own internal
// API, following each response's own continuation token until exhausted.
// This is what replaced scrolling: scrolling to trigger YT Music's lazy
// loading turned out to be unreliable for large playlists even in a fully
// visible/focused tab (confirmed directly — one run loaded 1833/1843
// tracks fine, an immediate retry on the same playlist stalled at exactly
// 100 and never progressed). Paging through the same data via fetch() has
// no such dependency on rendering or scroll events at all.
async function fetchRemainingViaApi(token) {
  const ctx = await getInnertubeContext();
  const items = [];
  let nextToken = token;
  let complete = false;

  while (nextToken) {
    const auth = await getAuthHeader(); // timestamp-bound, refresh every call
    const response = await fetchWithTimeout(
      'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false',
      {
        method: 'POST',
        headers: buildInnertubeHeaders(ctx, auth),
        body: JSON.stringify({
          context: buildInnertubeContext(ctx),
          continuation: nextToken,
        }),
      }
    );
    if (!response.ok) {
      log('ERROR: browse continuation HTTP', response.status);
      break;
    }
    const data = await response.json();
    const continuationItems =
      data.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems;
    if (!continuationItems) {
      log('ERROR: browse continuation response had no continuationItems');
      break;
    }

    nextToken = null;
    for (const item of continuationItems) {
      if (item.continuationItemRenderer) {
        nextToken = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
        continue;
      }
      const parsed = parseBrowseItem(item);
      if (parsed) items.push(parsed);
    }
    if (!nextToken) complete = true; // ran out of continuations naturally, not via an error
    await sleep(200 + Math.floor(Math.random() * 200));
  }

  return { items, complete };
}

// The full, true-order track list: the ~100 rows rendered in the DOM at
// page load, plus everything else fetched via the API continuation chain.
// Doesn't touch the DOM beyond what's already there — no scrolling.
//
// `incomplete` reflects whether the API pagination actually broke off due
// to an error, not whether the count matches the playlist header's stated
// total — those can legitimately disagree by a handful of tracks on very
// large playlists even when every continuation was fetched successfully
// (confirmed directly: a full, error-free fetch landed 10 tracks under a
// 1,667-track header, consistently, across a fresh reload).
async function getAllTrackItems() {
  const continuation = await getInitialContinuation();
  const domCount = continuation ? continuation.afterCount : getRows().length;
  const domItems = getRows().slice(0, domCount).map(getRowInfo);
  if (!continuation) return { items: domItems, incomplete: false };
  const { items: apiItems, complete } = await fetchRemainingViaApi(continuation.token);
  return { items: domItems.concat(apiItems), incomplete: !complete };
}

async function scan() {
  const { items, incomplete } = await getAllTrackItems();
  const disliked = items
    .filter((t) => t.disliked)
    .map(({ title, artist, videoId, setVideoId }) => ({ title, artist, videoId, setVideoId }));
  return {
    total: items.length,
    incomplete,
    expectedTotal: getExpectedTotal(),
    disliked,
  };
}

async function removeAll(onProgress) {
  const { items, incomplete } = await getAllTrackItems();
  const targets = items.filter((t) => t.disliked);
  const total = targets.length;
  log(
    'removeAll targets:', total,
    '— with videoId+setVideoId:', targets.filter(t => t.videoId && t.setVideoId).length,
    targets.slice(0, 3)
  );
  let removed = 0;
  let skipped = 0;
  let lastError = null;

  for (const track of targets) {
    if (!track.videoId || !track.setVideoId) {
      skipped++;
      lastError = 'Track had no videoId/setVideoId (unexpected data shape)';
      log('ERROR: skipping track with missing ids:', track.title, track);
      continue;
    }
    try {
      const ok = await removeTrackViaApi(track.videoId, track.setVideoId);
      if (ok) {
        removed++;
        // The API call bypasses YT Music's own UI, so a rendered row won't
        // disappear on its own — remove it here to keep the visible list
        // in sync with what actually happened. Tracks fetched via the API
        // (not rendered) have no row to remove.
        track.row?.remove();
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
    incomplete,
  };
}

async function scanLiked() {
  const { items, incomplete } = await getAllTrackItems();
  return {
    total: items.length,
    incomplete,
    expectedTotal: getExpectedTotal(),
    likedCount: items.filter((t) => t.liked).length,
  };
}

// Moves every liked (thumbs-up) track to the top, preserving each group's
// existing relative order (a stable partition: liked tracks first in their
// current order, then everything else in its current order) — not a full
// re-sort. Built as: take the desired final order, then walk it back to
// front, moving each track to be immediately before the one that should
// follow it. That's well-defined regardless of a track's current position,
// so processing back-to-front is safe: once desiredOrder[i+1] is correctly
// anchored, placing desiredOrder[i] right before it can't be undone by
// earlier (later-processed) moves.
//
// Adjacency (to skip pointless no-op API calls) is tracked via a plain
// array + setVideoId lookups, not the DOM: most of a large playlist is
// never rendered at all (fetched via the API instead), so there's no DOM
// adjacency to check for those tracks in the first place.
async function sortLikedToTop(onProgress) {
  const { items, incomplete } = await getAllTrackItems();

  const liked = items.filter((t) => t.liked);
  const notLiked = items.filter((t) => !t.liked);
  const desiredOrder = [...liked, ...notLiked];
  const currentOrder = items.slice();
  const positionOf = (setVideoId) => currentOrder.findIndex((t) => t.setVideoId === setVideoId);

  // Used as the progress-bar denominator. Not a hard bound -- the loop
  // below actually walks every adjacent pair in desiredOrder, most of
  // which are already-correct no-ops it skips without an API call -- but
  // showing that full pair count (which can be in the thousands) as "total
  // moves" is deeply misleading: it makes near-instant progress look
  // stuck. In practice at most one move is needed per liked track, so
  // that's a far more honest estimate of real work.
  const total = liked.length;
  let moved = 0;
  let skipped = 0;
  let lastError = null;

  for (let i = desiredOrder.length - 2; i >= 0; i--) {
    const track = desiredOrder[i];
    const anchor = desiredOrder[i + 1];

    if (!track.setVideoId || !anchor.setVideoId) {
      skipped++;
      lastError = 'Track had no setVideoId (unexpected data shape)';
      continue;
    }

    const trackPos = positionOf(track.setVideoId);
    const anchorPos = positionOf(anchor.setVideoId);
    if (trackPos + 1 === anchorPos) continue; // already adjacent -- no-op

    try {
      const ok = await moveTrackViaApi(track.setVideoId, anchor.setVideoId);
      if (ok) {
        moved++;
        const [movedItem] = currentOrder.splice(trackPos, 1);
        currentOrder.splice(positionOf(anchor.setVideoId), 0, movedItem);
        // Keep any rendered rows in sync with what actually happened, same
        // reasoning as removeAll(). Tracks fetched via the API (not
        // rendered) have no row to move.
        if (track.row && anchor.row) {
          anchor.row.parentNode.insertBefore(track.row, anchor.row);
        }
        onProgress(moved, total);
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
    moved,
    total,
    skipped,
    lastError,
    incomplete,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scan') {
    scan().then(sendResponse);
    return true;
  }
  if (message.type === 'scanLiked') {
    scanLiked().then(sendResponse);
    return true;
  }
  if (message.type === 'sortLikedToTop') {
    sortLikedToTop((moved, total) => {
      chrome.runtime.sendMessage({ type: 'sortProgress', moved, total }).catch(() => {});
    }).then(sendResponse);
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
