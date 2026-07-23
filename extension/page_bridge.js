// Runs in the page's own MAIN world (see manifest.json), unlike
// content_script.js which runs isolated and can't see the page's ytcfg
// global. Publishes the few values needed to call YouTube Music's own
// internal API onto a DOM attribute the isolated content script can read.
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
