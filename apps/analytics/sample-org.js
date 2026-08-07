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

  function files(opts) {
    const o = Object.assign({ edgeCases: false }, opts || {});
    const out = {};
    const J = (p, v) => { out[p] = JSON.stringify(v, null, 2) + '\n'; };
    let n = 0;
    const newId = () => '177856000000' + String(++n * 4).padStart(6, '0');
    const vid = {}, views = [], schema = {}, lineage = {}, sqlindex = {};

    const tables = TABLES.concat(o.edgeCases ? SYSTEM.map((s) => [s, ['Id', 'Logged_On', 'Detail']]) : []);
    for (const [name, cols] of tables) {
      const id = newId(); vid[name] = id;
      const sys = SYSTEM.indexOf(name) >= 0;
      views.push({ VIEW_ID: id, VIEW_NAME: name, VIEW_TYPE: 'Table',
                   FOLDER: sys ? 'System' : 'Data', PARENT_ID: null, SYSTEM: sys,
                   ACT_VIEW_MODTIME: 1786000000000 + n * 1000,
                   LAST_DATA_MODIFY: '2 hours ago', LAST_DESIGN_MODIFY: ' 03 Jul 2026' });
      schema[id] = { name: name, kind: 'Table', system: sys, columns: cols.map((c, j) =>
        ({ name: c, type: /_Id$/.test(c) ? 'BIGINT' : (/_On$|_Date$/.test(c) ? 'DATE' : 'PLAIN'),
           colid: id + '-' + j })) };
    }
    const queries = QUERIES.concat(o.edgeCases ? EDGE_QUERIES : []);
    for (const [name, sql, sources] of queries) {
      const id = newId(); vid[name] = id;
      views.push({ VIEW_ID: id, VIEW_NAME: name, VIEW_TYPE: 'QueryTable', FOLDER: 'Queries',
                   PARENT_ID: null, SYSTEM: false, ACT_VIEW_MODTIME: 1786100000000 + n * 1000,
                   LAST_DATA_MODIFY: '1 day ago', LAST_DESIGN_MODIFY: ' 21 Jul 2026' });
      schema[id] = { name: name, kind: 'QueryTable', system: false,
                     columns: ['Col_1', 'Col_2', 'Col_3'].map((c, j) =>
                       ({ name: c, type: 'PLAIN', colid: id + '-' + j })) };
      if (sql === null) {
        sqlindex[id] = { file: null, failed: true, sources: [] };
      } else {
        out['sql/' + name + '-' + id + '.sql'] = sql ? sql + '\n' : '';
        sqlindex[id] = { file: name + '-' + id + '.sql',
                         sources: sources.map((s) => vid[s]).filter(Boolean) };
      }
      lineage[id] = { reads: sources.map((s) => vid[s]).filter(Boolean), read_by: [] };
    }
    for (const [name, parent, kind] of REPORTS) {
      const id = newId(); vid[name] = id;
      views.push({ VIEW_ID: id, VIEW_NAME: name, VIEW_TYPE: kind, FOLDER: 'Reports',
                   PARENT_ID: vid[parent] || null, SYSTEM: false,
                   ACT_VIEW_MODTIME: 1786200000000 + n * 1000,
                   LAST_DATA_MODIFY: '3 days ago', LAST_DESIGN_MODIFY: ' 02 Aug 2026' });
      lineage[id] = { reads: vid[parent] ? [vid[parent]] : [], read_by: [] };
    }
    for (const name of DASHBOARDS) {
      const id = newId(); vid[name] = id;
      views.push({ VIEW_ID: id, VIEW_NAME: name, VIEW_TYPE: 'Dashboard', FOLDER: 'Reports',
                   PARENT_ID: null, SYSTEM: false, ACT_VIEW_MODTIME: 1786300000000 + n * 1000,
                   LAST_DATA_MODIFY: '3 days ago', LAST_DESIGN_MODIFY: ' 02 Aug 2026' });
      lineage[id] = { reads: [], read_by: [] };
    }
    // A snapshot: the loop below adds keys for the data-bearing views a report reads, which have no
    // lineage entry of their own until it does.
    for (const [src, d] of Object.entries(JSON.parse(JSON.stringify(lineage)))) {
      for (const r of d.reads) {
        if (!lineage[r]) lineage[r] = { reads: [], read_by: [] };
        lineage[r].read_by.push(src);
      }
    }
    const relations = FKS.map(([a, ca, b, cb]) =>
      ({ from: vid[a], fromColumn: ca, to: vid[b], toColumn: cb,
         relation: '("' + a + '"."' + ca + '")=("' + b + '"."' + cb + '")' }));

    J('views.json', { views: views, folders: ['Data', 'Queries', 'Reports'].concat(o.edgeCases ? ['System'] : []),
                      pullFailed: o.edgeCases && vid.Unreadable_Query ? [vid.Unreadable_Query] : [] });
    J('schema.json', { tables: schema, relations: relations });
    J('lineage.json', lineage);
    J('sql/index.json', sqlindex);
    J('.zoost.json', { workspace: WS, name: 'Sample workspace', label: 'Sample workspace',
                       base: 'https://analytics.zoho.eu',
                       // The one field that makes this a sample rather than a mirror.
                       sample: true, sampleAt: WHEN, lastPull: WHEN });
    return out;
  }

  const folderName = () => 'sample-workspace';
  window.SAMPLE_ORG = { files: files, folderName: folderName, workspace: WS, tables: TABLES, fks: FKS };
})();
