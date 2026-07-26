// Runs in the page's own MAIN world (see manifest.json), unlike
// content_script.js which runs isolated and can't see the page's ytcfg
// global. Publishes the few values needed to call YouTube Music's own
// internal API onto a DOM attribute the isolated content script can read.
const log = (...args) => console.log('[YTMT bridge]', ...args);

function publishInnertubeContext() {
  if (typeof ytcfg === 'undefined') return false;
  const ctx = {
    clientName: ytcfg.get('INNERTUBE_CLIENT_NAME'),
    clientVersion: ytcfg.get('INNERTUBE_CLIENT_VERSION'),
    authuser: String(ytcfg.get('SESSION_INDEX') || '0'),
    visitorData: ytcfg.get('VISITOR_DATA'),
  };
  if (!ctx.clientVersion || !ctx.visitorData) return false;
  document.documentElement.setAttribute(
    'data-ytmt-innertube-context',
    JSON.stringify(ctx)
  );
  return true;
}

if (!publishInnertubeContext()) {
  const interval = setInterval(() => {
    if (publishInnertubeContext()) clearInterval(interval);
  }, 200);
}

// row.data (Polymer's data binding) is a plain JS property, not a real DOM
// attribute — it only exists on this MAIN-world wrapper of the element,
// not on the isolated-world content script's wrapper for the same node.
// Real DOM attributes are visible across both, so tag each row with one.
const ROW_SELECTOR =
  'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer';

function tagRow(row) {
  const item = row.data && row.data.playlistItemData;
  if (!item) return false;
  if (item.videoId) row.setAttribute('data-ytmt-video-id', item.videoId);
  if (item.playlistSetVideoId) {
    row.setAttribute('data-ytmt-set-video-id', item.playlistSetVideoId);
  }
  return Boolean(item.videoId && item.playlistSetVideoId);
}

function tagAllRows() {
  document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
    if (!row.hasAttribute('data-ytmt-set-video-id')) tagRow(row);
  });
}

// The rendered playlist only ever has ~100 rows in the DOM at once; loading
// the rest by scrolling turned out to be unreliable (YouTube Music's own
// continuation-loading sometimes just doesn't progress, even in a fully
// visible/focused tab — observed directly, no root cause found). But the
// *token* needed to fetch the next batch via the same internal API is
// already sitting in the DOM from page load, on the trailing continuation
// placeholder row — publish it once so the isolated content script can
// page through the rest of the playlist itself via fetch(), no scrolling
// or DOM rendering required at all.
let continuationPublished = false;
function publishInitialContinuation() {
  if (continuationPublished) return;
  const rows = document.querySelectorAll(ROW_SELECTOR);
  const contItem = document.querySelector(
    'ytmusic-playlist-shelf-renderer ytmusic-continuation-item-renderer'
  );
  if (contItem) {
    const token = contItem.data?.continuationEndpoint?.continuationCommand?.token;
    if (token) {
      // Record how many rows were rendered *at the moment this token was
      // captured* — the token continues from exactly that point. If the
      // content script reads it later after the DOM has grown further
      // (e.g. the user scrolled around before clicking Scan), it must
      // only use the first this-many DOM rows and fetch the rest via the
      // token, or tracks would be double-counted (DOM overlap) or
      // skipped (gap).
      document.documentElement.setAttribute('data-ytmt-continuation-token', token);
      document.documentElement.setAttribute('data-ytmt-continuation-after-count', String(rows.length));
      continuationPublished = true;
    }
    return;
  }
  // No continuation placeholder at all: the whole playlist fits in the
  // first render, nothing more to page through. Publish an empty string
  // (as opposed to the attribute being absent, which means "not known
  // yet") so the content script doesn't wait on something that isn't coming.
  if (rows.length > 0) {
    document.documentElement.setAttribute('data-ytmt-continuation-token', '');
    continuationPublished = true;
  }
}

// This script runs at document_start (see manifest), before document.body
// exists yet -- observing it directly throws. Wait for it first.
function startObserving() {
  tagAllRows();
  publishInitialContinuation();
  new MutationObserver(() => {
    tagAllRows();
    publishInitialContinuation();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });
  // row.data can populate slightly after the element itself is inserted, so
  // the mutation observer alone can miss it -- this catches stragglers.
  setInterval(() => {
    tagAllRows();
    publishInitialContinuation();
  }, 500);
}

if (document.body) {
  startObserving();
} else {
  document.addEventListener('DOMContentLoaded', startObserving, { once: true });
}
