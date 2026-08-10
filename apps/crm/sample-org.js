/* sample-org.js - the sample workspace, generated rather than downloaded.
 *
 * ONE generator, two consumers, which is the pattern this project already uses for product-help.js
 * and analytics-sql.js: the panel writes these files into the working folder so somebody meeting
 * Zoost has something to open, and `node tools/fixtures.mjs` writes the same files into fixtures/
 * for the tests and the Store screenshots. A second generator would drift from the first, and the
 * whole reason the fixture exists is that it must not lie about the shape of a real workspace.
 *
 * WHAT IT IS NOT. It never contacts Zoho and it is not a pull: the workspace it writes carries
 * `sample: true` in .zoost.json, and the panel disables everything that talks to Zoho for it. There
 * is no demo *mode* anywhere - once the files are on disk it is an ordinary workspace, read by the
 * ordinary code, and deleting the folder is how you get rid of it.
 *
 * NAMES. The core is written by hand and reads like an org someone actually built - buildInvoice
 * calls calcTax which calls formatMoney - because that is what a first-time reader is looking at and
 * what the screenshots show. `standalone_1`, `standalone_2` would make the product look like a test
 * harness. Volume is composed from two small vocabularies instead, deterministically, so a few
 * hundred names come out plausible without anyone inventing them one at a time.
 *
 * THE FILE SHAPES ARE NOT INVENTED HERE. Every index is a **bare array**, not `{items: […]}`, and
 * every record carries the keys the pull writes - `nameSpace` with a capital S, `rest_api` rather
 * than a boolean `rest`, `sv: 2` and not 3, connections as objects. The first version guessed, and
 * the panel answered with `wfIdx is not iterable`, `idx.map is not a function`, no connections and a
 * broken export. Derive a shape from the writer in content-bridge.js and the reader in sidepanel.js,
 * never from what looks reasonable.
 *
 * A DELUGE NAMESPACE IS NOT FREE. `CALL_RE` in graph-core.js matches `<namespace>.<name>(` for
 * exactly the five namespaces Zoho CRM has. An earlier fixture invented its own, so the reference
 * scanner found nothing in perfectly plausible sources and the panel called a function that makes
 * four calls an orphan candidate. The category is a different field with different values
 * (`crmfundamentals`, `scheduler`, `custombutton`, and sometimes nothing) - the mismatch this
 * repository has recorded twice. Both are here and they are kept apart.
 */
(function () {
  const NS = ['standalone', 'automation', 'button', 'schedule', 'validation_rule'];
  const ORG = '1234567890';
  const INSTANCE = 'sampleorg';
  const BASE = 'https://crm.zoho.eu';
  const WHEN = '2026-08-07T10:00:00.000Z';
  const AUTHOR = 'Sample User';       // the one name every generated record is attributed to
  const WF_TRIGGER = 'Record Action'; // the rule's own `execute_when.type` and its index row say the
                                      // same fact, so they are the same string or the fixture lies

  // ---- the readable core -------------------------------------------------------------------
  // ns, name, category, params, what it calls. Written out because these are the ones a reader
  // meets first and the ones the screenshots show.
  const CORE = [
    ['standalone', 'log', 'standalone', ['message'], []],
    ['standalone', 'formatMoney', 'standalone', ['amount', 'currency'], []],
    ['standalone', 'isBusinessDay', 'standalone', ['day'], []],
    ['standalone', 'orgSettings', 'standalone', [], []],
    ['standalone', 'calcTax', 'standalone', ['amount', 'rate'], ['standalone.orgSettings']],
    ['standalone', 'applyDiscount', 'standalone', ['amount', 'code'], ['standalone.log']],
    ['standalone', 'buildInvoice', 'standalone', ['orderId'],
      ['standalone.calcTax', 'standalone.applyDiscount', 'standalone.formatMoney', 'standalone.log']],
    ['standalone', 'reserveStock', 'standalone', ['orderId'], ['standalone.log']],
    ['standalone', 'releaseStock', 'standalone', ['orderId'], ['standalone.log']],
    ['standalone', 'planShipment', 'standalone', ['orderId'],
      ['standalone.isBusinessDay', 'standalone.releaseStock', 'standalone.log']],
    ['standalone', 'trackParcel', 'standalone', ['tracking'], ['standalone.log']],
    ['standalone', 'escalateTicket', 'standalone', ['ticketId'], ['standalone.log']],
    ['standalone', 'reconcilePayments', 'standalone', ['since'], ['standalone.log']],
    ['standalone', 'buildCohort', 'standalone', ['from', 'to'], []],
    ['standalone', 'legacyHelper', '', ['input'], []],
    ['automation', 'onOrderCreate', 'crmfundamentals', ['orderId'],
      ['validation_rule.validateOrder', 'standalone.reserveStock', 'automation.recalcTotals']],
    ['automation', 'recalcTotals', 'crmfundamentals', ['orderId'],
      ['standalone.calcTax', 'standalone.formatMoney']],
    ['automation', 'onDealWon', 'crmfundamentals', ['dealId'], ['standalone.buildInvoice']],
    ['automation', 'onContactMerge', 'crmfundamentals', ['contactId'], ['standalone.log']],
    ['schedule', 'dunningRun', 'scheduler', [], ['standalone.buildInvoice', 'standalone.log']],
    ['schedule', 'syncPayments', 'scheduler', [], ['standalone.reconcilePayments', 'standalone.log']],
    ['schedule', 'nightlyDispatch', 'scheduler', [], ['standalone.planShipment', 'standalone.trackParcel']],
    ['schedule', 'closeStaleTickets', 'scheduler', [], ['standalone.escalateTicket']],
    ['schedule', 'pushAccounts', 'scheduler', [], ['standalone.orgSettings', 'standalone.log']],
    ['schedule', 'pullCatalogue', 'scheduler', [], ['standalone.orgSettings']],
    ['schedule', 'weeklyDigest', 'scheduler', [], ['standalone.buildCohort', 'standalone.formatMoney']],
    ['button', 'openTicket', 'custombutton', ['accountId', 'subject'], ['standalone.log']],
    ['button', 'exportCsv', 'custombutton', ['view'], ['standalone.buildCohort']],
    ['button', 'recalcOrder', 'custombutton', ['orderId'], ['automation.recalcTotals']],
    ['validation_rule', 'validateOrder', 'crmfundamentals', ['orderId'],
      ['standalone.orgSettings', 'standalone.log']],
    ['validation_rule', 'checkCreditLimit', 'crmfundamentals', ['accountId'], ['standalone.log']],
    // `notifyOwner` exists under two namespaces on purpose. A call that names neither exactly -
    // `button.notifyOwner()` from escalateTicket - resolves to two functions and is reported as
    // ambiguous, which is a state derived from the sources and not asserted anywhere.
    ['automation', 'notifyOwner', 'crmfundamentals', ['recordId'], ['standalone.log']],
    ['schedule', 'notifyOwner', 'scheduler', [], ['standalone.log']],
  ];

  // ---- volume -------------------------------------------------------------------------------
  // Composed, not enumerated: `verb + Noun` from two small lists gives a few hundred names that read
  // like an org rather than like a fixture, and the composition is deterministic so two runs agree.
  const VERBS = ['sync', 'fetch', 'push', 'clean', 'merge', 'split', 'archive', 'notify', 'audit',
                 'rebuild', 'refresh', 'validate', 'assign', 'convert', 'enrich', 'dedupe'];
  const NOUNS = ['Accounts', 'Contacts', 'Leads', 'Deals', 'Quotes', 'Invoices', 'Orders',
                 'Shipments', 'Tickets', 'Campaigns', 'Products', 'Subscriptions', 'Territories',
                 'Pricebooks', 'Vendors'];
  // Which namespace and category a generated function gets. Weighted so the shape looks like a real
  // org - mostly standalone, a handful of the rest - rather than an even split nobody has.
  const MIX = [
    ['standalone', 'standalone', 10],
    ['automation', 'crmfundamentals', 4],
    ['schedule', 'scheduler', 3],
    ['button', 'custombutton', 2],
    ['validation_rule', 'crmfundamentals', 1],
  ];

  // A small deterministic generator. Not Math.random: two runs have to produce identical files or a
  // diff in fixtures/ stops meaning anything.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function volume(count, seed) {
    const rnd = rng(seed);
    const pool = [];
    for (const [ns, cat, weight] of MIX) for (let i = 0; i < weight; i++) pool.push([ns, cat]);
    const out = [], used = new Set(CORE.map((c) => c[0] + '.' + c[1]));
    let guard = 0;
    while (out.length < count && guard++ < count * 40) {
      const [ns, cat] = pool[Math.floor(rnd() * pool.length)];
      const name = VERBS[Math.floor(rnd() * VERBS.length)] + NOUNS[Math.floor(rnd() * NOUNS.length)];
      const id = ns + '.' + name;
      if (used.has(id)) continue;
      used.add(id);
      out.push([ns, name, cat, [], []]);
    }
    // Wire them so the graph has depth rather than being a hedge of isolated boxes: each one calls
    // one or two things already present, which builds chains as the list grows.
    const all = CORE.concat(out);
    out.forEach((f, i) => {
      const pick = () => { const c = all[Math.floor(rnd() * all.length)]; return c[0] + '.' + c[1]; };
      const n = Math.floor(rnd() * 3);   // 0, 1 or 2 - a real org has plenty of leaves
      const calls = new Set();
      for (let k = 0; k < n; k++) { const t = pick(); if (t !== f[0] + '.' + f[1]) calls.add(t); }
      f[4] = [...calls];
    });
    return out;
  }

  // Failing executions, one per way a function can be invoked, so the list and its filter have
  // something to show. Ordinary business wording, like every other name in this file.
  // How often each of the busiest ran, in the last 24 hours. The numbers descend steeply on purpose:
  // a real org has two or three functions doing almost all the work and a long tail doing none, and
  // a flat list would make the «most run» view look like it says nothing.
  const RUNS = [
    ['automation.onOrderCreate', 239], ['standalone.buildInvoice', 172], ['schedule.nightlyDispatch', 22],
    ['standalone.calcTax', 12], ['standalone.formatMoney', 9], ['button.recalcTotals', 4],
    ['automation.syncContacts', 2], ['standalone.planShipment', 1],
  ];
  const FAILURES = [
    ['standalone.buildInvoice', "Custom exception - 'Missing tax rate' at Line Number: 42", 3, 'Rest API', 'standalone'],
    ['automation.onOrderCreate', "Improper Statement Error - null value at Line Number: 17", 2, 'Workflow', 'automation'],
    ['button.recalcTotals', "Runtime error - division by zero at Line Number: 8", 1, 'Button', 'button'],
    ['schedule.nightlyDispatch', "Connection timed out after 30000 ms", 5, 'Schedule', 'schedule'],
  ];
  const CONNECTIONS = [
    ['warehouse_api', 'Warehouse API', ['standalone.planShipment', 'standalone.reserveStock']],
    ['payments_gw', 'Payments gateway', ['schedule.syncPayments', 'standalone.reconcilePayments']],
    ['mail_relay', 'Mail relay', ['schedule.weeklyDigest', 'standalone.escalateTicket']],
    ['catalogue_feed', 'Catalogue feed', ['schedule.pullCatalogue']],
    ['tax_service', 'Tax service', ['standalone.calcTax']],
    ['archive_store', 'Archive store', []],
  ];

  const MODULES = [
    ['Accounts', 'Accounts', 'standard'], ['Contacts', 'Contacts', 'standard'],
    ['Leads', 'Leads', 'standard'], ['Deals', 'Deals', 'standard'],
    ['Products', 'Products', 'standard'], ['Quotes', 'Quotes', 'standard'],
    ['Invoices', 'Invoices', 'standard'], ['Orders', 'Sales Orders', 'standard'],
    ['Vendors', 'Vendors', 'standard'], ['Pricebooks', 'Price Books', 'standard'],
    ['Campaigns', 'Campaigns', 'standard'], ['Cases', 'Cases', 'standard'],
    ['Shipments', 'Shipments', 'custom'], ['Tickets', 'Support Tickets', 'custom'],
    ['Subscriptions', 'Subscriptions', 'custom'], ['Territories', 'Territories', 'custom'],
    ['Contracts', 'Contracts', 'custom'], ['Assets', 'Assets', 'custom'],
  ];
  const LOOKUPS = {
    Contacts: ['Accounts'], Deals: ['Accounts', 'Contacts'], Quotes: ['Deals', 'Accounts'],
    Invoices: ['Accounts', 'Orders'], Orders: ['Accounts', 'Quotes'], Shipments: ['Orders'],
    Tickets: ['Accounts', 'Contacts', 'Products'], Subscriptions: ['Accounts', 'Products'],
    Cases: ['Accounts', 'Contacts'], Contracts: ['Accounts', 'Quotes'], Assets: ['Accounts', 'Products'],
    Pricebooks: ['Products'], Territories: [], Campaigns: [], Vendors: [], Leads: [],
  };
  const FIELD_POOL = [
    ['Name', 'text', true], ['Owner', 'ownerlookup', true], ['Description', 'textarea', false],
    ['Status', 'picklist', false], ['Amount', 'currency', false], ['Currency', 'picklist', false],
    ['Opened_On', 'date', false], ['Closed_On', 'date', false], ['Priority', 'picklist', false],
    ['External_Ref', 'text', false], ['Notes', 'textarea', false], ['Archived', 'boolean', false],
  ];
  const WORKFLOWS = [
    ['Orders', 'New order received', 'automation.onOrderCreate', false],
    ['Orders', 'Order amount changed', 'automation.recalcTotals', false],
    ['Invoices', 'Invoice overdue', 'schedule.dunningRun', true],
    ['Tickets', 'Ticket unanswered', 'standalone.escalateTicket', true],
    ['Contacts', 'Contact merged', 'automation.onContactMerge', false],
    ['Deals', 'Deal won', 'automation.onDealWon', false],
    ['Shipments', 'Shipment dispatched', 'standalone.trackParcel', false],
    ['Leads', 'Lead untouched', null, true],
    ['Accounts', 'Credit limit changed', 'validation_rule.checkCreditLimit', false],
    ['Quotes', 'Quote accepted', 'automation.onOrderCreate', false],
  ];
  const SCHEDULES = [
    ['Nightly dispatch', 'schedule.nightlyDispatch', 'Every day at 02:00'],
    ['Dunning run', 'schedule.dunningRun', 'Every day at 06:00'],
    ['Close stale tickets', 'schedule.closeStaleTickets', 'Every Monday at 07:00'],
    ['Weekly digest', 'schedule.weeklyDigest', 'Every Monday at 08:00'],
    ['Catalogue pull', 'schedule.pullCatalogue', 'Every 6 hours'],
    ['Account push', 'schedule.pushAccounts', 'Every day at 23:30'],
    ['Payment sync', 'schedule.syncPayments', 'Every 2 hours'],
  ];

  // States that only exist so the panel's own marks and filters have something to show. They belong
  // in the fixture the tests and the screenshots read; they do NOT belong in the workspace a
  // first-time reader opens, where a refused module is just confusing.
  // An unresolved call is one the scanner finds in the source and cannot resolve; an ambiguous one
  // resolves to more than one function of that name. Both are derived from the Deluge by
  // graph-core.js, so both are created by *writing the call*, not by asserting the outcome.
  const EDGE = {
    refusedModule: 'Ledger',
    stale: ['standalone.legacyHelper', 'standalone.reconcilePayments'],
    unresolved: { 'validation_rule.validateOrder': ['standalone.lookupBand'],
                  'button.exportCsv': ['standalone.dumpEverything'] },
    // Not a name that is missing - one that is there twice. `button.notifyOwner` matches neither
    // namespace exactly, so it falls back to the name and finds two.
    ambiguous: { 'standalone.escalateTicket': ['button.notifyOwner'] },
  };

  // Zoho generates an api_name from the label, and the two are different strings - which is what the
  // «Name: display / internal» toggle switches between. A fixture where they are equal makes that
  // control look broken, which is how it was reported.
  function labelOf(name) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ').toLowerCase() : '');
  }
  function deluge(ns, name, params, calls) {
    const sig = (params.length ? 'map ' : 'void ') + name +
      '(' + params.map((p) => 'string ' + p).join(', ') + ')';
    // `namespace.name(...)` - the form CALL_RE looks for, which is how Deluge actually calls a
    // function. Written any other way the reference graph comes out empty.
    const body = calls.length
      ? calls.map((c, i) => '    r' + i + ' = ' + c + '();').join('\n')
      : '    // nothing else is called';
    return '// ' + ns + '.' + name + ' - sample function, generated for the sample org.\n' +
      sig + '\n{\n    info "' + ns + '.' + name + ' start";\n' + body + '\n' +
      '    return ' + (params.length ? 'r0' : 'null') + ';\n}\n';
  }

  const snake = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2');

  /** The whole workspace as {path: text}, in the shape a pull writes it.
   *
   * Every index is a bare array. Every record carries the keys the reader asks for. Both were
   * guessed the first time and every one of the guesses was wrong; see the note at the top.
   *
   * `opts.functions` is roughly how many to make; `opts.edgeCases` adds the awkward states;
   * `opts.onProgress(done, total, what)` is called as it goes, because writing three hundred files
   * through the File System Access API takes long enough to look like a hang.
   */
  function files(opts) {
    const o = Object.assign({ functions: 120, edgeCases: false, onProgress: null }, opts || {});
    const list = CORE.concat(volume(Math.max(0, o.functions - CORE.length), 20260807));
    const out = {};
    const J = (p, v) => { out[p] = JSON.stringify(v, null, 2) + '\n'; };
    const say = (done, total, what) => { if (o.onProgress) o.onProgress(done, total, what); };

    // ---- functions ----
    // The index is what the tree lists before anything is downloaded: a bare array, and `namespace`
    // here (the meta file spells it `nameSpace`, which is Zoho's own casing and not a typo).
    const index = [];
    list.forEach(([ns, name, cat, params, calls], i) => {
      const id = String(9000 + i);
      const api = snake(name);
      // An unresolved reference is a call in the *source* to something that is not there - that is
      // how the panel finds them, by scanning the Deluge. Writing it into the meta instead would
      // have been a claim the source does not support, and the fixture would show a state no real
      // workspace can reach.
      const extra = o.edgeCases
        ? (EDGE.unresolved[ns + '.' + name] || []).concat(EDGE.ambiguous[ns + '.' + name] || [])
        : [];
      out['functions/' + ns + '/' + api + '.dg'] = deluge(ns, name, params, calls.concat(extra));
      // toFile()'s meta, field for field. sv is 2 - the current META_SV - and 1 for the ones that are
      // meant to read as stale; 3 would be *newer* than the panel understands.
      J('functions/' + ns + '/' + api + '.meta.json', {
        id: id, name: name, display_name: labelOf(name), api_name: api,
        nameSpace: ns, category: cat, source: 'crm',
        return_type: params.length ? 'map' : 'void',
        params: params.map((p) => ({ name: p, type: 'string' })),
        description: '', updatedTime: '2026-07-0' + (1 + (i % 9)) + 'T09:00:00+00:00',
        modified_by: AUTHOR, associated_place: null, workflow: '',
        rest_api: (name === 'exportCsv' || name === 'openTicket')
          ? [{ type: 'GET', active: true }] : [],
        connections: CONNECTIONS.filter((c) => c[2].includes(ns + '.' + name))
          .map((c) => ({ name: c[0], label: c[1], service: 'custom', scopes: [] })),
        sv: (o.edgeCases && EDGE.stale.includes(ns + '.' + name)) ? 1 : 2,
      });
      index.push({ id: id, api_name: api, name: name, display_name: labelOf(name),
                   namespace: ns, category: cat, source: 'crm',
                   rest: name === 'exportCsv' || name === 'openTicket' });
      say(i + 1, list.length, 'functions');
    });
    J('functions/index.json', index);

    // Forty plausible values, composed rather than invented one at a time - the same rule the
    // function names follow.
    const LONG_PICKLIST = ['New', 'Qualified', 'Contacted', 'Proposal sent', 'Negotiation', 'On hold']
      .concat(Array.from({ length: 34 }, (_, k) => `Stage ${k + 1} - awaiting review`));
    // ---- modules ----
    const index2 = [], layIndex = [];
    const modList = MODULES.concat(o.edgeCases ? [[EDGE.refusedModule, 'Ledger', 'custom']] : []);
    modList.forEach(([api, label, cat], i) => {
      const refused = o.edgeCases && api === EDGE.refusedModule;
      const fields = refused ? [] : FIELD_POOL.slice(0, 6 + (i % 6)).map(([a, t, m], k) =>
        ({ api_name: a, label: a.replace(/_/g, ' '), data_type: t, length: t === 'text' ? 255 : null,
           custom: cat === 'custom', mandatory: m, lookup: null,
           // One picklist per module is long, because a long one is a state of its own: forty
           // values on a line is what made the fields table scroll sideways with no end, and a
           // fixture where every picklist has three values shows a product that never meets it.
           picklist: t !== 'picklist' ? [] : (a === 'Status' ? LONG_PICKLIST : ['One', 'Two', 'Three']),
           id: String(7000 + i * 20 + k) }));
      if (!refused) {
        (LOOKUPS[api] || []).forEach((t, k) => fields.push(
          { api_name: t.replace(/s$/, '') + '_Ref', label: t.replace(/s$/, ''), data_type: 'lookup',
            length: null, custom: false, mandatory: false, lookup: t, picklist: [],
            id: String(7500 + i * 20 + k) }));
      }
      const layouts = refused ? [] : [{ id: String(3000 + i), name: 'Standard', visible: true,
                                        status: 'active', sections: [{ name: 'Information' }, { name: 'Details' }] }];
      if (!refused && i % 4 === 0) layouts.push({ id: String(3100 + i), name: 'Compact', visible: true, status: 'active', sections: [{ name: 'Information' }] });
      if (!refused && o.edgeCases && i % 5 === 0) layouts.push({ id: String(3200 + i), name: 'Retired', visible: false, status: 'inactive', sections: [] });
      const related = refused ? [] : Object.keys(LOOKUPS).filter((c) => (LOOKUPS[c] || []).includes(api)).map((c) =>
        ({ api_name: c + '_of_' + api, label: c, module: c, type: 'default', visible: true,
           connected_module: null, linking_module: null, id: String(8000 + i), src: 'api' }));
      if (!refused && o.edgeCases) {
        related.push({ api_name: 'Attachments', label: 'Attachments', module: 'Attachments',
                       type: 'system', visible: true, connected_module: null, linking_module: null,
                       id: String(8500 + i), src: 'api' });
        if (api === 'Products' || api === 'Campaigns') {
          related.push({ api_name: 'Campaign_Products', label: 'Campaign products',
                         module: api === 'Campaigns' ? 'Products' : 'Campaigns', type: 'multiselect',
                         visible: true, connected_module: null,
                         linking_module: 'Campaign_Product_Link', id: String(8600 + i), src: 'api' });
        }
      }
      // The compact summary the module JSON keeps, which is what the preview line reads.
      const summary = layouts.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false,
                                            status: l.status || null, sections: (l.sections || []).length }));
      const mod = {
        related_lists: related,
        unreadable: refused ? { status: 400, code: 'INVALID_MODULE', at: WHEN,
                                message: 'operation cannot be performed for hidden module' } : null,
        api_name: api, module_name: api, singular_label: label.replace(/s$/, ''), plural_label: label,
        id: String(6000 + i), generated_type: cat,
        deletable: cat === 'custom', editable: true, creatable: true,
        viewable: true, visible: true, api_supported: true,
        layouts: summary, fields: fields,
      };
      J('modules/' + api + '.json', mod);
      J('modules/layouts/' + api + '.json', layouts);
      index2.push({ api_name: api, module_name: api, generated_type: cat,
                    fields: fields.length, layouts: summary.length, related_lists: related.length });
      layIndex.push({ module: api, generated: api, layouts: summary });
      say(i + 1, modList.length, 'modules');
    });
    J('modules/index.json', index2);
    J('modules/layouts/index.json', layIndex);

    // ---- automation actions ----
    // Four kinds with one shape, and the state that matters is `associated`: in a real org about
    // half of them are attached to nothing, so a fixture where they all are shows a product with
    // nothing to find. The workflow rules above name the notification ones by id, which is the join
    // the panel makes - so the sample has rules that fire something other than a function too.
    const ACT_KINDS = [
      ['email_notifications', ['Order confirmation', 'Invoice reminder', 'Welcome message',
                               'Ticket acknowledged', 'Parcel on its way', 'Renewal notice']],
      ['field_updates', ['Set stage to Won', 'Clear owner', 'Mark as reviewed', 'Reset priority']],
      ['tasks', ['Call the customer back', 'Chase the invoice', 'Prepare the handover']],
      ['webhooks', ['Notify the warehouse']],
    ];
    const actions = [];
    ACT_KINDS.forEach(([kind, names], ki) => names.forEach((nm, i) => {
      const id = String(5000 + ki * 100 + i);
      const a = { kind, id, name: nm, sv: 3, module: MODULES[(ki + i) % MODULES.length][0],
                  module_label: MODULES[(ki + i) % MODULES.length][1],
                  associated: (ki + i) % 3 !== 2, created_by: AUTHOR, modified_by: AUTHOR,
                  created_time: '2026-06-0' + ((i % 8) + 1) + 'T09:00:00+00:00',
                  modified_time: '2026-07-1' + ((i % 9) + 1) + 'T09:00:00+00:00', locked: false };
      if (kind === 'email_notifications') {
        a.template = { id: String(5900 + i), name: nm + ' template' };
        // An organisation address and a user's are two different facts, and the panel says which -
        // so the fixture has both. Neither is a customer's: they are the org's own senders.
        a.from_type = i % 3 === 0 ? 'user' : 'organization_email';
        a.from_name = i % 3 === 0 ? AUTHOR : 'Sample Org';
        a.from_address = i % 3 === 0 ? 'sales@example.com' : 'noreply@example.com';
        a.recipient_count = 1 + (i % 3);
      }
      if (kind === 'field_updates') {
        // The three shapes a value comes in - a picklist string, a boolean, and none at all, which
        // means «clear it» and not «unknown». 69 of 97 in a real org write a picklist.
        a.field = ['Stage', 'Owner', 'Reviewed', 'Priority'][i % 4];
        a.field_label = ['Stage', 'Owner', 'Reviewed', 'Priority'][i % 4];
        a.field_type = ['picklist', 'ownerlookup', 'boolean', 'picklist'][i % 4];
        a.value = [ 'Won', null, true, 'High' ][i % 4];
        a.value_kind = a.value === null ? 'cleared' : 'static';
      }
      if (kind === 'tasks') {
        a.notify = i % 2 === 0;
        // The three kinds of mapping Zoho returns, with the string it has already rendered: a
        // static value, one computed from the trigger, and one merged from a field.
        // Both forms, as Zoho sends them: the configuration in `value` and the org-language
        // rendering in `display`. One mapping deliberately carries only the rendered string, so the
        // fallback for a shape this code has not met is a state something actually draws.
        a.mappings = [
          { field: 'Subject', type: 'merge_field', value: nm + ' for ${Contact.Name}', display: nm + ' for the contact' },
          { field: 'Due_Date', type: 'execution_time', value: { sign: 'plus', unit: '7', period: 'days', trigger_field: '${CURRENTTIME}' }, display: 'Trigger date plus 7 days' },
          { field: 'Owner', type: 'static', value: { id: '9001', name: AUTHOR }, display: AUTHOR },
          { field: 'Status', type: 'static', value: 'Not Started', display: 'Not started' },
          { field: 'Priority', type: 'static', value: ['High', 'Normal', 'Low'][i % 3], display: ['High', 'Normal', 'Low'][i % 3] },
          { field: 'Remind_At', type: 'execution_time', value: { sign: 'minus', unit: '2', period: 'days', trigger_field: '${!Tasks.Due_Date}', time: '12:00', notify_type: 'emailandpopup' }, display: '2 days before' },
          { field: 'Description', type: 'static', value: null, display: 'a shape this code has not met' },
        ];
      }
      if (kind === 'webhooks') { a.method = 'POST'; a.url = 'https://example.com/hooks/warehouse'; }
      // One row written by an older pull, so «this pull did not read it» has something to render:
      // it is the state every row was in the day the field was added, and it looked like an org
      // where nothing writes anything.
      if (o.edgeCases && kind === 'field_updates' && i === 3) { delete a.sv; delete a.value; delete a.field_type; }
      actions.push(a);
    }));
    J('actions/index.json', actions);

    // ---- workflows ----
    const wfs = [];
    // A rule that fires a function the org does not have is «broken automation» in the health audit,
    // and the fixture had no such rule: the check ran, found nothing, and looked correct. It is an
    // edge case, so it goes where the other awkward states go and not in the workspace somebody
    // opens on their first day.
    const wfList = WORKFLOWS.concat(o.edgeCases
      ? [['Orders', 'Order archived', 'standalone.archiveOrderLegacy', false]] : []);
    wfList.forEach(([mod, name, fn, sched], i) => {
      const wid = String(4000 + i);
      // Three shapes here were invented rather than derived, and each one silently removed a
      // feature from the sample: the action went in a bare `actions` on the condition where Zoho
      // puts `instant_actions.actions`; its type was `function` where Zoho writes `functions`; and
      // it named the target «namespace.name» with an id of its own, so `resolveFn()` matched on
      // neither. The result was a sample workspace with no workflow-to-function edge at all - not in
      // the call graph, not in the health audit's broken automations, not in the assistant's action
      // counts - and nothing failed, because a filter that matches nothing is indistinguishable from
      // an org that has nothing.
      //
      // Both type forms are real: counted in a mirrored org, 149 `functions` against 2 `function`.
      // A rule naming a function the org does not have keeps its action, because that is the broken
      // automation the health audit exists to report.
      const target = fn ? index.find((e) => e.name === String(fn).split('.').pop()) : null;
      const fnAct = !fn ? [] : [target
        ? { type: i % 3 === 1 ? 'function' : 'functions', name: target.name, id: target.id }
        : { type: 'functions', name: String(fn).split('.').pop(), id: String(4500 + i) }];
      // Most rules in a real org fire something that is not a function - 275 notification actions
      // against 149 function ones in the org this was measured on - so most rules here do too, and
      // the id is the one the actions index carries, because that join is the point of the area.
      // Only actions Zoho reports as in use are fired by a rule here, so the two sources agree and
      // «attached to nothing» has something to find: an action that is unassociated *and* named by
      // a rule would be a contradiction the fixture invented.
      const usable = actions.filter((x) => x.associated);
      const other = usable[i % usable.length];
      const actionList = fnAct.concat(other ? [{ type: other.kind, id: other.id, name: other.name }] : []);
      // The *rule* object, which is what fetchWorkflow returns and what the file holds - not a
      // wrapper around it. wfScheduled() reads conditions[].scheduled_actions[].execute_after.
      J('workflows/' + wid + '.json', {
        id: wid, name: name, description: '',
        module: { api_name: mod, id: String(6000 + i) },
        execute_when: { type: WF_TRIGGER, on: 'created' },
        status: { active: true },
        conditions: [{
          sequence_number: 1, criteria: { field: { api_name: 'Status' }, comparator: 'not_equal', value: '' },
          // `instant_actions.actions`, which is where Zoho puts an immediate action and where all
          // nine readers look. The fixture wrote a bare `actions` on the condition - a key nothing
          // reads - so only the *scheduled* half of the sample ever had an action at all.
          instant_actions: { actions: sched ? [] : actionList },
          scheduled_actions: sched ? [{ execute_after: { unit: 2, period: 'days' }, actions: actionList }] : [],
        }],
        last_executed_time: '2026-07-2' + (i % 9) + 'T11:20:00+00:00',
      });
      wfs.push({ id: wid, name: name, description: '', module: mod, module_id: String(6000 + i),
                 type: WF_TRIGGER, active: true, source: 'crm' });
    });
    J('workflows/index.json', wfs);

    // ---- schedules and connections ----
    J('schedules/index.json', SCHEDULES.map(([n, f, r], i) => {
      const [ns, nm] = f.split('.');
      const fi = list.findIndex(([a, b]) => a === ns && b === nm);
      return { id: String(5000 + i), name: n, status: 'active',
               function_id: fi >= 0 ? String(9000 + fi) : '', function_name: nm,
               frequency: r, next: '2026-08-08T02:00:00+00:00',
               last: '2026-08-0' + (1 + (i % 7)) + 'T02:00:00+00:00' };
    }));
    J('connections/index.json', CONNECTIONS.map(([c, lbl], i) =>
      ({ name: c, label: lbl, connector: 'custom', connectorLabel: 'Custom service',
         connected: true, createdBy: AUTHOR, scopes: ['ZohoCRM.modules.ALL'],
         id: String(2000 + i) })));

    // ---- execution failures ----
    // A generated org has never run, so strictly it has nothing that failed. It gets a handful all
    // the same: a tab that is empty for everybody trying the product shows a simpler product than
    // the one that ships, which is the rule this file already follows for every other state. The
    // input of each failure - what Zoho calls `params` - is not here because it never crosses the
    // bridge, so a sample cannot contain something a real workspace does not.
    J('failures/index.json', {
      at: WHEN,
      usage: { success: 412, failure: 6 },
      // Zoho answers with a *top* list, not a census, so the sample does too - eight rows out of a
      // hundred and twenty, which is what makes the «not every function» caveat on screen true.
      credits: { limit: 500000, used: 418 },
      runs: RUNS.map(([fn, n], i) => {
        const [ns, nm] = fn.split('.');
        const fi = list.findIndex(([a, b]) => a === ns && b === nm);
        return { id: fi >= 0 ? String(9000 + fi) : null, name: fi >= 0 ? index[fi].display_name : nm, count: n };
      }),
      failures: FAILURES.map(([fn, reason, count, comp, cat], i) => {
        const [ns, nm] = fn.split('.');
        const fi = list.findIndex(([a, b]) => a === ns && b === nm);
        // Zoho's `function_info.name` is the **display** name - «WebHook - Update Student» in a real
        // response - so the fixture uses the display name too, or the join to the function silently
        // finds nothing and the panel shows a failure list that matches no function on screen.
        const disp = fi >= 0 ? index[fi].display_name : nm;
        return { id: String(7000 + i), name: disp, functionId: fi >= 0 ? String(9000 + fi) : null,
                 description: '', reason, count, componentType: comp, category: cat,
                 lastFailedAt: '2026-08-0' + (2 + (i % 6)) + 'T0' + (1 + i) + ':14:00+02:00',
                 firstFailedAt: '2026-07-2' + (1 + i) + 'T0' + (1 + i) + ':02:00.000Z',
                 reRunAt: null, recordId: null };
      }),
    });

    const areas = {};
    ['functions', 'modules', 'workflows', 'schedules', 'connections', 'failures']
      .forEach((a) => (areas[a] = { at: WHEN, pulledAt: WHEN, ok: true }));
    J('.zoost.json', {
      org: ORG, instance: INSTANCE, base: BASE, sandbox: false, label: 'Sample org',
      // The one field that makes this a sample rather than a mirror. The panel reads it and refuses
      // every action that would talk to Zoho - there is no demo mode, only this flag and the guards
      // that already exist.
      sample: true, sampleAt: WHEN,
      lastPull: WHEN, access: areas,
    });
    return out;
  }

  const folderName = () => INSTANCE + '-' + ORG;

  window.SAMPLE_ORG = { files: files, folderName: folderName, org: ORG, instance: INSTANCE,
                        base: BASE, namespaces: NS };
})();
