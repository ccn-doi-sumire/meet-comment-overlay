// Forwards events from the Meet tab to the desktop overlay running on this PC.
// The overlay (overlay/mac-overlay.js or overlay/win-overlay.ps1) listens on 127.0.0.1 only.
const OVERLAY_PORT = 39393;
const BASE = `http://127.0.0.1:${OVERLAY_PORT}`;

async function call(kind, events) {
  const init =
    kind === 'events'
      ? { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(events || []) }
      : { method: 'GET', cache: 'no-store' };
  init.signal = AbortSignal.timeout(3000);
  const res = await fetch(BASE + (kind === 'events' ? '/event' : '/ping'), init);
  let body = {};
  try {
    body = await res.json();
  } catch (e) {
    // not JSON; the status code is enough
  }
  return { ok: res.ok, paused: !!body.paused };
}

// The same chat message is picked up from several sources: the data channel ('channel'), Meet's
// new-message notification and the chat panel. Each message flows once: a copy from a source
// that has not yet reported that message is dropped.
// Copies read from the page can come much later than the one from the data channel: Meet only
// draws while its tab is visible, and catches up when the user comes back to it. Messages from
// the data channel are therefore remembered for hours, the others for a few seconds.
const KEEP_MS = 10 * 1000;
const KEEP_CHANNEL_MS = 3 * 60 * 60 * 1000;
const recentComments = []; // { text, raw, at, keep, sources: Set }

// Self-diagnosis, for GET /diag on the overlay: which source saw a message after the first one,
// and - for a comment that the data channel did not deliver - where its text travelled (the
// Meet tab answers that, see explainText in capture.js). Only the first few are reported.
let copyReportsLeft = 20;
let explainsLeft = 3;

function askToExplain(entry, tabId) {
  if (explainsLeft <= 0 || tabId === undefined) return;
  setTimeout(() => {
    if (entry.sources.has('channel') || explainsLeft <= 0) return;
    explainsLeft--;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'meet-comment-overlay', kind: 'explain', text: entry.raw }, { frameId: 0 }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }, 4000);
}

// Notifications may cut long messages short ("…"), so a shortened copy counts as the same.
function sameMessage(a, b) {
  if (a === b) return true;
  const cut = (s) => s.replace(/(…|\.\.\.)$/, '').trim();
  const [x, y] = [cut(a), cut(b)];
  if (Math.min(x.length, y.length) < 8) return x === y;
  return x.startsWith(y) || y.startsWith(x);
}

/** The events without repeated comments, followed by diagnosis reports about the repeats. */
function dropDuplicates(events, tabId) {
  const now = Date.now();
  const reports = [];
  for (let i = recentComments.length - 1; i >= 0; i--) {
    if (now - recentComments[i].at > recentComments[i].keep) recentComments.splice(i, 1);
  }
  while (recentComments.length > 1000) recentComments.shift();
  const kept = (events || []).filter((e) => {
    if (!e || e.type !== 'comment') return true;
    const raw = String(e.text || '').slice(0, 200);
    // Spaces differ between sources (the page puts one around emoji images), so ignore them,
    // together with zero-width spaces and emoji variation selectors.
    const text = String(e.text || '').replace(/[\s\u200b\ufe0f]+/g, '');
    const source = e.source || 'unknown';
    const dup = recentComments.find((c) => !c.sources.has(source) && sameMessage(c.text, text));
    if (dup) {
      if (copyReportsLeft-- > 0) {
        reports.push({ type: 'diag', report: { reason: 'copy', text: raw.slice(0, 30), source, after: [...dup.sources], seconds: Math.round((now - dup.at) / 1000) } });
      }
      dup.sources.add(source);
      return false;
    }
    const entry = { text, raw, at: now, keep: source === 'channel' ? KEEP_CHANNEL_MS : KEEP_MS, sources: new Set([source]) };
    recentComments.push(entry);
    if (source !== 'channel') askToExplain(entry, tabId);
    return true;
  });
  return kept.concat(reports);
}

// Settings from the popup (chrome.storage.local). Kept in memory; reloaded when they change and
// when the service worker restarts.
const DEFAULTS = { size: 'normal', speed: 'normal', ngWords: [], paused: false };
const SIZES = { small: 0.75, normal: 1, large: 1.3, xlarge: 1.7 };
const SPEEDS = { slow: 9, normal: 6, fast: 4 }; // seconds to cross the screen
let settings = null;
let versionReported = false;

async function loadSettings() {
  if (!settings) settings = Object.assign({}, DEFAULTS, await chrome.storage.local.get(DEFAULTS));
  return settings;
}
chrome.storage.onChanged.addListener(() => {
  settings = null;
});

// Upper/lower case and full/half width are not distinguished.
const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase();

function applySettings(events, cfg) {
  const ng = (cfg.ngWords || []).map(normalize).filter(Boolean);
  const out = [];
  for (const e of events) {
    // Hidden with the button in Meet: nothing flows (diagnosis reports still pass).
    if (cfg.paused && e && (e.type === 'comment' || e.type === 'reaction')) continue;
    if (e && e.type === 'comment') {
      const text = normalize(e.text);
      if (ng.some((w) => text.includes(w))) continue;
      out.push(Object.assign({}, e, { fontScale: SIZES[cfg.size] || 1, seconds: SPEEDS[cfg.speed] || 6 }));
    } else {
      out.push(e);
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'meet-comment-overlay') return false;
  if (msg.kind === 'pause') {
    chrome.storage.local.set({ paused: !!msg.value });
    return false;
  }
  const events = msg.kind === 'events' ? dropDuplicates(msg.events, sender && sender.tab ? sender.tab.id : undefined) : null;
  if (events && !events.length) {
    sendResponse({ ok: true, deduplicated: true });
    return false;
  }
  loadSettings()
    .then((cfg) => {
      const toSend = events ? applySettings(events, cfg) : null;
      if (toSend && !toSend.length) return { ok: true, filtered: true };
      // Once: which version of the extension is running (for GET /diag on the overlay).
      const stamp = toSend && !versionReported ? [{ type: 'diag', report: { reason: 'extension', version: chrome.runtime.getManifest().version } }] : [];
      return call(msg.kind, toSend && toSend.concat(stamp)).then((res) => {
        if (stamp.length && res.ok) versionReported = true;
        return res;
      });
    })
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // respond asynchronously
});
