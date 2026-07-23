const contentEl = document.getElementById('content');
const nameEl = document.getElementById('playlist-name');

let currentTabId = null;
let scanResult = null;

function render(build) {
  contentEl.innerHTML = '';
  build(contentEl);
}

function button(label, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function paragraph(text, className) {
  const p = document.createElement('p');
  p.textContent = text;
  if (className) p.className = className;
  return p;
}

function renderIdle() {
  render((el) => {
    el.appendChild(button('Scan for disliked tracks', onScanClick));
  });
}

function renderNotOnPlaylist() {
  nameEl.textContent = 'Not a YouTube Music playlist';
  render((el) => {
    el.appendChild(
      paragraph(
        'Open a playlist on music.youtube.com, then reopen this popup.',
        'muted'
      )
    );
  });
}

function renderConnectionError() {
  render((el) => {
    el.appendChild(
      paragraph(
        "Couldn't reach the page. Try reloading the YouTube Music tab and reopening this popup.",
        'muted'
      )
    );
    el.appendChild(button('Retry scan', onScanClick));
  });
}

function renderScanning() {
  render((el) => {
    el.appendChild(
      paragraph(
        'Scanning… loading the full playlist. This can take a while for large playlists.'
      )
    );
  });
}

function renderIncompleteWarning(el, result) {
  if (!result.incomplete) return;
  el.appendChild(
    paragraph(
      `Only loaded ${result.total}/${result.expectedTotal} tracks — the page may not have finished loading. Try scrolling to the bottom of the playlist yourself, then Scan again.`,
      'muted'
    )
  );
}

function renderScanned(result) {
  render((el) => {
    if (result.disliked.length === 0) {
      el.appendChild(
        paragraph(`Nothing to remove — 0 disliked out of ${result.total} tracks.`)
      );
      renderIncompleteWarning(el, result);
      el.appendChild(button('Scan again', onScanClick));
      return;
    }

    el.appendChild(
      paragraph(`Found ${result.disliked.length} disliked out of ${result.total} tracks:`)
    );
    renderIncompleteWarning(el, result);

    const list = document.createElement('ul');
    for (const track of result.disliked) {
      const li = document.createElement('li');
      li.textContent = track.artist
        ? `${track.title} — ${track.artist}`
        : track.title;
      list.appendChild(li);
    }
    el.appendChild(list);

    el.appendChild(button(`Remove all ${result.disliked.length}`, onRemoveAllClick));
    el.appendChild(paragraph('Keep this popup open until removal finishes.', 'muted'));
  });
}

function renderRemoving(removed, total) {
  render((el) => {
    el.appendChild(paragraph(`Removing… ${removed}/${total}`));
    el.appendChild(paragraph('Keep this popup open until removal finishes.', 'muted'));
  });
}

function renderDone(result) {
  render((el) => {
    el.appendChild(
      paragraph(`Done. Removed ${result.removed}/${result.total} disliked tracks.`)
    );
    if (result.incomplete) {
      el.appendChild(
        paragraph(
          'The playlist may not have fully loaded, so some disliked tracks further down could have been missed. Scroll to the bottom yourself and Scan again to check.',
          'muted'
        )
      );
    }
    el.appendChild(button('Scan again', onScanClick));
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function onScanClick() {
  renderScanning();
  try {
    scanResult = await chrome.tabs.sendMessage(currentTabId, { type: 'scan' });
    renderScanned(scanResult);
  } catch (err) {
    renderConnectionError();
  }
}

async function onRemoveAllClick() {
  const expectedTotal = scanResult.disliked.length;
  renderRemoving(0, expectedTotal);

  const progressListener = (message) => {
    if (message.type === 'progress') {
      renderRemoving(message.removed, message.total);
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const result = await chrome.tabs.sendMessage(currentTabId, {
      type: 'removeAll',
    });
    renderDone(result);
  } catch (err) {
    renderConnectionError();
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
  }
}

async function init() {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.startsWith('https://music.youtube.com/playlist')) {
    renderNotOnPlaylist();
    return;
  }
  currentTabId = tab.id;
  nameEl.textContent = tab.title || 'YouTube Music playlist';
  renderIdle();
}

init();
