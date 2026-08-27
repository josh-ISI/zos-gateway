// z/OS Gateway - frontend logic.
//
// No backend of our own. Every call here goes to a relative /zosmf/* path,
// which the IHS reverse proxy in front of this console (see
// ../ARCHITECTURE.md) forwards to the real z/OSMF instance on :10443,
// rewriting Origin/Referer/CSRF headers along the way. The browser's own
// session cookie (LtpaToken2, set by login.html against
// /zosmf/services/authenticate) *is* the authentication for every request
// below - there is nothing server-side here holding a session.
//
// This replaces WEBADM.rexx + submit-job.ps1 + the exDeleteMember/
// exCopyWholePds/exAllocLike JCL-generation dance in the old TK5
// source/console.js entirely. z/OSMF's Files REST API does dataset
// allocate/read/write/copy/delete as single SAF-checked calls - no temp
// datasets, no IEBCOPY EXCLUDE, no hand-sized SPACE= guesses, no
// copy-out/verify/delete-original ordering to get wrong.

const $ = s => document.querySelector(s);

// ---- protected HLQs -------------------------------------------------------
// yourid has RACF SPECIAL on this system (see zos/ARCHITECTURE.md
// "Decisions"), so SAF gives zero safety net against a UI bug here the way
// it might for a more restricted userid. This list is a client-side
// guardrail only, not a real security boundary - it exists purely to stop
// this console from creating/editing/deleting things under system-critical
// HLQs by accident (see ISSUES.md's "Critical incident" note: a bug here
// once wiped SYS1.PROCLIB). Intentionally left empty at the maintainer's
// request, to allow dataset creation under any HLQ including SYS*.** ones
// (e.g. SYS3.CAI.OPSMVS.* product datasets that legitimately need managing
// from here) - re-add entries like 'SYS1' below if you want the guardrail
// back for specific HLQs.
const PROTECTED_HLQ = [];
function isProtected(dsn) {
  return PROTECTED_HLQ.includes((dsn.split('.')[0] || '').toUpperCase());
}

// ---- theme (light/dark) ----------------------------------------------------
// Browser-local preference only - there's nowhere on z/OSMF to store a user
// setting like this, and there's no need for one; localStorage on this
// origin is enough to remember it for next time this browser signs in.
const THEME_KEY = 'isiConsoleTheme';
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.themeOpt').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
  const quickBtn = $('#themeToggleBtn');
  if (quickBtn) quickBtn.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
}
function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private browsing etc - still apply for this session */ }
  applyTheme(theme);
}
function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { /* ignore */ }
  applyTheme(saved);
}
initTheme();
const themeToggleBtn = $('#themeToggleBtn');
if (themeToggleBtn) {
  themeToggleBtn.onclick = () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
  };
}
document.querySelectorAll('.themeOpt').forEach(b => { b.onclick = () => setTheme(b.dataset.theme); });

// ---- flash messages --------------------------------------------------------
// Longer-lived than the old text-only version, and copyable - error
// messages in particular (catalog errors, z/OSMF error bodies) are often
// worth pasting into a ticket/chat rather than just reading once before
// they vanish. Hovering pauses the auto-dismiss timer so moving the mouse
// toward the copy button doesn't race the message disappearing.
const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="4" y="4" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10V3a1 1 0 0 1 1-1h7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function flash(text, ok) {
  const m = $('#msg');
  m.innerHTML = '<span class="msgText"></span>'
    + '<button class="msgCopy" type="button" title="Copy message">' + COPY_ICON + '</button>'
    + '<button class="msgClose" type="button" title="Dismiss">&times;</button>';
  m.querySelector('.msgText').textContent = text;
  m.className = 'show ' + (ok ? 'ok' : 'err');
  const copyBtn = m.querySelector('.msgCopy');
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = CHECK_ICON;
      copyBtn.title = 'Copied!';
      setTimeout(() => { copyBtn.innerHTML = COPY_ICON; copyBtn.title = 'Copy message'; }, 1200);
    }).catch(() => flash('Could not copy - your browser blocked clipboard access.', false));
  };
  m.querySelector('.msgClose').onclick = (e) => {
    e.stopPropagation();
    clearTimeout(m._t);
    m.className = '';
  };
  const duration = ok ? 5000 : 15000;
  const start = () => { clearTimeout(m._t); m._t = setTimeout(() => { m.className = ''; }, duration); };
  m.onmouseenter = () => clearTimeout(m._t);
  m.onmouseleave = start;
  start();
}

// ---- z/OSMF REST helper -----------------------------------------------
function enc(s) { return encodeURIComponent(s); }
function dsPath(dsn, member) { return '/zosmf/restfiles/ds/' + enc(member ? dsn + '(' + member + ')' : dsn); }

async function zCall(method, path, { body, isJson, raw, headers } = {}) {
  const h = Object.assign({}, headers || {});
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = isJson ? 'application/json' : 'text/plain';
    payload = isJson ? JSON.stringify(body) : body;
  }
  const r = await fetch(path, { method, headers: h, body: payload });
  if (r.status === 401 || r.status === 403) {
    location.href = 'login.html';
    throw new Error('Session expired');
  }
  const text = await r.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { /* not JSON */ } }
  if (!r.ok) {
    // z/OSMF error bodies often split the useful part across "message"
    // (short/generic, e.g. "LMDLIST error") and "details" (the actual
    // explanation) - combine both so friendlyZosmfError() below has
    // something to pattern-match against either way.
    let msg = text || ('HTTP ' + r.status);
    if (json) {
      const parts = [json.message, json.details && json.details.join('; ')].filter(Boolean);
      if (parts.length) msg = parts.join(' - ');
    }
    throw new Error(msg);
  }
  return raw ? text : (json !== null ? json : text);
}

// ---- auth guard -------------------------------------------------------
async function requireAuth() {
  try {
    const r = await fetch('/zosmf/info');
    if (r.status === 401 || r.status === 403) { location.href = 'login.html'; return false; }
  } catch (e) {
    flash('Could not reach the gateway backend - is the IHS proxy up?', false);
    return false;
  }
  const u = localStorage.getItem('isiUser');
  // A valid z/OSMF session (checked above) only proves *some* authenticated
  // request works - it says nothing about whether *this* browser ever
  // recorded who that is. That gap showed up live: a colleague's session
  // passed the check above but isiUser was never set locally (reached
  // index.html without going through login.html's form - a bookmark, a
  // leftover session, etc.), so the profile popover showed "(unknown)"
  // instead of their actual userid. Rather than display an unknown
  // identity, force a real sign-in so isiUser is always accurate afterward.
  if (!u) { location.href = 'login.html'; return false; }
  const whoText = 'Signed in as ' + u;
  $('#whoLabel').textContent = whoText; // visually hidden, kept for screen readers
  $('#profileBtn').title = whoText + ' \u00B7 Profile & appearance';
  const pu = $('#profileUser');
  if (pu) pu.textContent = u || '(unknown)';
  const ph = $('#profileHost');
  if (ph) ph.textContent = location.hostname || '(unknown)'; // whatever host is actually serving this page
  return true;
}
$('#logoutBtn').onclick = async () => {
  saveLayoutState(); // before clearing isiUser below - layoutStorageKey() needs it to key the save correctly
  try { await fetch('/zosmf/services/authenticate', { method: 'DELETE' }); } catch (e) { /* best-effort */ }
  localStorage.removeItem('isiUser');
  location.href = 'login.html';
};
// Safety net for the far more common case of just closing the tab/browser
// instead of clicking Sign out - same save, no navigation involved.
window.addEventListener('beforeunload', saveLayoutState);

// ---- sidebar sections (Data Sets / USS / Jobs) -------------------------
// Zowe-Explorer-style: all three sections live in one persistent sidebar
// and can be independently collapsed/expanded, rather than the old
// top-nav tabs that showed exactly one of Datasets/Jobs/Profile at a time.
// data-order captures each section's original Data Sets/USS/Jobs position
// once, before reorderSideSections() (below) ever moves anything - that's
// the stable reference it sorts by, so repeated collapse/expand toggling
// can't drift the "home" order over time.
document.querySelectorAll('.sideSection').forEach((sec, i) => { sec.dataset.order = i; });
document.querySelectorAll('.sideHead').forEach(h => {
  h.onclick = () => {
    h.closest('.sideSection').classList.toggle('open');
    reorderSideSections();
    applySideHeights();
  };
});
// Collapsing a section drops it to the bottom of the sidebar, out of the
// way of the sections still open; expanding it again returns it to its
// original position among the other open ones. Both groups (open, then
// collapsed) keep their own original relative order - this only ever
// splits the list into "open ones first, collapsed ones after," never
// scrambles it further. Reuses the same 2 .sideResizer elements rather
// than recreating them (appendChild moves an existing node, so their drag
// handlers - wired once below, reading neighbors live off the DOM at drag
// time - keep working after being repositioned).
function reorderSideSections() {
  const sidebar = $('.sidebar');
  const sections = Array.from(sidebar.querySelectorAll('.sideSection'));
  const resizers = Array.from(sidebar.querySelectorAll('.sideResizer'));
  const ordered = sections.slice().sort((a, b) => {
    const aOpen = a.classList.contains('open') ? 0 : 1;
    const bOpen = b.classList.contains('open') ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return Number(a.dataset.order) - Number(b.dataset.order);
  });
  ordered.forEach((sec, i) => {
    sidebar.appendChild(sec);
    if (i < ordered.length - 1 && resizers[i]) sidebar.appendChild(resizers[i]);
  });
}

// ---- resizable sidebar: section heights + overall width -----------------
// Two independent drag affordances, both remembered in localStorage:
//  - .sideResizer bars between stacked sections - drag up/down to trade
//    height between whichever *open* sections are nearest above/below.
//  - #shellResizer between the sidebar and the editor pane - drag left/
//    right to resize the sidebar itself.
// Collapsed sections aren't given an explicit height (they just show their
// header), so dragging a resizer only ever grows/shrinks actual open
// sections - nearestOpenSection() walks past any collapsed ones in between.
const SIDE_HEIGHTS_KEY = 'isiSideHeights';
const SIDE_WIDTH_KEY = 'isiSideWidth';
// Starting flex-basis for an open section the user has never dragged, i.e.
// one with no entry in isiSideHeights - roughly a header plus a filter row
// plus a few tree rows. See applySideHeights() for why this must not be 0.
const DEFAULT_SIDE_H = 180;
function loadSideHeights() {
  try { return JSON.parse(localStorage.getItem(SIDE_HEIGHTS_KEY) || '{}'); } catch (e) { return {}; }
}
function saveSideHeights() {
  try { localStorage.setItem(SIDE_HEIGHTS_KEY, JSON.stringify(sideHeights)); } catch (e) { /* private browsing etc */ }
}
let sideHeights = loadSideHeights();
function applySideHeights() {
  document.querySelectorAll('.sideSection').forEach(sec => {
    if (!sec.classList.contains('open')) { sec.style.flex = ''; sec.style.height = ''; return; }
    // A saved height is a *preference*, not a hard floor - flex-shrink:1
    // (instead of the old "flex: none") lets it give up space when a
    // third section opens and everything no longer fits at its preferred
    // size. Rigidly held heights here were squeezing a newly-opened
    // section down to 0px and off the screen instead of everyone sharing
    // the shortfall. .sideSection.open's own min-height:34px is the floor
    // that keeps every open section's header visible regardless.
    // flex-grow was previously 0 here ("0 1 <px>"), which pinned a section
    // to its last-dragged height forever, even after its siblings got
    // collapsed and left the whole rest of the sidebar empty below it -
    // reported as "collapsing doesn't drop things to the bottom any more"
    // and "the Jobs section is too short and I can't make it bigger" (with
    // only Jobs open, there's no adjacent *open* sibling left for the
    // sideResizer drag to trade height with either, so manual resize was a
    // dead end too). flex-grow:1 keeps the saved height as the starting
    // size but lets the section actually claim any space its collapsed-away
    // neighbors freed up, same as a section with no saved height at all.
    // The no-saved-height case used a flex-basis of 0, which quietly broke
    // as soon as a *new* section was added to the sidebar. Flexbox
    // distributes shrinkage in proportion to each item's basis, so an item
    // with basis 0 absorbs none of the shortfall - but it also starts from
    // 0, so when the older sections' saved heights already overflow the
    // sidebar there is no free space left to grow into, and the new
    // section sits pinned at .sideSection.open's 34px min-height: header
    // visible, body zero-height. That is exactly how the Volumes section
    // presented when it shipped - it was the only section nobody had ever
    // dragged, so the only one with no entry in isiSideHeights.
    // A real default basis makes an un-dragged section shrink and grow on
    // the same terms as its saved-height siblings instead of being a
    // special case that only behaves when the sidebar isn't full.
    const basis = sideHeights[sec.id] || DEFAULT_SIDE_H;
    sec.style.flex = '1 1 ' + basis + 'px';
    sec.style.height = '';
  });
}
function nearestOpenSection(el, dir) {
  let node = dir === 'prev' ? el.previousElementSibling : el.nextElementSibling;
  while (node) {
    if (node.classList && node.classList.contains('sideSection') && node.classList.contains('open')) return node;
    node = dir === 'prev' ? node.previousElementSibling : node.nextElementSibling;
  }
  return null;
}
// Collapsed sections have already been moved to the bottom of the sidebar
// by reorderSideSections() above by the time a drag can start here -
// nearestOpenSection() below still walks past any collapsed ones it finds
// (harmless belt-and-suspenders for the resizer sitting among the
// collapsed group at the bottom, where there may be nothing open to
// either side to resize at all).
document.querySelectorAll('.sideResizer').forEach(handle => {
  handle.addEventListener('mousedown', (e) => {
    const above = nearestOpenSection(handle, 'prev');
    const below = nearestOpenSection(handle, 'next');
    if (!above && !below) return;
    e.preventDefault();
    handle.classList.add('active');
    const startY = e.clientY;
    const startAboveH = above ? above.getBoundingClientRect().height : 0;
    const startBelowH = below ? below.getBoundingClientRect().height : 0;
    const MIN_H = 60;
    function onMove(ev) {
      const delta = ev.clientY - startY;
      if (above) {
        const h = Math.max(MIN_H, startAboveH + delta);
        // flex-shrink:1 (not "none") so a third open section elsewhere in
        // the sidebar can still claim its min-height instead of being
        // squeezed out while this drag is in progress. flex-grow:1 (not 0 -
        // see applySideHeights() for why) so this stays consistent with how
        // the saved height gets re-applied on the next collapse/expand.
        above.style.flex = '1 1 ' + h + 'px'; above.style.height = '';
        sideHeights[above.id] = h;
      }
      if (below) {
        const h = Math.max(MIN_H, startBelowH - delta);
        below.style.flex = '1 1 ' + h + 'px'; below.style.height = '';
        sideHeights[below.id] = h;
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
      saveSideHeights();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});
reorderSideSections();
applySideHeights();

function loadSideWidth() {
  const v = parseInt(localStorage.getItem(SIDE_WIDTH_KEY) || '', 10);
  return Number.isFinite(v) ? v : 320;
}
function saveSideWidth(w) {
  try { localStorage.setItem(SIDE_WIDTH_KEY, String(w)); } catch (e) { /* ignore */ }
}
const sidebarEl = $('.sidebar');
sidebarEl.style.width = loadSideWidth() + 'px';
$('#shellResizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const handle = $('#shellResizer');
  handle.classList.add('active');
  const startX = e.clientX;
  const startW = sidebarEl.getBoundingClientRect().width;
  function onMove(ev) {
    const w = Math.min(720, Math.max(220, startW + (ev.clientX - startX)));
    sidebarEl.style.width = w + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    handle.classList.remove('active');
    saveSideWidth(sidebarEl.getBoundingClientRect().width);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ---- profile popover -----------------------------------------------------
// Replaces the old full-page Profile tab - just signed-in-as/host info and
// the light/dark toggle, anchored under the header's profile button.
$('#profileBtn').onclick = (e) => {
  e.stopPropagation();
  $('#profilePop').classList.toggle('show');
};
document.addEventListener('click', (e) => {
  const pop = $('#profilePop');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target) && e.target.id !== 'profileBtn') {
    pop.classList.remove('show');
  }
});

// ==================== favorites ====================
// Star/pin items across all three sections. There's nowhere on z/OSMF to
// store this (same reasoning as the theme preference above), so it's a
// browser-local list keyed loosely enough that datasets/members/USS paths/
// job runs can all live in one list. Job favorites store a specific jobid,
// not just a jobname - JES job numbers get reused, but favoriting is most
// useful for "let me get back to this run's output before it ages off",
// and re-searching by jobname on open is a reasonable fallback either way.
const FAV_KEY = 'isiFavorites';
let favorites = [];
function loadFavorites() {
  try { favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { favorites = []; }
}
function saveFavorites() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch (e) { /* private browsing etc */ }
}
function favKey(f) {
  if (f.kind === 'ds') return 'ds:' + f.dsn + '(' + (f.mbr || '') + ')';
  if (f.kind === 'uss') return 'uss:' + f.path;
  return 'job:' + f.jobname + '.' + f.jobid;
}
function isFavorite(f) { return favorites.some(x => favKey(x) === favKey(f)); }
function toggleFavorite(f) {
  if (isFavorite(f)) favorites = favorites.filter(x => favKey(x) !== favKey(f));
  else favorites.push(f);
  saveFavorites();
  renderFavorites();
}
function favLabel(f) {
  if (f.kind === 'ds') return f.dsn + (f.mbr ? '(' + f.mbr + ')' : '');
  if (f.kind === 'uss') return f.path;
  return f.jobname + ' (' + f.jobid + ')';
}
// Nested under each section's own tree (dsFavTree/ussFavTree/jobFavTree)
// rather than a standalone sidebar section - matches the Zowe Explorer VS
// Code extension's per-view Favorites node, minus its own collapse toggle
// (see the .favBlock CSS comment). Only rendered when that kind actually
// has favorites, so an empty list doesn't sit there taking up space.
function renderFavorites() {
  renderKindFavorites('dsFavTree', 'ds');
  renderKindFavorites('ussFavTree', 'uss');
  renderKindFavorites('jobFavTree', 'job');
}
function renderKindFavorites(containerId, kind) {
  const box = $('#' + containerId); if (!box) return;
  const items = favorites.filter(f => f.kind === kind);
  if (!items.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  // Twistable like any other tree node (reuses the same .treeItem.dir
  // chevron the dataset/USS/job trees use) - box.dataset.open remembers
  // the toggle state across re-renders (e.g. adding/removing a favorite
  // elsewhere) within this page load, defaulting to open.
  const wasOpen = box.dataset.open !== 'false';
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'treeItem dir' + (wasOpen ? ' open' : '');
  head.innerHTML = '<span class="favStar">&#9733;</span><span>Favorites</span>';
  box.appendChild(head);
  const childWrap = document.createElement('div');
  childWrap.className = 'treeChildren';
  childWrap.style.display = wasOpen ? '' : 'none';
  box.appendChild(childWrap);
  head.onclick = () => {
    const opening = childWrap.style.display === 'none';
    childWrap.style.display = opening ? '' : 'none';
    head.classList.toggle('open', opening);
    box.dataset.open = opening ? 'true' : 'false';
  };
  items.forEach(f => {
    const row = document.createElement('div');
    row.className = 'treeItem member favItem';
    row.innerHTML = '<span class="favStar">&#9733;</span><span>' + escHtml(favLabel(f)) + '</span>';
    row.onclick = () => openFavorite(f);
    row.oncontextmenu = e => ctxShow(e, [
      ['Open', () => openFavorite(f)],
      ['Remove from Favorites', () => toggleFavorite(f)],
    ]);
    childWrap.appendChild(row);
  });
}
async function openFavorite(f) {
  if (f.kind === 'ds' && !f.mbr) {
    // A favorited whole PDS should behave like clicking it in the tree
    // (expand to show its members), not try to read it as one text stream
    // - z/OSMF reading a PDS with no member concatenates every member's
    // raw records together, which is exactly the garbled box-character
    // output that was reported. isPO is looked up fresh when a favorite predates
    // this fix (its stored shape won't have the flag yet) rather than
    // requiring everyone to remove and re-add existing favorites.
    let isPO = f.isPO;
    if (isPO === undefined) {
      try {
        const items = await dsList(f.dsn);
        const it = items.find(x => x.dsname === f.dsn) || items[0];
        isPO = !!(it && (it.dsorg || '').indexOf('PO') === 0);
      } catch (e) { isPO = false; }
    }
    if (isPO) {
      $('#hlqFilter').value = f.dsn;
      currentDslevel = f.dsn;
      await refreshTree();
      const row = Array.from($('#dsTree').querySelectorAll('.treeItem.dir')).find(r => r.textContent.trim().startsWith(f.dsn));
      if (row) { row.scrollIntoView({ block: 'nearest' }); row.click(); }
      else flash(f.dsn + ' not found - it may have been deleted or renamed', false);
      return;
    }
    openTab(f.dsn, f.mbr);
    return;
  }
  if (f.kind === 'ds') { openTab(f.dsn, f.mbr); return; }
  if (f.kind === 'uss') {
    // Same idea for a favorited USS directory - browse into it instead of
    // trying to open it as a file. Same self-healing approach for
    // favorites saved before isDir was tracked: ussList() on the path
    // succeeds for a directory and throws for a file.
    let isDir = f.isDir;
    if (isDir === undefined) {
      try { await ussList(f.path); isDir = true; } catch (e) { isDir = false; }
    }
    if (isDir) { goToUssPath(f.path); return; }
    openUssTab(f.path);
    return;
  }
  currentJobPrefix = f.jobname;
  currentJobOwner = '*';
  currentJobStatus = '';
  $('#jobFilter').value = f.jobname;
  await refreshJobTree();
  flash('Listed jobs matching ' + f.jobname + ' - expand ' + f.jobid + ' below if it\'s still on the queue', true);
}

// ==================== misc helpers: clipboard, download, encoding, diff ====================
function copyNameToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => flash('Copied "' + text + '" to the clipboard', true),
      () => flash('Clipboard access was blocked by the browser', false)
    );
  } else {
    flash('Clipboard API not available in this browser', false);
  }
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// z/OSMF honors X-IBM-Data-Type on both the datasets and USS files APIs -
// "text;fileEncoding=<codepage>" re-runs the EBCDIC/ASCII conversion
// through a specific codepage instead of the default, and "binary" skips
// conversion entirely. Used by "Open with Encoding..." below.
function encHeaders(encoding) {
  if (!encoding) return {};
  if (encoding.toLowerCase() === 'binary') return { 'X-IBM-Data-Type': 'binary' };
  return { 'X-IBM-Data-Type': 'text;fileEncoding=' + encoding };
}
async function dsReadEnc(dsn, member, encoding) { return await zCall('GET', dsPath(dsn, member), { raw: true, headers: encHeaders(encoding) }); }
async function dsWriteEnc(dsn, member, text, encoding) { await zCall('PUT', dsPath(dsn, member), { body: text, headers: encHeaders(encoding) }); }
async function ussReadEnc(path, encoding) { return await zCall('GET', '/zosmf/restfiles/fs/' + ussEncPath(path), { raw: true, headers: encHeaders(encoding) }); }
async function ussWriteEnc(path, text, encoding) { await zCall('PUT', '/zosmf/restfiles/fs/' + ussEncPath(path), { body: text, headers: encHeaders(encoding) }); }

const ENCODING_CHOICES = 'ISO8859-1, UTF-8, IBM-037, IBM-1047, Binary';
function pickEncoding() {
  const choice = prompt('Open with encoding - common choices: ' + ENCODING_CHOICES + '\n(leave blank for the default text conversion)', '');
  return choice === null ? null : choice.trim();
}
async function openWithEncoding(kind, ref) {
  const encoding = pickEncoding();
  if (encoding === null) return;
  const label = kind === 'ds' ? ref.dsn + (ref.mbr ? '(' + ref.mbr + ')' : '') : ref.path;
  try {
    const text = kind === 'ds' ? await dsReadEnc(ref.dsn, ref.mbr, encoding) : await ussReadEnc(ref.path, encoding);
    const t = kind === 'ds'
      ? { id: nextId++, kind: 'ds', dsn: ref.dsn, mbr: ref.mbr || '', text, dirty: false, fmt: null, encoding: encoding || null }
      : { id: nextId++, kind: 'uss', path: ref.path, text, dirty: false, fmt: null, encoding: encoding || null };
    tabs.push(t); activateTab(t);
    flash('Opened ' + label + (encoding ? ' as ' + encoding : ''), true);
  } catch (e) { flash(friendlyZosmfError(e.message, label) || ('Open failed: ' + e.message), false); }
}

// "Pull from Mainframe" - discards any local edits in an already-open tab
// and re-fetches its content fresh (honoring the tab's own encoding, if
// "Open with Encoding..." was used to open it). Called from the tab's own
// context menu; pullFromMainframeByRef() below is the tree-context-menu
// equivalent, which just opens the item normally if it isn't already open
// (nothing local to discard in that case).
async function pullFromMainframe(t) {
  if (t.dirty && !confirm('Discard local changes to ' + tabLabel(t) + ' and reload it from the mainframe?')) return;
  try {
    const text = t.kind === 'uss'
      ? (t.encoding ? await ussReadEnc(t.path, t.encoding) : await ussRead(t.path))
      : (t.encoding ? await dsReadEnc(t.dsn, t.mbr, t.encoding) : await dsRead(t.dsn, t.mbr));
    t.text = text; t.dirty = false;
    renderTabsFor(t.pane);
    if (panes[t.pane] && panes[t.pane].activeId === t.id) renderEditorFor(t.pane);
    flash('Reloaded ' + tabLabel(t) + ' from the mainframe', true);
  } catch (e) { flash('Reload failed: ' + e.message, false); }
}
function pullFromMainframeByRef(kind, ref) {
  const t = kind === 'ds'
    ? tabs.find(x => x.kind === 'ds' && x.dsn === ref.dsn && x.mbr === (ref.mbr || ''))
    : tabs.find(x => x.kind === 'uss' && x.path === ref.path);
  if (t) return pullFromMainframe(t);
  return kind === 'ds' ? openTab(ref.dsn, ref.mbr) : openUssTab(ref.path);
}

// ---- Show Attributes / generic info modal ----
function showInfoModal(title, text) {
  $('#infoModalTitle').textContent = title;
  $('#infoModalBody').textContent = text;
  $('#infoModal').classList.add('show');
}
$('#infoModalClose').onclick = () => $('#infoModal').classList.remove('show');
async function showAttributes(dsn, mbr) {
  try {
    const items = await dsList(dsn);
    const it = items.find(x => x.dsname === dsn) || items[0];
    if (!it) { flash('Could not find attributes for ' + dsn, false); return; }
    const lines = [
      'Data set: ' + dsn,
      mbr ? 'Member: ' + mbr : null,
      'Organization: ' + (it.dsorg || '?'),
      'Record format: ' + (it.recfm || '?'),
      'Record length: ' + (it.lrecl || '?'),
      'Block size: ' + (it.blksize || '?'),
      'Volume: ' + (it.vol || it.vols || '?'),
      'Catalog: ' + (it.catnm || '?'),
      'Migrated: ' + (it.migr || 'NO'),
    ].filter(Boolean);
    showInfoModal('Attributes', lines.join('\n'));
  } catch (e) { flash('Attributes failed: ' + e.message, false); }
}

// ---- Select for Compare / Compare with Selected ----
// A minimal two-item diff, not a full multi-file compare workspace: pick
// one item, then pick a second and it opens side by side with a
// classic LCS line diff (dynamic-programming longest-common-subsequence -
// fine for source-sized files; not meant for huge datasets).
let compareSelection = null; // {kind, dsn, mbr, path, label}
function selectForCompare(ref) {
  compareSelection = ref;
  flash('Selected ' + ref.label + ' for compare - right-click another item and choose "Compare with Selected"', true);
}
async function compareWithSelected(ref) {
  if (!compareSelection) return;
  const left = compareSelection, right = ref;
  compareSelection = null;
  try {
    const leftText = left.kind === 'ds' ? await dsRead(left.dsn, left.mbr) : await ussRead(left.path);
    const rightText = right.kind === 'ds' ? await dsRead(right.dsn, right.mbr) : await ussRead(right.path);
    showCompare(left.label, leftText, right.label, rightText);
  } catch (e) { flash('Compare failed: ' + e.message, false); }
}
function diffLines(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const n = la.length, m = lb.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) { out.push({ type: 'same', a: la[i], b: lb[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', a: la[i] }); i++; }
    else { out.push({ type: 'add', b: lb[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', a: la[i] }); i++; }
  while (j < m) { out.push({ type: 'add', b: lb[j] }); j++; }
  return out;
}
function showCompare(labelA, textA, labelB, textB) {
  const rows = diffLines(textA, textB);
  const left = [], right = [];
  rows.forEach(r => {
    if (r.type === 'same') {
      left.push('<div class="diffLine">' + escHtml(r.a) + '</div>');
      right.push('<div class="diffLine">' + escHtml(r.b) + '</div>');
    } else if (r.type === 'del') {
      left.push('<div class="diffLine diffDel">' + escHtml(r.a) + '</div>');
      right.push('<div class="diffLine diffPad">&nbsp;</div>');
    } else {
      left.push('<div class="diffLine diffPad">&nbsp;</div>');
      right.push('<div class="diffLine diffAdd">' + escHtml(r.b) + '</div>');
    }
  });
  $('#compareTitleA').textContent = labelA;
  $('#compareTitleB').textContent = labelB;
  $('#comparePaneA').innerHTML = left.join('');
  $('#comparePaneB').innerHTML = right.join('');
  $('#compareModal').classList.add('show');
}
$('#compareClose').onclick = () => $('#compareModal').classList.remove('show');

// ==================== context menu ====================
function ctxHide() { $('#ctx').classList.remove('show'); }
document.addEventListener('click', ctxHide);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ctxHide();
    $('#newDsModal').classList.remove('show');
    $('#infoModal').classList.remove('show');
    $('#compareModal').classList.remove('show');
    $('#ussFilterPop').classList.remove('show');
    if (focusedPaneId) findBarHide(focusedPaneId);
  }
  // Belt-and-suspenders alongside the editor textarea's own onkeydown
  // (below): a brand-new member is opened right after window.prompt()
  // closes, and some browsers don't reliably honor a programmatic
  // .focus() call made in that same tick - so Ctrl/Cmd+S can land on the
  // document (triggering the browser's native "save page") instead of the
  // textarea. Catching it here too, gated on a tab actually being open,
  // means the shortcut works regardless of exactly what has focus.
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && curTab()) {
    e.preventDefault();
    saveCurrent();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && curTab()) {
    e.preventDefault();
    findBarShow(focusedPaneId, false);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && curTab() && !curTab().readOnly) {
    e.preventDefault();
    findBarShow(focusedPaneId, true);
  }
});

function ctxShow(e, items) {
  e.preventDefault(); e.stopPropagation();
  const m = $('#ctx'); m.innerHTML = '';
  items.forEach(it => {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); return; }
    const d = document.createElement('div'); d.className = 'ci'; d.textContent = it[0];
    d.onclick = ev => { ev.stopPropagation(); ctxHide(); it[1](); };
    m.appendChild(d);
  });
  m.classList.add('show');
  // Measure after it's actually laid out (the .show class is what makes it
  // display:block) so a tall menu can be clamped/flipped to stay fully
  // on-screen - the old version only clamped the *top* corner against the
  // viewport edge, so a menu opened near the bottom (like this longer USS
  // file menu) could still run its lower items off the bottom of the
  // window with no way to reach them.
  const menuW = m.offsetWidth || 210;
  const menuH = m.offsetHeight || 0;
  let left = e.clientX, top = e.clientY;
  if (left + menuW > innerWidth - 10) left = Math.max(10, innerWidth - menuW - 10);
  if (top + menuH > innerHeight - 10) top = Math.max(10, innerHeight - menuH - 10);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
}

function showCtx(e, dsn, mbr, isPO, kind) {
  const isOpenable = mbr || !isPO;
  const label = dsn + (mbr ? '(' + mbr + ')' : '');
  const items = [];
  if (isOpenable) {
    items.push(['Open', () => openTab(dsn, mbr)]);
    items.push(['Open (Browse)', () => openTab(dsn, mbr, { readOnly: true })]);
    items.push(['Open with Encoding...', () => openWithEncoding('ds', { dsn, mbr })]);
    items.push(['Pull from Mainframe', () => pullFromMainframeByRef('ds', { dsn, mbr })]);
    items.push(['Submit as JCL', () => submitAsJCL(dsn, mbr)]);
    if (mbr) items.push(['Run REXX...', () => runRexx(dsn, mbr)]);
  }
  if (isPO && !mbr) {
    items.push(['New member...', () => newMember(dsn)]);
    items.push(['Upload file...', () => uploadMember(dsn)]);
  }
  // zFS datasets are VSAM linear datasets under the hood, so dsKind() can
  // only narrow this down to "vsam" from the dataset list attributes alone -
  // not every VSAM cluster offered "Mount..." here is actually zFS-formatted.
  // Mounting a non-zFS VSAM cluster just fails cleanly with a z/OSMF error
  // (routed through friendlyZosmfError like everything else), so this is
  // safe to offer rather than silently unavailable.
  if (!mbr && kind === 'vsam') {
    items.push(['Mount as zFS...', () => mountZfsPrompt(dsn)]);
    items.push(['Unmount zFS...', () => unmountZfsPrompt(dsn)]);
  }
  items.push('-');
  items.push(['Show Attributes', () => showAttributes(dsn, mbr)]);
  items.push(['Copy', () => setClip('copy', dsn, mbr, isPO)]);
  items.push(['Cut', () => setClip('move', dsn, mbr, isPO)]);
  items.push('-');
  if (isOpenable) items.push(['Download' + (mbr ? ' Member...' : '...'), () => downloadMember(dsn, mbr)]);
  const favRef = { kind: 'ds', dsn, mbr, isPO, label };
  items.push([isFavorite(favRef) ? 'Remove from Favorites' : 'Add to Favorites', () => toggleFavorite(favRef)]);
  items.push('-');
  if (isOpenable) {
    const cmp = { kind: 'ds', dsn, mbr, label };
    items.push(compareSelection ? ['Compare with Selected', () => compareWithSelected(cmp)] : ['Select for Compare', () => selectForCompare(cmp)]);
  }
  items.push('-');
  items.push(['Copy Name', () => copyNameToClipboard(label)]);
  items.push('-');
  items.push([mbr ? 'Rename member...' : 'Rename dataset...', () => renameItem(dsn, mbr, isPO)]);
  items.push([mbr ? 'Delete member' : 'Delete dataset', () => deleteItem(dsn, mbr)]);
  if (clip) {
    items.push('-');
    if (isPO) items.push([(clip.mbr || !clip.isPO) ? 'Paste as new member...' : 'Paste (merge members)', () => pasteInto(dsn, true)]);
    else items.push(['Paste (overwrite dataset)', () => pasteInto(dsn, false)]);
    items.push(['Paste into new dataset...', () => pasteIntoNew()]);
  }
  ctxShow(e, items);
}

function showTabCtx(e, t) {
  const items = [];
  if (!t.readOnly) items.push(['Save', () => saveById(t.id)]);
  if (!t.readOnly) items.push(['Pull from Mainframe', () => pullFromMainframe(t)]);
  if (!t.readOnly) items.push(['Submit as JCL', () => submitTabAsJCL(t)]);
  if (!t.readOnly && t.kind === 'ds' && t.mbr) items.push(['Run REXX...', () => runRexxTab(t)]);
  if (t.kind === 'syslog') items.push(['Issue operator command...', () => issueCustomCommand()]);
  items.push(['Copy Name', () => copyNameToClipboard(tabLabel(t))]);
  items.push('-');
  items.push(['Close tab', () => closeTab(t.id)]);
  if (tabsInPane(t.pane).length > 1) {
    items.push(['Close Others', () => closeOtherTabs(t)]);
    items.push(['Close All', () => closeAllTabs(t.pane)]);
  }
  ctxShow(e, items);
}
// Right-clicking empty space in a tab bar (not any specific tab) - only
// "Close All" makes sense there since there's no single tab the other menu
// items (Save/Submit/Close Others/etc.) would apply to.
function showEmptyTabbarCtx(e, paneId) {
  if (!tabsInPane(paneId).length) return;
  ctxShow(e, [['Close All', () => closeAllTabs(paneId)]]);
}
// Closes every other tab in t's own pane, leaving t itself open - scoped
// to the pane it was right-clicked in (matches VS Code's "Close Others",
// which only acts on the group you right-clicked in, not every pane at
// once). Reuses closeTab() per tab so dirty-confirm, the SYSLOG poll-timer
// cleanup, and empty-pane collapse all stay exactly as they already are
// for a single close - snapshot the id list first since closeTab() mutates
// the shared `tabs` array as it goes.
function closeOtherTabs(t) {
  const others = tabsInPane(t.pane).filter(x => x.id !== t.id).map(x => x.id);
  others.forEach(id => closeTab(id));
}
// Same idea as closeOtherTabs, but also closes the tab that was
// right-clicked (or, from the empty-tabbar-area menu, every tab in that
// pane) - scoped to a single pane, same as Close Others.
function closeAllTabs(paneId) {
  const ids = tabsInPane(paneId).map(t => t.id);
  ids.forEach(id => closeTab(id));
}

$('#dsTree').addEventListener('contextmenu', e => {
  if (e.target.id !== 'dsTree' || !clip) return;
  ctxShow(e, [['Paste into new dataset...', () => pasteIntoNew()]]);
});

// ==================== dataset REST wrappers ====================
async function dsList(dslevel) {
  const j = await zCall('GET', '/zosmf/restfiles/ds?dslevel=' + enc(dslevel), { headers: { 'X-IBM-Attributes': 'base' } });
  return (j && j.items) || [];
}
async function dsListMembers(dsn) {
  const j = await zCall('GET', dsPath(dsn) + '/member');
  return ((j && j.items) || []).map(i => i.member);
}
async function dsRead(dsn, member) { return await zCall('GET', dsPath(dsn, member), { raw: true }); }
async function dsWrite(dsn, member, text) { await zCall('PUT', dsPath(dsn, member), { body: text }); }
async function dsAllocate(dsn, attrs) { await zCall('POST', dsPath(dsn), { body: attrs, isJson: true }); }
async function dsDelete(dsn, member) { await zCall('DELETE', dsPath(dsn, member)); }
// z/OSMF's copy request does NOT merge a whole PDS in one call (confirmed
// against the live system - fails "'to' data set organization is
// partitioned, sequential data set expected"). Whole-PDS copy is a loop of
// single-member copies instead; see dsCopyWholePds.
async function dsCopyMember(fromDsn, fromMember, toDsn, toMember, replace) {
  await zCall('PUT', dsPath(toDsn, toMember), {
    body: { request: 'copy', 'from-dataset': fromMember ? { dsn: fromDsn, member: fromMember } : { dsn: fromDsn }, replace: !!replace },
    isJson: true,
  });
}
async function dsCopyWholePds(fromDsn, toDsn) {
  const members = await dsListMembers(fromDsn);
  for (const m of members) await dsCopyMember(fromDsn, m, toDsn, m, true);
  return members;
}
async function downloadMember(dsn, mbr) {
  const label = dsn + (mbr ? '(' + mbr + ')' : '');
  try {
    const text = await dsRead(dsn, mbr);
    downloadText((mbr || dsn.split('.').pop()) + '.txt', text);
    flash('Downloaded ' + label, true);
  } catch (e) { flash(friendlyZosmfError(e.message, label) || ('Download failed: ' + e.message), false); }
}

// ==================== USS REST wrappers ====================
// Full CRUD now (browse/open/save/copy/paste/delete/chmod/create/rename),
// matching the Zowe Explorer USS context menu used as a reference.
function ussEncPath(path) {
  // z/OSMF wants each path segment percent-encoded individually, not the
  // slashes themselves - encoding the whole path as one component would
  // turn "/u/yourid/x" into "%2Fu%2Fyourid%2Fx", which the restfiles/fs
  // endpoint doesn't accept as a path suffix.
  return path.replace(/^\/+/, '').split('/').map(enc).join('/');
}
async function ussList(path) {
  const j = await zCall('GET', '/zosmf/restfiles/fs?path=' + enc(path));
  return (j && j.items) || [];
}
// Default USS text conversion: explicitly request IBM-1047 rather than
// omitting X-IBM-Data-Type - this is the codepage this project's own USS
// content is actually stored in (see the README's deploy steps: every text
// file pushed to USS goes through "text;fileEncoding=IBM-1047"), and it's
// also z/OSMF's own implicit default when the header is left off, so being
// explicit here just documents that rather than changing behavior.
//
// IMPORTANT: there is no single correct default for every USS file. USS
// genuinely mixes EBCDIC-native content (anything deployed/edited through
// mainframe-native tooling, which is the norm for this project - RACF
// backend scripts, htdocs files, etc.) with true ASCII-native content
// (shell-generated dotfiles like .bash_history, since OMVS's own shell
// writes those as plain ASCII, untagged). Forcing ISO8859-1 here previously
// "fixed" .bash_history but broke the far more common IBM-1047 case:
// z/OSMF took genuinely-EBCDIC bytes and, told to treat them as ISO8859-1,
// never ran the EBCDIC conversion at all - so what displayed was raw EBCDIC
// byte values misread as Latin-1, and round-tripping (edit + save) wrote
// back through the wrong codepage entirely. Confirmed live against
// racf-backend-recycle.sh (deployed via `zowe zos-files upload --encoding
// IBM-1047`, correct in PCOMM/x3270, garbled in the browser after that
// change; also garbled in PCOMM after being edited/saved via the browser).
//
// ussRead() below therefore keeps IBM-1047 as the *first* attempt, but no
// longer treats it as the final answer: textScore() grades what came back,
// and only when that grade is bad does it spend a second request trying
// ISO8859-1. A real IBM-1047 file decodes cleanly on the first read and
// scores well, so it never reaches the fallback - which is what keeps this
// from regressing the racf-backend-recycle.sh case above. "Open with
// Encoding..." (openWithEncoding/pickEncoding) remains the manual override
// for anything the heuristic gets wrong, or for codepages outside these two.

// Fraction of characters that are plausible text: printable ASCII, plus the
// handful of whitespace controls real text actually contains. Deliberately
// counts only ASCII as "good" - EBCDIC bytes misread as Latin-1 land almost
// entirely in the C1 control range and the accented high range, which is
// precisely the signature being detected (and exactly what the garbled
// application.yml screenshot showed). Returns 1 for empty input so a
// zero-length file is never taken as evidence of the wrong codepage.
function textScore(s) {
  if (!s || !s.length) return 1;
  let good = 0;
  // Cap the scan: a few KB is plenty to tell text from mojibake, and this
  // must not become a per-open cost proportional to file size.
  const n = Math.min(s.length, 8192);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) good++;
  }
  return good / n;
}
// Below this, content is treated as "probably decoded through the wrong
// codepage". Normal source/config text sits at essentially 1.0; the EBCDIC-
// as-Latin-1 case sits far below. 0.85 leaves generous room for legitimately
// accented or non-English text without tripping.
const TEXT_SCORE_MIN = 0.85;
// Remembers which codepage each USS path was successfully *read* through, so
// ussWrite() can save it back the same way. Without this the auto-detect
// below would recreate the exact round-trip corruption it exists to prevent:
// a file read as ISO8859-1 but written back as IBM-1047 gets converted
// through a codepage it was never stored in. Keyed by path, populated only
// by ussRead() - "Open with Encoding..." tabs carry their own t.encoding and
// go through ussWriteEnc() instead, so the two mechanisms don't overlap.
const ussReadEncoding = Object.create(null);
async function ussRead(path) {
  const primary = await zCall('GET', '/zosmf/restfiles/fs/' + ussEncPath(path), { raw: true, headers: encHeaders('IBM-1047') });
  if (textScore(primary) >= TEXT_SCORE_MIN) { ussReadEncoding[path] = 'IBM-1047'; return primary; }
  // Looks like it was decoded through the wrong codepage - try the other
  // common case before giving up. Keep the better of the two rather than
  // blindly preferring the retry, so a file that is simply binary (bad
  // under both) still comes back as the IBM-1047 read it would have
  // returned before, instead of silently changing behavior.
  let alt;
  try { alt = await zCall('GET', '/zosmf/restfiles/fs/' + ussEncPath(path), { raw: true, headers: encHeaders('ISO8859-1') }); }
  catch (e) { ussReadEncoding[path] = 'IBM-1047'; return primary; }
  if (textScore(alt) > textScore(primary)) {
    ussReadEncoding[path] = 'ISO8859-1';
    flash('Opened as ISO8859-1 - IBM-1047 did not decode cleanly.', true);
    return alt;
  }
  ussReadEncoding[path] = 'IBM-1047';
  return primary;
}
// Saves through whichever codepage this path was last read through, so an
// auto-detected ISO8859-1 file round-trips intact instead of being written
// back as EBCDIC. Falls back to IBM-1047 for a path never read here (e.g.
// creating a brand-new file), which is the project's own convention.
async function ussWrite(path, text) {
  const enc = ussReadEncoding[path] || 'IBM-1047';
  await zCall('PUT', '/zosmf/restfiles/fs/' + ussEncPath(path), { body: text, headers: encHeaders(enc) });
}
async function ussDelete(path, isDir) {
  await zCall('DELETE', '/zosmf/restfiles/fs/' + ussEncPath(path), isDir ? { headers: { 'X-IBM-Option': 'recursive' } } : undefined);
}
async function ussCreate(path, type, mode) {
  await zCall('POST', '/zosmf/restfiles/fs/' + ussEncPath(path), {
    body: { type, mode: mode || (type === 'directory' ? 'rwxr-xr-x' : 'rw-r--r--') },
    isJson: true,
  });
}
async function ussChmod(path, mode) {
  await zCall('PUT', '/zosmf/restfiles/fs/' + ussEncPath(path), { body: { request: 'chmod', mode }, isJson: true });
}
// Atomic rename/move - confirmed against IBM's own z/OSMF Ansible collection
// source (zmf_file.py's operate_file_action(), action=='move': the PUT goes
// to the *new* path with {"request":"move","from":"<old path>"} in the
// body). One REST call, works for both files and directories (no recursive
// copy needed for a directory rename) - this replaces the old "no atomic
// USS rename" assumption noted here previously, which turned out to be
// wrong (or the API gained this since that note was written).
async function ussRename(oldPath, newPath) {
  await zCall('PUT', '/zosmf/restfiles/fs/' + ussEncPath(newPath), { body: { request: 'move', from: oldPath }, isJson: true });
}

// ---- "can we even show this as text?" guard -------------------------------
// z/OSMF's dataset-list call already tells us dsorg/recfm/migr for free (via
// the X-IBM-Attributes:base header used in dsList above), so for whole
// datasets we can catch the obvious non-text cases *before* attempting a
// read - VSAM clusters, migrated (HSM-archived) datasets, and RECFM=U
// load-module-style sequential datasets. This avoids both a confusing raw
// error and, worse, actually pulling a huge binary dataset's raw bytes into
// the browser (confirmed live: a VSAM cluster's base component returned
// HTTP 200 with tens of MB of binary garbage instead of erroring at all).
function dsKind(it) {
  const dsorg = (it.dsorg || '').toUpperCase();
  const recfm = (it.recfm || '').toUpperCase();
  if (dsorg.indexOf('VS') === 0) return 'vsam';
  if (it.migr === 'YES') return 'migrated';
  if (dsorg.indexOf('PO') !== 0 && recfm.indexOf('U') === 0) return 'loadmodule';
  return 'text';
}
function dsKindMessage(kind, dsn) {
  if (kind === 'vsam') return dsn + ' is a VSAM data set - it can\'t be opened as text here. Use IDCAMS, a batch job, or a VSAM-aware tool instead.';
  if (kind === 'migrated') return dsn + ' is migrated (archived by HSM) - recall it first (ISPF 3.4 "HRECALL" or an HRECALL job), then try again.';
  if (kind === 'loadmodule') return dsn + ' looks like a load module or other binary data set (RECFM=U) - it can\'t be shown as text here.';
  return null;
}
// Reactive fallback for cases the guard above can't catch client-side
// (e.g. opened via the context menu, which doesn't carry dsorg/recfm, or
// any other z/OSMF read/write failure) - pattern-matches the handful of
// common z/OSMF/USS error signatures into something readable, and falls
// back to the raw message untouched if nothing matches.
function friendlyZosmfError(message, label) {
  const m = (message || '').toLowerCase();
  if (m.indexOf('fopen') >= 0) {
    return label + ' can\'t be opened as text (fopen() failed on the z/OSMF side) - it\'s likely a VSAM cluster, load library, or other binary data set.';
  }
  if (m.indexOf('edc5111i') >= 0 || m.indexOf('permission denied') >= 0) {
    return 'Permission denied reading ' + label + ' - check RACF read access to it.';
  }
  if (m.indexOf('lminit') >= 0 || m.indexOf('data set in use') >= 0) {
    // z/OSMF's "list members of a PDS" call (GET .../ds/{dsn}/member) uses
    // ISPF Library Management services server-side under the caller's own
    // userid - which needs an exclusive ENQ on that user's own ISPF
    // profile dataset for the duration. Listing X.ISPF.PROFILE's own
    // members while any ISPF/TSO session for that user is active anywhere
    // (a native 3270 session, another browser tab of this console, etc.)
    // will always collide with that ENQ - it's expected ISPF behavior, not
    // a bug in this tool, and there's nothing worth browsing in a profile
    // dataset's members anyway. Confirmed live 2026-08-07 (YOURID hit this
    // expanding YOURID.ISPF.PROFILE in the tree).
    if (/\.ISPF\.PROFILE$/i.test(label)) {
      return label + ' - locked by your own ISPF/TSO session elsewhere. Not a bug.';
    }
    return label + ' - locked by another job/user (LMINIT). Try again later.';
  }
  if (m.indexOf('lmdlist') >= 0 || m.indexOf('catalog error') >= 0) {
    if (startsWithWildcard(label)) {
      return '"' + label + '" starts with a wildcard, so it had to search multiple catalogs, and one of them ' +
        'returned an error - z/OSMF\'s REST API aborts the whole search when that happens (ISPF 3.4 shows the ' +
        'same catalog error as a warning but still returns whatever it found). Try narrowing the pattern so it ' +
        'routes to one catalog instead, e.g. "*J.**" rather than "**.something" - use * to substitute for part ' +
        'of a qualifier instead of leaving the whole thing open.';
    }
    return 'Catalog error looking up ' + label + ' - it may not be cataloged, or the catalog search failed.';
  }
  if (m.indexOf('not cataloged') >= 0 || m.indexOf('not found') >= 0) {
    return label + ' was not found - check the name and that it\'s cataloged.';
  }
  return null;
}

// ==================== tree ====================
let currentDslevel = '';
// Maps dsn -> { isOpen, reload } for every PO dataset currently rendered in
// the tree, rebuilt fresh on every refreshTree(). Lets member-level
// operations (new member, rename, delete, paste) refresh just that PDS's
// child list in place instead of collapsing the whole tree back down via a
// full refreshTree() - see refreshMemberList() below.
let pdsNodeRegistry = new Map();
async function refreshTree() {
  const tree = $('#dsTree'); tree.innerHTML = '<div class="treeItem muted">Loading...</div>';
  pdsNodeRegistry = new Map();
  try {
    const items = await dsList(currentDslevel);
    tree.innerHTML = '';
    if (!items.length) { tree.innerHTML = '<div class="treeItem muted">No datasets found.</div>'; return; }
    items.forEach(it => tree.appendChild(renderDsNode(it)));
  } catch (e) { tree.innerHTML = ''; flash(friendlyZosmfError(e.message, currentDslevel) || ('List failed: ' + e.message), false); }
}
// Re-fetches just one PDS's member list in place, without collapsing or
// rebuilding the rest of the tree - used after creating/renaming/deleting
// a member so the PDS the user is actively working in stays expanded
// instead of everything snapping shut on every edit. A no-op if that PDS
// isn't currently expanded (nothing visible needs updating) or isn't in
// the current tree at all (e.g. a different HLQ filter is active).
async function refreshMemberList(dsn) {
  const node = pdsNodeRegistry.get(dsn);
  if (node && node.isOpen()) await node.reload();
}
// z/OSMF's dslevel filter (see dsList() above) allows wildcards in any
// qualifier, including the first - e.g. "*.COBOL" is valid, not just
// "HLQ.*". But a leading wildcard can't use catalog-alias routing to go
// straight to one user catalog the way an HLQ-first pattern can, so it may
// end up searching every catalog connected to the master catalog on this
// system - just a warning, not a block, since it's a real z/OS catalog
// architecture cost rather than something this console can optimize away.
function startsWithWildcard(pattern) { return /^[*%]/.test(pattern); }
$('#listBtn').onclick = () => {
  const val = $('#hlqFilter').value.trim() || ((localStorage.getItem('isiUser') || '') + '.*');
  if (startsWithWildcard(val) && !confirm(
    '"' + val + '" starts with a wildcard, so it can\'t be routed to a single catalog via HLQ alias - ' +
    'it may search every catalog on this system and be slow. Continue?'
  )) return;
  currentDslevel = val;
  refreshTree();
};
$('#refreshBtn').onclick = refreshTree;
$('#hlqFilter').addEventListener('keydown', e => { if (e.key === 'Enter') $('#listBtn').click(); });

function renderDsNode(it) {
  const dsn = it.dsname;
  const isPO = (it.dsorg || '').indexOf('PO') === 0;
  const kind = dsKind(it);
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'treeItem' + (isPO ? ' dir' : '') + (kind !== 'text' ? ' unsupported' : '');
  row.innerHTML = '<span>' + dsn + '</span>' + (it.dsorg ? ' <span class="muted">' + it.dsorg + (kind !== 'text' ? ' - not viewable' : '') + '</span>' : '');
  wrap.appendChild(row);
  // Sequential (non-PO) datasets are draggable straight into a pane -
  // members of a PDS get the same treatment individually, below.
  if (!isPO && kind === 'text') wireTreeDrag(row, { kind: 'ds', dsn, mbr: '' });
  const childWrap = document.createElement('div');
  childWrap.style.display = 'none';
  wrap.appendChild(childWrap);
  let loaded = false;

  async function loadMembers() {
    childWrap.innerHTML = '<div class="treeItem member muted">Loading...</div>';
    try {
      const members = await dsListMembers(dsn);
      loaded = true;
      childWrap.innerHTML = '';
      if (!members.length) childWrap.innerHTML = '<div class="treeItem member muted">(empty PDS)</div>';
      members.forEach(m => childWrap.appendChild(renderMemberNode(dsn, m)));
      const newRow = document.createElement('div');
      newRow.className = 'treeItem member new';
      newRow.textContent = '+ new member';
      newRow.onclick = (e) => { e.stopPropagation(); newMember(dsn); };
      childWrap.appendChild(newRow);
    } catch (e) {
      childWrap.innerHTML = '<div class="treeItem member muted errmsg">' + escHtml(friendlyZosmfError(e.message, dsn) || e.message) + '</div>';
    }
  }
  if (isPO) {
    pdsNodeRegistry.set(dsn, {
      isOpen: () => childWrap.style.display !== 'none',
      reload: loadMembers,
    });
  }

  row.onclick = async () => {
    if (!isPO) {
      if (kind !== 'text') { flash(dsKindMessage(kind, dsn), false); return; }
      openTab(dsn, '');
      return;
    }
    const opening = childWrap.style.display === 'none';
    childWrap.style.display = opening ? '' : 'none';
    row.classList.toggle('open', opening);
    if (opening && !loaded) await loadMembers();
  };
  row.oncontextmenu = e => showCtx(e, dsn, '', isPO, kind);
  // Only a PDS can receive a dropped file as a new member - same scope as
  // the "Upload file..." menu item above, which is also PO-only.
  if (isPO) wireFileDropTarget(row, (file) => uploadMember(dsn, file));
  return wrap;
}
function renderMemberNode(dsn, mbr) {
  const row = document.createElement('div');
  row.className = 'treeItem member';
  row.textContent = mbr;
  row.onclick = () => openTab(dsn, mbr);
  row.oncontextmenu = e => showCtx(e, dsn, mbr, false);
  wireTreeDrag(row, { kind: 'ds', dsn, mbr });
  return row;
}

// ==================== USS tree ====================
let currentUssPath = '';
async function refreshUssTree() {
  const tree = $('#ussTree'); tree.innerHTML = '<div class="treeItem muted">Loading...</div>';
  try {
    const items = await ussList(currentUssPath);
    tree.innerHTML = '';
    const visible = items.filter(it => it.name !== '.' && it.name !== '..');
    if (!visible.length) { tree.innerHTML = '<div class="treeItem muted">Empty directory.</div>'; return; }
    // Directories first, then files, both alphabetically - matches the
    // Zowe Explorer USS tree's default ordering.
    visible.sort((a, b) => {
      const ad = (a.mode || '')[0] === 'd', bd = (b.mode || '')[0] === 'd';
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    visible.forEach(it => tree.appendChild(renderUssNode(it, currentUssPath, null)));
  } catch (e) { tree.innerHTML = ''; flash('USS list failed: ' + e.message, false); }
}
function ussJoin(dir, name) {
  return (dir.endsWith('/') ? dir : dir + '/') + name;
}
// Every node carries `parentReload` - the function that refreshes *its own
// parent's* child list in place. Directories additionally build their own
// `loadChildren` closure, passed to their own context menu as `selfReload`
// for New file/New folder/Paste (which change *this* directory's
// contents), while `parentReload` is what Delete uses (removing this node
// changes the parent's listing, not this one's). Same in-place-refresh
// idea as pdsNodeRegistry for the dataset tree, just via closures instead
// of a registry Map since USS nesting is arbitrarily deep. Top-level items
// (directly under the browsed root) get parentReload=null, which falls
// back to a full refreshUssTree() - there's no separate "parent" node for
// the root itself.
function renderUssNode(it, parentPath, parentReload) {
  const path = ussJoin(parentPath, it.name);
  const isDir = (it.mode || '')[0] === 'd';
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'treeItem' + (isDir ? ' dir' : '');
  row.innerHTML = '<span>' + it.name + '</span>';
  wrap.appendChild(row);
  if (isDir) {
    const childWrap = document.createElement('div');
    // .treeChildren (console.css) adds a small left-padding step per
    // nesting level - was already defined for exactly this ("each nested
    // childWrap adds another indent so depth is visible") but never
    // actually applied here, so every depth rendered flush with no visual
    // indent at all.
    childWrap.className = 'treeChildren';
    childWrap.style.display = 'none';
    wrap.appendChild(childWrap);
    let loaded = false;
    async function loadChildren() {
      loaded = true;
      childWrap.innerHTML = '<div class="treeItem member muted">Loading...</div>';
      try {
        const items = await ussList(path);
        childWrap.innerHTML = '';
        const visible = items.filter(x => x.name !== '.' && x.name !== '..');
        if (!visible.length) { childWrap.innerHTML = '<div class="treeItem member muted">(empty)</div>'; return; }
        visible.sort((a, b) => {
          const ad = (a.mode || '')[0] === 'd', bd = (b.mode || '')[0] === 'd';
          if (ad !== bd) return ad ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        visible.forEach(x => childWrap.appendChild(renderUssNode(x, path, loadChildren)));
      } catch (e) {
        childWrap.innerHTML = '<div class="treeItem member muted">' + e.message + '</div>';
      }
    }
    row.onclick = async () => {
      const opening = childWrap.style.display === 'none';
      childWrap.style.display = opening ? '' : 'none';
      row.classList.toggle('open', opening);
      if (opening && !loaded) await loadChildren();
    };
    row.oncontextmenu = e => showUssCtx(e, path, true, loadChildren, parentReload);
    wireFileDropTarget(row, (file) => uploadUssFile(path, loadChildren, file));
  } else {
    row.classList.add('member');
    row.onclick = () => openUssTab(path);
    row.oncontextmenu = e => showUssCtx(e, path, false, null, parentReload);
    wireTreeDrag(row, { kind: 'uss', path });
  }
  return wrap;
}
function showUssCtx(e, path, isDir, selfReload, parentReload) {
  const items = [];
  if (!isDir) {
    items.push(['Open', () => openUssTab(path)]);
    items.push(['Open (Browse)', () => openUssTab(path, { readOnly: true })]);
    items.push(['Open with Encoding...', () => openWithEncoding('uss', { path })]);
    items.push(['Pull from Mainframe', () => pullFromMainframeByRef('uss', { path })]);
    items.push('-');
    items.push(['Copy', () => setUssClip('copy', path)]);
    items.push(['Cut', () => setUssClip('move', path)]);
  } else {
    items.push(['New file...', () => newUssFile(path, selfReload)]);
    items.push(['New folder...', () => newUssFolder(path, selfReload)]);
    items.push(['Upload file...', () => uploadUssFile(path, selfReload)]);
    if (ussClip) items.push(['Paste', () => ussPasteInto(path, selfReload)]);
  }
  items.push('-');
  if (!isDir) items.push(['Download', () => downloadUssFile(path)]);
  const favRef = { kind: 'uss', path, isDir, label: path };
  items.push([isFavorite(favRef) ? 'Remove from Favorites' : 'Add to Favorites', () => toggleFavorite(favRef)]);
  items.push('-');
  if (!isDir) {
    const cmp = { kind: 'uss', path, label: path };
    items.push(compareSelection ? ['Compare with Selected', () => compareWithSelected(cmp)] : ['Select for Compare', () => selectForCompare(cmp)]);
    items.push('-');
  }
  items.push(['Copy Path', () => copyNameToClipboard(path)]);
  items.push('-');
  items.push(['Edit Attributes...', () => editUssAttributes(path)]);
  items.push([isDir ? 'Rename folder...' : 'Rename...', () => renameUssItem(path, isDir, parentReload)]);
  items.push([isDir ? 'Delete folder' : 'Delete', () => deleteUssItem(path, isDir, parentReload)]);
  ctxShow(e, items);
}
let ussClip = null; // {op:'copy'|'move', path}
function setUssClip(op, path) {
  ussClip = { op, path };
  flash((op === 'move' ? 'Cut ' : 'Copied ') + path + ' - right-click a destination folder to paste', true);
}
async function ussPasteInto(destDir, selfReload) {
  if (!ussClip) return;
  const suggested = ussClip.path.split('/').pop();
  const nv = prompt('File name in ' + destDir + ':', suggested);
  if (!nv) return;
  const destPath = ussJoin(destDir, nv.trim());
  try {
    const text = await ussRead(ussClip.path);
    await ussWrite(destPath, text);
    if (ussClip.op === 'move') await ussDelete(ussClip.path, false);
    flash('Pasted ' + destPath, true);
    ussClip = null;
    if (selfReload) selfReload(); else refreshUssTree();
  } catch (e) { flash('Paste failed: ' + e.message, false); }
}
async function newUssFile(dir, selfReload) {
  const nv = prompt('New file name in ' + dir + ':', '');
  if (!nv) return;
  const path = ussJoin(dir, nv.trim());
  try {
    await ussCreate(path, 'file');
    flash('Created ' + path, true);
    if (selfReload) selfReload(); else refreshUssTree();
    openUssTab(path);
  } catch (e) { flash('Create failed: ' + e.message, false); }
}
// `file`, if supplied, is a real File object already in hand (a drag-drop
// from the OS) - skips the file picker and reads straight from it. Left
// undefined for the normal "Upload file..." menu path, which still opens
// the picker itself.
async function uploadUssFile(dir, selfReload, file) {
  let picked;
  if (file) {
    try { picked = { name: file.name, text: await readFileAsText(file) }; }
    catch (e) { flash('Could not read ' + file.name + ': ' + e.message, false); return; }
  } else {
    picked = await pickLocalTextFile();
    if (!picked) return;
  }
  const nv = prompt('Upload ' + picked.name + ' as file name in ' + dir + ':', picked.name);
  if (!nv) return;
  const path = ussJoin(dir, nv.trim());
  try {
    await ussWrite(path, picked.text);
    flash('Uploaded ' + picked.name + ' to ' + path, true);
    if (selfReload) selfReload(); else refreshUssTree();
    // If it's already open in a tab (re-uploading over something you're
    // editing), refresh that tab's content in place too rather than
    // leaving it showing the pre-upload text with a stale "unsaved" state.
    const open = tabs.find(t => t.kind === 'uss' && t.path === path);
    if (open) {
      open.text = picked.text; open.dirty = false;
      renderTabsFor(open.pane);
      if (panes[open.pane] && panes[open.pane].activeId === open.id) renderEditorFor(open.pane);
    }
  } catch (e) { flash('Upload failed: ' + e.message, false); }
}
// ==================== upload a local file ====================
// Reads a file picked from the user's own computer via a hidden <input
// type="file"> - resolves to {name, text}, or null if the picker was
// cancelled (the 'cancel' event on <input type=file> is a fairly recent
// addition but well-supported in current Chrome/Edge/Firefox; if a much
// older browser doesn't fire it, cancelling just leaves the promise
// pending, same as never having picked a file - harmless, nothing else in
// this flow depends on it resolving). Always builds a fresh <input>
// instead of reusing one, since a file input's change event doesn't refire
// on most browsers if the exact same file is picked twice in a row.
// Reads as text (not binary) - consistent with the rest of this console,
// which is a source-code editor throughout and has no binary-file support
// anywhere else either.
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read ' + file.name));
    reader.readAsText(file);
  });
}
function pickLocalTextFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => { if (input.isConnected) document.body.removeChild(input); };
    input.addEventListener('cancel', () => { cleanup(); resolve(null); });
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      cleanup();
      if (!file) { resolve(null); return; }
      readFileAsText(file).then(text => resolve({ name: file.name, text })).catch(() => resolve(null));
    });
    input.click();
  });
}
// ==================== drag-and-drop upload from the OS ====================
// Lets you drag a file straight out of Windows Explorer/Finder onto a PDS
// or USS directory row - separate from wireTreeDrag() (which makes tree
// rows draggable *sources*, for dragging *into* an editor pane) and from
// the pane-level drag/drop (which only reacts to this app's own custom
// application/x-isi-* payloads). This reacts to the browser's native
// 'Files' drag type instead, which an OS-level file drag carries and this
// app's own in-app drags never do, so the two can never collide on the
// same element.
function isFileDrag(e) {
  return e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
}
// Shared by both the dataset and USS wiring below - `doUpload(file)` is
// whichever upload function actually applies (uploadMember/uploadUssFile),
// already bound to its target dsn/path. Multiple dropped files upload one
// at a time (each has its own member/file-name prompt), rather than
// firing all their prompts at once.
function wireFileDropTarget(el, doUpload) {
  el.addEventListener('dragover', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('dropTargetFile');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('dropTargetFile');
  });
  el.addEventListener('drop', async e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('dropTargetFile');
    for (const file of Array.from(e.dataTransfer.files)) await doUpload(file);
  });
}
async function newUssFolder(dir, selfReload) {
  const nv = prompt('New folder name in ' + dir + ':', '');
  if (!nv) return;
  const path = ussJoin(dir, nv.trim());
  try {
    await ussCreate(path, 'directory');
    flash('Created ' + path, true);
    if (selfReload) selfReload(); else refreshUssTree();
  } catch (e) { flash('Create failed: ' + e.message, false); }
}
async function editUssAttributes(path) {
  const mode = prompt('New permissions for ' + path + ' (octal, e.g. 755):', '755');
  if (!mode) return;
  if (!/^[0-7]{3,4}$/.test(mode.trim())) { flash('Enter an octal mode like 755 or 0755', false); return; }
  try {
    await ussChmod(path, mode.trim());
    flash('Updated permissions on ' + path, true);
  } catch (e) { flash('Edit attributes failed: ' + e.message, false); }
}
async function renameUssItem(path, isDir, parentReload) {
  const oldName = path.split('/').pop();
  const parentDir = path.slice(0, path.length - oldName.length); // includes trailing "/"
  const nv = prompt('Rename ' + path + ' to:', oldName);
  if (!nv) return;
  const newName = nv.trim();
  if (!newName || newName === oldName) return;
  if (newName.indexOf('/') >= 0) { flash('New name can\'t contain "/" - use Cut/Paste to move it to a different folder instead.', false); return; }
  const newPath = parentDir + newName;
  try {
    await ussRename(path, newPath);
    // Keep any open tabs pointing at this file (or, for a directory rename,
    // anything nested underneath it) in sync with the new path.
    tabs.forEach(t => {
      if (t.kind !== 'uss') return;
      if (t.path === path) t.path = newPath;
      else if (isDir && t.path.indexOf(path + '/') === 0) t.path = newPath + t.path.slice(path.length);
    });
    renderAllTabbars();
    flash('Renamed to ' + newPath, true);
    if (parentReload) parentReload(); else refreshUssTree();
  } catch (e) { flash(friendlyZosmfError(e.message, path) || ('Rename failed: ' + e.message), false); }
}
async function deleteUssItem(path, isDir, parentReload) {
  if (!confirm('Delete ' + path + (isDir ? ' and everything inside it' : '') + '? This cannot be undone.')) return;
  try {
    await ussDelete(path, isDir);
    tabs = tabs.filter(t => !(t.kind === 'uss' && t.path === path));
    reconcilePanesAfterTabsRemoved();
    flash('Deleted ' + path, true);
    if (parentReload) parentReload(); else refreshUssTree();
  } catch (e) { flash('Delete failed: ' + e.message, false); }
}
async function downloadUssFile(path) {
  try {
    const text = await ussRead(path);
    downloadText(path.split('/').pop() || 'file.txt', text);
    flash('Downloaded ' + path, true);
  } catch (e) { flash('Download failed: ' + e.message, false); }
}
async function submitUssAsJCL(path) {
  const open = tabs.find(t => t.kind === 'uss' && t.path === path);
  let text = open ? open.text : null;
  if (text === null) {
    try { text = await ussRead(path); }
    catch (e) { flash('Submit failed: ' + e.message, false); return; }
  }
  try {
    const r = await zCall('PUT', '/zosmf/restjobs/jobs', { body: text });
    flash('Submitted ' + r.jobname + ' (' + r.jobid + ') - see the Jobs section', true);
    showJobToast(r.jobname, r.jobid);
  } catch (e) { flash('Submit failed: ' + e.message, false); }
}
// Right-clicking empty space in the tree (not on any row) targets the
// currently-browsed root - same pattern as #dsTree's own root-level paste.
$('#ussTree').addEventListener('contextmenu', e => {
  if (e.target.id !== 'ussTree') return;
  const items = [
    ['New file...', () => newUssFile(currentUssPath, null)],
    ['New folder...', () => newUssFolder(currentUssPath, null)],
    ['Upload file...', () => uploadUssFile(currentUssPath, null)],
  ];
  if (ussClip) items.push(['Paste', () => ussPasteInto(currentUssPath, null)]);
  ctxShow(e, items);
});
// Dropping a file on empty tree space (not any specific row) targets
// whatever directory is currently being browsed - individual row drop
// targets (wireFileDropTarget above) stop propagation on their own
// dragover/drop, so this only ever fires for a drop that didn't land on a
// more specific folder.
wireFileDropTarget($('#ussTree'), (file) => uploadUssFile(currentUssPath, null, file));

// ---- USS breadcrumb bar: up / refresh / search+recent-filters popover ----
// The "search" affordance from the Zowe Explorer screenshot used as a reference
// is really just "jump to a path", with a remembered history of recent
// ones (a Zowe "USS filter" is literally the root path you're browsing) -
// there's no cross-directory filename search in z/OSMF's Files API to back
// a real full-text search, so this reproduces the navigation UX rather
// than promising something the REST API can't do.
const USS_RECENT_KEY = 'isiUssRecentPaths';
function loadUssRecent() {
  try { return JSON.parse(localStorage.getItem(USS_RECENT_KEY) || '[]'); } catch (e) { return []; }
}
function pushUssRecent(path) {
  let recent = loadUssRecent().filter(p => p !== path);
  recent.unshift(path);
  recent = recent.slice(0, 15);
  try { localStorage.setItem(USS_RECENT_KEY, JSON.stringify(recent)); } catch (e) { /* ignore */ }
}
function renderUssRecent() {
  const list = $('#ussRecentList'); if (!list) return;
  const recent = loadUssRecent();
  if (!recent.length) { list.innerHTML = '<div class="treeItem muted">No recent paths yet.</div>'; return; }
  list.innerHTML = recent.map(p => '<div class="ussRecentItem">' + escHtml(p) + '</div>').join('');
  list.querySelectorAll('.ussRecentItem').forEach((el, i) => {
    el.onclick = () => goToUssPath(recent[i]);
  });
}
function goToUssPath(path) {
  currentUssPath = (path || '').trim() || '/';
  $('#ussCurPath').textContent = currentUssPath;
  $('#ussFilterPop').classList.remove('show');
  pushUssRecent(currentUssPath);
  refreshUssTree();
}
$('#ussSearchBtn').onclick = (e) => {
  e.stopPropagation();
  renderUssRecent();
  $('#ussPathFilter').value = currentUssPath;
  $('#ussFilterPop').classList.toggle('show');
  if ($('#ussFilterPop').classList.contains('show')) $('#ussPathFilter').focus();
};
$('#ussFilterGo').onclick = () => goToUssPath($('#ussPathFilter').value);
$('#ussPathFilter').addEventListener('keydown', e => { if (e.key === 'Enter') goToUssPath($('#ussPathFilter').value); });
// Click-to-edit the current path directly in the breadcrumb bar, instead of
// always having to open the search popover first just to jump somewhere.
// Swaps #ussCurPath (display) for #ussCurPathEdit (a real input) in place -
// Enter commits via the existing goToUssPath() (which also re-renders
// #ussCurPath's text), Escape or clicking away cancels back to the display
// span with no navigation.
function wireUssCurPathEdit() {
  const disp = $('#ussCurPath');
  const edit = $('#ussCurPathEdit');
  if (!disp || !edit) return;
  const startEdit = () => {
    edit.value = currentUssPath;
    disp.style.display = 'none';
    edit.style.display = '';
    edit.focus();
    edit.select();
  };
  const endEdit = () => {
    edit.style.display = 'none';
    disp.style.display = '';
  };
  disp.onclick = startEdit;
  edit.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goToUssPath(edit.value); endEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
  };
  edit.onblur = endEdit;
}
wireUssCurPathEdit();
$('#ussUpBtn').onclick = () => {
  const parts = currentUssPath.replace(/\/+$/, '').split('/').filter(Boolean);
  parts.pop();
  goToUssPath('/' + parts.join('/'));
};
$('#ussRefreshBtn').onclick = refreshUssTree;
document.addEventListener('click', (e) => {
  const pop = $('#ussFilterPop');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target) && e.target.id !== 'ussSearchBtn') {
    pop.classList.remove('show');
  }
});

// ==================== syntax highlighting + column ruler ====================
// Hand-rolled, zero dependencies - a transparent textarea sits on top of a
// <pre><code> that shows the colorized text underneath (kept scroll-synced
// with it), plus a line-number gutter and a format-aware column ruler above
// it. Same technique, and largely the same JCL/REXX keyword set, as the old
// TK5 Explorer in source/console.js - ported here because none of it is
// actually TK5/Hercules-specific, it's just plain JS/CSS.
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const KW_JCL_REXX = 'JOB|EXEC|PEND|PROC|IF|THEN|ELSE|ENDIF|INCLUDE|OUTPUT|SET|JCLLIB|DD|CNTL|ENDCNTL|JOBLIB|COPY|EXCLUDE|SELECT|SCRATCH|RENAME|CATALOG|VOL|DSNAME|MEMBER|ADDRESS|ARG|CALL|DO|DROP|EXIT|INTERPRET|ITERATE|LEAVE|NOP|NUMERIC|OPTIONS|OTHERWISE|PARSE|PROCEDURE|PULL|PUSH|QUEUE|RETURN|SAY|SIGNAL|TRACE|UPPER|LOWER|WHEN|EXPOSE|FOREVER|TO|BY|WHILE|UNTIL|VALUE|WITH|VAR';
// COBOL reserved words worth calling out - division/section headers,
// PROGRAM-ID, the data-description clauses, and the common verbs. Not
// exhaustive (COBOL has several hundred reserved words), just the ones
// likely to actually show up in typical source, matching the VS Code/Zowe
// reference used for this.
const KW_COBOL = 'IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE|DIVISION|SECTION|PROGRAM-ID|AUTHOR|CONFIGURATION|SOURCE-COMPUTER|OBJECT-COMPUTER|SPECIAL-NAMES|INPUT-OUTPUT|FILE-CONTROL|FILE|WORKING-STORAGE|LINKAGE|LOCAL-STORAGE|SELECT|ASSIGN|ORGANIZATION|FD|PIC|PICTURE|VALUE|VALUES|OCCURS|REDEFINES|USAGE|COMP|COMP-3|COMPUTATIONAL|DISPLAY|ACCEPT|MOVE|ADD|SUBTRACT|MULTIPLY|DIVIDE|COMPUTE|IF|ELSE|END-IF|EVALUATE|WHEN|END-EVALUATE|PERFORM|UNTIL|VARYING|THRU|THROUGH|TIMES|END-PERFORM|GO|GOBACK|STOP|RUN|CALL|USING|RETURNING|EXIT|CONTINUE|NEXT|SENTENCE|OPEN|CLOSE|READ|WRITE|REWRITE|DELETE|INTO|FROM|GIVING|TO|OF|IN|IS|ARE|NOT|AND|OR|GREATER|LESS|THAN|EQUAL|STRING|UNSTRING|INSPECT|INITIALIZE|SET|SEARCH|SORT|MERGE';
// Built per-format rather than once, because the assembler "name field"
// group below only makes sense for assembler source - a bare word sitting
// in column 1 means "this is a label" in HLASM, but would be a false
// positive for JCL/REXX/plain text (where column 1 has no such meaning).
// Small enough (and re-highlighting already reruns on every keystroke
// anyway) that rebuilding the regex per call isn't worth caching.
function buildTokRe(fmt) {
  const asmLabel = fmt === 'asm' ? '|(?<asmlbl>^[A-Za-z$#@][\\w$#@]*)' : '';
  const kwList = fmt === 'cobol' ? KW_COBOL : KW_JCL_REXX;
  return new RegExp(
    '(?<cmtblock>/\\*[\\s\\S]*?\\*/)' +
    '|(?<cmtjcl>^[ \\t]*//\\*.*$)' +
    '|(?<cmtasm>^[ \\t]*\\*.*$)' +
    // No gap allowed between "//" and the name field - a real JCL statement
    // name sits immediately in columns 3+ (e.g. "//STEPNAME"). A JCL
    // continuation line has "//" followed by *blank* columns before the
    // operand resumes (e.g. "//  PARM='-aggregate ...'"), so allowing
    // [ \t]* here (as this used to) let \S+ greedily swallow the first
    // word of the continued operand - including an opening quote - as a
    // "name" token. That orphaned the matching closing quote later on the
    // same line, which then opened a brand-new, never-terminated string
    // that swallowed the rest of the file in the string color until the
    // next stray apostrophe happened to "close" it.
    '|(?<name>^[ \\t]*//\\S+)' +
    asmLabel +
    "|(?<str1>'(?:[^']|'')*')" +
    '|(?<str2>"(?:[^"\\\\]|\\\\.)*")' +
    '|(?<kw>\\b(?:' + kwList + ')\\b)' +
    '|(?<num>\\b\\d+\\b)',
    'gim'
  );
}
function tokenizeSegment(text, re) {
  let out = '', last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out += escHtml(text.slice(last, m.index));
    const g = m.groups;
    const cls = (g.cmtblock || g.cmtjcl || g.cmtasm) ? 'tok-cmt'
      : g.name ? 'tok-name'
      : g.asmlbl ? 'tok-label'
      : (g.str1 || g.str2) ? 'tok-str'
      : g.kw ? 'tok-kw'
      : g.num ? 'tok-num' : null;
    out += cls ? '<span class="' + cls + '">' + escHtml(m[0]) + '</span>' : escHtml(m[0]);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out += escHtml(text.slice(last));
  return out;
}
// HLASM's free-text comment field (whatever trails the operand) isn't
// delimited by anything - it just starts wherever the operand ends, which
// the regex-based tokenizer above can't find on its own without tracking
// quote state field by field (an apostrophe in an ordinary word like
// "CALLER'S" would otherwise look identical to the start of a string
// literal, and swallow everything up to the next quote - including a real
// string later in the same line). This walks a single assembler line
// character by character to find where the comment actually begins: after
// the label (if col 1 is non-blank) and operation have gone by, the first
// run of 2+ blanks that isn't inside a quoted string.
function findAsmCommentStart(line) {
  const hasLabel = line.length > 0 && line[0] !== ' ' && line[0] !== '\t';
  const needed = hasLabel ? 3 : 2;
  let inStr = false, inField = false, fieldCount = 0, i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (inStr) {
      if (ch === "'") {
        if (line[i + 1] === "'") { i += 2; continue; }
        inStr = false;
      }
      i++; continue;
    }
    if (ch === "'") {
      inStr = true;
      if (!inField) { inField = true; fieldCount++; }
      i++; continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inField) {
        inField = false;
        let j = i;
        while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
        if ((j - i) >= 2 && fieldCount >= needed) return j < n ? j : -1;
        i = j; continue;
      }
      i++; continue;
    }
    if (!inField) { inField = true; fieldCount++; }
    i++;
  }
  return -1;
}
function highlightCode(text, fmt) {
  // 'plain' (SYSLOG, job spool files, and the editor's own "Plain" format
  // option) was falling all the way through to tokenizeSegment() below with
  // no early return, which builds its regex from the JCL/REXX keyword list
  // regardless of fmt - ordinary SYSLOG words like "TO", "JOB", and "VOL"
  // (all real REXX/JCL keywords) were getting wrapped in colored <span>
  // tags. That's a purely cosmetic bug in the highlight overlay, but it
  // looked exactly like a broken/inconsistent text *selection* when
  // reported, since the spurious keyword coloring sits under the same
  // selection highlight and makes some words look like they didn't get
  // selected right. Plain text needs zero tokenization - just escape it.
  if (fmt === 'plain') return escHtml(text) || '&nbsp;';
  if (fmt === 'asm') {
    const re = buildTokRe('asm');
    const out = text.split('\n').map(line => {
      if (/^\*/.test(line)) return '<span class="tok-cmt">' + escHtml(line) + '</span>';
      const cIdx = findAsmCommentStart(line);
      const codePart = cIdx === -1 ? line : line.slice(0, cIdx);
      const cmtPart = cIdx === -1 ? '' : line.slice(cIdx);
      let seg = tokenizeSegment(codePart, re);
      if (cmtPart) seg += '<span class="tok-cmt">' + escHtml(cmtPart) + '</span>';
      return seg;
    }).join('\n');
    return out || '&nbsp;';
  }
  return tokenizeSegment(text, buildTokRe(fmt)) || '&nbsp;';
}

// JCL, assembler, COBOL and PL/I all treat column 72 as the end of the
// significant coding area (continuation flag for JCL/ASM; end of Area B for
// COBOL; end of the default MARGINS(2,72) for PL/I) and column 80 as the
// old card-image limit - z/OSMF doesn't enforce either one for you when you
// save, so this just makes them visible instead of silent.
// (This is exactly the class of bug that bit source/sumloop.asm on TK5.)
function buildRuler(fmt) {
  const width = 200, marked = (fmt === 'jcl' || fmt === 'asm' || fmt === 'cobol' || fmt === 'pli');
  let html = '';
  for (let c = 1; c <= width; c++) {
    const ch = (c % 10 === 0) ? String(Math.floor(c / 10) % 10) : (c % 5 === 0 ? '+' : '-');
    let cls = '';
    if (marked && c === 72) cls = 'mark72';
    else if (marked && c === 80) cls = 'mark80';
    html += cls ? '<span class="' + cls + '" title="col ' + c + (c === 72 ? ' - continuation flag' : ' - card-image limit') + '">' + ch + '</span>' : ch;
  }
  return html;
}
// Naming-convention fallback - only reached when there's no content yet to
// sniff (a brand-new empty member) or the content itself is inconclusive.
// Nothing here is required by the system the way, say, REXX's first-line
// rule is; it's just a hint, and plenty of real shops don't follow any
// dataset naming convention at all.
function guessFormat(dsn, mbr) {
  const name = (dsn + '.' + (mbr || '')).toUpperCase();
  if (name.indexOf('JCL') >= 0) return 'jcl';
  if (name.indexOf('COBOL') >= 0 || name.indexOf('CBL') >= 0 || name.indexOf('COB') >= 0) return 'cobol';
  if (name.indexOf('PLI') >= 0 || name.indexOf('PL1') >= 0) return 'pli';
  if (name.indexOf('ASM') >= 0) return 'asm';
  if (name.indexOf('EXEC') >= 0 || name.indexOf('REXX') >= 0 || name.indexOf('RX') >= 0) return 'rexx';
  return 'plain';
}
function firstNonBlankLine(text, maxScan) {
  let start = 0;
  while (start < text.length && start < maxScan) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const line = text.slice(start, nl);
    if (line.trim() !== '') return line;
    start = nl + 1;
  }
  return '';
}
// Content-based detection, tried before the naming-convention fallback
// above - the file's actual syntax is far more reliable than a name
// nobody's obligated to follow, and an 8-character PDS member name barely
// has room to spell out "COBOL" in the first place. Ordered by
// confidence: REXX and JCL are checked first because they're essentially
// deterministic (TSO/E literally requires an exec's first statement to be
// a comment containing the word REXX, and every real JCL statement starts
// with // in columns 1-2 - neither is just "usually looks like this," the
// way the COBOL/assembler/PL-I checks below are). Only scans a bounded
// window of the text, not the whole file, so this stays cheap even
// against a large sequential dataset - and it's still far cheaper than
// the full regex tokenization that already runs on every keystroke for
// syntax highlighting itself.
function sniffFormat(text) {
  if (!text) return null;
  const first = firstNonBlankLine(text, 500);
  const firstTrim = first.trimStart();
  if (!firstTrim) return null; // nothing typed yet - e.g. a brand-new empty member
  if (firstTrim.startsWith('/*') && /\bREXX\b/i.test(first)) return 'rexx';
  if (firstTrim.startsWith('//')) return 'jcl';
  const head = text.slice(0, 4000);
  // COBOL: a DIVISION header or PROGRAM-ID clause is COBOL-specific.
  if (/\bIDENTIFICATION\s+DIVISION\b/i.test(head) || /\bPROGRAM-ID\b/i.test(head)) return 'cobol';
  // HLASM: CSECT/DSECT/RSECT/START are assembler control-section
  // directives that don't show up in any of the other formats.
  if (/^[ \t]*[A-Za-z$#@][\w$#@]*[ \t]+(CSECT|DSECT|RSECT|START)\b/im.test(head) || /^[ \t]*(CSECT|DSECT|RSECT)\b/im.test(head)) return 'asm';
  // PL/I: a labeled PROCEDURE statement ("name: PROC"/"name: PROCEDURE")
  // or a %PROCESS/%INCLUDE compiler directive are both PL/I-specific.
  if (/:\s*PROC(?:EDURE)?\b/i.test(head) || /^[ \t]*%(PROCESS|INCLUDE)\b/im.test(head)) return 'pli';
  return null;
}
function guessFormatFor(t) {
  if (t.kind === 'job' || t.kind === 'syslog') return 'plain'; // never fixed-column source
  return sniffFormat(t.text) || (t.kind === 'uss' ? guessFormat(t.path, '') : guessFormat(t.dsn, t.mbr));
}
function effectiveFormat(t) { return t.fmt || guessFormatFor(t); }

// Vertical guide lines at each format's classic fixed-column field
// boundaries. Each line marks a column *boundary* (right edge of the
// numbered column), so a value of N draws the line between column N and
// N+1 - that's why paired values like 10/11 or 8/9 "box in" a single
// mandatory blank separator column between two fields.
//
// JCL (coding form): col 2 (end of "//"), 10 (end of the 8-char name
// field), 11 (mandatory blank after the name), 15 (end of the 4-char
// operation field), 16 (mandatory blank before the operand field), 72
// (continuation flag). Verified against a real VS Code + Zowe Explorer
// reference screenshot.
//
// Assembler (HLASM Language Reference: name field starts col 1, operation
// field starts col 10, operand field starts col 16, continuation flag col
// 72 - https://www.ibm.com/docs/en/SSLTBW_2.2.0/pdf/asmr1022.pdf): col 8
// (end of the 8-char name field), 9 (mandatory blank), 14 (end of the
// 5-char operation field), 15 (mandatory blank before the operand field),
// 72 (continuation flag). 8+1+5+1+56+1+8 = 80 columns exactly.
//
// COBOL (fixed format): col 6 (end of the 6-char sequence area), 7 (the
// indicator column itself - *, -, /, D), 11 (end of Area A / start of Area
// B - no separator column between them), 72 (end of Area B; cols 73-80 are
// an unprocessed identification field).
//
// PL/I (fixed format, default compiler option MARGINS(2,72)): col 1 (the
// single reserved/margin column), 72 (right margin; cols 73-80 are an
// optional, unprocessed sequence-number field). PL/I has no Area A/B split
// - it's free-form within the margins.
const JCL_GUIDE_COLS = [2, 10, 11, 15, 16, 72];
const ASM_GUIDE_COLS = [8, 9, 14, 15, 72];
const COBOL_GUIDE_COLS = [6, 7, 11, 72];
const PLI_GUIDE_COLS = [1, 72];
let CHAR_WIDTH = null;
function measureCharWidth() {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.font = '13px/1.5 "SF Mono", Consolas, "Courier New", monospace';
  probe.textContent = '0'.repeat(100);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 100;
  document.body.removeChild(probe);
  return w || 7.8;
}
// Tracks which pane + column set is currently built inside that pane's
// #edGuides, so a scroll event (which calls this constantly) doesn't
// rebuild the DOM every time - but renderEditorFor() replaces #edGuides
// itself on every tab open/switch, so the check is keyed on the *element
// instance* per pane (guidesBuiltFor, declared with the rest of the pane
// state above), not just the column list, or a same-format tab switch
// would silently leave the new (empty) container un-populated.
function positionGuides(paneId, fmt) {
  const root = paneRootEls[paneId];
  const guides = root && root.querySelector('#edGuides');
  if (!guides) return;
  const marked = (fmt === 'jcl' || fmt === 'asm' || fmt === 'cobol' || fmt === 'pli');
  guides.style.display = marked ? '' : 'none';
  if (!marked) { guidesBuiltFor[paneId] = null; return; }
  if (CHAR_WIDTH === null) CHAR_WIDTH = measureCharWidth();
  const cols = fmt === 'jcl' ? JCL_GUIDE_COLS
    : fmt === 'cobol' ? COBOL_GUIDE_COLS
    : fmt === 'pli' ? PLI_GUIDE_COLS
    : ASM_GUIDE_COLS;
  if (guidesBuiltFor[paneId] !== guides) {
    guides.innerHTML = cols.map(c =>
      '<div class="edGuideLine' + (c === 72 ? ' mark72' : ' field') + '" data-col="' + c + '"></div>'
    ).join('');
    guidesBuiltFor[paneId] = guides;
  }
  const area = root.querySelector('#editorArea');
  const leftPad = 16; // matches .edText/.edHl padding-left in console.css
  const scrollLeft = area ? area.scrollLeft : 0;
  guides.querySelectorAll('.edGuideLine').forEach(el => {
    const c = parseInt(el.dataset.col, 10);
    el.style.left = (leftPad + c * CHAR_WIDTH - scrollLeft) + 'px';
  });
}

// ==================== tabs / editor ====================
// Three tab shapes, distinguished by `kind`:
//   ds:  { id, kind:'ds',  dsn, mbr, text, dirty, fmt, isNew }
//   uss: { id, kind:'uss', path, text, dirty, fmt }
//   job: { id, kind:'job', jobname, jobid, stepname, ddname, fileId, text, dirty:false, fmt, readOnly:true }
// ds/uss tabs are editable and save back to z/OSMF; job tabs are always
// read-only spool content (matching the Zowe Explorer reference screenshot
// - a job's DD statements open in a locked tab, never writable).
let tabs = [];
let nextId = 1;

// ==================== split-pane editor layout ====================
// A binary split tree, same model VS Code/tmux/i3 use: a leaf is one
// visible editor group (its own tab bar + editor body); a split is a
// row (side-by-side) or col (stacked) pair of children with flex sizes.
// Tabs stay in the single flat `tabs` array (unchanged) - each tab just
// gains a `.pane` field saying which leaf it belongs to. Per-pane find/
// replace state (findMatches/findIndex/findTerm/findAnchor) lives on the
// pane object itself, not as module-level globals, since multiple panes
// can each have their own find bar open at once.
let panes = {};          // paneId -> { id, activeId, findMatches, findIndex, findTerm, findAnchor }
let paneLayout = null;   // {type:'leaf', id} | {type:'split', dir:'row'|'col', children:[...], sizes:[...]}
let focusedPaneId = null; // last pane the user clicked/typed into - target for keyboard shortcuts, tree "open"
let nextPaneId = 1;
const paneRootEls = {};  // paneId -> its .paneLeaf DOM element (reused across re-layouts, never recreated)
const guidesBuiltFor = {}; // paneId -> #edGuides element instance last built (see positionGuides)

function curTab() {
  const p = panes[focusedPaneId];
  return p ? tabs.find(t => t.id === p.activeId) : undefined;
}
function tabsInPane(paneId) { return tabs.filter(t => t.pane === paneId); }
function makePane() {
  const id = 'p' + (nextPaneId++);
  panes[id] = { id, activeId: null, findMatches: [], findIndex: -1, findTerm: '', findAnchor: 0 };
  return id;
}
function initPanes() {
  const id = makePane();
  paneLayout = { type: 'leaf', id };
  focusedPaneId = id;
}

// ==================== layout persistence (survive sign-out/sign-in) ====================
// Remembers which tabs were open, in what pane split arrangement, and
// which pane/tab was focused - keyed per user (localStorage key includes
// isiUser) so two different people signing in on the same browser never
// see each other's open files. Deliberately does NOT persist tab content
// or dirty/unsaved state - only enough identity (dsn/mbr, USS path, or job
// refs) to reopen each tab fresh from z/OSMF on restore, exactly like
// every other "open" path in this file already does. A tab that fails to
// reopen (deleted since, access revoked, spool purged, etc) is skipped
// individually - openTab/openUssTab/openJobFile already flash() their own
// errors, so the rest of the restore just continues around it.
function layoutStorageKey() {
  const u = localStorage.getItem('isiUser');
  return 'isiLayout:' + (u || 'anon');
}
function serializeTab(t) {
  const base = { kind: t.kind, pane: t.pane, fmt: t.fmt || null, encoding: t.encoding || null };
  if (t.kind === 'ds') return Object.assign(base, { dsn: t.dsn, mbr: t.mbr });
  if (t.kind === 'uss') return Object.assign(base, { path: t.path });
  if (t.kind === 'job') return Object.assign(base, { jobname: t.jobname, jobid: t.jobid, stepname: t.stepname, ddname: t.ddname, fileId: t.fileId });
  return null; // syslog (and anything else transient) isn't worth restoring - it's a live view, not a document
}
function findRestoredTab(entry) {
  if (entry.kind === 'ds') return tabs.find(x => x.kind === 'ds' && x.dsn === entry.dsn && x.mbr === (entry.mbr || ''));
  if (entry.kind === 'uss') return tabs.find(x => x.kind === 'uss' && x.path === entry.path);
  if (entry.kind === 'job') return tabs.find(x => x.kind === 'job' && x.jobname === entry.jobname && x.jobid === entry.jobid && x.fileId === entry.fileId);
  return null;
}
function saveLayoutState() {
  if (!paneLayout) return; // never got past requireAuth() this session - nothing to save
  try {
    const serializedTabs = tabs.map(t => {
      const s = serializeTab(t);
      if (s) s.active = !!(panes[t.pane] && panes[t.pane].activeId === t.id);
      return s;
    }).filter(Boolean);
    const state = { paneLayout, focusedPaneId, tabs: serializedTabs };
    localStorage.setItem(layoutStorageKey(), JSON.stringify(state));
  } catch (e) { /* storage full/unavailable (private browsing etc) - next sign-in just starts fresh */ }
}
// Runs once at boot, before the normal empty-pane initPanes() path -
// rebuilds the saved split tree (with brand-new pane ids; the old ones
// don't mean anything across a session boundary) and reopens each tab
// into its remapped pane. Returns false (caller falls back to
// initPanes()) if there's nothing saved or it's unreadable.
async function restoreLayoutState(raw) {
  let state;
  try { state = JSON.parse(raw); } catch (e) { return false; }
  if (!state || !state.paneLayout || !Array.isArray(state.tabs)) return false;

  const idMap = {};
  function rebuildTree(node) {
    if (node.type === 'leaf') {
      const newId = makePane();
      idMap[node.id] = newId;
      return { type: 'leaf', id: newId };
    }
    return { type: 'split', dir: node.dir, sizes: (node.sizes || []).slice(), children: (node.children || []).map(rebuildTree) };
  }
  paneLayout = rebuildTree(state.paneLayout);
  focusedPaneId = idMap[state.focusedPaneId] || Object.values(idMap)[0];
  renderPaneLayout();
  if (paneRootEls[focusedPaneId]) paneRootEls[focusedPaneId].classList.add('focused');

  for (const entry of state.tabs) {
    const paneId = idMap[entry.pane];
    if (!paneId || !panes[paneId]) continue;
    focusedPaneId = paneId; // openTab/openUssTab/openJobFile default a brand-new tab's pane to focusedPaneId
    try {
      if (entry.kind === 'ds') {
        if (entry.encoding) await openWithEncoding('ds', { dsn: entry.dsn, mbr: entry.mbr });
        else await openTab(entry.dsn, entry.mbr);
      } else if (entry.kind === 'uss') {
        if (entry.encoding) await openWithEncoding('uss', { path: entry.path });
        else await openUssTab(entry.path);
      } else if (entry.kind === 'job') {
        await openJobFile(entry.jobname, entry.jobid, entry.stepname, entry.ddname, entry.fileId);
      }
    } catch (e) { /* individual open failures already flash()'d by the functions above */ }
    if (entry.fmt) {
      const opened = findRestoredTab(entry);
      if (opened) {
        opened.fmt = entry.fmt;
        if (panes[opened.pane] && panes[opened.pane].activeId === opened.id) renderEditorFor(opened.pane);
      }
    }
  }
  // Opening several tabs into the same pane above leaves whichever opened
  // last active in that pane, not necessarily the one that was actually
  // active when the layout was saved - fix that up now that everything's
  // been reopened.
  state.tabs.filter(e => e.active).forEach(entry => {
    const t = findRestoredTab(entry);
    if (t) activateTab(t);
  });
  if (idMap[state.focusedPaneId]) setFocusedPane(idMap[state.focusedPaneId]);
  return true;
}
function eachLeaf(node, fn) {
  if (node.type === 'leaf') { fn(node.id); return; }
  node.children.forEach(c => eachLeaf(c, fn));
}
function countLeaves(node) { let n = 0; eachLeaf(node, () => n++); return n; }
function findLeafNode(node, id) {
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const c of node.children) { const f = findLeafNode(c, id); if (f) return f; }
  return null;
}
function replaceNodeInTree(node, leafId, replacement) {
  if (node.type === 'leaf') return node.id === leafId ? replacement : node;
  return { type: 'split', dir: node.dir, sizes: node.sizes.slice(), children: node.children.map(c => replaceNodeInTree(c, leafId, replacement)) };
}
// Removes a leaf from the tree; a split left with only one child collapses
// into that child, same as closing the last file in a VS Code split group.
function removeLeafFromTree(node, id) {
  if (node.type === 'leaf') return node.id === id ? null : node;
  const children = [], sizes = [];
  node.children.forEach((c, i) => {
    const r = removeLeafFromTree(c, id);
    if (r) { children.push(r); sizes.push(node.sizes[i]); }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { type: 'split', dir: node.dir, children, sizes: sizes.map(s => s / total) };
}

function setFocusedPane(paneId) {
  if (!panes[paneId] || focusedPaneId === paneId) return;
  const prev = paneRootEls[focusedPaneId];
  if (prev) prev.classList.remove('focused');
  focusedPaneId = paneId;
  const cur = paneRootEls[paneId];
  if (cur) cur.classList.add('focused');
}

// Points a tab at a pane, makes it that pane's active tab, and focuses the
// pane - the single choke point every "open/switch to this tab" call site
// below goes through (replaces the old flat curId = t.id pattern).
function activateTab(t) {
  if (!t.pane || !panes[t.pane]) t.pane = focusedPaneId;
  panes[t.pane].activeId = t.id;
  setFocusedPane(t.pane);
  renderTabsFor(t.pane);
  renderEditorFor(t.pane);
}
// After a bulk tab removal (dataset/USS delete, etc.) that isn't scoped to
// one pane, walk every pane and fall back its active tab if the one it was
// pointing at is now gone. Re-renders every pane's bar; only re-renders the
// editor body for panes whose active tab actually changed.
function reconcilePanesAfterTabsRemoved() {
  Object.keys(panes).forEach(pid => {
    const p = panes[pid];
    if (p.activeId != null && !tabs.find(t => t.id === p.activeId)) {
      const remaining = tabsInPane(pid);
      p.activeId = remaining.length ? remaining[remaining.length - 1].id : null;
      renderTabsFor(pid);
      renderEditorFor(pid);
    } else {
      renderTabsFor(pid);
    }
  });
}
function renderAllTabbars() { Object.keys(panes).forEach(renderTabsFor); }

function removePane(paneId) {
  const el = paneRootEls[paneId];
  if (el) el.remove();
  delete paneRootEls[paneId];
  delete panes[paneId];
  const newTree = removeLeafFromTree(paneLayout, paneId);
  paneLayout = newTree || { type: 'leaf', id: makePane() };
  if (focusedPaneId === paneId) {
    const leaves = []; eachLeaf(paneLayout, id => leaves.push(id));
    focusedPaneId = leaves[0];
    const cur = paneRootEls[focusedPaneId];
    if (cur) cur.classList.add('focused');
  }
  renderPaneLayout();
}

function moveTabToPane(tabId, targetPaneId) {
  const t = tabs.find(x => x.id === tabId);
  if (!t || t.pane === targetPaneId) return;
  const fromPane = t.pane;
  t.pane = targetPaneId;
  panes[targetPaneId].activeId = t.id;
  if (fromPane && panes[fromPane] && panes[fromPane].activeId === tabId) {
    const remaining = tabsInPane(fromPane);
    panes[fromPane].activeId = remaining.length ? remaining[remaining.length - 1].id : null;
  }
}
function reorderTab(tabId, beforeTabId) {
  const from = tabs.findIndex(t => t.id === tabId);
  if (from === -1) return;
  const [t] = tabs.splice(from, 1);
  let to = beforeTabId == null ? -1 : tabs.findIndex(x => x.id === beforeTabId);
  if (to === -1) to = tabs.length;
  tabs.splice(to, 0, t);
}
// Drops a tab that's staying in the same pane it's already in, or moving
// into a different existing pane, without creating a new split.
function handleTabDropOnPane(tabId, targetPaneId, beforeTabId) {
  const t = tabs.find(x => x.id === tabId);
  if (!t) return;
  const fromPane = t.pane;
  if (fromPane === targetPaneId) {
    reorderTab(tabId, beforeTabId);
    renderTabsFor(targetPaneId);
    setFocusedPane(targetPaneId);
    return;
  }
  moveTabToPane(tabId, targetPaneId);
  if (beforeTabId != null) reorderTab(tabId, beforeTabId);
  renderTabsFor(targetPaneId); renderEditorFor(targetPaneId);
  if (fromPane) {
    renderTabsFor(fromPane);
    if (tabsInPane(fromPane).length === 0 && countLeaves(paneLayout) > 1) removePane(fromPane);
    else renderEditorFor(fromPane);
  }
  setFocusedPane(targetPaneId);
}
// Splits targetPaneId in `dir` (row=left/right, col=top/bottom), putting a
// brand-new pane `before` or after it, and moves tabId into that new pane.
function splitPaneAndMove(targetPaneId, dir, before, tabId) {
  const newId = makePane();
  const leafNode = findLeafNode(paneLayout, targetPaneId);
  const splitNode = {
    type: 'split', dir, sizes: [0.5, 0.5],
    children: before ? [{ type: 'leaf', id: newId }, leafNode] : [leafNode, { type: 'leaf', id: newId }],
  };
  paneLayout = replaceNodeInTree(paneLayout, targetPaneId, splitNode);
  const t = tabs.find(x => x.id === tabId);
  const fromPane = t ? t.pane : null;
  if (t) { t.pane = newId; panes[newId].activeId = t.id; }
  if (fromPane && panes[fromPane] && panes[fromPane].activeId === tabId) {
    const remaining = tabsInPane(fromPane);
    panes[fromPane].activeId = remaining.length ? remaining[remaining.length - 1].id : null;
  }
  renderPaneLayout();
  renderTabsFor(newId); renderEditorFor(newId);
  if (fromPane && fromPane !== newId) {
    renderTabsFor(fromPane);
    if (tabsInPane(fromPane).length === 0 && countLeaves(paneLayout) > 1) removePane(fromPane);
    else renderEditorFor(fromPane);
  }
  setFocusedPane(newId);
}
// Routes a drop onto a pane's body: center = move/activate here (no
// split), an edge zone = split this pane and move the tab into the new
// half. Used by both tab-drag and tree-item-drag drops.
function handleDropInPane(tabId, paneId, zone) {
  const t = tabs.find(x => x.id === tabId);
  if (!t) return;
  if (!zone || zone === 'center') {
    if (t.pane === paneId) { activateTab(t); return; }
    handleTabDropOnPane(tabId, paneId, null);
    return;
  }
  if (t.pane === paneId && tabsInPane(paneId).length === 1) return; // nothing to split against
  const dir = (zone === 'left' || zone === 'right') ? 'row' : 'col';
  const before = (zone === 'left' || zone === 'top');
  splitPaneAndMove(paneId, dir, before, tabId);
}
// Opens a tree item (dataset member/PS dataset/USS file) dropped from the
// sidebar. Center = open in the hovered pane; an edge zone = split first,
// then open into the new half.
async function openDragPayloadInPane(payload, paneId, zone) {
  if (zone && zone !== 'center') {
    const dir = (zone === 'left' || zone === 'right') ? 'row' : 'col';
    const before = (zone === 'left' || zone === 'top');
    const newId = makePane();
    paneLayout = replaceNodeInTree(paneLayout, paneId, {
      type: 'split', dir, sizes: [0.5, 0.5],
      children: before ? [{ type: 'leaf', id: newId }, { type: 'leaf', id: paneId }] : [{ type: 'leaf', id: paneId }, { type: 'leaf', id: newId }],
    });
    renderPaneLayout();
    setFocusedPane(newId);
  } else {
    setFocusedPane(paneId);
  }
  if (payload.kind === 'ds') await openTab(payload.dsn, payload.mbr || '');
  else if (payload.kind === 'uss') await openUssTab(payload.path);
}

function wirePaneResizer(handle, splitNode, childIndex) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('active');
    const isRow = splitNode.dir === 'row';
    const container = handle.parentElement;
    const totalPx = isRow ? container.getBoundingClientRect().width : container.getBoundingClientRect().height;
    const start = isRow ? e.clientX : e.clientY;
    const startSizes = splitNode.sizes.slice();
    function onMove(ev) {
      const cur = isRow ? ev.clientX : ev.clientY;
      const deltaFrac = (cur - start) / totalPx;
      const a = Math.max(0.1, startSizes[childIndex] + deltaFrac);
      const b = Math.max(0.1, startSizes[childIndex + 1] - deltaFrac);
      const norm = startSizes[childIndex] + startSizes[childIndex + 1];
      splitNode.sizes[childIndex] = (a / (a + b)) * norm;
      splitNode.sizes[childIndex + 1] = (b / (a + b)) * norm;
      applyPaneSizes(container, splitNode);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
function applyPaneSizes(container, node) {
  let ci = 0;
  Array.from(container.children).forEach(child => {
    if (child.classList.contains('paneResizer')) return;
    child.style.flex = (node.sizes[ci] != null ? node.sizes[ci] : 1 / node.children.length) + ' 1 0';
    ci++;
  });
}

function createPaneLeaf(id) {
  const el = document.createElement('div');
  el.className = 'paneLeaf';
  el.dataset.pane = id;
  el.innerHTML =
    '<div class="tabbar" data-pane="' + id + '"></div>' +
    '<div class="editorWrap" data-pane="' + id + '">' +
      '<div class="emptyState">Select a data set, USS file, or job spool file, or drag a tab here.</div>' +
    '</div>' +
    '<div class="paneDropOverlay" data-pane="' + id + '"></div>';
  paneRootEls[id] = el;
  el.addEventListener('mousedown', () => setFocusedPane(id));
  wireTabbarDrop(el.querySelector('.tabbar'), id);
  wirePaneDropTargets(el, id);
  return el;
}
function buildPaneNode(node) {
  if (node.type === 'leaf') {
    const el = paneRootEls[node.id] || createPaneLeaf(node.id);
    // Clear any inline flex ratio left over from a previous split - a pane
    // being (re-)built as a bare leaf falls back to the CSS default
    // (flex:1, i.e. fill all available space). This matters specifically
    // when a split collapses back down to one pane: the surviving leaf's
    // element is reused as-is (never recreated), so without this reset it
    // kept whatever "half the width" ratio applyPaneSizes() gave it while
    // it still had a sibling, and stayed visually stuck at that width even
    // once it was the only pane left. If this leaf is still part of a
    // multi-child split, the applyPaneSizes() call below (for its parent)
    // immediately overwrites this with the correct ratio anyway.
    el.style.flex = '';
    return el;
  }
  const wrap = document.createElement('div');
  wrap.className = 'paneSplit ' + node.dir;
  node.children.forEach((child, i) => {
    wrap.appendChild(buildPaneNode(child));
    if (i < node.children.length - 1) {
      const rz = document.createElement('div');
      rz.className = 'paneResizer ' + (node.dir === 'row' ? 'vert' : 'horiz');
      wirePaneResizer(rz, node, i);
      wrap.appendChild(rz);
    }
  });
  applyPaneSizes(wrap, node);
  return wrap;
}
// Purely structural: rebuilds the tree of .paneSplit wrappers + resizers,
// re-parenting existing .paneLeaf elements (never recreating them, so a
// leaf's live textarea/scroll/find state survives being moved to a new
// spot in the tree). Callers are responsible for calling renderTabsFor/
// renderEditorFor on whichever specific panes had their tab content
// change - this function alone never touches tab bar or editor content.
function renderPaneLayout() {
  const root = $('#paneRoot');
  if (!root) return;
  const built = buildPaneNode(paneLayout);
  root.innerHTML = '';
  root.appendChild(built);
}

// ---- drag and drop: tabs + sidebar tree items into/between panes ----
// Two custom MIME types carried in dataTransfer:
//   application/x-isi-tab  - an already-open tab, value is its numeric id
//   application/x-isi-open - a sidebar tree item not yet open, JSON
//     {kind:'ds', dsn, mbr} or {kind:'uss', path}
// Only dragovers/drops carrying one of these are intercepted (preventDefault
// is what enables a drop at all); anything else - e.g. dragging selected
// text within a textarea - is left to the browser's own default handling.
function dragHasPayload(e) {
  return e.dataTransfer.types.includes('application/x-isi-tab') || e.dataTransfer.types.includes('application/x-isi-open');
}
function clearAllPaneDropOverlays() {
  document.querySelectorAll('.paneDropOverlay').forEach(o => o.className = 'paneDropOverlay');
}
// Belt-and-suspenders: dragleave doesn't fire reliably in every browser/
// every path a drag can end on (dropped over a nested target that stops
// propagation, cancelled with Escape, released outside any valid drop
// target, dragged out of the window entirely...) - a stuck blue overlay
// left showing after the drag ends is a UI bug users will actually see, so
// this runs on every dragend/drop anywhere in the document as a final
// catch-all, regardless of whether the per-pane handlers above already
// cleaned up their own overlay.
document.addEventListener('dragend', clearAllPaneDropOverlays);
document.addEventListener('drop', clearAllPaneDropOverlays);
// A tab drag is a move (effectAllowed 'move' at dragstart); a tree-item
// drag is a copy (the item stays in the tree - effectAllowed 'copy' at
// dragstart). dropEffect on the target has to match whichever one is
// actually in flight, or some browsers (Chrome included) silently refuse
// the drop altogether - no drop event, no visible error, just nothing -
// which is exactly what an unconditional dropEffect='move' caused here for
// tree items dragged from the sidebar (their effectAllowed is 'copy').
function dragEffectFor(e) {
  return e.dataTransfer.types.includes('application/x-isi-tab') ? 'move' : 'copy';
}
function wireTabDrag(el, t) {
  el.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-isi-tab', String(t.id));
    setTimeout(() => el.classList.add('dragging'), 0); // deferred so the drag ghost image is captured pre-fade
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}
// Drag source for sidebar tree rows (dataset members, sequential datasets,
// USS files) - dropping one opens it in whichever pane/zone it lands on.
function wireTreeDrag(el, payload) {
  el.draggable = true;
  el.addEventListener('dragstart', e => {
    e.stopPropagation(); // don't let a parent tree row's own dragstart (if any) also fire
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-isi-open', JSON.stringify(payload));
  });
}
function tabbarInsertionPoint(barEl, clientX) {
  const tabEls = [...barEl.querySelectorAll('.tab')];
  for (const el of tabEls) {
    const r = el.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return parseInt(el.dataset.tabId, 10);
  }
  return null;
}
// Dropping directly on a pane's tab bar always means "add/reorder as a tab
// here" - never triggers a split, regardless of where in the bar it lands.
function wireTabbarDrop(barEl, paneId) {
  const clearMarkers = () => barEl.querySelectorAll('.tab.dropBefore').forEach(x => x.classList.remove('dropBefore'));
  barEl.addEventListener('dragover', e => {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dragEffectFor(e);
    clearMarkers();
    // The tab bar's own dragover stops propagation, so the pane-level
    // dragover below (which paints the split-zone overlay) never runs
    // while hovering the bar - clear it explicitly here too, or moving
    // from the editor body up onto the tab bar to drop left the overlay
    // stuck showing after the drop (there's no split to show over a tab
    // bar drop in the first place).
    const overlay = barEl.parentElement && barEl.parentElement.querySelector('.paneDropOverlay');
    if (overlay) overlay.className = 'paneDropOverlay';
    const insertBeforeId = tabbarInsertionPoint(barEl, e.clientX);
    if (insertBeforeId != null) {
      const targetEl = barEl.querySelector('[data-tab-id="' + insertBeforeId + '"]');
      if (targetEl) targetEl.classList.add('dropBefore');
    }
  });
  barEl.addEventListener('dragleave', e => { if (!barEl.contains(e.relatedTarget)) clearMarkers(); });
  barEl.addEventListener('drop', e => {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearMarkers();
    const insertBeforeId = tabbarInsertionPoint(barEl, e.clientX);
    const tabData = e.dataTransfer.getData('application/x-isi-tab');
    const openData = e.dataTransfer.getData('application/x-isi-open');
    if (tabData) handleTabDropOnPane(parseInt(tabData, 10), paneId, insertBeforeId);
    else if (openData) openDragPayloadInPane(JSON.parse(openData), paneId, 'center');
  });
}
// Dropping on a pane's editor body: center 25% = open/move here with no
// split; the outer 25% on any edge = split this pane and land in the new
// half, VS Code-style. Shows a translucent zone overlay while dragging.
function wirePaneDropTargets(el, paneId) {
  const overlay = el.querySelector('.paneDropOverlay');
  let zone = null;
  el.addEventListener('dragover', e => {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragEffectFor(e);
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const EDGE = 0.25;
    let z = 'center';
    if (x < EDGE) z = 'left';
    else if (x > 1 - EDGE) z = 'right';
    else if (y < EDGE) z = 'top';
    else if (y > 1 - EDGE) z = 'bottom';
    zone = z;
    overlay.className = 'paneDropOverlay show zone-' + z;
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) { overlay.className = 'paneDropOverlay'; zone = null; }
  });
  el.addEventListener('drop', e => {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    const z = zone || 'center';
    overlay.className = 'paneDropOverlay'; zone = null;
    const tabData = e.dataTransfer.getData('application/x-isi-tab');
    const openData = e.dataTransfer.getData('application/x-isi-open');
    if (tabData) handleDropInPane(parseInt(tabData, 10), paneId, z);
    else if (openData) openDragPayloadInPane(JSON.parse(openData), paneId, z);
  });
}
function tabLabel(t) {
  if (t.kind === 'syslog') return 'SYSLOG (live)';
  if (t.kind === 'job') return t.jobname + '.' + t.jobid + '.' + t.stepname + '.' + t.ddname + '.' + t.fileId;
  if (t.kind === 'uss') return t.path;
  return t.dsn + (t.mbr ? '(' + t.mbr + ')' : '');
}

// opts.readOnly opens a genuine "Browse" tab - same content, but the tab
// system's existing readOnly flag (already used for job spool/SYSLOG tabs)
// disables Save/Pull/Submit/Run REXX and marks the textarea read-only, so
// there's no risk of an accidental edit. Keyed into the existing-tab check
// alongside dsn/mbr so an Edit tab and a Browse tab of the same member can
// both be open at once as two distinct tabs (matching Zowe Explorer's own
// Browse-vs-Edit split) rather than one clobbering/reusing the other.
async function openTab(dsn, mbr, opts) {
  const readOnly = !!(opts && opts.readOnly);
  const existing = tabs.find(t => t.kind === 'ds' && t.dsn === dsn && t.mbr === (mbr || '') && !!t.readOnly === readOnly);
  if (existing) { activateTab(existing); return; }
  let text;
  try { text = await dsRead(dsn, mbr); }
  catch (e) {
    const label = dsn + (mbr ? '(' + mbr + ')' : '');
    flash(friendlyZosmfError(e.message, label) || ('Open failed: ' + e.message), false);
    return;
  }
  const t = { id: nextId++, kind: 'ds', dsn, mbr: mbr || '', text, dirty: false, fmt: null, readOnly };
  tabs.push(t);
  activateTab(t);
}

async function openUssTab(path, opts) {
  const readOnly = !!(opts && opts.readOnly);
  const existing = tabs.find(t => t.kind === 'uss' && t.path === path && !!t.readOnly === readOnly);
  if (existing) { activateTab(existing); return; }
  let text;
  try { text = await ussRead(path); }
  catch (e) { flash(friendlyZosmfError(e.message, path) || ('Open failed: ' + e.message), false); return; }
  const t = { id: nextId++, kind: 'uss', path, text, dirty: false, fmt: null, readOnly };
  tabs.push(t);
  activateTab(t);
}

async function openJobFile(jobname, jobid, stepname, ddname, fileId) {
  const existing = tabs.find(t => t.kind === 'job' && t.jobname === jobname && t.jobid === jobid && t.fileId === fileId);
  if (existing) { activateTab(existing); return; }
  let text;
  try {
    text = await zCall('GET', '/zosmf/restjobs/jobs/' + enc(jobname) + '/' + enc(jobid) + '/files/' + fileId + '/records', { raw: true });
  } catch (e) { flash('Open failed: ' + e.message, false); return; }
  const t = { id: nextId++, kind: 'job', jobname, jobid, stepname, ddname, fileId, text, dirty: false, fmt: null, readOnly: true };
  tabs.push(t);
  activateTab(t);
}

// ==================== live SYSLOG tab ====================
// Polls z/OSMF's "Get messages from a hardcopy log" service - part of the
// same z/OS console services group as consoleCmd() above, added by APAR
// PH38968 (z/OS V2R4+): GET /zosmf/restconsoles/v1/log, with hardcopy=
// syslog|operlog, a timestamp/timeRange window, and a direction. Like
// consoleCmd(), this specific endpoint hasn't been exercised against the
// live system from this session (no zosmf credentials available here) -
// it's a plain read (no confirm() needed the way command-issuing calls
// get one), but treat it as best-effort until confirmed working. If the
// call 404s/500s (endpoint not present on this z/OS release, or SYSLOG
// authority not granted - see the "Required authorizations" note on
// IBM's z/OS console services doc), the tab shows that error inline
// instead of silently doing nothing.
const SYSLOG_POLL_MS = 5000;
function findSyslogTab() { return tabs.find(t => t.kind === 'syslog'); }
async function fetchSyslog(params) {
  const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  return await zCall('GET', '/zosmf/restconsoles/v1/log?' + qs);
}
// z/OSMF's console log API returns each item's time two ways: `time`, a
// pre-formatted GMT string ("Fri Aug 07 04:42:10 GMT 2026"), and
// `timestamp`, epoch milliseconds (already relied on elsewhere in this
// file - openSyslogTab()/pollSyslog() sort and dedupe against it directly
// against Date.now(), so it has to be ms). Displaying `time` as-is always
// showed GMT; this instead builds the display string from `timestamp` at
// a fixed UTC+10 offset so it reads as AEST. Deliberately a fixed +10, not
// an IANA zone like Australia/Sydney via Intl - that would drift to AEDT
// (+11) during the southern-hemisphere daylight-saving months, which is
// not what was asked for. If a future ask is "always my current local
// time, DST included", switch this to
// item.timestamp's Date formatted with Intl.DateTimeFormat(undefined,
// {timeZone:'Australia/Brisbane'}) (no DST) or 'Australia/Sydney' (DST)
// instead of the manual offset below.
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
const SYSLOG_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatSyslogLine(item) {
  let time;
  if (typeof item.timestamp === 'number') {
    const d = new Date(item.timestamp + AEST_OFFSET_MS);
    const pad = n => String(n).padStart(2, '0');
    time = SYSLOG_MONTH_ABBR[d.getUTCMonth()] + ' ' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) +
      ' AEST ' + d.getUTCFullYear();
  } else {
    // Fallback if timestamp is ever missing - whatever z/OSMF sent as text (GMT, not converted).
    time = (item.time || '').replace(/^\w{3}\s+/, '');
  }
  const job = (item.jobName || '').trim();
  return (time || '?') + (job ? '  ' + job : '') + '  ' + (item.message || '');
}
async function openSyslogTab() {
  const existing = findSyslogTab();
  // Only one SYSLOG tab ever exists - if it's already open in some other
  // pane, follow the user to whichever pane they're currently in instead
  // of just re-activating it back where it originally happened to open
  // (the Syslog button lives in the header, outside every pane, so
  // focusedPaneId here is simply "whichever pane was last clicked/typed
  // into" - the same "currently active pane" every other shortcut uses).
  if (existing) { handleTabDropOnPane(existing.id, focusedPaneId, null); return; }
  const t = { id: nextId++, kind: 'syslog', text: 'Loading SYSLOG...', dirty: false, fmt: 'plain', readOnly: true, lastTimestamp: null, pollTimer: null };
  tabs.push(t);
  activateTab(t);
  try {
    const r = await fetchSyslog({ hardcopy: 'syslog', direction: 'backward', timeRange: '10m' });
    const items = (r.items || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    // No trailing "\n" here (see pollSyslog's append below for why) - keeps
    // t.text from ever ending in a newline.
    t.text = items.length ? items.map(formatSyslogLine).join('\n') : '(no SYSLOG activity in the last 10 minutes)';
    t.lastTimestamp = items.length ? items[items.length - 1].timestamp : Date.now();
    t.lastPollAt = Date.now(); t.lastPollError = null;
    if (panes[t.pane] && panes[t.pane].activeId === t.id) renderEditorFor(t.pane);
  } catch (e) {
    t.text = 'Could not load SYSLOG: ' + e.message;
    t.lastPollError = e.message;
    if (panes[t.pane] && panes[t.pane].activeId === t.id) renderEditorFor(t.pane);
    flash('SYSLOG load failed: ' + e.message, false);
  }
  t.pollTimer = setInterval(() => pollSyslog(t), SYSLOG_POLL_MS);
}
async function pollSyslog(t) {
  if (!tabs.includes(t)) { clearInterval(t.pollTimer); return; } // tab was closed since the last tick
  if (t.lastTimestamp == null) return;
  try {
    // Anchored to "now" (direction=backward, no timestamp param) rather
    // than to lastTimestamp - a window measured *forward* from lastTimestamp
    // only ever covers a fixed slice starting there, so once more than
    // ~timeRange of quiet time passed, that slice drifted into the past and
    // could never reach "now" again (lastTimestamp only advances when
    // something new is actually found). Querying backward from now every
    // tick can't get stuck that way; the client-side filter below still
    // dedupes against anything already shown.
    const r = await fetchSyslog({ hardcopy: 'syslog', direction: 'backward', timeRange: '20s' });
    const items = (r.items || []).filter(it => it.timestamp > t.lastTimestamp).sort((a, b) => a.timestamp - b.timestamp);
    t.lastPollAt = Date.now(); t.lastPollError = null;
    if (items.length) {
      // Prepend the separator instead of trailing it after every batch, so
      // t.text never ends in "\n". Confirmed live (via direct DOM
      // inspection) that a trailing newline makes the <textarea> reserve a
      // full extra line's height for the phantom empty final line, while
      // the #edHl <pre> overlay does *not* grow by the same amount for an
      // identical string - #editorArea.scrollHeight and #edHl.scrollHeight
      // ended up ~19px (one line) apart. Both elements get scrolled to
      // "the bottom" independently (area explicitly here/in
      // appendSyslogToEditor, edHl by copying area's scrollTop in
      // syncEditorScroll), and syncEditorScroll's raw pixel copy gets
      // silently clamped to #edHl's own (smaller) max scroll - so the
      // overlay ends up showing a different, earlier window of lines than
      // what's actually in the textarea underneath. That's what was behind
      // every round of "selecting the wrong text" and "can't select the
      // last line": near the bottom is exactly where this clamp mismatch
      // bites. No trailing newline means identical rendered height in both
      // elements, so there's nothing left to clamp differently.
      t.text += '\n' + items.map(formatSyslogLine).join('\n');
      t.lastTimestamp = items[items.length - 1].timestamp;
      appendSyslogToEditor(t);
    }
    updateSyslogStatus(t);
  } catch (e) {
    // Previously swallowed entirely - but a poll that's failing every tick
    // (e.g. missing SYSPLEX.OPERLOG/JESSPOOL read authority, separate from
    // the OPERCMDS authority needed to *issue* a command) looked
    // indistinguishable from "not auto-refreshing" with zero feedback.
    // Surface it in the status line instead of flash()-spamming every 5s.
    t.lastPollError = e.message;
    updateSyslogStatus(t);
  }
}
// Small "is this actually live" indicator in the toolbar - shows the last
// successful poll time, or the error if polling is currently failing.
function updateSyslogStatus(t) {
  if (!panes[t.pane] || panes[t.pane].activeId !== t.id) return;
  const root = paneRootEls[t.pane];
  const el = root && root.querySelector('#edSyslogStatus');
  if (!el) return;
  // U+25CF (BLACK CIRCLE) and U+00B7 (MIDDLE DOT) are written as escapes so
  // this file's bytes stay pure ASCII. Deploying it runs it through
  // "--encoding IBM-1047", and U+25CF has no IBM-1047 mapping at all - the
  // conversion substitutes X'3F' (EBCDIC SUB) for it, so a literal bullet
  // here arrives on the server corrupted and renders as a replacement glyph.
  // (U+00B7 does map, to X'B3', but escaping both keeps the rule simple:
  // no non-ASCII bytes in any file that gets uploaded through a codepage
  // conversion.) The escape survives untouched because it is plain ASCII
  // source text; the browser builds the real character at runtime.
  if (t.lastPollError) {
    el.textContent = '\u25CF Auto-refresh error: ' + t.lastPollError;
    el.className = 'edSyslogStatus err';
  } else {
    el.textContent = '\u25CF Live \u00B7 last updated ' + (t.lastPollAt ? new Date(t.lastPollAt).toLocaleTimeString() : '-');
    el.className = 'edSyslogStatus ok';
  }
}
// Updates the live textarea in place (no full renderEditor(), which would
// reset scroll) only when this tab is actually the one showing - if the
// user has switched away, t.text is still kept current in the background
// and the next renderEditor() call (on switching back) picks it up.
// "Near the bottom already" auto-follows new lines, tail -f style;
// scrolled up to read history is left alone.
function appendSyslogToEditor(t) {
  if (!panes[t.pane] || panes[t.pane].activeId !== t.id) return;
  const root = paneRootEls[t.pane];
  const area = root && root.querySelector('#editorArea');
  if (!area) return;
  // Don't clobber an in-progress text selection (e.g. selecting a message
  // to copy it) - setting .value resets selectionStart/selectionEnd to a
  // collapsed caret, which was interrupting a mid-drag selection every 5s
  // and made the highlighted region look broken/disjointed (reported as
  // "highlighting doesn't select properly"). t.text keeps accumulating in
  // the background regardless - this tick's new lines just show up on the
  // next append once the selection is cleared, same "leave it alone while
  // the user is doing something with it" treatment scrolled-up reading
  // already gets above.
  //
  // Checking selectionStart!==selectionEnd alone still missed the moment
  // *before* a range exists - clicking down to start a drag is a collapsed
  // selection for that first instant, and the last line is exactly where
  // this bites hardest: sitting at the bottom of a live tail means a poll
  // tick is most likely to land right as you click, auto-follow jumps the
  // view to the new bottom mid-click, and the line you were trying to grab
  // has already moved out from under the mouse. Pausing on focus instead -
  // the whole time the textarea is clicked into, not just once a range is
  // dragged out - covers that gap too.
  if (document.activeElement === area || area.selectionStart !== area.selectionEnd) return;
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 40;
  // Explicitly save/restore scroll position across the value reassignment
  // rather than trusting the browser to preserve it on its own - reassigning
  // .value is exactly the kind of DOM operation that inconsistently keeps
  // scrollTop across browsers/versions, and #edHl's scrollTop is only ever
  // set *from* area.scrollTop (syncEditorScroll below) - so if area's own
  // scroll position drifted even slightly during the reassignment, the
  // overlay (what's visually shown) and the textarea (what's actually
  // selected/copied) would end up looking at different lines while
  // appearing perfectly aligned on screen. This is the most likely cause of
  // "the text I selected isn't the text that pasted" when it's scrolled up
  // reading history during a live poll tick.
  const savedTop = area.scrollTop, savedLeft = area.scrollLeft;
  area.value = t.text;
  if (!nearBottom) { area.scrollTop = savedTop; area.scrollLeft = savedLeft; }
  refreshEditorChrome(t);
  if (nearBottom) { area.scrollTop = area.scrollHeight; syncEditorScroll(t.pane); }
}
$('#syslogBtn').onclick = openSyslogTab;

// Creates a member inside an existing PDS. Nothing is written to z/OSMF
// yet - this just opens a new dirty, empty tab for it; the member is only
// actually created on the first Save (z/OSMF's write API returns 201 and
// creates it if it doesn't already exist yet - confirmed against the live
// system, see ARCHITECTURE.md's test log). Same UX as the old TK5 Explorer's
// "New member..." (source/console.js's exNewMember): prompt, validate,
// open empty+dirty, create-on-save.
function newMember(dsn) {
  const m = prompt('New member name (1-8 chars):', '');
  if (!m) return;
  const mbr = m.trim().toUpperCase();
  if (!/^[A-Z#@$][A-Z0-9#@$]{0,7}$/.test(mbr)) {
    flash('Invalid member name - 1-8 chars, must start with a letter, #, @, or $', false);
    return;
  }
  const existing = tabs.find(t => t.kind === 'ds' && t.dsn === dsn && t.mbr === mbr);
  if (existing) { activateTab(existing); return; }
  const t = { id: nextId++, kind: 'ds', dsn, mbr, text: '', dirty: true, fmt: null, isNew: true };
  tabs.push(t);
  activateTab(t);
  flash('New member ' + mbr + ' - Save to create it', true);
}
// `file`, if supplied, is a real File object already in hand (a drag-drop
// from the OS) - skips the file picker and reads straight from it. Left
// undefined for the normal "Upload file..." menu path.
async function uploadMember(dsn, file) {
  let picked;
  if (file) {
    try { picked = { name: file.name, text: await readFileAsText(file) }; }
    catch (e) { flash('Could not read ' + file.name + ': ' + e.message, false); return; }
  } else {
    picked = await pickLocalTextFile();
    if (!picked) return;
  }
  const base = picked.name.replace(/\.[^./\\]*$/, ''); // strip a file extension, if any
  const suggested = base.toUpperCase().replace(/[^A-Z0-9#@$]/g, '').slice(0, 8);
  const m = prompt('Upload ' + picked.name + ' as member (1-8 chars):', suggested);
  if (!m) return;
  const mbr = m.trim().toUpperCase();
  if (!/^[A-Z#@$][A-Z0-9#@$]{0,7}$/.test(mbr)) {
    flash('Invalid member name - 1-8 chars, must start with a letter, #, @, or $', false);
    return;
  }
  try {
    await dsWrite(dsn, mbr, picked.text);
    flash('Uploaded ' + picked.name + ' as ' + dsn + '(' + mbr + ')', true);
    refreshMemberList(dsn);
    // Same as uploadUssFile - if this member's already open in a tab,
    // refresh it in place instead of leaving stale pre-upload content
    // sitting there marked clean.
    const open = tabs.find(t => t.kind === 'ds' && t.dsn === dsn && t.mbr === mbr);
    if (open) {
      open.text = picked.text; open.dirty = false;
      renderTabsFor(open.pane);
      if (panes[open.pane] && panes[open.pane].activeId === open.id) renderEditorFor(open.pane);
    }
  } catch (e) { flash(friendlyZosmfError(e.message, dsn + '(' + mbr + ')') || ('Upload failed: ' + e.message), false); }
}

// ==================== upload as a new sequential dataset / new PDS ====================
// FB is the conventional recfm for source datasets on this system (matches
// the New Dataset modal's own default), but a hardcoded LRECL=80 would
// reject - or silently truncate - any uploaded line longer than 80 chars,
// which is the common case for text files that didn't originate on a
// mainframe. Sizing LRECL to the longest actual line (never below 80,
// the classic card-image floor) avoids that without changing recfm.
// BLKSIZE=0 lets the system pick an optimal block size rather than
// guessing one here.
function computeLrecl(text, min) {
  let max = min || 80;
  text.split(/\r?\n/).forEach(l => { if (l.length > max) max = l.length; });
  return Math.min(32760, max);
}
// Derives a valid 1-8 char PDS member name from a local filename (strip
// extension, uppercase, drop anything outside the legal member charset,
// prefix with M if what's left doesn't start with a letter/#/@/$) and
// de-dupes it against every name already used in this same upload batch by
// appending a numeric suffix - used by the folder-upload flows below,
// where prompting for every single file's name one at a time would be
// impractical.
function suggestMemberName(filename, used) {
  const base = filename.replace(/\.[^./\\]*$/, '');
  let name = base.toUpperCase().replace(/[^A-Z0-9#@$]/g, '').slice(0, 8);
  if (!name) name = 'MEMBER';
  if (!/^[A-Z#@$]/.test(name)) name = ('M' + name).slice(0, 8);
  if (!used.has(name)) { used.add(name); return name; }
  for (let n = 1; n < 1000; n++) {
    const suffix = String(n);
    const candidate = (name.slice(0, 8 - suffix.length) + suffix);
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  const fallback = 'M' + Date.now().toString(36).toUpperCase().slice(-7);
  used.add(fallback);
  return fallback;
}
// Same picker as pickLocalTextFile, but for an entire folder -
// `webkitdirectory` is non-standard but well-supported in Chrome/Edge/
// Firefox/Safari; resolves to every file found, each carrying
// webkitRelativePath (e.g. "MyFolder/sub/file.txt") so callers can tell
// how deep it was nested. Returns null if nothing was picked/cancelled.
function pickLocalFolder() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => { if (input.isConnected) document.body.removeChild(input); };
    input.addEventListener('cancel', () => { cleanup(); resolve(null); });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      cleanup();
      resolve(files.length ? files : null);
    });
    input.click();
  });
}
// `file`, if supplied, is a real File object already in hand (a drag-drop
// from the OS) - skips the file picker and reads straight from it. Left
// undefined for the normal menu path.
async function uploadAsNewDataset(file) {
  let picked;
  if (file) {
    try { picked = { name: file.name, text: await readFileAsText(file) }; }
    catch (e) { flash('Could not read ' + file.name + ': ' + e.message, false); return; }
  } else {
    picked = await pickLocalTextFile();
    if (!picked) return;
  }
  const hlq = ($('#hlqFilter').value.trim() || localStorage.getItem('isiUser') || '').split('.')[0];
  const base = picked.name.replace(/\.[^./\\]*$/, '');
  const qual = base.toUpperCase().replace(/[^A-Z0-9#@$]/g, '').slice(0, 8) || 'UPLOAD';
  const suggested = (hlq ? hlq + '.' : '') + qual;
  const dsnInput = prompt('Upload ' + picked.name + ' as new sequential dataset:', suggested);
  if (!dsnInput) return;
  const dsn = dsnInput.trim().toUpperCase();
  if (isProtected(dsn)) { flash(dsn + ' is under a protected HLQ - not creating here.', false); return; }
  try {
    const lrecl = computeLrecl(picked.text, 80);
    await dsAllocate(dsn, { dsorg: 'PS', alcunit: 'TRK', primary: 1, secondary: 1, recfm: 'FB', lrecl, blksize: 0 });
    await dsWrite(dsn, '', picked.text);
    flash('Uploaded ' + picked.name + ' as ' + dsn, true);
    $('#hlqFilter').value = dsn.split('.')[0] + '.*';
    currentDslevel = $('#hlqFilter').value;
    refreshTree();
  } catch (e) { flash(friendlyZosmfError(e.message, dsn) || ('Upload failed: ' + e.message), false); }
}
// Uploads every top-level file in a locally-picked folder as members of an
// EXISTING PDS - files inside nested subfolders are skipped (a PDS is
// flat, it can't represent a folder hierarchy) and counted in the summary
// rather than silently dropped. Names are derived automatically
// (suggestMemberName above); prompting for each one individually would be
// impractical for anything but a tiny folder.
async function uploadFolderAsMembers(dsn) {
  const files = await pickLocalFolder();
  if (!files) return;
  const top = files.filter(f => (f.webkitRelativePath || f.name).split('/').filter(Boolean).length <= 2);
  const skipped = files.length - top.length;
  if (!top.length) { flash('No files found directly inside that folder.', false); return; }
  const used = new Set();
  let ok = 0; const failed = [];
  for (const file of top) {
    let text;
    try { text = await readFileAsText(file); } catch (e) { failed.push(file.name + ' (could not read)'); continue; }
    const mbr = suggestMemberName(file.name, used);
    try { await dsWrite(dsn, mbr, text); ok++; }
    catch (e) { failed.push(file.name + ' -> ' + mbr); }
  }
  refreshMemberList(dsn);
  const parts = ['Uploaded ' + ok + ' of ' + top.length + ' file(s) to ' + dsn];
  if (skipped) parts.push(skipped + ' in subfolder(s) skipped');
  if (failed.length) parts.push('failed: ' + failed.join(', '));
  flash(parts.join(' - '), failed.length === 0);
}
// Same idea as uploadFolderAsMembers, but allocates a brand-new PDS first
// (sized off the folder itself - dirblk from the file count, LRECL from
// the longest line across every file so nothing gets rejected/truncated).
async function uploadFolderAsNewPds() {
  const files = await pickLocalFolder();
  if (!files) return;
  const top = files.filter(f => (f.webkitRelativePath || f.name).split('/').filter(Boolean).length <= 2);
  const skipped = files.length - top.length;
  if (!top.length) { flash('No files found directly inside that folder.', false); return; }
  const folderName = ((files[0].webkitRelativePath || '').split('/')[0] || 'UPLOAD');
  const hlq = ($('#hlqFilter').value.trim() || localStorage.getItem('isiUser') || '').split('.')[0];
  const qual = folderName.toUpperCase().replace(/[^A-Z0-9#@$]/g, '').slice(0, 8) || 'UPLOAD';
  const suggested = (hlq ? hlq + '.' : '') + qual;
  const dsnInput = prompt('Upload ' + top.length + ' file(s) as new PDS:', suggested);
  if (!dsnInput) return;
  const dsn = dsnInput.trim().toUpperCase();
  if (isProtected(dsn)) { flash(dsn + ' is under a protected HLQ - not creating here.', false); return; }
  const reads = [];
  for (const file of top) {
    try { reads.push({ file, text: await readFileAsText(file) }); }
    catch (e) { flash('Could not read ' + file.name + ' - skipped.', false); }
  }
  if (!reads.length) return;
  const lrecl = computeLrecl(reads.map(r => r.text).join('\n'), 80);
  try {
    await dsAllocate(dsn, { dsorg: 'PO', alcunit: 'TRK', primary: 5, secondary: 5, dirblk: Math.max(5, reads.length + 2), recfm: 'FB', lrecl, blksize: 0 });
  } catch (e) { flash(friendlyZosmfError(e.message, dsn) || ('Allocate failed: ' + e.message), false); return; }
  const used = new Set();
  let ok = 0; const failed = [];
  for (const { file, text } of reads) {
    const mbr = suggestMemberName(file.name, used);
    try { await dsWrite(dsn, mbr, text); ok++; }
    catch (e) { failed.push(file.name + ' -> ' + mbr); }
  }
  const parts = ['Created ' + dsn + ' - uploaded ' + ok + ' of ' + reads.length + ' file(s)'];
  if (skipped) parts.push(skipped + ' in subfolder(s) skipped');
  if (failed.length) parts.push('failed: ' + failed.join(', '));
  flash(parts.join(' - '), failed.length === 0);
  $('#hlqFilter').value = dsn.split('.')[0] + '.*';
  currentDslevel = $('#hlqFilter').value;
  refreshTree();
}

function renderTabsFor(paneId) {
  const root = paneRootEls[paneId];
  const bar = root && root.querySelector('.tabbar');
  if (!bar) return;
  bar.innerHTML = '';
  // Only fire for a right-click that lands on the bar's own empty space -
  // clicks on an actual .tab bubble up here too (contextmenu events
  // bubble), but that tab's own oncontextmenu below already showed its
  // menu, so e.target === bar (not some .tab descendant) keeps this from
  // popping a second, conflicting menu on top of it.
  bar.oncontextmenu = e => { if (e.target === bar) showEmptyTabbarCtx(e, paneId); };
  const activeId = panes[paneId] && panes[paneId].activeId;
  tabsInPane(paneId).forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.dirty ? ' dirty' : '');
    el.draggable = true;
    el.dataset.tabId = t.id;
    el.innerHTML = '<span class="dot"></span>'
      + (t.readOnly ? '<span class="lock" title="Read-only">&#128274;</span>' : '')
      + '<span class="tabLabel">' + escHtml(tabLabel(t)) + '</span><span class="x">&times;</span>';
    el.onclick = (e) => { if (e.target.classList.contains('x')) { closeTab(t.id); return; } activateTab(t); };
    el.oncontextmenu = e => showTabCtx(e, t);
    wireTabDrag(el, t);
    bar.appendChild(el);
  });
}

// Renders the editor body for one specific pane, keyed off that pane's own
// active tab (panes[paneId].activeId) - every element lookup below is
// scoped to this pane's own DOM subtree (via paneRootEls[paneId] /
// wrap.querySelector), never the page-global $(), since with multiple
// panes open simultaneously there can be several #editorArea-shaped
// elements in the document at once and a global lookup would silently hit
// whichever one happens to be first in DOM order.
function renderEditorFor(paneId) {
  const root = paneRootEls[paneId];
  const wrap = root && root.querySelector('.editorWrap');
  if (!wrap) return;
  const pane = panes[paneId];
  const t = pane ? tabs.find(x => x.id === pane.activeId) : undefined;
  if (!t) { wrap.innerHTML = '<div class="emptyState">Select a data set, USS file, or job spool file, or drag a tab here.</div>'; return; }
  // Fresh tab, fresh find state - the find bar itself is rebuilt hidden
  // below regardless, but without this, switching tabs while a search was
  // active would leave findMatches holding position offsets computed
  // against the *previous* tab's text, which is meaningless (and possibly
  // out of range) against this one.
  pane.findMatches = []; pane.findIndex = -1; pane.findTerm = '';
  wrap.innerHTML =
    '<div class="findBar" id="findBar">' +
      '<div class="findRow">' +
        (t.readOnly ? '' : '<span class="findChev" id="findChev" title="Toggle Replace">&#9656;</span>') +
        '<input type="text" id="findInput" placeholder="Find" autocomplete="off" spellcheck="false">' +
        '<span class="findCount" id="findCount"></span>' +
        '<button class="iconBtn" id="findPrev" title="Previous match (Shift+Enter)">&#8593;</button>' +
        '<button class="iconBtn" id="findNext" title="Next match (Enter)">&#8595;</button>' +
        '<button class="iconBtn" id="findClose" title="Close (Esc)">&times;</button>' +
      '</div>' +
      (t.readOnly ? '' :
      '<div class="findRow findReplaceRow" id="replaceRow">' +
        '<input type="text" id="replaceInput" placeholder="Replace" autocomplete="off" spellcheck="false">' +
        '<button class="btn" id="replaceOne">Replace</button>' +
        '<button class="btn" id="replaceAll">All</button>' +
      '</div>') +
    '</div>' +
    '<div class="edToolbar">' +
      '<label for="edFmtSel">Format</label>' +
      '<select id="edFmtSel">' +
        '<option value="auto">Auto</option>' +
        '<option value="jcl">JCL</option>' +
        '<option value="cobol">COBOL</option>' +
        '<option value="pli">PL/I</option>' +
        '<option value="asm">Assembler</option>' +
        '<option value="rexx">REXX</option>' +
        '<option value="plain">Plain</option>' +
      '</select>' +
      '<span class="edLines" id="edLines"></span>' +
      (t.kind === 'syslog' ? '<span class="edSyslogStatus" id="edSyslogStatus"></span>' : '') +
      '<span class="edReadOnly" id="edSaveHint" style="display:none">&#128274; Read-only</span>' +
    '</div>' +
    '<div class="edRulerRow">' +
      '<div class="edGutterPad"></div>' +
      '<div class="edRulerStage"><pre class="edRuler" id="edRuler"></pre></div>' +
    '</div>' +
    '<div class="edBody">' +
      '<div class="edGutter" id="edGutter"></div>' +
      '<div class="edStage">' +
        '<pre class="edHl" id="edHl"><code id="edHlCode"></code></pre>' +
        '<pre class="edFindHl" id="edFindHl"></pre>' +
        '<textarea id="editorArea" class="edText" spellcheck="false"></textarea>' +
        '<div class="edGuides" id="edGuides"></div>' +
      '</div>' +
    '</div>';

  const area = wrap.querySelector('#editorArea');
  const pinBottom = t.kind === 'syslog'; // a live log wants its newest (last) line in view, not its first
  area.value = t.text;
  area.readOnly = !!t.readOnly;
  // Setting .value moves the caret to the end of the text, and focusing a
  // textarea scrolls to reveal wherever the caret is - so without this,
  // every newly-opened member "helpfully" jumps to its last line. Reset
  // the caret and scroll position to the top before anything can focus it
  // (bottom for a live log, where the newest line is the point of interest).
  if (pinBottom) { area.setSelectionRange(area.value.length, area.value.length); area.scrollTop = area.scrollHeight; }
  else { area.setSelectionRange(0, 0); area.scrollTop = 0; }
  area.scrollLeft = 0;
  wrap.querySelector('#edFmtSel').value = t.fmt || 'auto';
  const saveHint = wrap.querySelector('#edSaveHint');
  if (saveHint) saveHint.style.display = t.readOnly ? '' : 'none';
  if (t.kind === 'syslog') updateSyslogStatus(t);
  refreshEditorChrome(t);

  area.oninput = () => {
    t.text = area.value;
    if (!t.dirty) { t.dirty = true; renderTabsFor(paneId); }
    refreshEditorChrome(t);
    // Editing the document itself shifts every match position after the
    // edit point - keep the find highlight/count from going stale while
    // find is open, without re-jumping to a new "nearest" match.
    const bar = wrap.querySelector('#findBar');
    if (bar && bar.classList.contains('show')) runFind(paneId, false);
  };
  area.onscroll = () => syncEditorScroll(paneId);
  area.onmousedown = () => setFocusedPane(paneId);
  area.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrent(); return; }
    // Ctrl/Cmd+F and +H are the browser's own "find in page" / history
    // shortcuts - preventDefault() here keeps them from popping the
    // browser's native find bar over ours, same reasoning as the Ctrl+S
    // fix above.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findBarShow(paneId, false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && !t.readOnly) { e.preventDefault(); findBarShow(paneId, true); return; }
  };
  // Right-click inside the editor gets the same menu as right-clicking its
  // tab (Save / Submit as JCL / Close) - this replaces the browser's native
  // cut/copy/paste menu here, same tradeoff the dataset tree already makes
  // for its own context menu. Keyboard shortcuts (Ctrl/Cmd+C/X/V) still work.
  area.oncontextmenu = e => showTabCtx(e, t);
  wireFindBar(paneId, t);
  wrap.querySelector('#edFmtSel').onchange = (e) => {
    t.fmt = e.target.value === 'auto' ? null : e.target.value;
    refreshEditorChrome(t);
  };
  // Belt-and-suspenders alongside the document-level Ctrl+S fallback
  // further down this file: right after window.prompt() closes (e.g.
  // creating a new member), some browsers leave focus sitting on the
  // browser chrome itself rather than handing it back to the page, so a
  // single synchronous .focus() call here doesn't always stick - Ctrl+S
  // then reaches the browser's own "Save Page As" instead of this
  // console, since a keydown that never lands inside the document can't
  // be caught by any listener attached to it. window.focus() reclaims
  // focus from the chrome back into the page, and the deferred re-focus
  // on the next tick covers browsers that only finish settling focus
  // after this script returns.
  window.focus();
  area.focus();
  setTimeout(() => area.focus(), 0);
  // Belt-and-suspenders: some browsers apply their own "scroll to reveal
  // the caret" behavior on focus *after* this script finishes running (on
  // the next layout/paint), which would silently undo the reset above. Redo
  // it once synchronously and again after the next couple of frames so it
  // sticks no matter which pass the browser does its own scrolling in.
  const pinScroll = () => {
    if (pinBottom) { area.setSelectionRange(area.value.length, area.value.length); area.scrollTop = area.scrollHeight; }
    else { area.setSelectionRange(0, 0); area.scrollTop = 0; }
    area.scrollLeft = 0;
    syncEditorScroll(paneId);
  };
  pinScroll();
  requestAnimationFrame(() => requestAnimationFrame(pinScroll));
}

// ==================== find / replace in the editor ====================
// #editorArea is a plain textarea (there's no rich-editor decoration API
// backing it), so this works the way find does in any plain text field:
// one match selected/navigated at a time via setSelectionRange(), with a
// running "N of M" count - rather than highlighting every match at once,
// which a textarea has no way to render. Case-insensitive literal
// substring match (no regex) - matches VS Code/Chrome/Sublime's default
// find behavior. Matching is done on lowercased text purely to *locate*
// positions; the positions and lengths themselves are identical in the
// original-case string, so selection/replacement below don't need any
// extra bookkeeping.
// Find/replace state lives on each pane object (panes[paneId].findMatches
// etc, initialized in makePane()), not as module-level globals - each pane
// can have its own find bar open on its own tab at the same time.
function collectFindMatches(paneId, term) {
  const root = paneRootEls[paneId];
  const area = root && root.querySelector('#editorArea');
  if (!area || !term) return [];
  const hay = area.value.toLowerCase();
  const needle = term.toLowerCase();
  const matches = [];
  let idx = 0;
  while (true) {
    const pos = hay.indexOf(needle, idx);
    if (pos === -1) break;
    matches.push(pos);
    idx = pos + needle.length; // non-overlapping
  }
  return matches;
}
function findBarShow(paneId, withReplace) {
  const root = paneRootEls[paneId];
  const bar = root && root.querySelector('#findBar');
  if (!bar) return;
  setFocusedPane(paneId);
  const pane = panes[paneId];
  const area = root.querySelector('#editorArea');
  const sel = area ? area.value.slice(area.selectionStart, area.selectionEnd) : '';
  // Captured once, here - not re-read from area.selectionStart on every
  // keystroke, since selectMatch() below moves that same selection to
  // whatever match it lands on. Re-reading it live would make each
  // keystroke's "nearest match" search drift to wherever the *previous*
  // keystroke happened to jump, instead of staying anchored to where the
  // cursor actually was when the find bar was opened.
  pane.findAnchor = area ? area.selectionStart : 0;
  bar.classList.add('show');
  const input = root.querySelector('#findInput');
  if (sel && !sel.includes('\n')) input.value = sel;
  input.focus(); input.select();
  runFind(paneId, true);
  if (withReplace) { openReplaceRow(paneId); const r = root.querySelector('#replaceInput'); if (r) r.focus(); }
}
function openReplaceRow(paneId) {
  const root = paneRootEls[paneId];
  const row = root && root.querySelector('#replaceRow');
  const chev = root && root.querySelector('#findChev');
  if (row) row.classList.add('show');
  if (chev) chev.classList.add('open');
}
function findBarHide(paneId) {
  const root = paneRootEls[paneId];
  const bar = root && root.querySelector('#findBar');
  if (bar) bar.classList.remove('show');
  const pane = panes[paneId];
  if (pane) { pane.findMatches = []; pane.findIndex = -1; }
  const hlEl = root && root.querySelector('#edFindHl');
  if (hlEl) hlEl.innerHTML = '';
  const area = root && root.querySelector('#editorArea');
  if (area) area.focus();
}
// Recomputes matches and the "N of M" count as you type - deliberately
// does NOT touch the editor's focus or selection. selectMatch() (used by
// findNext/findPrev/Enter/Replace, all discrete one-off actions rather
// than continuous typing) is the only thing that calls area.focus(): it
// used to be called from here too, on every keystroke, which stole focus
// away from the find input mid-typing - the very next character you typed
// then landed in the editor's textarea instead of the find box, and since
// the previous match was still selected there, that keystroke would
// silently overwrite it. Narrating why this split matters because it's
// exactly the kind of thing that looks fine in a quick test and corrupts
// real content the first time someone types a multi-character search term.
function runFind(paneId, selectNearest) {
  const root = paneRootEls[paneId];
  const pane = panes[paneId];
  const input = root && root.querySelector('#findInput');
  const countEl = root && root.querySelector('#findCount');
  if (!input || !countEl || !pane) return;
  pane.findTerm = input.value;
  pane.findMatches = collectFindMatches(paneId, pane.findTerm);
  if (!pane.findTerm) { countEl.textContent = ''; pane.findIndex = -1; updateFindHighlight(paneId); return; }
  if (!pane.findMatches.length) { countEl.textContent = 'No results'; pane.findIndex = -1; updateFindHighlight(paneId); return; }
  if (selectNearest) {
    pane.findIndex = pane.findMatches.findIndex(p => p >= pane.findAnchor);
    // No match at or after the anchor - wrap to the last one (nearest
    // going backward) rather than snapping to the document's very first
    // match, which would otherwise make narrowing a search term jump
    // somewhere unrelated to where you actually started.
    if (pane.findIndex === -1) pane.findIndex = pane.findMatches.length - 1;
  } else if (pane.findIndex === -1) {
    pane.findIndex = 0;
  }
  countEl.textContent = (pane.findIndex + 1) + ' of ' + pane.findMatches.length;
  updateFindHighlight(paneId);
}
// Paints a background <mark> behind every match (not just the current
// one, unlike selectMatch()'s native selection) so results are visible
// while typing, without ever touching the textarea's focus/selection.
// Gated at 3+ characters by design - shorter terms match too often
// to be a useful highlight and would just paint the whole document.
function buildFindHighlight(text, matches, termLen) {
  let out = '', last = 0;
  for (const pos of matches) {
    out += escHtml(text.slice(last, pos)) + '<mark>' + escHtml(text.slice(pos, pos + termLen)) + '</mark>';
    last = pos + termLen;
  }
  return out + escHtml(text.slice(last));
}
function updateFindHighlight(paneId) {
  const root = paneRootEls[paneId];
  const pane = panes[paneId];
  const el = root && root.querySelector('#edFindHl');
  if (!el || !pane) return;
  const area = root.querySelector('#editorArea');
  if (!area || !pane.findTerm || pane.findTerm.length < 3 || !pane.findMatches.length) { el.innerHTML = ''; return; }
  el.innerHTML = buildFindHighlight(area.value, pane.findMatches, pane.findTerm.length);
}
// Actually jumps to and highlights the current match - only called from
// explicit navigation (Next/Prev/Enter) or after a Replace, never from
// plain typing. See the note on runFind() above.
function selectMatch(paneId) {
  const root = paneRootEls[paneId];
  const pane = panes[paneId];
  const area = root && root.querySelector('#editorArea');
  if (!area || !pane || pane.findIndex < 0 || !pane.findMatches.length) return;
  const pos = pane.findMatches[pane.findIndex];
  area.focus();
  area.setSelectionRange(pos, pos + pane.findTerm.length); // focusing after this scrolls the selection into view
  syncEditorScroll(paneId);
  root.querySelector('#findCount').textContent = (pane.findIndex + 1) + ' of ' + pane.findMatches.length;
}
function findNext(paneId) {
  const pane = panes[paneId];
  if (!pane) return;
  if (!pane.findMatches.length) runFind(paneId, false);
  if (!pane.findMatches.length) return;
  pane.findIndex = (pane.findIndex + 1) % pane.findMatches.length;
  selectMatch(paneId);
}
function findPrev(paneId) {
  const pane = panes[paneId];
  if (!pane) return;
  if (!pane.findMatches.length) runFind(paneId, false);
  if (!pane.findMatches.length) return;
  pane.findIndex = (pane.findIndex - 1 + pane.findMatches.length) % pane.findMatches.length;
  selectMatch(paneId);
}
function replaceOne(paneId) {
  const root = paneRootEls[paneId];
  const pane = panes[paneId];
  const area = root && root.querySelector('#editorArea');
  const t = pane && tabs.find(x => x.id === pane.activeId);
  if (!area || !t || t.readOnly || !pane.findMatches.length || pane.findIndex < 0) return;
  const replacement = root.querySelector('#replaceInput').value;
  const pos = pane.findMatches[pane.findIndex];
  const before = area.value.slice(0, pos);
  const after = area.value.slice(pos + pane.findTerm.length);
  area.value = before + replacement + after;
  t.text = area.value;
  if (!t.dirty) { t.dirty = true; renderTabsFor(paneId); }
  refreshEditorChrome(t);
  // Positions after this one all shifted by the length difference - re-run
  // the search fresh and land on whatever's now closest to where this
  // match used to be, same idea as a "replace and advance" flow.
  pane.findMatches = collectFindMatches(paneId, pane.findTerm);
  const anchor = before.length + replacement.length;
  pane.findIndex = pane.findMatches.findIndex(p => p >= anchor);
  if (pane.findIndex === -1) pane.findIndex = pane.findMatches.length ? 0 : -1;
  if (pane.findIndex >= 0) selectMatch(paneId);
  else root.querySelector('#findCount').textContent = 'No results';
}
function replaceAll(paneId) {
  const root = paneRootEls[paneId];
  const pane = panes[paneId];
  const area = root && root.querySelector('#editorArea');
  const t = pane && tabs.find(x => x.id === pane.activeId);
  const term = root && root.querySelector('#findInput').value;
  if (!area || !t || t.readOnly || !term || !pane.findMatches.length) return;
  const replacement = root.querySelector('#replaceInput').value;
  const count = pane.findMatches.length;
  if (!confirm('Replace all ' + count + ' occurrence' + (count === 1 ? '' : 's') + ' of "' + term + '"?')) return;
  // Built from findMatches' positions rather than value.split(term) -
  // split() would only catch exact-case matches, not the case-insensitive
  // set already found and counted above.
  let result = '', last = 0;
  for (const pos of pane.findMatches) {
    result += area.value.slice(last, pos) + replacement;
    last = pos + term.length;
  }
  result += area.value.slice(last);
  area.value = result;
  t.text = area.value;
  if (!t.dirty) { t.dirty = true; renderTabsFor(paneId); }
  refreshEditorChrome(t);
  pane.findMatches = []; pane.findIndex = -1;
  root.querySelector('#findCount').textContent = 'Replaced ' + count;
}
function wireFindBar(paneId, t) {
  const root = paneRootEls[paneId];
  const findInput = root && root.querySelector('#findInput');
  if (!findInput) return;
  findInput.oninput = () => runFind(paneId, true);
  findInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrev(paneId); else findNext(paneId); }
    else if (e.key === 'Escape') { e.preventDefault(); findBarHide(paneId); }
  };
  root.querySelector('#findPrev').onclick = () => findPrev(paneId);
  root.querySelector('#findNext').onclick = () => findNext(paneId);
  root.querySelector('#findClose').onclick = () => findBarHide(paneId);
  if (!t.readOnly) {
    const replaceInput = root.querySelector('#replaceInput');
    replaceInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceOne(paneId); }
      else if (e.key === 'Escape') { e.preventDefault(); findBarHide(paneId); }
    };
    root.querySelector('#replaceOne').onclick = () => replaceOne(paneId);
    root.querySelector('#replaceAll').onclick = () => replaceAll(paneId);
    const chev = root.querySelector('#findChev');
    const replaceRow = root.querySelector('#replaceRow');
    if (chev && replaceRow) {
      chev.onclick = () => {
        const opening = !replaceRow.classList.contains('show');
        replaceRow.classList.toggle('show', opening);
        chev.classList.toggle('open', opening);
        if (opening) replaceInput.focus();
      };
    }
  }
}

// Rebuilds the highlight overlay, gutter, ruler, and line count - called on
// tab open and on every keystroke. Cheap enough for JCL/REXX-sized members;
// this is the same "just re-render everything" approach the old TK5
// Explorer used for its own overlay pair. Scoped via t.pane rather than a
// paneId argument since every caller already has the tab in hand.
function refreshEditorChrome(t) {
  const root = paneRootEls[t.pane];
  const area = root && root.querySelector('#editorArea');
  if (!area) return;
  const lines = area.value.split('\n');
  // Same height-mismatch bug documented for the SYSLOG tab above, but
  // general to every tab kind: a <textarea> reserves a full line-height for
  // the phantom empty line after a trailing "\n"; the #edHl <pre><code>
  // overlay does not grow by the same amount for the identical string. That
  // fixed dataset text ending in "\n" (the overwhelmingly common case) at
  // its source there was SYSLOG-specific; this generalizes it without
  // touching real content: pad the *rendered* overlay HTML with one extra
  // blank line whenever the source ends in "\n", so #edHl's scrollHeight
  // always matches #editorArea's. Never touches area.value/t.text, so it
  // can't affect what actually gets saved.
  const hlHtml = highlightCode(area.value, effectiveFormat(t));
  root.querySelector('#edHlCode').innerHTML = area.value.endsWith('\n') ? hlHtml + '\n' : hlHtml;
  let gutter = '';
  for (let i = 1; i <= lines.length; i++) gutter += i + '\n';
  root.querySelector('#edGutter').textContent = gutter;
  root.querySelector('#edRuler').innerHTML = buildRuler(effectiveFormat(t));
  root.querySelector('#edLines').textContent = lines.length + (lines.length === 1 ? ' line' : ' lines');
  syncEditorScroll(t.pane);
}

function syncEditorScroll(paneId) {
  const root = paneRootEls[paneId];
  const area = root && root.querySelector('#editorArea');
  const hl = root && root.querySelector('#edHl');
  if (!area || !hl) return;
  hl.scrollTop = area.scrollTop;
  hl.scrollLeft = area.scrollLeft;
  const gutter = root.querySelector('#edGutter');
  if (gutter) gutter.scrollTop = area.scrollTop;
  const ruler = root.querySelector('#edRuler');
  if (ruler) ruler.style.transform = 'translateX(-' + area.scrollLeft + 'px)';
  const pane = panes[paneId];
  const t = pane && tabs.find(x => x.id === pane.activeId);
  if (t) positionGuides(paneId, effectiveFormat(t));
}

async function saveById(id) { const t = tabs.find(x => x.id === id); if (!t) return; activateTab(t); await saveCurrent(); }
async function saveCurrent() {
  const t = curTab();
  if (!t) return;
  if (t.readOnly) { flash(tabLabel(t) + ' is read-only - job spool output can\'t be saved.', false); return; }
  const label = tabLabel(t);
  try {
    if (t.kind === 'uss') {
      if (t.encoding) await ussWriteEnc(t.path, t.text, t.encoding); else await ussWrite(t.path, t.text);
    } else {
      if (isProtected(t.dsn)) { flash(t.dsn + ' is a protected system dataset - edit via ISPF, not this console.', false); return; }
      if (t.encoding) await dsWriteEnc(t.dsn, t.mbr, t.text, t.encoding); else await dsWrite(t.dsn, t.mbr, t.text);
    }
    t.dirty = false; renderTabsFor(t.pane);
    flash('Saved ' + label, true);
    if (t.kind === 'ds' && t.isNew) { t.isNew = false; refreshMemberList(t.dsn); }
  } catch (e) {
    flash(friendlyZosmfError(e.message, label) || ('Save failed: ' + e.message), false);
  }
}

function closeTab(id) {
  const t = tabs.find(x => x.id === id);
  if (t && t.dirty && !confirm('Discard unsaved changes to ' + tabLabel(t) + '?')) return;
  if (t && t.pollTimer) clearInterval(t.pollTimer); // stop the live SYSLOG poll loop
  const paneId = t ? t.pane : focusedPaneId;
  tabs = tabs.filter(x => x.id !== id);
  if (panes[paneId] && panes[paneId].activeId === id) {
    const remaining = tabsInPane(paneId);
    panes[paneId].activeId = remaining.length ? remaining[remaining.length - 1].id : null;
  }
  renderTabsFor(paneId);
  renderEditorFor(paneId);
  // An empty pane collapses out of the layout, same as VS Code closing the
  // last tab in a split group - but never drop below one pane overall.
  if (panes[paneId] && tabsInPane(paneId).length === 0 && countLeaves(paneLayout) > 1) {
    removePane(paneId);
  }
}

async function submitAsJCL(dsn, mbr) {
  const label = dsn + (mbr ? '(' + mbr + ')' : '');
  const open = tabs.find(t => t.kind === 'ds' && t.dsn === dsn && t.mbr === (mbr || ''));
  let text = open ? open.text : null;
  if (text === null) {
    try { text = await dsRead(dsn, mbr); }
    catch (e) { flash(friendlyZosmfError(e.message, label) || ('Submit failed: ' + e.message), false); return; }
  }
  try {
    const r = await zCall('PUT', '/zosmf/restjobs/jobs', { body: text });
    flash('Submitted ' + r.jobname + ' (' + r.jobid + ') - see the Jobs section', true);
    showJobToast(r.jobname, r.jobid);
  } catch (e) { flash(friendlyZosmfError(e.message, label) || ('Submit failed: ' + e.message), false); }
}
async function submitTabAsJCL(t) {
  if (t.kind === 'uss') return submitUssAsJCL(t.path);
  if (t.kind === 'ds') return submitAsJCL(t.dsn, t.mbr);
  flash('Job spool output can\'t be submitted as JCL.', false);
}

// ==================== run REXX exec ====================
// Wraps a PDS member in a small TSO-batch job (PGM=IKJEFT01 + SYSEXEC DD +
// a "%member [parms]" SYSTSIN card) and submits it through the same Jobs
// REST endpoint submitAsJCL uses above - this reuses the already-proven
// job-submission/toast/Jobs-navigation plumbing instead of standing up a
// separate interactive TSO-address-space (/zosmf/tsoApp/tso) integration.
// No USER=/PASSWORD= on the job card: z/OSMF authenticates the submitter
// and JES runs the job as them, same as every other job this console
// submits (see zos/lib/jobs.js).
function buildRexxJcl(dsn, mbr, parm) {
  const user = (localStorage.getItem('isiUser') || 'REXXRUN').slice(0, 7).toUpperCase();
  const jobname = (user + 'X').slice(0, 8);
  const parmCard = parm ? ' ' + parm : '';
  return [
    '//' + jobname.padEnd(8, ' ') + ' JOB (REXX),\'RUN ' + mbr + '\',CLASS=A,MSGCLASS=H,',
    '//             REGION=4096K,NOTIFY=&SYSUID',
    '//RUNREXX  EXEC PGM=IKJEFT01,DYNAMNBR=20',
    '//SYSEXEC  DD DSN=' + dsn + ',DISP=SHR',
    '//SYSTSPRT DD SYSOUT=*',
    '//SYSTSIN  DD *',
    '%' + mbr + parmCard,
    '/*'
  ].join('\n');
}
async function runRexx(dsn, mbr) {
  const parm = prompt('Optional parameters for %' + mbr + ' (leave blank for none):', '');
  if (parm === null) return;
  // %member runs whatever is currently SAVED on the mainframe - warn if an
  // open tab for this exact member has unsaved edits, since those won't
  // be reflected in the run.
  const open = tabs.find(x => x.kind === 'ds' && x.dsn === dsn && x.mbr === mbr && x.dirty);
  if (open && !confirm(mbr + ' has unsaved changes open in a tab. Run REXX executes the last SAVED copy on the mainframe, not your edits. Continue?')) return;
  const jcl = buildRexxJcl(dsn, mbr, parm.trim());
  try {
    const r = await zCall('PUT', '/zosmf/restjobs/jobs', { body: jcl });
    flash('Running ' + mbr + ' as ' + r.jobname + ' (' + r.jobid + ') - see the Jobs section', true);
    showJobToast(r.jobname, r.jobid);
  } catch (e) { flash(friendlyZosmfError(e.message, mbr) || ('Run failed: ' + e.message), false); }
}
async function runRexxTab(t) {
  if (t.kind !== 'ds' || !t.mbr) { flash('Run REXX is only available for PDS members.', false); return; }
  return runRexx(t.dsn, t.mbr);
}

// ==================== delete / rename / clipboard ====================
async function deleteItem(dsn, mbr) {
  const label = dsn + (mbr ? '(' + mbr + ')' : '');
  if (isProtected(dsn)) { flash(dsn + ' is a protected system dataset - delete via ISPF, not this console.', false); return; }
  if (!confirm('Delete ' + label + (mbr ? '' : ' and ALL of its members') + '? This cannot be undone.')) return;
  try {
    await dsDelete(dsn, mbr);
    tabs = tabs.filter(t => !(t.kind === 'ds' && t.dsn === dsn && (!mbr || t.mbr === mbr)));
    reconcilePanesAfterTabsRemoved();
    flash('Deleted ' + label, true);
    if (mbr) refreshMemberList(dsn); else refreshTree();
  } catch (e) { flash('Delete failed: ' + e.message, false); }
}

async function renameItem(dsn, mbr, isPO) {
  if (isProtected(dsn)) { flash(dsn + ' is a protected system dataset - rename via ISPF, not this console.', false); return; }
  const label = mbr || dsn;
  const nv = prompt('Rename ' + label + ' to:', label);
  if (!nv) return;
  const newVal = nv.trim().toUpperCase();
  if (!newVal || newVal === label) return;
  try {
    if (mbr) {
      await dsCopyMember(dsn, mbr, dsn, newVal, false);
      await dsDelete(dsn, mbr);
    } else {
      await dsAllocate(newVal, { like: dsn });
      if (isPO) await dsCopyWholePds(dsn, newVal);
      else await dsCopyMember(dsn, '', newVal, '', true);
      await dsDelete(dsn, '');
    }
    tabs.forEach(t => {
      if (t.kind === 'ds' && t.dsn === dsn && t.mbr === (mbr || '')) { t.dsn = mbr ? dsn : newVal; t.mbr = mbr ? newVal : ''; }
    });
    renderAllTabbars();
    flash('Renamed to ' + newVal, true);
    if (mbr) refreshMemberList(dsn); else refreshTree();
  } catch (e) { flash('Rename failed: ' + e.message, false); }
}

let clip = null; // {op:'copy'|'move', dsn, mbr, isPO}
function setClip(op, dsn, mbr, isPO) {
  clip = { op, dsn, mbr, isPO };
  renderClip();
  flash((op === 'move' ? 'Cut ' : 'Copied ') + dsn + (mbr ? '(' + mbr + ')' : '') + ' - right-click a destination to paste', true);
}
function renderClip() {
  const bar = $('#clipBar');
  if (!clip) { bar.classList.remove('show'); return; }
  bar.classList.add('show');
  $('#clipText').textContent = (clip.op === 'move' ? 'Cut: ' : 'Copied: ') + clip.dsn + (clip.mbr ? '(' + clip.mbr + ')' : '');
}
$('#clipClear').onclick = () => { clip = null; renderClip(); };

async function pasteInto(destDsn, destIsPO) {
  if (!clip) return;
  try {
    if (destIsPO) {
      if (!clip.mbr && clip.isPO) {
        await dsCopyWholePds(clip.dsn, destDsn);
      } else {
        const suggested = clip.mbr || clip.dsn.split('.').pop();
        const nv = prompt('Member name in ' + destDsn + ':', suggested);
        if (!nv) return;
        const destMbr = nv.trim().toUpperCase();
        if (clip.mbr) await dsCopyMember(clip.dsn, clip.mbr, destDsn, destMbr, true);
        else { const text = await dsRead(clip.dsn, ''); await dsWrite(destDsn, destMbr, text); }
      }
    } else {
      if (!confirm('Overwrite the contents of ' + destDsn + ' with ' + clip.dsn + (clip.mbr ? '(' + clip.mbr + ')' : '') + '?')) return;
      if (clip.mbr) { const text = await dsRead(clip.dsn, clip.mbr); await dsWrite(destDsn, '', text); }
      else await dsCopyMember(clip.dsn, '', destDsn, '', true);
    }
    const wasMemberMove = clip.op === 'move' && clip.mbr;
    const srcDsn = clip.dsn;
    if (clip.op === 'move') await dsDelete(clip.dsn, clip.mbr);
    flash('Pasted into ' + destDsn, true);
    clip = null; renderClip();
    // Paste always targets an *existing* dataset (pasteIntoNew() is the one
    // that adds a new top-level row), so the only tree updates needed are
    // to whichever PDS member lists actually changed - never a full
    // refreshTree(), which would otherwise collapse every other expanded
    // PDS in the view.
    if (destIsPO) refreshMemberList(destDsn);
    if (wasMemberMove) refreshMemberList(srcDsn);
  } catch (e) { flash('Paste failed: ' + e.message, false); }
}

async function pasteIntoNew() {
  if (!clip) return;
  const suggested = clip.mbr ? clip.dsn.split('.')[0] + '.NEW.' + clip.mbr : clip.dsn + '.COPY';
  const nv = prompt('New dataset name:', suggested);
  if (!nv) return;
  const dsn = nv.trim().toUpperCase();
  try {
    if (clip.mbr) {
      // 'like' only works against a whole dataset, not a member reference,
      // so a brand-new PDS to receive a single copied member gets sane
      // defaults instead of inheriting the source member's real attributes.
      await dsAllocate(dsn, { dsorg: 'PO', alcunit: 'TRK', primary: 1, secondary: 1, dirblk: 5, recfm: 'FB', lrecl: 80, blksize: 3120 });
      await dsCopyMember(clip.dsn, clip.mbr, dsn, clip.mbr, true);
    } else {
      await dsAllocate(dsn, { like: clip.dsn });
      if (clip.isPO) await dsCopyWholePds(clip.dsn, dsn);
      else await dsCopyMember(clip.dsn, '', dsn, '', true);
    }
    if (clip.op === 'move') await dsDelete(clip.dsn, clip.mbr);
    flash('Copied to new dataset ' + dsn, true);
    clip = null; renderClip();
    $('#hlqFilter').value = dsn.split('.')[0] + '.*';
    currentDslevel = $('#hlqFilter').value;
    refreshTree();
  } catch (e) { flash('Create/paste failed: ' + e.message, false); }
}

// ==================== new dataset modal ====================
$('#newDsBtn').onclick = () => {
  $('#newDsModal').classList.add('show');
  $('#ndInfo').textContent = '';
  $('#ndCreate').disabled = false;
  const hlq = ($('#hlqFilter').value.trim() || localStorage.getItem('isiUser') || '').split('.')[0];
  if (hlq && !$('#ndDsn').value) $('#ndDsn').value = hlq + '.NEW.PDS';
  ndTypeChange();
};
$('#ndCancel').onclick = () => $('#newDsModal').classList.remove('show');
$('#ndType').onchange = ndTypeChange;
$('#ndVsamType').onchange = ndVsamTypeChange;
function ndTypeChange() {
  const type = $('#ndType').value;
  const isPO = type === 'PO';
  const isPsPo = type === 'PO' || type === 'PS';
  const isVsam = type === 'VSAM';
  // PO/PS space is allocated in TRK (unchanged, see dsAllocate call below);
  // VSAM/IDCAMS and zFS/IOEAGFMT both take CYL in the JCL builders further
  // down, so the shared Primary/Secondary fields just relabel to match.
  $('#ndDirWrap').style.visibility = isPO ? 'visible' : 'hidden';
  $('#ndPsPoFields').style.display = isPsPo ? '' : 'none';
  $('#ndVsamFields').style.display = isVsam ? '' : 'none';
  $('#ndPriLabel').textContent = isPsPo ? 'Primary (TRK)' : 'Primary (CYL)';
  $('#ndSecLabel').textContent = isPsPo ? 'Secondary (TRK)' : 'Secondary (CYL)';
  if (isVsam) ndVsamTypeChange();
}
function ndVsamTypeChange() {
  const t = $('#ndVsamType').value;
  $('#ndKeyWrap').style.display = t === 'INDEXED' ? '' : 'none';
  $('#ndRecSizeWrap').style.display = t === 'LINEAR' ? 'none' : '';
}
$('#ndCreate').onclick = async () => {
  const dsn = $('#ndDsn').value.trim().toUpperCase();
  if (!dsn) { $('#ndInfo').textContent = 'Enter a dataset name.'; return; }
  if (isProtected(dsn)) { $('#ndInfo').textContent = dsn + ' is under a protected HLQ - not creating here.'; return; }
  const type = $('#ndType').value;
  $('#ndCreate').disabled = true; $('#ndInfo').textContent = 'Creating...';
  try {
    if (type === 'PO' || type === 'PS') {
      const attrs = {
        dsorg: type,
        alcunit: 'TRK',
        primary: parseInt($('#ndPri').value || '1', 10),
        secondary: parseInt($('#ndSec').value || '1', 10),
        recfm: ($('#ndRecfm').value || 'FB').trim(),
        lrecl: parseInt($('#ndLrecl').value || '80', 10),
        blksize: parseInt($('#ndBlk').value || '3120', 10),
      };
      if (type === 'PO') attrs.dirblk = parseInt($('#ndDir').value || '5', 10);
      await dsAllocate(dsn, attrs);
      $('#newDsModal').classList.remove('show');
      flash('Created ' + dsn, true);
      $('#hlqFilter').value = dsn.split('.')[0] + '.*';
      currentDslevel = $('#hlqFilter').value;
      refreshTree();
    } else if (type === 'VSAM') {
      const opts = {
        clusterType: $('#ndVsamType').value,
        primary: parseInt($('#ndPri').value || '1', 10),
        secondary: parseInt($('#ndSec').value || '1', 10),
        keyLen: parseInt($('#ndKeyLen').value || '10', 10),
        keyOff: parseInt($('#ndKeyOff').value || '0', 10),
        recAvg: parseInt($('#ndRecAvg').value || '80', 10),
        recMax: parseInt($('#ndRecMax').value || '80', 10),
      };
      await createVsamCluster(dsn, opts);
      $('#newDsModal').classList.remove('show');
      flash('Created VSAM cluster ' + dsn, true);
      $('#hlqFilter').value = dsn.split('.')[0] + '.*';
      currentDslevel = $('#hlqFilter').value;
      refreshTree();
    } else if (type === 'ZFS') {
      const primary = parseInt($('#ndPri').value || '1', 10);
      const secondary = parseInt($('#ndSec').value || '1', 10);
      await createZfs(dsn, primary, secondary);
      $('#newDsModal').classList.remove('show');
      flash('Created zFS filesystem ' + dsn, true);
      $('#hlqFilter').value = dsn.split('.')[0] + '.*';
      currentDslevel = $('#hlqFilter').value;
      refreshTree();
    }
  } catch (e) { $('#ndInfo').textContent = e.message; }
  finally { $('#ndCreate').disabled = false; }
};

// ==================== VSAM / zFS creation ====================
// z/OSMF's Dataset REST API (dsAllocate -> POST .../restfiles/ds/{dsn},
// used above for PO/PS) only accepts dsorg PO or PS - no VSAM, no zFS. The
// first version of this feature worked around that by submitting IDCAMS/
// IOEAGFMT as batch JCL through the Jobs API (same pattern as
// runRexx()/submitAsJCL() elsewhere in this file) - it worked, but async
// (had to poll the Jobs section for the result) and needed manual
// fixed-column JCL continuation for long dataset names.
//
// Checking z/OSMF's own API Explorer (https://<host>:10443/zosmf/api/
// explorer/) turned up purpose-built synchronous endpoints for both, which
// this now uses instead - simpler and no JCL involved at all:
//   - PUT /zosmf/restfiles/ams - "Access Method Services Interface".
//     Runs IDCAMS commands directly: body {"input": [...command strings...],
//     "JSONversion": 1}, returns 200 if IDCAMS RC <= 4. No JCL card-image
//     column limits apply since the command text travels as JSON strings,
//     not 80-byte card images - the whole DEFINE CLUSTER fits on one line.
//   - POST /zosmf/restfiles/mfs/zfs/{file-system-name} - "Create z/OS UNIX
//     zFS Filesystem". Purpose-built for exactly this: body
//     {"cylsPri": n, "cylsSec": n, "JSONversion": 1}, 201 on success. This
//     replaces the IOEAGFMT batch job outright - z/OSMF handles the
//     allocate+format itself.
// Both are synchronous, so dataset creation now behaves like PO/PS again:
// the modal closes and the tree refreshes immediately, no job to go check.
//
// Still not live-tested against a real z/OSMF instance as of this writing -
// the request shapes above are taken directly from the reference system's
// own API Explorer output, but that system's SMS setup (storage classes, ACS
// routines, whether non-SMS volumes need an explicit VOLUMES() clause on
// the IDCAMS side) is unverified from here. No VOLUMES() is specified for
// VSAM, relying on SMS auto-assigning storage the same way a plain PO/PS
// allocate does. Test with a disposable name first (e.g. YOURID.TEST.KSDS)
// before trusting this against anything real.
async function createVsamCluster(dsn, opts) {
  const attrs = [opts.clusterType, 'CYL(' + opts.primary + ' ' + opts.secondary + ')'];
  if (opts.clusterType === 'INDEXED') attrs.push('KEYS(' + opts.keyLen + ' ' + opts.keyOff + ')');
  if (opts.clusterType !== 'LINEAR') attrs.push('RECORDSIZE(' + opts.recAvg + ' ' + opts.recMax + ')');
  const cmd = 'DEFINE CLUSTER (NAME(' + dsn + ') ' + attrs.join(' ') + ')';
  return zCall('PUT', '/zosmf/restfiles/ams', { body: { input: [cmd], JSONversion: 1 }, isJson: true });
}
async function createZfs(dsn, primary, secondary) {
  return zCall('POST', '/zosmf/restfiles/mfs/zfs/' + enc(dsn), {
    body: { cylsPri: primary, cylsSec: secondary, JSONversion: 1 }, isJson: true,
  });
}

// ==================== zFS mount ====================
// PUT /zosmf/restfiles/mfs/{file-system-name} - "Mount/Unmount a UNIX file
// system", verified against this system's own API Explorer (Filesystem
// APIs > MountUnixFile). Body: {"action":"mount","mount-point":"<uss path>",
// "fs-type":"ZFS","mode":"rdonly"|"rdwr"}. 204 on success, no content.
// fs-type must match the TYPE operand on the target FILESYSTYPE statement in
// BPXPRMxx - "ZFS" for a zFS-formatted linear dataset, which is what this
// menu item is offered for. mount-point must already exist as a USS
// directory (z/OSMF does not create it) - same "create the path first"
// caveat as the README's upload instructions.
async function mountZfs(dsn, mountPoint, mode) {
  await zCall('PUT', '/zosmf/restfiles/mfs/' + enc(dsn), {
    body: { action: 'mount', 'mount-point': mountPoint, 'fs-type': 'ZFS', mode: mode || 'rdonly' },
    isJson: true,
  });
}
async function mountZfsPrompt(dsn) {
  const mp = prompt('Mount ' + dsn + ' to which USS path?\n(The directory must already exist - create it first in the USS tree if needed.)', '/u/');
  if (!mp) return;
  const mountPoint = mp.trim();
  if (mountPoint.indexOf('/') !== 0) { flash('Mount point must be an absolute USS path starting with "/".', false); return; }
  const rw = confirm('Mount ' + dsn + ' at ' + mountPoint + ' read-write?\n\nOK = read-write, Cancel = read-only.');
  try {
    await mountZfs(dsn, mountPoint, rw ? 'rdwr' : 'rdonly');
    flash('Mounted ' + dsn + ' at ' + mountPoint + ' (' + (rw ? 'read-write' : 'read-only') + ')', true);
    refreshUssTree();
  } catch (e) {
    flash(friendlyZosmfError(e.message, dsn) || ('Mount failed: ' + e.message), false);
  }
}
// Same PUT endpoint as mountZfs, action:"unmount" - confirmed via the same
// live API Explorer model dump used for mountZfs above (action enum is
// ['mount','unmount'] on one shared request body). The model doesn't expose
// a force/immediate unmount option (unlike the z/OS UNMOUNT console command's
// NORMAL/IMMEDIATE/FORCE/DRAIN/RESET), so a busy filesystem's unmount just
// fails cleanly through friendlyZosmfError like everything else here - no
// force-unmount escalation offered from the console.
async function unmountZfs(dsn) {
  await zCall('PUT', '/zosmf/restfiles/mfs/' + enc(dsn), { body: { action: 'unmount' }, isJson: true });
}
async function unmountZfsPrompt(dsn) {
  if (!confirm('Unmount ' + dsn + '?\n\nThis detaches the filesystem from its current mount point. Files open underneath it may cause this to fail.')) return;
  try {
    await unmountZfs(dsn);
    flash('Unmounted ' + dsn, true);
    refreshUssTree();
  } catch (e) {
    flash(friendlyZosmfError(e.message, dsn) || ('Unmount failed: ' + e.message), false);
  }
}

// ==================== jobs tree ====================
// Zowe-Explorer-style: each job is a tree node; expanding it lists its
// DD/spool statements (JESMSGLG, JESJCL, JESYSMSG, and one per step's
// SYSPRINT etc.) as children, and clicking one opens it as a read-only tab
// via openJobFile() above - replacing the old table + single dropdown-
// driven output panel.
// owner/prefix support wildcards (* multi-char, ? single-char) server-side.
// status is trickier: z/OSMF's restjobs API only recognizes literal
// "ACTIVE" for that query param - anything else (OUTPUT, INPUT, or leaving
// it off) is treated the same and returns both active and completed jobs.
// So OUTPUT/INPUT filtering happens client-side below, against the
// `status` field already present on each returned job document.
async function jobsList(owner, prefix, status) {
  let path = '/zosmf/restjobs/jobs?owner=' + enc(owner || '*') + '&prefix=' + enc(prefix || '*');
  if (status === 'ACTIVE') path += '&status=ACTIVE';
  const j = await zCall('GET', path);
  let rows = Array.isArray(j) ? j : [];
  if (status && status !== 'ACTIVE') rows = rows.filter(r => r.status === status);
  return rows;
}
let currentJobPrefix = '';
let currentJobOwner = '*';
let currentJobStatus = '';
let currentJobSort = '';
function sortJobRows(rows, sortKey) {
  const copy = rows.slice();
  if (sortKey === 'id') copy.sort((a, b) => a.jobid.localeCompare(b.jobid));
  else if (sortKey === 'name') copy.sort((a, b) => a.jobname.localeCompare(b.jobname));
  else if (sortKey === 'retcode') copy.sort((a, b) => (a.retcode || '').localeCompare(b.retcode || ''));
  return copy;
}
// Keyed by jobname.jobid, rebuilt fresh on every refreshJobTree() - same
// in-place-refresh idea as pdsNodeRegistry, so "Refresh Job" can update one
// row's status pill and (if expanded) its DD list without collapsing every
// other expanded job in the tree.
let jobNodeRegistry = new Map();
function jobKey(j) { return j.jobname + '.' + j.jobid; }
async function refreshJobTree() {
  const tree = $('#jobTree'); tree.innerHTML = '<div class="treeItem muted">Loading...</div>';
  jobNodeRegistry = new Map();
  try {
    let rows = await jobsList(currentJobOwner, currentJobPrefix, currentJobStatus);
    rows = sortJobRows(rows, currentJobSort);
    tree.innerHTML = '';
    if (!rows.length) { tree.innerHTML = '<div class="treeItem muted">No jobs found.</div>'; return; }
    rows.forEach(j => tree.appendChild(renderJobNode(j)));
  } catch (e) { tree.innerHTML = ''; flash(friendlyZosmfError(e.message, currentJobPrefix) || ('Job list failed: ' + e.message), false); }
}
function renderJobNode(j) {
  const wrap = document.createElement('div');
  wrap.dataset.jobkey = jobKey(j); // lets openJobInTree() find this node from outside the tree
  const row = document.createElement('div');
  row.className = 'treeItem dir';
  function paintRow() {
    const st = ['OUTPUT', 'ACTIVE'].includes(j.status) ? j.status : 'other';
    row.innerHTML = '<span>' + j.jobname + ' (' + j.jobid + ')</span> '
      + '<span class="pill ' + st + '">' + j.status + '</span>'
      + (j.retcode ? ' <span class="muted">' + j.retcode + '</span>' : '');
  }
  paintRow();
  wrap.appendChild(row);
  const childWrap = document.createElement('div');
  childWrap.style.display = 'none';
  wrap.appendChild(childWrap);
  let loaded = false;
  async function loadFiles() {
    loaded = true;
    childWrap.innerHTML = '<div class="treeItem member muted">Loading...</div>';
    try {
      const files = await zCall('GET', '/zosmf/restjobs/jobs/' + enc(j.jobname) + '/' + enc(j.jobid) + '/files');
      childWrap.innerHTML = '';
      if (!files || !files.length) { childWrap.innerHTML = '<div class="treeItem member muted">(no spool files)</div>'; return; }
      files.forEach(f => childWrap.appendChild(renderJobFileNode(j, f)));
    } catch (e) {
      childWrap.innerHTML = '<div class="treeItem member muted">' + e.message + '</div>';
    }
  }
  row.onclick = async () => {
    const opening = childWrap.style.display === 'none';
    childWrap.style.display = opening ? '' : 'none';
    row.classList.toggle('open', opening);
    if (opening && !loaded) await loadFiles();
  };
  row.oncontextmenu = e => showJobCtx(e, j);
  jobNodeRegistry.set(jobKey(j), {
    isOpen: () => childWrap.style.display !== 'none',
    reload: loadFiles,
    refreshStatus: async () => {
      try {
        const fresh = await zCall('GET', '/zosmf/restjobs/jobs/' + enc(j.jobname) + '/' + enc(j.jobid));
        j.status = fresh.status; j.retcode = fresh.retcode;
        paintRow();
      } catch (e) { /* job may have aged off the queue - leave last known status showing */ }
    },
  });
  return wrap;
}
function renderJobFileNode(j, f) {
  const row = document.createElement('div');
  row.className = 'treeItem member';
  row.textContent = (f.stepname || 'JES2') + ':' + f.ddname + '(' + f.id + ')';
  row.onclick = () => openJobFile(j.jobname, j.jobid, f.stepname || 'JES2', f.ddname, f.id);
  return row;
}
async function refreshJobNode(j) {
  const node = jobNodeRegistry.get(jobKey(j));
  if (!node) return;
  await node.refreshStatus();
  if (node.isOpen()) await node.reload();
  flash('Refreshed ' + j.jobname, true);
}

// ---- jump to a job from outside the tree (submit toast, favorites) -----
// Expands the Jobs section if it's collapsed, filters the tree down to
// this job, and expands its node so the spool file list is right there
// ready to click - one retry with a short delay since z/OSMF can take a
// moment to surface a job that was just submitted.
async function openJobInTree(jobname, jobid) {
  const sec = $('#secJobs');
  if (sec && !sec.classList.contains('open')) {
    sec.classList.add('open');
    applySideHeights();
  }
  currentJobPrefix = jobname;
  currentJobOwner = '*';
  currentJobStatus = '';
  $('#jobFilter').value = jobname;
  await refreshJobTree();
  const sel = '#jobTree [data-jobkey="' + CSS.escape(jobname + '.' + jobid) + '"] > .treeItem.dir';
  let row = document.querySelector(sel);
  if (!row) {
    await new Promise(r => setTimeout(r, 1200));
    await refreshJobTree();
    row = document.querySelector(sel);
  }
  if (row) {
    row.scrollIntoView({ block: 'center' });
    if (!row.classList.contains('open')) row.click();
  } else {
    flash(jobname + ' (' + jobid + ') isn\'t showing in the job list yet - try Refresh in a moment.', false);
  }
}

// ---- bottom-right "job submitted" toast --------------------------------
// Separate from the top-center #msg flash (which just confirms the submit
// happened) - this one sticks around long enough to click, and jumping
// straight to the job's spool files is the main point of it.
function showJobToast(jobname, jobid) {
  const host = $('#jobToasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'jobToast';
  el.innerHTML =
    '<div class="jobToastMain">' +
      '<div class="jobToastTitle">Job submitted</div>' +
      '<div class="jobToastSub">' + escHtml(jobname) + ' (' + escHtml(jobid) + ') &middot; click to view output</div>' +
    '</div>' +
    '<button class="jobToastClose" title="Dismiss">&times;</button>';
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }
  el.querySelector('.jobToastClose').onclick = (e) => { e.stopPropagation(); dismiss(); };
  el.onclick = () => { dismiss(); openJobInTree(jobname, jobid); };
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const timer = setTimeout(dismiss, 12000);
}

async function getJobJcl(j) {
  const existing = tabs.find(t => t.kind === 'job' && t.jobname === j.jobname && t.jobid === j.jobid && t.fileId === 'JCL');
  if (existing) { activateTab(existing); return; }
  try {
    const text = await zCall('GET', '/zosmf/restjobs/jobs/' + enc(j.jobname) + '/' + enc(j.jobid) + '/files/JCL/records', { raw: true });
    const t = { id: nextId++, kind: 'job', jobname: j.jobname, jobid: j.jobid, stepname: 'JES2', ddname: 'JCL', fileId: 'JCL', text, dirty: false, fmt: 'jcl', readOnly: true };
    tabs.push(t); activateTab(t);
  } catch (e) { flash('Get JCL failed: ' + e.message, false); }
}
async function downloadAllSpool(j, binary) {
  try {
    const files = await zCall('GET', '/zosmf/restjobs/jobs/' + enc(j.jobname) + '/' + enc(j.jobid) + '/files');
    if (!files || !files.length) { flash('No spool files to download', false); return; }
    let combined = '';
    for (const f of files) {
      const text = await zCall('GET', '/zosmf/restjobs/jobs/' + enc(j.jobname) + '/' + enc(j.jobid) + '/files/' + f.id + '/records',
        { raw: true, headers: binary ? { 'X-IBM-Data-Type': 'binary' } : {} });
      combined += '===== ' + (f.stepname || 'JES2') + ':' + f.ddname + ' (' + f.id + ') =====\n' + text + '\n\n';
    }
    downloadText(j.jobname + '.' + j.jobid + (binary ? '.binary.txt' : '.txt'), combined);
    flash('Downloaded all spool output for ' + j.jobname, true);
  } catch (e) { flash('Download failed: ' + e.message, false); }
}
// z/OSMF's Console REST API - issues a live MVS operator command through
// the default extended console ("defcn"). This is real operator-console
// power (same category of risk the PROCLIB-wipe incident came out of), so
// every caller below shows the exact command text in a confirm() before
// sending it - never fires silently. Not yet exercised against the live
// system from this session (no zosmf credentials available here), so the
// endpoint/verb should be treated as best-effort until confirmed working.
async function consoleCmd(cmd) {
  return await zCall('PUT', '/zosmf/restconsoles/consoles/defcn', { body: { cmd }, isJson: true });
}
async function issueModifyCommand(j) {
  const parm = prompt('Modify parameter for ' + j.jobname + ' - sent as: F ' + j.jobname + ',<parm>', '');
  if (parm === null) return;
  const cmd = 'F ' + j.jobname + ',' + parm;
  if (!confirm('Issue this MVS console command?\n\n' + cmd)) return;
  try { await consoleCmd(cmd); flash('Issued: ' + cmd, true); }
  catch (e) { flash('Command failed: ' + e.message, false); }
}
async function issueStopCommand(j) {
  const cmd = 'P ' + j.jobname;
  if (!confirm('Issue this MVS console command?\n\n' + cmd)) return;
  try { await consoleCmd(cmd); flash('Issued: ' + cmd, true); }
  catch (e) { flash('Command failed: ' + e.message, false); }
}
// Free-text version reached from the SYSLOG tab's right-click menu - same
// consoleCmd() plumbing and confirm()-before-send safety net as the two
// job-scoped commands above, just without a pre-filled template since any
// command is fair game here (this is real operator-console power - the
// same category of risk the PROCLIB-wipe incident came out of).
async function issueCustomCommand() {
  const cmd = prompt('MVS console command to issue:', '');
  if (!cmd || !cmd.trim()) return;
  const trimmed = cmd.trim();
  if (!confirm('Issue this MVS console command?\n\n' + trimmed)) return;
  try {
    await consoleCmd(trimmed);
    flash('Issued: ' + trimmed, true);
    // Give the command a moment to land in SYSLOG, then poll early so its
    // response shows up right away instead of waiting for the next
    // scheduled tick (up to SYSLOG_POLL_MS later).
    const t = findSyslogTab();
    if (t) setTimeout(() => pollSyslog(t), 800);
  } catch (e) { flash('Command failed: ' + e.message, false); }
}
async function cancelJobRow(jobname, jobid) {
  if (!confirm('Cancel ' + jobname + ' ' + jobid + '? This stops it if still running or queued (output is kept - use Delete Job to purge it too).')) return;
  try {
    await zCall('PUT', '/zosmf/restjobs/jobs/' + enc(jobname) + '/' + enc(jobid), { body: { request: 'cancel' }, isJson: true });
    flash('Cancelled ' + jobname, true);
    refreshJobTree();
  } catch (e) { flash('Cancel failed: ' + e.message, false); }
}
function showJobCtx(e, j) {
  const favRef = { kind: 'job', jobname: j.jobname, jobid: j.jobid, label: j.jobname + ' (' + j.jobid + ')' };
  ctxShow(e, [
    ['Refresh Job', () => refreshJobNode(j)],
    ['Get JCL', () => getJobJcl(j)],
    ['Download All', () => downloadAllSpool(j, false)],
    ['Download All (Binary)', () => downloadAllSpool(j, true)],
    '-',
    ['Issue Modify Command...', () => issueModifyCommand(j)],
    ['Issue Stop Command', () => issueStopCommand(j)],
    '-',
    [isFavorite(favRef) ? 'Remove from Favorites' : 'Add to Favorites', () => toggleFavorite(favRef)],
    '-',
    ['Copy Name', () => copyNameToClipboard(j.jobname + ' (' + j.jobid + ')')],
    '-',
    ['Cancel Job', () => cancelJobRow(j.jobname, j.jobid)],
    ['Delete Job', () => purgeJobRow(j.jobname, j.jobid)],
  ]);
}
async function purgeJobRow(jobname, jobid) {
  if (!confirm('Purge ' + jobname + ' ' + jobid + '?')) return;
  try {
    await zCall('DELETE', '/zosmf/restjobs/jobs/' + enc(jobname) + '/' + enc(jobid));
    flash('Purged ' + jobname, true);
    refreshJobTree();
  } catch (e) { flash('Purge failed: ' + e.message, false); }
}
$('#jobsListBtn').onclick = () => {
  currentJobPrefix = $('#jobFilter').value.trim();
  currentJobOwner = '*';
  currentJobStatus = '';
  refreshJobTree();
};
$('#jobsRefreshBtn').onclick = refreshJobTree;
$('#jobFilter').addEventListener('keydown', e => { if (e.key === 'Enter') $('#jobsListBtn').click(); });

// ---- Search Jobs popover: Owner / Prefix / Status + recent-search history ----
// Same localStorage-recent-list pattern as USS's ussFilterPop/USS_RECENT_KEY
// above - z/OSMF's restjobs API supports real owner/prefix filtering
// server-side (unlike USS, which has no server-side search at all), so this
// is closer to Zowe Explorer's actual "Search Jobs" quick-pick than the USS
// one is to a real filename search.
const JOB_SEARCH_RECENT_KEY = 'isiJobSearchRecent';
function loadJobSearchRecent() {
  try { return JSON.parse(localStorage.getItem(JOB_SEARCH_RECENT_KEY) || '[]'); } catch (e) { return []; }
}
function pushJobSearchRecent(s) {
  const key = JSON.stringify(s);
  let recent = loadJobSearchRecent().filter(r => JSON.stringify(r) !== key);
  recent.unshift(s);
  recent = recent.slice(0, 15);
  try { localStorage.setItem(JOB_SEARCH_RECENT_KEY, JSON.stringify(recent)); } catch (e) { /* ignore */ }
}
function jobSearchLabel(s) {
  return 'Owner: ' + (s.owner || '*') + '  Prefix: ' + (s.prefix || '*') + '  Status: ' + (s.status || 'All');
}
function renderJobSearchRecent() {
  const list = $('#jobSearchRecentList'); if (!list) return;
  const recent = loadJobSearchRecent();
  if (!recent.length) { list.innerHTML = '<div class="treeItem muted">No recent searches yet.</div>'; return; }
  list.innerHTML = recent.map(s => '<div class="ussRecentItem">' + escHtml(jobSearchLabel(s)) + '</div>').join('');
  list.querySelectorAll('.ussRecentItem').forEach((el, i) => { el.onclick = () => applyJobSearch(recent[i]); });
}
function applyJobSearch(s) {
  $('#jobSearchOwner').value = s.owner || '';
  $('#jobSearchPrefix').value = s.prefix || '';
  $('#jobSearchStatus').value = s.status || '';
  currentJobOwner = s.owner || '*';
  currentJobPrefix = s.prefix || '*';
  currentJobStatus = s.status || '';
  $('#jobFilter').value = currentJobPrefix === '*' ? '' : currentJobPrefix;
  $('#jobSearchPop').classList.remove('show');
  pushJobSearchRecent(s);
  refreshJobTree();
}
// position:fixed popover, so it's placed via JS from the button's own
// bounding rect (same clamp-to-viewport approach as ctxShow() above) -
// see the .jobSearchPop CSS comment for why it can't just anchor with
// top/left/right the way .ussFilterPop does.
function positionJobSearchPop() {
  const btn = $('#jobsSearchBtn'), pop = $('#jobSearchPop');
  const r = btn.getBoundingClientRect();
  const popW = pop.offsetWidth || 260, popH = pop.offsetHeight || 0;
  let left = r.left;
  if (left + popW > innerWidth - 10) left = Math.max(10, innerWidth - popW - 10);
  let top = r.bottom + 6;
  if (top + popH > innerHeight - 10) top = Math.max(10, innerHeight - popH - 10);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
$('#jobsSearchBtn').onclick = (e) => {
  e.stopPropagation();
  renderJobSearchRecent();
  $('#jobSearchOwner').value = currentJobOwner === '*' ? '' : currentJobOwner;
  $('#jobSearchPrefix').value = currentJobPrefix === '*' ? '' : currentJobPrefix;
  $('#jobSearchStatus').value = currentJobStatus;
  const opening = !$('#jobSearchPop').classList.contains('show');
  $('#jobSearchPop').classList.toggle('show');
  if (opening) { positionJobSearchPop(); $('#jobSearchOwner').focus(); }
};
$('#jobSearchGo').onclick = () => {
  applyJobSearch({
    owner: $('#jobSearchOwner').value.trim() || '*',
    prefix: $('#jobSearchPrefix').value.trim() || '*',
    status: $('#jobSearchStatus').value,
  });
};
['#jobSearchOwner', '#jobSearchPrefix'].forEach(sel => {
  $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') $('#jobSearchGo').click(); });
});
document.addEventListener('click', (e) => {
  const pop = $('#jobSearchPop');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target) && e.target.id !== 'jobsSearchBtn') {
    pop.classList.remove('show');
  }
});

// ---- Sort Jobs ----
$('#jobSortSelect').onchange = () => { currentJobSort = $('#jobSortSelect').value; refreshJobTree(); };

// ---- Start Polling Active Jobs ----
// Lighter-weight than the SYSLOG tab's poll (no tab lifetime to track,
// since this drives the always-present sidebar tree rather than a tab) -
// just an interval that re-runs whatever job search/filter is currently
// active, toggled on/off from the same icon button.
const JOB_POLL_MS = 10000;
let jobPollTimer = null;
function setJobPolling(on) {
  const btn = $('#jobsPollBtn');
  if (on) {
    if (jobPollTimer) return;
    jobPollTimer = setInterval(refreshJobTree, JOB_POLL_MS);
    btn.classList.add('active');
    btn.innerHTML = '&#9208;';
    btn.title = 'Stop Polling Active Jobs';
  } else {
    if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null; }
    btn.classList.remove('active');
    btn.innerHTML = '&#9654;';
    btn.title = 'Start Polling Active Jobs';
  }
}
$('#jobsPollBtn').onclick = () => setJobPolling(!jobPollTimer);

// ---- Issue TSO Command ----
// z/OSMF's newer single-call TSO/E API (PUT .../zosmf/tsoApp/v1/tso) -
// starts a TSO address space, runs the one command, and tears it down in
// one round trip, versus the older stateful start/send/ping/end session
// API. Runs under the logged-in user's own TSO authority (not operator-
// console authority the way consoleCmd() above is), but still real system
// power, so it gets the same confirm()-before-send treatment as the MVS
// console commands. Not yet exercised against the live system from this
// session - treat the endpoint/response shape as best-effort until
// confirmed working.
async function issueTsoCommand() {
  const cmd = prompt('TSO command to issue:', '');
  if (!cmd || !cmd.trim()) return;
  const trimmed = cmd.trim();
  if (!confirm('Issue this TSO command?\n\n' + trimmed)) return;
  try {
    const r = await zCall('PUT', '/zosmf/tsoApp/v1/tso', { body: { tsoCmd: trimmed }, isJson: true });
    const lines = Array.isArray(r.cmdResponse) ? r.cmdResponse.map(m => m.message).join('\n') : '';
    showInfoModal('TSO: ' + trimmed, lines || '(no output)');
  } catch (e) { flash('TSO command failed: ' + e.message, false); }
}
// Header-level, not Jobs-toolbar-only - same "global action, not tied to
// one sidebar section" placement as #syslogBtn, since a TSO command isn't
// scoped to Datasets/USS/Jobs any more than SYSLOG is. Used to live as
// #jobsTsoBtn in the Jobs toolbar only; moved here so it's reachable no
// matter which section is open.
$('#tsoBtn').onclick = issueTsoCommand;

// ==================== volumes ====================
// z/OSMF's Storage Management REST API (a separate service from the
// dataset/USS Files API used everywhere else in this console) - GET
// /zosmf/storage/rest/v1/volumes, returning a bare JSON array (not the
// {items:[...]} envelope the Files API uses) of volume records. Requires
// the z/OSMF "Storage Management" plugin to be active on the target
// system (SAF resource identifier STORAGE); if this section errors, check
// /zosmf/info's plugin list first. Field names/shapes are per IBM's spec:
// https://www.ibm.com/docs/en/zos/3.1.0?topic=services-get-list-volumes
//
// SCOPE - THIS IS SMS-MANAGED VOLUMES ONLY, and that is the API's
// behaviour, not a bug here. IBM describes the response as "an array of
// JSON *storage group* documents", and every field is a property of the
// volume's SMS *definition* rather than of the live device: lastUser is
// "the user that made the last update to the volume definition",
// updateDate/updateTime are that definition's, and storageGroupName /
// storageGroupStatus have no meaning off SMS. It reads the SMS
// configuration, not the UCBs - so a real, online, non-SMS volume (one
// DEVSERV reports as PRIV/RSDNT with no SMS status) is correctly absent
// from the result, and the API returns an empty array rather than an
// error. Confirmed live against a non-SMS volume.
//
// There is no z/OSMF REST API that enumerates online DASD generally.
// Covering non-SMS volumes would mean issuing D U,DASD,ONLINE or DEVSERV
// QDASD through the operator console API (/zosmf/restconsoles) and
// parsing the console text - deliberately not done, since that data
// source cannot supply free space, capacity or storage-group attributes
// anyway. The section is labelled "Volumes (SMS-managed)" in index.html
// so the scope is visible in the UI rather than only in this comment.
async function volList(filter) {
  const qs = filter ? ('?filter=' + enc(filter)) : '';
  const j = await zCall('GET', '/zosmf/storage/rest/v1/volumes' + qs);
  return Array.isArray(j) ? j : ((j && j.items) || []);
}
// Capacity/free-space fields are documented as plain megabyte numbers -
// shown as GB above 1024MB for readability, exact MB below that.
function fmtMB(mb) {
  if (mb === undefined || mb === null) return '?';
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}
let currentVolFilter = '';
async function refreshVolumes() {
  const box = $('#volTree'); if (!box) return;
  box.innerHTML = '<div class="treeItem muted">Loading...</div>';
  try {
    const vols = await volList(currentVolFilter);
    box.innerHTML = '';
    // An empty array here is a normal, successful response - most often it
    // just means the volser asked for isn't SMS-managed. Say so, rather
    // than the bare "not found" that sent this looking like a bug once.
    if (!vols.length) {
      box.innerHTML = '<div class="treeItem muted">' +
        (currentVolFilter
          ? 'No SMS-managed volume matches ' + escHtml(currentVolFilter) + '.'
          : 'No SMS-managed volumes found.') +
        '</div>' +
        '<div class="treeItem muted">Volumes outside SMS (DEVSERV shows them as PRIV/RSDNT with no SMS status) are not reported by this API.</div>';
      return;
    }
    vols.forEach(v => box.appendChild(buildVolRow(v)));
  } catch (e) {
    box.innerHTML = '';
    flash('List volumes failed: ' + e.message + ' - is the Storage Management plugin enabled on this z/OSMF?', false);
  }
}
// A volume record whose totalCapacity is 0 has no space data behind it -
// SMS simply hasn't got current statistics for that volume (IBM's own
// documented sample response is exactly this: every space field zero).
// That is NOT the same as a full volume, and rendering it as "0 MB free,
// 0% used" states the opposite of the truth twice over - 0% used should
// imply almost everything is free. Report the absence instead.
function hasSpaceData(v) {
  return !!v.totalCapacity;
}
// Derive "% used" from capacity and free space rather than trusting the
// API's own fullVolumeLastUsed, which comes back 0 on volumes whose
// totalCapacity/freeSpace are plainly non-zero and contradict it (SMPWK1:
// 79.3 GB total, 28.6 GB free, "% full: 0%"). IBM documents the field as
// "the percentage of total space that is in use", but does not say what
// populates it, and it evidently is not populated here - whereas capacity
// and free space are live and consistent. Two numbers that disagree are
// worse than one, so the arithmetic wins and the raw field is reported
// separately in the attributes modal rather than driving the display.
function usedPct(v) {
  if (!hasSpaceData(v)) return null;
  const free = v.freeSpace || 0;
  const used = v.totalCapacity - free;
  if (used < 0) return null; // free > capacity: nonsense, don't invent a number
  return Math.round((used / v.totalCapacity) * 100);
}
function buildVolRow(v) {
  const row = document.createElement('div');
  row.className = 'treeItem';
  const pct = usedPct(v);
  const spaceHtml = hasSpaceData(v)
    ? '<span class="volFree">' + escHtml(fmtMB(v.freeSpace)) + ' free</span>' +
      '<span class="volPct">' + escHtml(pct === null ? '?' : pct + '%') + ' used</span>'
    : '<span class="volFree">no space data</span>';
  row.innerHTML =
    '<span class="volSerial">' + escHtml(v.volumeSerial || '?') + '</span>' +
    spaceHtml +
    (v.storageGroupName ? '<span class="volSg">' + escHtml(v.storageGroupName) + '</span>' : '');
  row.onclick = () => showVolumeAttributes(v);
  row.oncontextmenu = e => ctxShow(e, [
    ['Show Attributes...', () => showVolumeAttributes(v)],
    ['Copy Volser', () => copyNameToClipboard(v.volumeSerial || '')],
  ]);
  return row;
}
function showVolumeAttributes(v) {
  const lines = [
    'Volume: ' + (v.volumeSerial || '?'),
    '',
  ];
  if (hasSpaceData(v)) {
    const pct = usedPct(v);
    lines.push(
      'Total capacity: ' + fmtMB(v.totalCapacity),
      'Used: ' + fmtMB(v.totalCapacity - (v.freeSpace || 0)) +
        (pct === null ? '' : '  (' + pct + '%)'),
      'Free space: ' + fmtMB(v.freeSpace) +
        (pct === null ? '' : '  (' + (100 - pct) + '%)'),
      'Largest free extent: ' + fmtMB(v.largestFreeExtent),
      '',
      'As reported by SMS (may be unpopulated - see % used above,',
      'which is derived from capacity and free space):',
      '  % full: ' + (v.fullVolumeLastUsed === undefined || v.fullVolumeLastUsed === null ? '?' : v.fullVolumeLastUsed + '%'),
      '  % track-managed space used: ' + (v.trackRegionLastUsed === undefined || v.trackRegionLastUsed === null ? '?' : v.trackRegionLastUsed + '%'),
    );
  } else {
    lines.push(
      'Space: no data reported by SMS for this volume.',
      '(All space fields came back zero, which means statistics are',
      'unavailable - it does not mean the volume is full.)',
    );
  }
  lines.push(
    '',
    'Storage group: ' + (v.storageGroupName || '(none)'),
    'Storage group status: ' + (v.storageGroupStatus || '?'),
    '',
    'Last updated by: ' + (v.lastUser || '?'),
    'Last updated: ' + ([v.updateDate, v.updateTime].filter(Boolean).join(' ') || '?'),
  );
  if (Array.isArray(v.status) && v.status.length) {
    lines.push('', 'System status:');
    v.status.forEach(s => {
      lines.push('  ' + (s.sysName || '?') + ': MVS=' + (s.mvsSystemStatus || '?') +
        ', requested=' + (s.requestedSystemStatus || '?') + ', SMS=' + (s.confirmedSmsStatus || '?'));
    });
  }
  showInfoModal('Volume Attributes', lines.join('\n'));
}
$('#volListBtn').onclick = () => { currentVolFilter = $('#volFilter').value.trim(); refreshVolumes(); };
$('#volFilter').addEventListener('keydown', e => { if (e.key === 'Enter') $('#volListBtn').click(); });
$('#volRefreshBtn').onclick = refreshVolumes;

// ==================== init ====================
(async function init() {
  const ok = await requireAuth();
  if (!ok) return;
  let restored = false;
  try {
    const saved = localStorage.getItem(layoutStorageKey());
    if (saved) restored = await restoreLayoutState(saved);
  } catch (e) { restored = false; }
  if (!restored) {
    initPanes();
    renderPaneLayout();
    if (paneRootEls[focusedPaneId]) paneRootEls[focusedPaneId].classList.add('focused');
  }
  loadFavorites();
  renderFavorites();
  const u = localStorage.getItem('isiUser');
  currentDslevel = u ? u + '.*' : '';
  $('#hlqFilter').value = currentDslevel;
  if (currentDslevel) refreshTree();
  // USS default path mirrors the dataset HLQ default above - the user's own
  // home directory, best-guessed from their userid (lowercase, standard USS
  // convention). Jobs deliberately does NOT auto-load here - same as before
  // the sidebar rework, it only lists on an explicit List click, since a
  // wildcard-owner job query is a heavier/less-obviously-wanted call than a
  // dataset or USS listing scoped to the user's own HLQ/home.
  goToUssPath(u ? '/u/' + u.toLowerCase() : '/');
})();
