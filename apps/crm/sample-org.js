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
  const EDGE = {
    refusedModule: 'Ledger',
    stale: ['standalone.legacyHelper', 'standalone.reconcilePayments'],
    unresolved: { 'validation_rule.validateOrder': ['standalone.lookupBand'],
                  'button.exportCsv': ['standalone.dump'] },
    ambiguous: { 'standalone.escalateTicket': ['log'] },
  };

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

  /** The whole workspace as {path: text}. `opts.functions` is roughly how many to make;
   *  `opts.edgeCases` adds the states above. */
  function files(opts) {
    const o = Object.assign({ functions: 120, edgeCases: false }, opts || {});
    const list = CORE.concat(volume(Math.max(0, o.functions - CORE.length), 20260807));
    const out = {};
    const J = (p, v) => { out[p] = JSON.stringify(v, null, 2) + '\n'; };

    const index = [];
    list.forEach(([ns, name, cat, params, calls], i) => {
      const id = ns + '.' + name;
      out['functions/' + ns + '/' + name + '.dg'] = deluge(ns, name, params, calls);
      J('functions/' + ns + '/' + name + '.meta.json', {
        sv: (o.edgeCases && EDGE.stale.includes(id)) ? 1 : 3,
        id: String(9000 + i), name: name, namespace: ns, display_name: name, category: cat,
        return_type: params.length ? 'map' : 'void',
        params: params.map((p) => ({ name: p, type: 'string' })),
        connections: CONNECTIONS.filter((c) => c[2].includes(id)).map((c) => c[0]),
        modified_by: 'Sample User',
        modified_time: '2026-07-0' + (1 + (i % 9)) + 'T09:00:00+00:00',
        rest: name === 'exportCsv' || name === 'openTicket',
        unresolved: (o.edgeCases && EDGE.unresolved[id]) || [],
        ambiguous: (o.edgeCases && EDGE.ambiguous[id]) || [],
      });
      index.push({ id: String(9000 + i), name: name, namespace: ns, display_name: name, category: cat });
    });
    J('functions/index.json', { items: index });

    const mods = [];
    const modList = MODULES.concat(o.edgeCases ? [[EDGE.refusedModule, 'Ledger', 'custom']] : []);
    modList.forEach(([api, label, cat], i) => {
      if (o.edgeCases && api === EDGE.refusedModule) {
        const refusal = { status: 400, code: 'INVALID_MODULE', at: WHEN,
                          message: 'operation cannot be performed for hidden module' };
        J('modules/' + api + '.json', { api_name: api, display_name: label, category: cat,
                                        fields: [], layouts: [], related_lists: [], unreadable: refusal });
        J('modules/layouts/' + api + '.json', { api_name: api, layouts: [] });
        mods.push({ api_name: api, display_name: label, category: cat,
                    fieldCount: 0, layoutCount: 0, unreadable: refusal });
        return;
      }
      const fields = FIELD_POOL.slice(0, 6 + (i % 6)).map(([a, t, m]) =>
        ({ api_name: a, data_type: t, mandatory: m, lookup: null }));
      (LOOKUPS[api] || []).forEach((t) => fields.push(
        { api_name: t.replace(/s$/, '') + '_Ref', data_type: 'lookup', mandatory: false, lookup: t }));
      const layouts = [{ id: 3000 + i, name: 'Standard', visible: true, sections: 3 }];
      if (i % 4 === 0) layouts.push({ id: 3100 + i, name: 'Compact', visible: true, sections: 2 });
      if (o.edgeCases && i % 5 === 0) layouts.push({ id: 3200 + i, name: 'Retired', visible: false, sections: 1 });
      const related = Object.keys(LOOKUPS).filter((c) => (LOOKUPS[c] || []).includes(api)).map((c) =>
        ({ api_name: c + '_of_' + api, label: c, module: c, type: 'default', visible: true,
           via: c.replace(/s$/, '') + '_Ref' }));
      if (o.edgeCases) {
        related.push({ api_name: 'Attachments', label: 'Attachments', module: 'Attachments',
                       type: 'system', visible: true, via: '' });
        if (api === 'Products' || api === 'Campaigns') {
          related.push({ api_name: 'Campaign_Products', label: 'Campaign products',
                         module: api === 'Campaigns' ? 'Products' : 'Campaigns',
                         type: 'multiselect', visible: true, via: 'linking: Campaign_Product_Link' });
        }
      }
      J('modules/' + api + '.json', { api_name: api, display_name: label, category: cat,
                                      fields: fields, layouts: layouts, related_lists: related });
      J('modules/layouts/' + api + '.json', { api_name: api, layouts: layouts });
      mods.push({ api_name: api, display_name: label, category: cat,
                  fieldCount: fields.length, layoutCount: layouts.length });
    });
    J('modules/index.json', { items: mods });
    J('modules/layouts/index.json',
      { items: mods.map((m) => ({ api_name: m.api_name, layoutCount: m.layoutCount })) });

    const wfs = [];
    WORKFLOWS.forEach(([mod, name, fn, sched], i) => {
      const wid = String(4000 + i);
      const actions = fn ? [{ type: 'function', name: fn }] : [];
      J('workflows/' + wid + '.json', {
        id: wid, name: name, module: mod, active: true,
        conditions: [{ criteria: 'Status is not empty',
                       actions: sched ? [] : actions,
                       scheduled_actions: sched ? [{ delay: '2 days', actions: actions }] : [] }],
        last_executed_time: '2026-07-2' + (i % 9) + 'T11:20:00+00:00',
      });
      wfs.push({ id: wid, name: name, module: mod, active: true });
    });
    J('workflows/index.json', { items: wfs });
    J('schedules/index.json', { items: SCHEDULES.map(([n, f, r], i) =>
      ({ id: String(5000 + i), name: n, function: f, recurrence: r, active: true,
         last_run: '2026-08-0' + (1 + (i % 7)) + 'T02:00:00+00:00' })) });
    J('connections/index.json', { items: CONNECTIONS.map(([c, lbl, users]) =>
      ({ name: c, display_name: lbl, service: 'custom', status: 'connected', used_by: users })) });

    const areas = {};
    ['functions', 'modules', 'workflows', 'schedules', 'connections']
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
