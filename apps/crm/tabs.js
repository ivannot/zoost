/*
 * tabs.js - the one list of the panel's tabs, read by the side panel and by the settings page.
 *
 * It was written twice: `TABS` in sidepanel.js and `TAB_DEFS` in options.js, kept in step by nobody.
 * Adding Actions to the panel therefore left Settings unable to hide, reorder or exclude it - the
 * duplication this repository spends its length fighting, in the one place a new tab is most likely
 * to be forgotten. Same shape as product-help.js and analytics-sql.js: one text, several readers.
 *
 * `names` and `search` are the panel's business; `note` is the settings page's. Both live here,
 * because splitting them would be two lists again.
 */
window.ZOOST_TABS = [
  // `short` is the name the mode bar falls back to when seven segments will not fit on one row - the
  // last rung of `fitTabs`, below closing the spacing and below 10px type, and the one that keeps a
  // word readable instead of wrapping a button onto a line of its own. `WF` rather than «Flows»:
  // Zoho Flow is a different product and the confusion would be free. `BP` and `Conn` are what Zoho
  // users say. Both names are in the markup and CSS picks, so nothing rewrites a label at run time.
  { id: 'functions', label: 'Functions', short: 'Func', names: true, search: true, note: 'Deluge functions, namespaces, cross-references' },
  { id: 'modules', label: 'Modules', short: 'Mods', names: true, note: 'fields, layouts, related lists' },
  { id: 'workflows', label: 'Workflows', short: 'WF', note: 'rules, triggers, actions' },
  { id: 'schedules', label: 'Schedules', short: 'Sched', note: 'scheduled functions' },
  { id: 'blueprints', label: 'Blueprints', short: 'BP', note: 'the process records walk, per module' },
  { id: 'actions', label: 'Actions', short: 'Acts', note: 'what a rule fires: notifications, field updates, tasks, webhooks' },
  { id: 'connections', label: 'Connections', short: 'Conn', note: 'the org connection catalogue' },
];
