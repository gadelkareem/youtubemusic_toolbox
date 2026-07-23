const ROW_SELECTOR =
  'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function getRows() {
  return Array.from(document.querySelectorAll(ROW_SELECTOR));
}

function findButton(row, ariaLabel) {
  return Array.from(
    row.querySelectorAll('button, tp-yt-paper-icon-button, yt-icon-button')
  ).find((b) => (b.getAttribute('aria-label') || '') === ariaLabel);
}

function getRowInfo(row) {
  const strings = row.querySelectorAll('yt-formatted-string.complex-string');
  return {
    title: strings[0] ? strings[0].textContent.trim() : '(unknown title)',
    artist: strings[1] ? strings[1].textContent.trim() : '',
  };
}

function getDislikedRows() {
  return getRows().filter((row) => {
    if (row.hasAttribute('data-purge-skip')) return false;
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

function closeAnyOpenMenu() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
}

// Returns true if a track was removed, 'skip' if this row couldn't be
// removed (and has been marked so it isn't retried), or false if there
// was nothing to remove.
async function removeOneDislikedRow() {
  const rows = getDislikedRows();
  if (rows.length === 0) return false;
  const row = rows[0];

  const menuBtn = findButton(row, 'Action menu');
  if (!menuBtn) {
    row.setAttribute('data-purge-skip', 'true');
    return 'skip';
  }

  menuBtn.click();
  const opened = await waitFor(
    () => document.querySelector('tp-yt-iron-dropdown[opened]'),
    4000
  );
  if (!opened) {
    row.setAttribute('data-purge-skip', 'true');
    return 'skip';
  }

  const dropdown = document.querySelector('tp-yt-iron-dropdown[opened]');
  const removeItem = Array.from(
    dropdown.querySelectorAll('ytmusic-menu-service-item-renderer')
  ).find((el) => el.textContent.trim() === 'Remove from playlist');

  if (!removeItem) {
    closeAnyOpenMenu();
    row.setAttribute('data-purge-skip', 'true');
    return 'skip';
  }

  removeItem.click();
  await waitFor(() => !document.body.contains(row), 4000);
  return true;
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
  const total = getDislikedRows().length;
  const loadedTotal = getRows().length;
  let removed = 0;

  while (true) {
    const remaining = getDislikedRows().length;
    if (remaining === 0) break;

    const result = await removeOneDislikedRow();
    if (result === true) {
      removed++;
      onProgress(removed, total);
    } else if (result !== 'skip') {
      break;
    }

    await sleep(400 + Math.floor(Math.random() * 400));
  }

  return {
    removed,
    total,
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
      chrome.runtime.sendMessage({ type: 'progress', removed, total });
    }).then(sendResponse);
    return true;
  }
  return undefined;
});
