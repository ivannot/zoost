// CRM navigation and reveal actions.
// ---------- reveal (auto-navigate to Functions page, then filter) ----------
const crmNavigationContext = () => ({
  base: bound?.base || lastCtx?.origin,
  instance: bound?.instance || lastCtx?.instance,
});
function functionsUrl() { return crmFunctionsUrl(crmNavigationContext()); }
function functionUrl(uiId) { return crmFunctionUrl(crmNavigationContext(), uiId); }
// Offered data centres come from the manifest; the selected one remains a user choice because a
// consultant may move between accounts hosted in different data centres.
const DCS = [...new Set((chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => h.startsWith('https://crm.'))
  .map((h) => h.slice('https://crm.'.length).replace(/\/.*$/, '')))].sort();
const dcOf = (origin) => (String(origin || '').match(/^https:\/\/[^.]+\.(.+)$/) || [])[1] || null;
function renderGoDc() {
  const sel = $('gozohodc'); if (!sel) return;
  const want = sel.dataset.touched ? sel.value
    : (dcOf(bound?.base) || dcOf(lastCtx?.origin) || zohoDc);
  if (sel.options.length !== DCS.length) {
    sel.innerHTML = DCS.map((d) => `<option value="${escA(d)}">${escHtml(d)}</option>`).join('');
  }
  sel.value = DCS.includes(want) ? want : DCS[0];
}
function homeUrl() {
  const dc = ($('gozohodc') && $('gozohodc').value) || dcOf(bound?.base) || dcOf(lastCtx?.origin) || zohoDc;
  // Production, never the sandbox: this is the way *in*, and a sandbox host is a place you arrive at
  // from a workspace that already knows it is one.
  return crmHomeUrl(dc);
}
// The adapter checks the complete host against manifest permissions and navigates the CRM frame
// inside suite shells, preserving the shell instead of replacing the whole tab.
const crmZohoNavigator = createCrmZohoNavigator({
  chromeApi: chrome,
  hostPatterns: ZOHO_MATCHES,
  findTab: zohoTabId,
  findFrame: crmFrameId,
  refused: (url) => setStatus('This workspace points at '
    + (((url || '').match(/^https?:\/\/[^/]+/) || [])[0] || 'somewhere')
    + ', which is not a Zoho address. Nothing was opened - check where this workspace folder came from.', 'bad'),
});
const goToZoho = crmZohoNavigator.open;
async function openZohoHome() {
  if (sampleRefuse()) return;
  await goToZoho(homeUrl());
}
function actionUrl(a) { return crmActionUrl(crmNavigationContext(), a); }
function templateUrl(a) { return crmTemplateUrl(crmNavigationContext(), a); }
async function openZohoAt(url, what) {
  if (sampleRefuse()) return;
  if (!url) { setStatus(MSG.noActionTarget, 'warn'); return; }
  // **The refusal is the return value, and six callers threw it away.** `goToZoho` answers `null`
  // on one path only - the origin guard - and that guard has already written «This workspace points
  // at <somewhere>, which is not a Zoho address. Nothing was opened», in red, for a workspace folder
  // that came from somebody else. Announcing success on top of it left that sentence on screen for
  // microseconds and told the reader the page is open. It is not.
  if (!await goToZoho(url)) return;
  setStatus(`Opened \u00ab${what}\u00bb in Zoho.`, 'ok');
}
async function openActionInZoho(a) { await openZohoAt(actionUrl(a), a.name || a.id); }
async function openModulePage(genName, navigable, label) {
  if (sampleRefuse()) return;
  if (navigable === false) { setStatus(`\u00ab${label || genName}\u00bb has no records tab (linking/subform or no access).`, 'warn'); return; }
  const url = crmModuleUrl(crmNavigationContext(), genName);
  if (!url) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  if (!await goToZoho(url)) return;
  setStatus(`Opened \u00ab${genName}\u00bb in Zoho.`, 'ok');
}
async function openModuleLayouts(gen) {
  if (sampleRefuse()) return;
  const url = crmLayoutUrl(crmNavigationContext(), gen);
  if (!url) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  if (!await goToZoho(url)) return;
  setStatus(`Opened ${gen} layouts in Zoho.`, 'ok');
}
async function openModuleLayout(gen, layoutId) {
  if (sampleRefuse()) return;
  const url = crmLayoutUrl(crmNavigationContext(), gen, layoutId);
  if (!url) { setStatus(MSG.noModuleTarget, 'warn'); return; }
  if (!await goToZoho(url)) return;
  setStatus(layoutId ? 'Opened the layout in Zoho.' : `Opened ${gen} layouts in Zoho.`, 'ok');
}
function moduleNavigable(m) {
  const gen = m.module_name || '', api = m.api_name || '';
  if (/^LinkingModule\d+$/i.test(gen)) return false;   // junction (many-to-many) modules
  if (/__s$/i.test(api)) return false;                  // system modules (e.g. Approval_Action_Logs__s) have no records tab
  if (['linking', 'subform'].includes(m.generated_type)) return false;
  if (m.viewable === false || m.visible === false || m.api_supported === false) return false;
  return true;
}
async function switchTab() {
  if (sampleRefuse()) return;
  if (!bound || !bound.base || !bound.instance) { setStatus('Unknown target - pull that workspace once from its own tab.', 'warn'); return; }
  const targetHome = `${bound.base}/crm/${bound.instance}/`;
  const curBase = (lastCtx && lastCtx.origin) || bound.base;
  const id = await activeZohoTabId();
  // Same Zoho account (prod <-> sandbox on the same data center) shares an SSO session: just navigate, no logout.
  const dc = (b) => (b || '').replace(/:\/\/(crm|crmsandbox)\./, '://');
  const sameAccount = dc(curBase) === dc(bound.base) && envOf(curBase) !== envOf(bound.base);
  // The tab, not the frame, and both branches of this function mean it. Ending a session is not a
  // navigation inside somebody's shell: a logout in an iframe leaves the shell around it holding a
  // session that no longer exists. `goToZoho` is for going to a *page*.
  if (sameAccount) {
    if (id) await chrome.tabs.update(id, { url: targetHome, active: true }); else await chrome.tabs.create({ url: targetHome, active: true });
    return;
  }
  // Different account: a clean logout + re-login is required. Confirm first, since it ends the current Zoho session.
  const ok = window.confirm(`Switch to «${bound.instance}» (org ${bound.org})?\n\nThis logs you out of the current Zoho session «${lastCtx?.instance || '?'}» (org ${lastCtx?.org || '?'}) and takes this tab to the login for the target org.`);
  if (!ok) return;
  const accounts = curBase.replace(/:\/\/[^.]+\./, '://accounts.');   // crm./crmsandbox. -> accounts.
  const url = `${accounts}/logout?servicename=ZohoCRM&serviceurl=${encodeURIComponent(targetHome)}`;
  if (id) await chrome.tabs.update(id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}
async function openTargetZoho() {
  if (sampleRefuse()) return null;   // null, not undefined: the caller reads it as "no tab id"
  const url = functionsUrl();                       // prefers the ACTIVE workspace's base+instance
  if (!url) { setStatus(MSG.noTarget, 'warn'); return null; }
  return goToZoho(url);
}
$('funcs').onclick = () => openTargetZoho();
// Touched by hand, so the next repaint leaves it alone: this control is redrawn on every
// workspace change, and a choice that is reset while you are looking at it is not a choice.
$('gozohodc').onchange = () => { $('gozohodc').dataset.touched = '1'; };
$('gozoho').onclick = () => openZohoHome();
$('mmgo').onclick = () => switchTab();   // mismatch: log out current session and land on the workspace's org (current tab)



// Find = fill the Zoho functions-list search box with this function's name. We wait (bounded, in
// reveal) for the search box to exist - a known, language-independent element - then fill it ONCE.
// If it is not there, we STOP and say exactly that, instead of retrying an action we are not sure of.

// Navigate to the Zoho Functions list (deterministic URL) and pre-filter it to `fn` (Find). The
// only DOM touch left is filling the class-selected search box; there is no click-and-hope here.
/** Take the reader to their functions in Zoho, and stop there.
 *
 * **This used to type into Zoho's own search box** - the single exception the first non-negotiable
 * carried, and the last thing this product wrote into somebody else's page: `focus()`, the native
 * value setter, three synthetic events. Zoho is building a functions interface addressed by URL,
 * which makes the exception unnecessary, so the panel navigates and lets their page decide what to
 * show. A reader on the old interface lands on the list, which is exactly where the typing left them
 * anyway; a reader on the new one gets whatever that address resolves to.
 *
 * **The deep link exists now, and it exists because the mapping is pulled rather than guessed.**
 * The newer interface addresses a function by the id of its record in the `Functions__s` module,
 * and the id this product holds is that record's `dependent_id` - measured across a whole org, 100
 * of 100 on the first page. The pull asks Zoho's own list for the pair and puts it on the index row;
 * where it is missing - an org on the old interface, a role without the module, a workspace mirrored
 * before this existed - the list is still what opens, which is what this function did for everyone
 * until today. Nothing is constructed from an id that has not been joined.
 */
async function reveal(fn) {
  if (sampleRefuse()) return;
  // The one function when the mapping is known, the list when it is not. Both are constructed
  // addresses and neither touches their page.
  const one = functionUrl(fn.uiId);
  const url = one || functionsUrl();
  if (!url) { setStatus(MSG.noTarget, 'warn'); return; }
  // **One navigation, not two.** `openTargetZoho` *is* `goToZoho(functionsUrl())`, so the second
  // call was redundant on the branch where a tab existed and worse on the branch where none did:
  // `chrome.tabs.create` resolves before the navigation commits, so the fresh tab's `url` is still
  // empty, `zohoTabId()` fails all three of its tests, and `goToZoho` opens a *second* tab. One
  // click on «Functions in Zoho» with no CRM tab open left two identical tabs.
  setStatus(MSG.openingFns, 'busy');
  // `goToZoho` already creates a tab when none exists. Going through `openTargetZoho` on that branch
  // rebuilt the old list URL and silently discarded `one`, then announced that the function itself
  // was open. One destination, handed to the one navigator on both branches.
  const at = await goToZoho(url);
  if (!at) return;
  setStatus(one ? `\u00ab${fn.displayName || fn.name || fn.apiName}\u00bb is open in Zoho.`
                : `Zoho\u0027s functions are open - look for \u00ab${fn.displayName || fn.name || fn.apiName}\u00bb.`, 'ok');
}



async function revealFromPreview(action) {
  if (currentPath && currentPath.startsWith('workflows/')) { await openWorkflowInZoho(currentPath.split('/').pop().replace(/\.json$/, '')); return; }
  if (currentPath && currentPath.startsWith('actions/')) { const a = actionData.find((x) => x.path === currentPath); if (a) await openActionInZoho(a); return; }
  if (currentPath && currentPath.startsWith('modules/')) {
    const m = moduleData.find((x) => x.path === currentPath); if (!m) return; if (action === 'filter') await openModuleLayouts(m.gen); else await openModulePage(m.gen, m.navigable, m.label); return;
  }
  const e = functionRowForPath(currentPath); if (!e) return;
  const info = index.get(e.id);
  try { await reveal({ id: e.id, uiId: e.uiId, name: info?.name || e.api_name, displayName: e.display_name, apiName: e.api_name }); }
  catch (err) { setStatus('Find failed: ' + err.message, 'warn'); }
}
$('pvreveal').onclick = () => revealFromPreview('edit');
$('pvfind').onclick = () => revealFromPreview('filter');

