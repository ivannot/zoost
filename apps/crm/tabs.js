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
  { id: 'functions', label: 'Functions', names: true, search: true, note: 'Deluge functions, namespaces, cross-references' },
  { id: 'modules', label: 'Modules', names: true, note: 'fields, layouts, related lists' },
  { id: 'workflows', label: 'Workflows', note: 'rules, triggers, actions' },
  { id: 'schedules', label: 'Schedules', note: 'scheduled functions' },
  { id: 'actions', label: 'Actions', note: 'what a rule fires: notifications, field updates, tasks, webhooks' },
  { id: 'connections', label: 'Connections', note: 'the org connection catalogue' },
];
