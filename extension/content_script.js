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

function getDislikedRows(skipSet) {
  return getRows().filter((row) => {
    if (skipSet && skipSet.has(row)) return false;
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

// A bare el.click() unreliably triggers YouTube Music's Material Design
// buttons/menu items — observed in testing to sometimes silently do
// nothing. Dispatching a full pointer/mouse sequence (as a real click
// produces) plus a trailing click() is more reliable.
function robustClick(el) {
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
    button: 0,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

// Returns true if a track was confirmed removed, 'skip' if this row
// couldn't be removed this run (tracked only in skipSet, a plain Set of row
// elements local to this removeAll() call — never written to the DOM, so
// a failed row still shows up normally on the next Scan), or false if
// there was nothing left to remove.
async function removeOneDislikedRow(skipSet) {
  const rows = getDislikedRows(skipSet);
  if (rows.length === 0) return false;
  const row = rows[0];

  const menuBtn = findButton(row, 'Action menu');
  if (!menuBtn) {
    skipSet.add(row);
    return 'skip';
  }

  robustClick(menuBtn);
  let opened = await waitFor(
    () => document.querySelector('tp-yt-iron-dropdown[opened]'),
    3000
  );
  if (!opened) {
    // The menu is occasionally slow to open — one retry before giving up.
    robustClick(menuBtn);
    opened = await waitFor(
      () => document.querySelector('tp-yt-iron-dropdown[opened]'),
      3000
    );
  }
  if (!opened) {
    skipSet.add(row);
    return 'skip';
  }

  const dropdown = document.querySelector('tp-yt-iron-dropdown[opened]');
  const removeItem = Array.from(
    dropdown.querySelectorAll('ytmusic-menu-service-item-renderer')
  ).find((el) => el.textContent.trim() === 'Remove from playlist');

  if (!removeItem) {
    closeAnyOpenMenu();
    skipSet.add(row);
    return 'skip';
  }

  robustClick(removeItem);
  const removed = await waitFor(() => !document.body.contains(row), 4000);
  if (!removed) {
    closeAnyOpenMenu();
    skipSet.add(row);
    return 'skip';
  }
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
  const skipSet = new Set();
  const total = getDislikedRows().length;
  const loadedTotal = getRows().length;
  let removed = 0;
  let skipped = 0;

  while (true) {
    const remaining = getDislikedRows(skipSet).length;
    if (remaining === 0) break;

    const result = await removeOneDislikedRow(skipSet);
    if (result === true) {
      removed++;
      onProgress(removed, total);
    } else if (result === 'skip') {
      skipped++;
    } else {
      break;
    }

    await sleep(400 + Math.floor(Math.random() * 400));
  }

  return {
    removed,
    total,
    skipped,
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
