/* sample-org.js - the sample workspace, generated rather than downloaded.
 *
 * The twin of apps/crm/sample-org.js, and the same two consumers: the panel writes these files into
 * the working folder so somebody meeting Zoost has something to open, and `node tools/fixtures.mjs`
 * writes them into fixtures/ for the tests and the Store screenshots. One generator, so the fixture
 * cannot describe a workspace shape the product does not produce.
 *
 * It never contacts Zoho Analytics and it is not a pull: the workspace carries `sample: true` in
 * .zoost.json and the panel disables everything that would talk to the platform. There is no demo
 * mode - once the files are on disk it is an ordinary workspace, read by the ordinary code.
 *
 * NAMES. The core reads like a warehouse someone actually built, because that is what the
 * screenshots show and what a first-time reader explores. Volume is composed from two small
 * vocabularies, deterministically, rather than enumerated: `Table_1`, `Table_2` would make the
 * product look like a test harness.
 */
(function () {
  const WS = '99000001';
  const WHEN = '2026-08-07T10:00:00.000Z';

  // name -> columns. The joins below reference these by name, so the two cannot drift.
  const TABLES = [
    ['Accounts', ['Account_Id', 'Account_Name', 'Region', 'Segment', 'Created_On']],
    ['Contacts', ['Contact_Id', 'Account_Id', 'Full_Name', 'Email_Domain', 'Opted_In']],
    ['Orders', ['Order_Id', 'Account_Id', 'Order_Date', 'Channel', 'Net_Amount']],
    ['Order_Lines', ['Line_Id', 'Order_Id', 'Product_Id', 'Quantity', 'Unit_Price']],
    ['Products', ['Product_Id', 'Product_Name', 'Family', 'List_Price']],
    ['Shipments', ['Shipment_Id', 'Order_Id', 'Carrier', 'Dispatched_On', 'Delivered_On']],
    ['Invoices', ['Invoice_Id', 'Order_Id', 'Issued_On', 'Due_On', 'Gross_Amount']],
    ['Payments', ['Payment_Id', 'Invoice_Id', 'Received_On', 'Method', 'Amount']],
    ['Tickets', ['Ticket_Id', 'Account_Id', 'Opened_On', 'Severity', 'Closed_On']],
    ['Regions', ['Region', 'Country', 'Timezone']],
    ['Campaigns', ['Campaign_Id', 'Campaign_Name', 'Channel', 'Budget']],
    ['Touchpoints', ['Touch_Id', 'Campaign_Id', 'Contact_Id', 'Touched_On']],
    ['Subscriptions', ['Subscription_Id', 'Account_Id', 'Product_Id', 'Started_On', 'Ends_On']],
    ['Returns', ['Return_Id', 'Order_Id', 'Reason', 'Received_On']],
  ];
  const FKS = [
    ['Contacts', 'Account_Id', 'Accounts', 'Account_Id'],
    ['Orders', 'Account_Id', 'Accounts', 'Account_Id'],
    ['Order_Lines', 'Order_Id', 'Orders', 'Order_Id'],
    ['Order_Lines', 'Product_Id', 'Products', 'Product_Id'],
    ['Shipments', 'Order_Id', 'Orders', 'Order_Id'],
    ['Invoices', 'Order_Id', 'Orders', 'Order_Id'],
    ['Payments', 'Invoice_Id', 'Invoices', 'Invoice_Id'],
    ['Tickets', 'Account_Id', 'Accounts', 'Account_Id'],
    ['Accounts', 'Region', 'Regions', 'Region'],
    ['Touchpoints', 'Campaign_Id', 'Campaigns', 'Campaign_Id'],
    ['Touchpoints', 'Contact_Id', 'Contacts', 'Contact_Id'],
    ['Subscriptions', 'Account_Id', 'Accounts', 'Account_Id'],
    ['Subscriptions', 'Product_Id', 'Products', 'Product_Id'],
    ['Returns', 'Order_Id', 'Orders', 'Order_Id'],
  ];
  // Zoho Analytics flags its own tables. `system` is a condition in the chips, not a kind, so it
  // carries no colour - the rule this project applies everywhere.
  const SYSTEM = ['ZohoUsers', 'ZohoImportLog', 'ZohoScheduleLog'];

  const Q = (name, sql, sources) => [name, sql, sources];
  const QUERIES = [
    Q('Revenue_By_Region',
      'SELECT r."Country", SUM(o."Net_Amount") AS "Revenue"\nFROM "Orders" o\n' +
      'JOIN "Accounts" a ON a."Account_Id" = o."Account_Id"\n' +
      'JOIN "Regions" r ON r."Region" = a."Region"\nGROUP BY r."Country"',
      ['Orders', 'Accounts', 'Regions']),
    Q('Open_Invoices',
      'SELECT i."Invoice_Id", i."Due_On", i."Gross_Amount"\nFROM "Invoices" i\n' +
      'LEFT JOIN "Payments" p ON p."Invoice_Id" = i."Invoice_Id"\nWHERE p."Payment_Id" IS NULL',
      ['Invoices', 'Payments']),
    Q('Late_Shipments',
      'SELECT s."Shipment_Id", s."Carrier"\nFROM "Shipments" s\nWHERE s."Delivered_On" IS NULL',
      ['Shipments']),
    Q('Basket_Size',
      'SELECT o."Order_Id", SUM(l."Quantity") AS "Units"\nFROM "Order_Lines" l\n' +
      'JOIN "Orders" o ON o."Order_Id" = l."Order_Id"\nGROUP BY o."Order_Id"',
      ['Order_Lines', 'Orders']),
    Q('Ticket_Load',
      'SELECT a."Segment", COUNT(t."Ticket_Id") AS "Tickets"\nFROM "Tickets" t\n' +
      'JOIN "Accounts" a ON a."Account_Id" = t."Account_Id"\nGROUP BY a."Segment"',
      ['Tickets', 'Accounts']),
    Q('Campaign_Reach',
      'SELECT c."Campaign_Name", COUNT(DISTINCT t."Contact_Id") AS "Reached"\n' +
      'FROM "Touchpoints" t\nJOIN "Campaigns" c ON c."Campaign_Id" = t."Campaign_Id"\n' +
      'GROUP BY c."Campaign_Name"', ['Touchpoints', 'Campaigns']),
    Q('Return_Rate',
      'SELECT o."Channel", COUNT(r."Return_Id") AS "Returns"\nFROM "Returns" r\n' +
      'JOIN "Orders" o ON o."Order_Id" = r."Order_Id"\nGROUP BY o."Channel"', ['Returns', 'Orders']),
    Q('Active_Subscriptions',
      'SELECT p."Family", COUNT(s."Subscription_Id") AS "Active"\nFROM "Subscriptions" s\n' +
      'JOIN "Products" p ON p."Product_Id" = s."Product_Id"\nWHERE s."Ends_On" IS NULL\n' +
      'GROUP BY p."Family"', ['Subscriptions', 'Products']),
  ];
  // Two edge cases that five surfaces used to conflate: a query Zoho returned **empty**, and one it
  // could not return at all. '' is a fact, null is a failure, and `x || fallback` reads them alike.
  const EDGE_QUERIES = [Q('Empty_Draft', '', []), Q('Unreadable_Query', null, [])];

  const REPORTS = [
    ['Revenue by country', 'Revenue_By_Region', 'Chart'],
    ['Revenue trend', 'Revenue_By_Region', 'Chart'],
    ['Open invoices', 'Open_Invoices', 'Table'],
    ['Ageing buckets', 'Open_Invoices', 'Pivot'],
    ['Carrier performance', 'Late_Shipments', 'Chart'],
    ['Units per order', 'Basket_Size', 'Chart'],
    ['Tickets by segment', 'Ticket_Load', 'Chart'],
    ['Campaign reach', 'Campaign_Reach', 'Chart'],
    ['Returns by channel', 'Return_Rate', 'Pivot'],
    ['Subscription mix', 'Active_Subscriptions', 'Chart'],
    ['Product catalogue', 'Products', 'Table'],
    ['Contact coverage', 'Contacts', 'Pivot'],
    ['Region reference', 'Regions', 'Table'],
  ];
  const DASHBOARDS = ['Commercial overview', 'Operations', 'Finance', 'Marketing'];

  const stemOf = (name, id) => (String(name || 'unnamed').replace(/[^\w.\- ]/g, '_').trim().slice(0, 80) || 'unnamed') + '-' + id;

  /** The whole workspace as {path: text}, in the shape the pull writes it.
   *
   * NOT the raw Zoho payload: the bridge transforms `VIEW_ID`/`VIEW_NAME` into `id`/`name` before
   * anything reaches disk, and the first version of this file wrote the raw keys - so the panel read
   * a workspace with no views in it. Derive a shape from writeToDisk() and loadFromDisk(), never
   * from the API the bridge happens to call.
   */
  function files(opts) {
    const o = Object.assign({ edgeCases: false }, opts || {});
    const out = {};
    const J = (p, v) => { out[p] = JSON.stringify(v, null, 2) + '\n'; };
    let n = 0;
    const newId = () => '177856000000' + String(++n * 4).padStart(6, '0');
    const vid = {}, views = [], schema = {}, deps = {}, sqlindex = {};

    const FOLDERS = [['1', 'Data'], ['2', 'Queries'], ['3', 'Reports']]
      .concat(o.edgeCases ? [['4', 'System']] : []);
    const folders = FOLDERS.map(([id, name], i) =>
      ({ id: id, name: name, description: '', parent: null, isDefault: i === 0 }));
    const fid = Object.fromEntries(FOLDERS.map(([id, name]) => [name, id]));

    const view = (name, type, folder, parent, system) => {
      const id = newId(); vid[name] = id;
      views.push({
        id: id, name: name, type: type, description: '',
        folder: fid[folder], folderName: folder, parent: parent ? vid[parent] : null,
        createdText: ' 03 Jul 2026', createdBy: 'Sample User', owner: 'Sample User',
        // Only one of these is machine-readable. The other two arrive already rendered in the
        // user's interface language and are carried verbatim - the fixture keeps that asymmetry,
        // because a workspace where every date sorts would hide the reason Design cannot.
        dataModifiedAt: 1786000000000 + n * 1000, dataModifiedBy: 'Sample User',
        designModifiedText: ' 21 Jul 2026', designModifiedBy: 'Sample User',
        live: false, system: !!system, favourite: false, tags: [],
      });
      return id;
    };
    const cols = (list) => list.map((c, j) => ({
      name: c, type: /_Id$/.test(c) ? 'BIGINT' : (/_On$|_Date$/.test(c) ? 'DATE' : 'PLAIN'),
      colid: 'c' + (++n) + '-' + j, description: '' }));

    const tables = TABLES.concat(o.edgeCases ? SYSTEM.map((t) => [t, ['Id', 'Logged_On', 'Detail']]) : []);
    for (const [name, c] of tables) {
      const sys = SYSTEM.indexOf(name) >= 0;
      const id = view(name, 'Table', sys ? 'System' : 'Data', null, sys);
      schema[id] = { name: name, kind: 'Table', description: '', system: sys, dataPrep: false,
                     designModifiedAt: 1786000000000 + n * 1000, columns: cols(c) };
    }
    const queries = QUERIES.concat(o.edgeCases ? EDGE_QUERIES : []);
    for (const [name, sql, sources] of queries) {
      const id = view(name, 'QueryTable', 'Queries', null, false);
      schema[id] = { name: name, kind: 'QueryTable', description: '', system: false, dataPrep: false,
                     designModifiedAt: 1786100000000 + n * 1000, columns: cols(['Col_1', 'Col_2', 'Col_3']) };
      const stem = stemOf(name, id);
      const src = {};
      sources.forEach((t) => { if (vid[t]) src[vid[t]] = [t]; });
      // A query that could not be read has no file and no stem - «Retry failed» is what exists for
      // it - while one Zoho returned empty has a file with nothing in it. Different facts.
      if (sql === null) {
        sqlindex[id] = { stem: stem, name: name, parents: [], sources: {} };
      } else {
        out['sql/' + stem + '.sql'] = sql;
        sqlindex[id] = { stem: stem, name: name, parents: sources.map((t) => vid[t]).filter(Boolean), sources: src };
      }
      deps[id] = { id: id, parents: sources.map((t) => vid[t]).filter(Boolean), children: [], dashboards: [] };
    }
    for (const [name, parent, kind] of REPORTS) view(name, kind, 'Reports', parent, false);
    for (const name of DASHBOARDS) view(name, 'Dashboard', 'Reports', null, false);

    // Presentation views read their parent; a dashboard collects the reports in its folder. Both
    // directions are filled, because the panel reads children and dashboards as well as parents.
    for (const v of views) {
      if (!deps[v.id]) deps[v.id] = { id: v.id, parents: [], children: [], dashboards: [] };
      if (v.parent) deps[v.id].parents.push(v.parent);
    }
    for (const v of views) {
      for (const p of deps[v.id].parents) {
        if (!deps[p]) deps[p] = { id: p, parents: [], children: [], dashboards: [] };
        if (v.type === 'Dashboard') deps[p].dashboards.push(v.id); else deps[p].children.push(v.id);
      }
    }

    const relations = FKS.filter(([a, , b]) => vid[a] && vid[b]).map(([a, ca, b, cb]) => ({
      source: vid[a], target: vid[b], sourceName: a, targetName: b,
      sourceColumns: [ca], targetColumns: [cb],
      relation: '(' + a + '.' + ca + ')=(' + b + '.' + cb + ')',
    }));

    const failed = (o.edgeCases && vid.Unreadable_Query) ? [vid.Unreadable_Query] : [];
    J('views.json', { workspace: WS, pulledAt: WHEN, folders: folders, views: views });
    J('schema.json', { workspace: WS, tables: schema, relations: relations });
    J('lineage.json', { workspace: WS, deps: deps, failed: failed });
    J('sql/index.json', sqlindex);
    J('.zoost.json', {
      workspace: WS, name: 'Sample workspace', label: 'Sample workspace',
      origin: 'https://analytics.zoho.eu', sv: 1,
      // The one field that makes this a sample rather than a mirror.
      sample: true, sampleAt: WHEN, lastPull: WHEN,
      counts: { views: views.length, folders: folders.length,
                tables: Object.keys(schema).length, relations: relations.length,
                sql: Object.keys(sqlindex).length },
    });
    return out;
  }

  const folderName = () => 'sample-workspace';
  window.SAMPLE_ORG = { files: files, folderName: folderName, workspace: WS, tables: TABLES, fks: FKS };
})();
