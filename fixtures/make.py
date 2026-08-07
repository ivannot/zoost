#!/usr/bin/env python3
"""Build the sample org - a workspace of invented data, in the exact shape a pull writes.

Why this exists, in the order the reasons arrived.

1. **Screenshots.** Every image published so far was captured against the org this is developed on
   and then blurred, and a blurred screenshot is a poor advertisement for a tool whose subject is
   reading clearly. Rendered against this fixture there is nothing to hide, and the same image can be
   regenerated after a UI change instead of being re-captured.

2. **The data has to survive the session.** Fixtures built in a scratch directory die with the
   conversation that made them: a fresh checkout, or a new session, starts with nothing to point the
   panel at. This is in the repository, so it is there for whoever comes next.

3. **Tests.** A workspace on disk in the real shape is what the walks, the exports and the audit
   actually consume.

Nothing here is generated at random. The seed is fixed, so two runs produce byte-identical files and
a diff means something changed on purpose.

**Every name is generic on purpose.** Zoost is stated to be built independently of its author's day
job, and a real portal, module or function name in a fixture would quietly contradict that - so the
modules are the ones Zoho itself ships with, and the namespaces are ordinary business words.

    python3 fixtures/make.py          # rewrites fixtures/crm/ and fixtures/analytics/
"""
import json
import os
import pathlib
import random
import shutil

ROOT = pathlib.Path(__file__).resolve().parent
ORG = "1234567890"
INSTANCE = "sampleorg"

# ---------------------------------------------------------------------------------------------
# Zoho CRM
# ---------------------------------------------------------------------------------------------
MODULES = [
    # (api_name, label, category, fields beyond the common ones, related lists)
    ("Accounts", "Accounts", "standard"),
    ("Contacts", "Contacts", "standard"),
    ("Leads", "Leads", "standard"),
    ("Deals", "Deals", "standard"),
    ("Products", "Products", "standard"),
    ("Quotes", "Quotes", "standard"),
    ("Invoices", "Invoices", "standard"),
    ("Orders", "Sales Orders", "standard"),
    ("Shipments", "Shipments", "custom"),
    ("Tickets", "Support Tickets", "custom"),
    ("Campaigns", "Campaigns", "standard"),
    ("Subscriptions", "Subscriptions", "custom"),
    # Zoho answers 400 INVALID_MODULE for a hidden module. It is written with the refusal and its
    # date, wears the grey no-mark, and everything downstream of it is absent rather than zero -
    # a state with five surfaces of its own that an org without one cannot show.
    ("Ledger", "Ledger", "custom"),
]
REFUSED = "Ledger"
LOOKUPS = {
    "Contacts": ["Accounts"],
    "Deals": ["Accounts", "Contacts"],
    "Quotes": ["Deals", "Accounts"],
    "Invoices": ["Accounts", "Orders"],
    "Orders": ["Accounts", "Quotes"],
    "Shipments": ["Orders"],
    "Tickets": ["Accounts", "Contacts", "Products"],
    "Subscriptions": ["Accounts", "Products"],
    "Campaigns": [],
}
FIELD_POOL = [
    ("Name", "text", True), ("Owner", "ownerlookup", True), ("Description", "textarea", False),
    ("Status", "picklist", False), ("Amount", "currency", False), ("Currency", "picklist", False),
    ("Opened_On", "date", False), ("Closed_On", "date", False), ("Priority", "picklist", False),
    ("External_Ref", "text", False), ("Notes", "textarea", False), ("Archived", "boolean", False),
]
NAMESPACES = ["billing", "orders", "shipping", "support", "shared", "sync", "reporting"]
FUNCS = [
    ("shared", "log", "standalone", ["message"]),
    ("shared", "formatMoney", "standalone", ["amount", "currency"]),
    ("shared", "isBusinessDay", "standalone", ["day"]),
    ("shared", "orgSettings", "standalone", []),
    ("billing", "calcTax", "standalone", ["amount", "rate"]),
    ("billing", "buildInvoice", "standalone", ["orderId"]),
    ("billing", "applyDiscount", "standalone", ["amount", "code"]),
    ("billing", "dunningRun", "scheduler", []),
    ("billing", "syncPayments", "scheduler", []),
    ("orders", "validateOrder", "crmfundamentals", ["orderId"]),
    ("orders", "reserveStock", "standalone", ["orderId"]),
    ("orders", "releaseStock", "standalone", ["orderId"]),
    ("orders", "onOrderCreate", "crmfundamentals", ["orderId"]),
    ("orders", "recalcTotals", "standalone", ["orderId"]),
    ("shipping", "planShipment", "standalone", ["orderId"]),
    ("shipping", "trackParcel", "standalone", ["tracking"]),
    ("shipping", "nightlyDispatch", "scheduler", []),
    ("support", "openTicket", "custombutton", ["accountId", "subject"]),
    ("support", "escalate", "standalone", ["ticketId"]),
    ("support", "closeStale", "scheduler", []),
    ("sync", "pushAccounts", "scheduler", []),
    ("sync", "pullCatalogue", "scheduler", []),
    ("sync", "reconcile", "standalone", ["since"]),
    ("reporting", "weeklyDigest", "scheduler", []),
    ("reporting", "buildCohort", "standalone", ["from", "to"]),
    ("reporting", "exportCsv", "custombutton", ["view"]),
    ("support", "ticketButton", "custombutton", ["ticketId"]),
    ("orders", "orderButton", "custombutton", ["orderId"]),
    # Zoho does not always give a category. The empty one is a kind of its own in the chips
    # («no category»), and an org where it never occurs cannot show that.
    ("shared", "legacyHelper", "", ["input"]),
]

# Functions whose meta on disk is older than META_SV render as stale - the amber half-dot - and are
# what «Refresh outdated» exists for. An org where nothing is stale cannot show that flow.
STALE = {"shared.legacyHelper", "sync.reconcile"}
# A name the call regex found that resolves to nothing, and one that resolves to more than one.
# Both are measurements of absence and both have their own panel section and their own chip.
UNRESOLVED = {"orders.validateOrder": ["pricing.lookupBand"], "reporting.exportCsv": ["legacy.dump"]}
AMBIGUOUS = {"support.escalate": ["log"]}
CALLS = {
    "billing.buildInvoice": ["billing.calcTax", "billing.applyDiscount", "shared.formatMoney", "shared.log"],
    "billing.dunningRun": ["billing.buildInvoice", "shared.log"],
    "billing.syncPayments": ["shared.log", "sync.reconcile"],
    "billing.applyDiscount": ["shared.log"],
    "orders.onOrderCreate": ["orders.validateOrder", "orders.reserveStock", "orders.recalcTotals"],
    "orders.validateOrder": ["shared.orgSettings", "shared.log"],
    "orders.recalcTotals": ["billing.calcTax", "shared.formatMoney"],
    "orders.reserveStock": ["shared.log"],
    "orders.releaseStock": ["shared.log"],
    "shipping.planShipment": ["shared.isBusinessDay", "orders.releaseStock", "shared.log"],
    "shipping.nightlyDispatch": ["shipping.planShipment", "shipping.trackParcel"],
    "support.openTicket": ["shared.log"],
    "support.escalate": ["shared.log", "reporting.weeklyDigest"],
    "support.closeStale": ["support.escalate"],
    "sync.pushAccounts": ["shared.orgSettings", "shared.log"],
    "sync.pullCatalogue": ["shared.orgSettings"],
    "sync.reconcile": ["shared.log"],
    "reporting.weeklyDigest": ["reporting.buildCohort", "shared.formatMoney"],
    "reporting.exportCsv": ["reporting.buildCohort"],
    "support.ticketButton": ["support.openTicket"],
    "orders.orderButton": ["orders.validateOrder"],
    "shared.legacyHelper": [],
}
CONNECTIONS = [
    ("warehouse_api", "Warehouse API", ["shipping.planShipment", "orders.reserveStock"]),
    ("payments_gw", "Payments gateway", ["billing.syncPayments"]),
    ("mail_relay", "Mail relay", ["reporting.weeklyDigest", "support.escalate"]),
    ("catalogue_feed", "Catalogue feed", ["sync.pullCatalogue"]),
    ("archive_store", "Archive store", []),
]
WORKFLOWS = [
    ("Orders", "New order received", "orders.onOrderCreate", False),
    ("Orders", "Order amount changed", "orders.recalcTotals", False),
    ("Invoices", "Invoice overdue", "billing.dunningRun", True),
    ("Tickets", "Ticket unanswered", "support.escalate", True),
    ("Contacts", "Contact created", None, False),
    ("Deals", "Deal won", "billing.buildInvoice", False),
    ("Shipments", "Shipment dispatched", "shipping.trackParcel", False),
    ("Leads", "Lead untouched", None, True),
]
SCHEDULES = [
    ("Nightly dispatch", "shipping.nightlyDispatch", "Every day at 02:00"),
    ("Dunning run", "billing.dunningRun", "Every day at 06:00"),
    ("Close stale tickets", "support.closeStale", "Every Monday at 07:00"),
    ("Weekly digest", "reporting.weeklyDigest", "Every Monday at 08:00"),
    ("Catalogue pull", "sync.pullCatalogue", "Every 6 hours"),
    ("Account push", "sync.pushAccounts", "Every day at 23:30"),
]

DELUGE = """// {ns}.{name} - sample function, invented for the fixture org.
{sig}
{{
    info "{ns}.{name} start";
{body}
    return {ret};
}}
"""


def deluge(ns, name, params, calls):
    sig = "{} {}({})".format("void" if not params else "map", name,
                             ", ".join("string " + p for p in params))
    body = "\n".join('    {} = {}({});'.format("r" + str(i), c, "")
                     for i, c in enumerate(calls)) or "    // nothing else is called"
    return DELUGE.format(ns=ns, name=name, sig=sig, body=body, ret="null" if not params else "r0")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def js(path, obj):
    write(path, json.dumps(obj, indent=2, sort_keys=False) + "\n")


def build_crm(out: pathlib.Path):
    random.seed(11)
    shutil.rmtree(out, ignore_errors=True)

    # --- functions ---
    index = []
    for ns, name, cat, params in FUNCS:
        fid = ns + "." + name
        calls = CALLS.get(fid, [])
        src = deluge(ns, name, params, calls)
        write(out / "functions" / ns / (name + ".dg"), src)
        conns = [c for c, _lbl, users in CONNECTIONS if fid in users]
        js(out / "functions" / ns / (name + ".meta.json"), {
            # Below META_SV on purpose for a couple of them: that is what the amber half-dot and
            # «Refresh outdated» are for, and an org where nothing is stale cannot show either.
            "sv": 1 if fid in STALE else 3,
            "id": str(9000 + len(index)), "name": name, "namespace": ns,
            "display_name": name, "category": cat, "return_type": "void" if not params else "map",
            "params": [{"name": p, "type": "string"} for p in params],
            "connections": conns, "modified_by": "Sample User",
            "modified_time": "2026-07-0{}T09:00:00+00:00".format(1 + len(index) % 9),
            "rest": name in ("exportCsv", "openTicket"),
            "unresolved": UNRESOLVED.get(fid, []), "ambiguous": AMBIGUOUS.get(fid, []),
        })
        index.append({"id": str(9000 + len(index)), "name": name, "namespace": ns,
                      "display_name": name, "category": cat})
    js(out / "functions" / "index.json", {"items": index})

    # --- modules ---
    mods = []
    for i, (api, label, cat) in enumerate(MODULES):
        fields = [{"api_name": a, "data_type": t, "mandatory": m, "lookup": None}
                  for a, t, m in FIELD_POOL[: 6 + (i % 6)]]
        for target in LOOKUPS.get(api, []):
            fields.append({"api_name": target[:-1] + "_Ref", "data_type": "lookup",
                           "mandatory": False, "lookup": target})
        layouts = [{"id": 3000 + i, "name": "Standard", "visible": True, "sections": 3}]
        if i % 4 == 0:
            layouts.append({"id": 3100 + i, "name": "Compact", "visible": True, "sections": 2})
        if i % 5 == 0:
            layouts.append({"id": 3200 + i, "name": "Retired", "visible": False, "sections": 1})
        related = [{"api_name": "{}_of_{}".format(child, api), "label": child,
                    "module": child, "type": "default", "visible": True, "via": child + "_Ref"}
                   for child, parents in LOOKUPS.items() if api in parents]
        # Zoho's own system related lists, and a junction one. Both are facets in the Relations
        # table («system», «many-to-many») and a fixture without them leaves two filters with
        # nothing to filter.
        related += [{"api_name": "Attachments", "label": "Attachments", "module": "Attachments",
                     "type": "system", "visible": True, "via": ""},
                    {"api_name": "Notes", "label": "Notes", "module": "Notes",
                     "type": "system", "visible": False, "via": ""}]
        if api in ("Products", "Campaigns"):
            related.append({"api_name": "Campaign_Products", "label": "Campaign products",
                            "module": "Products" if api == "Campaigns" else "Campaigns",
                            "type": "multiselect", "visible": True,
                            "via": "linking: Campaign_Product_Link"})
        if api == REFUSED:
            js(out / "modules" / (api + ".json"), {
                "api_name": api, "display_name": label, "category": cat,
                "fields": [], "layouts": [], "related_lists": [],
                "unreadable": {"status": 400, "code": "INVALID_MODULE", "at": "2026-08-07T10:00:00.000Z",
                               "message": "operation cannot be performed for hidden module"},
            })
            js(out / "modules" / "layouts" / (api + ".json"), {"api_name": api, "layouts": []})
            mods.append({"api_name": api, "display_name": label, "category": cat,
                         "fieldCount": 0, "layoutCount": 0,
                         "unreadable": {"status": 400, "code": "INVALID_MODULE",
                                        "at": "2026-08-07T10:00:00.000Z",
                                        "message": "operation cannot be performed for hidden module"}})
            continue
        js(out / "modules" / (api + ".json"), {
            "api_name": api, "display_name": label, "category": cat,
            "fields": fields, "layouts": layouts, "related_lists": related,
        })
        js(out / "modules" / "layouts" / (api + ".json"), {"api_name": api, "layouts": layouts})
        mods.append({"api_name": api, "display_name": label, "category": cat,
                     "fieldCount": len(fields), "layoutCount": len(layouts)})
    js(out / "modules" / "index.json", {"items": mods})
    js(out / "modules" / "layouts" / "index.json",
       {"items": [{"api_name": m["api_name"], "layoutCount": m["layoutCount"]} for m in mods]})

    # --- workflows ---
    wfs = []
    for i, (mod, name, fn, scheduled) in enumerate(WORKFLOWS):
        wid = str(4000 + i)
        actions = ([{"type": "function", "name": fn}] if fn else [])
        js(out / "workflows" / (wid + ".json"), {
            "id": wid, "name": name, "module": mod, "active": True,
            "conditions": [{
                "criteria": "Status is not empty",
                "actions": actions if not scheduled else [],
                "scheduled_actions": ([{"delay": "2 days", "actions": actions}] if scheduled else []),
            }],
            "last_executed_time": "2026-07-2{}T11:20:00+00:00".format(i % 9),
        })
        wfs.append({"id": wid, "name": name, "module": mod, "active": True})
    js(out / "workflows" / "index.json", {"items": wfs})

    # --- schedules and connections ---
    js(out / "schedules" / "index.json", {"items": [
        {"id": str(5000 + i), "name": n, "function": f, "recurrence": r, "active": True,
         "last_run": "2026-08-0{}T02:00:00+00:00".format(1 + i % 7)}
        for i, (n, f, r) in enumerate(SCHEDULES)]})
    js(out / "connections" / "index.json", {"items": [
        {"name": c, "display_name": lbl, "service": "custom", "status": "connected",
         "used_by": users}
        for c, lbl, users in CONNECTIONS]})

    now = "2026-08-07T10:00:00.000Z"
    js(out / ".zoost.json", {
        "org": ORG, "instance": INSTANCE, "host": "crm.zoho.eu", "sandbox": False,
        "label": "Sample org", "lastPull": now,
        "access": {a: {"at": now, "pulledAt": now, "ok": True}
                   for a in ("functions", "modules", "workflows", "schedules", "connections")},
    })
    return index, mods


# ---------------------------------------------------------------------------------------------
# Zoho Analytics
# ---------------------------------------------------------------------------------------------
TABLES = [
    ("Accounts", ["Account_Id", "Account_Name", "Region", "Segment", "Created_On"]),
    ("Contacts", ["Contact_Id", "Account_Id", "Full_Name", "Email_Domain", "Opted_In"]),
    ("Orders", ["Order_Id", "Account_Id", "Order_Date", "Channel", "Net_Amount"]),
    ("Order_Lines", ["Line_Id", "Order_Id", "Product_Id", "Quantity", "Unit_Price"]),
    ("Products", ["Product_Id", "Product_Name", "Family", "List_Price"]),
    ("Shipments", ["Shipment_Id", "Order_Id", "Carrier", "Dispatched_On", "Delivered_On"]),
    ("Invoices", ["Invoice_Id", "Order_Id", "Issued_On", "Due_On", "Gross_Amount"]),
    ("Payments", ["Payment_Id", "Invoice_Id", "Received_On", "Method", "Amount"]),
    ("Tickets", ["Ticket_Id", "Account_Id", "Opened_On", "Severity", "Closed_On"]),
    ("Regions", ["Region", "Country", "Timezone"]),
    # Zoho Analytics flags its own system tables (isSystemTable). They are a condition in the chips,
    # and a workspace without one leaves that filter with nothing to filter.
    ("ZohoUsers", ["User_Id", "Email", "Role"]),
    ("ZohoImportLog", ["Import_Id", "Started_On", "Rows"]),
]
SYSTEM_TABLES = {"ZohoUsers", "ZohoImportLog"}
FKS = [
    ("Contacts", "Account_Id", "Accounts", "Account_Id"),
    ("Orders", "Account_Id", "Accounts", "Account_Id"),
    ("Order_Lines", "Order_Id", "Orders", "Order_Id"),
    ("Order_Lines", "Product_Id", "Products", "Product_Id"),
    ("Shipments", "Order_Id", "Orders", "Order_Id"),
    ("Invoices", "Order_Id", "Orders", "Order_Id"),
    ("Payments", "Invoice_Id", "Invoices", "Invoice_Id"),
    ("Tickets", "Account_Id", "Accounts", "Account_Id"),
    ("Accounts", "Region", "Regions", "Region"),
]
QUERIES = [
    ("Revenue_By_Region", "SELECT r.\"Country\", SUM(o.\"Net_Amount\") AS \"Revenue\"\n"
                          "FROM \"Orders\" o\n"
                          "JOIN \"Accounts\" a ON a.\"Account_Id\" = o.\"Account_Id\"\n"
                          "JOIN \"Regions\" r ON r.\"Region\" = a.\"Region\"\n"
                          "GROUP BY r.\"Country\"", ["Orders", "Accounts", "Regions"]),
    ("Open_Invoices", "SELECT i.\"Invoice_Id\", i.\"Due_On\", i.\"Gross_Amount\"\n"
                      "FROM \"Invoices\" i\n"
                      "LEFT JOIN \"Payments\" p ON p.\"Invoice_Id\" = i.\"Invoice_Id\"\n"
                      "WHERE p.\"Payment_Id\" IS NULL", ["Invoices", "Payments"]),
    ("Late_Shipments", "SELECT s.\"Shipment_Id\", s.\"Carrier\"\n"
                       "FROM \"Shipments\" s\n"
                       "WHERE s.\"Delivered_On\" IS NULL", ["Shipments"]),
    ("Basket_Size", "SELECT o.\"Order_Id\", SUM(l.\"Quantity\") AS \"Units\"\n"
                    "FROM \"Order_Lines\" l\n"
                    "JOIN \"Orders\" o ON o.\"Order_Id\" = l.\"Order_Id\"\n"
                    "GROUP BY o.\"Order_Id\"", ["Order_Lines", "Orders"]),
    ("Ticket_Load", "SELECT a.\"Segment\", COUNT(t.\"Ticket_Id\") AS \"Tickets\"\n"
                    "FROM \"Tickets\" t\n"
                    "JOIN \"Accounts\" a ON a.\"Account_Id\" = t.\"Account_Id\"\n"
                    "GROUP BY a.\"Segment\"", ["Tickets", "Accounts"]),
    # An empty SQL and an unreadable one are different facts and read differently on five surfaces:
    # '' is «Zoho returned nothing», null is «we could not fetch it». An `x || fallback` that
    # conflates them is a bug this project has already had, and it needs both to be caught.
    ("Empty_Draft", "", []),
    ("Unreadable_Query", None, []),
]
REPORTS = [
    ("Revenue by country", "Revenue_By_Region", "Chart"),
    ("Revenue trend", "Revenue_By_Region", "Chart"),
    ("Open invoices", "Open_Invoices", "Table"),
    ("Ageing buckets", "Open_Invoices", "Pivot"),
    ("Carrier performance", "Late_Shipments", "Chart"),
    ("Units per order", "Basket_Size", "Chart"),
    ("Tickets by segment", "Ticket_Load", "Chart"),
    ("Product catalogue", "Products", "Table"),
    ("Contact coverage", "Contacts", "Pivot"),
    ("Unused view", "Regions", "Table"),
]
DASHBOARDS = ["Commercial overview", "Operations", "Finance"]


def build_analytics(out: pathlib.Path):
    shutil.rmtree(out, ignore_errors=True)
    vid = {}
    views, schema, lineage, sqlindex = [], {}, {}, {}
    n = 0

    def newid():
        nonlocal n
        n += 1
        return "177856000000{:06d}".format(n * 4)

    for name, cols in TABLES:
        i = newid(); vid[name] = i
        views.append({"VIEW_ID": i, "VIEW_NAME": name, "VIEW_TYPE": "Table",
                      "FOLDER": "System" if name in SYSTEM_TABLES else "Data",
                      "PARENT_ID": None, "SYSTEM": name in SYSTEM_TABLES,
                      "ACT_VIEW_MODTIME": 1786000000000 + n * 1000,
                      "LAST_DATA_MODIFY": "2 hours ago", "LAST_DESIGN_MODIFY": " 03 Jul 2026"})
        schema[i] = {"name": name, "kind": "Table", "system": name in SYSTEM_TABLES, "columns": [
            {"name": c, "type": "PLAIN" if not c.endswith(("_Id", "_On")) else
             ("BIGINT" if c.endswith("_Id") else "DATE"), "colid": "{}-{}".format(i, j)}
            for j, c in enumerate(cols)]}
    for name, sql, sources in QUERIES:
        i = newid(); vid[name] = i
        views.append({"VIEW_ID": i, "VIEW_NAME": name, "VIEW_TYPE": "QueryTable",
                      "FOLDER": "Queries", "PARENT_ID": None, "SYSTEM": False,
                      "ACT_VIEW_MODTIME": 1786100000000 + n * 1000,
                      "LAST_DATA_MODIFY": "1 day ago", "LAST_DESIGN_MODIFY": " 21 Jul 2026"})
        schema[i] = {"name": name, "kind": "QueryTable", "columns": [
            {"name": c, "type": "PLAIN", "colid": "{}-{}".format(i, j)}
            for j, c in enumerate(["Col_" + str(k + 1) for k in range(3)])]}
        if sql is None:
            sqlindex[i] = {"file": None, "failed": True,
                           "sources": [vid[s] for s in sources if s in vid]}
        else:
            write(out / "sql" / "{}-{}.sql".format(name, i), sql + ("\n" if sql else ""))
            sqlindex[i] = {"file": "{}-{}.sql".format(name, i),
                           "sources": [vid[s] for s in sources if s in vid]}
        lineage[i] = {"reads": [vid[s] for s in sources if s in vid], "read_by": []}
    for name, parent, kind in REPORTS:
        i = newid(); vid[name] = i
        views.append({"VIEW_ID": i, "VIEW_NAME": name, "VIEW_TYPE": kind,
                      "FOLDER": "Reports", "PARENT_ID": vid.get(parent), "SYSTEM": False,
                      "ACT_VIEW_MODTIME": 1786200000000 + n * 1000,
                      "LAST_DATA_MODIFY": "3 days ago", "LAST_DESIGN_MODIFY": " 02 Aug 2026"})
        lineage[i] = {"reads": [vid[parent]] if parent in vid else [], "read_by": []}
    for name in DASHBOARDS:
        i = newid(); vid[name] = i
        views.append({"VIEW_ID": i, "VIEW_NAME": name, "VIEW_TYPE": "Dashboard",
                      "FOLDER": "Reports", "PARENT_ID": None, "SYSTEM": False,
                      "ACT_VIEW_MODTIME": 1786300000000 + n * 1000,
                      "LAST_DATA_MODIFY": "3 days ago", "LAST_DESIGN_MODIFY": " 02 Aug 2026"})
        lineage[i] = {"reads": [], "read_by": []}
    # A snapshot, because setdefault below adds keys: a data-bearing view read by a report has no
    # lineage entry of its own until this loop gives it one.
    for src, d in list(lineage.items()):
        for r in d["reads"]:
            lineage.setdefault(r, {"reads": [], "read_by": []})["read_by"].append(src)

    relations = [{"from": vid[a], "fromColumn": ca, "to": vid[b], "toColumn": cb,
                  "relation": '("{}"."{}")=("{}"."{}")'.format(a, ca, b, cb)}
                 for a, ca, b, cb in FKS]
    js(out / "views.json", {"views": views,
                            "folders": ["Data", "Queries", "Reports", "System"],
                            "pullFailed": [vid.get("Unreadable_Query")]})
    js(out / "schema.json", {"tables": schema, "relations": relations})
    js(out / "lineage.json", lineage)
    js(out / "sql" / "index.json", sqlindex)
    now = "2026-08-07T10:00:00.000Z"
    js(out / ".zoost.json", {"workspace": "99000001", "name": "Sample workspace",
                             "label": "Sample workspace", "host": "analytics.zoho.eu",
                             "lastPull": now})
    return views, vid, relations, lineage


# ---------------------------------------------------------------------------------------------
# The graphData payloads - what the panel puts in chrome.storage for the diagram window
# ---------------------------------------------------------------------------------------------
def graph_crm(index):
    nodes = {}
    for ns, name, cat, params in FUNCS:
        fid = ns + "." + name
        nodes[fid] = {"id": fid, "name": name, "display_name": name, "namespace": ns,
                      "category": cat, "calls": list(CALLS.get(fid, [])), "called_by": [],
                      "params": [{"name": p, "type": "string"} for p in params],
                      "return_type": "void" if not params else "map",
                      "rest": name in ("exportCsv", "openTicket"),
                      "dead_suspect": False,
                      "unresolved": UNRESOLVED.get(fid, []), "ambiguous": AMBIGUOUS.get(fid, [])}
    for i, (mod, name, fn, sched) in enumerate(WORKFLOWS):
        wid = "wf:" + str(4000 + i)
        nodes[wid] = {"id": wid, "name": name, "display_name": name, "namespace": mod,
                      "category": "workflows", "calls": [fn] if fn else [], "called_by": [],
                      "params": [], "return_type": "", "rest": False,
                      "dead_suspect": False, "unresolved": [], "ambiguous": []}
    for i, (name, fn, rec) in enumerate(SCHEDULES):
        sid = "sch:" + str(5000 + i)
        nodes[sid] = {"id": sid, "name": name, "display_name": name, "namespace": "schedules",
                      "category": "schedules", "calls": [fn], "called_by": [], "params": [],
                      "return_type": "", "rest": False, "dead_suspect": False,
                      "unresolved": [], "ambiguous": []}
    for c, lbl, users in CONNECTIONS:
        cid = "conn:" + c
        nodes[cid] = {"id": cid, "name": lbl, "display_name": lbl, "namespace": "connections",
                      "category": "connections", "calls": [], "called_by": [], "params": [],
                      "return_type": "", "rest": False, "dead_suspect": False,
                      "unresolved": [], "ambiguous": []}
        for u in users:
            if u in nodes:
                nodes[u]["calls"].append(cid)
    for n in nodes.values():
        for c in n["calls"]:
            if c in nodes:
                nodes[c]["called_by"].append(n["id"])
    for n in nodes.values():
        n["dead_suspect"] = not n["called_by"] and n["category"] not in ("workflows", "schedules")
    edges = sum(len(n["calls"]) for n in nodes.values())
    return {"kind": "calls", "nodes": nodes, "edges": [], "focus": None, "depth": 2,
            "counts": {"nodes": len(nodes), "edges": edges,
                       "dead_suspects": sum(1 for n in nodes.values() if n["dead_suspect"]),
                       "unresolved": 0},
            "workspace": {"instance": INSTANCE, "org": ORG, "label": "Sample org"}}


def graph_crm_schema():
    nodes = {}
    for api, label, cat in MODULES:
        if api == REFUSED:
            nodes[api] = {"id": api, "name": api, "api_name": api, "display_name": label,
                          "namespace": cat, "category": cat, "fields": [], "layouts": [],
                          "related_lists": [], "calls": [], "called_by": [],
                          "dead_suspect": False, "unresolved": [], "ambiguous": [],
                          "unreadable": {"status": 400, "code": "INVALID_MODULE",
                                         "at": "2026-08-07T10:00:00.000Z",
                                         "message": "operation cannot be performed for hidden module"}}
            continue
        fields = [{"api_name": a, "data_type": t, "mandatory": m, "lookup": None}
                  for a, t, m in FIELD_POOL[:6]]
        for target in LOOKUPS.get(api, []):
            fields.append({"api_name": target[:-1] + "_Ref", "data_type": "lookup",
                           "mandatory": False, "lookup": target})
        nodes[api] = {"id": api, "name": api, "api_name": api, "display_name": label,
                      "namespace": cat, "category": cat, "fields": fields,
                      "layouts": [{"id": 1, "name": "Standard", "visible": True}],
                      "related_lists": [], "calls": list(LOOKUPS.get(api, [])), "called_by": [],
                      "dead_suspect": False, "unresolved": [], "ambiguous": []}
    for n in nodes.values():
        for c in n["calls"]:
            if c in nodes:
                nodes[c]["called_by"].append(n["id"])
    edges = sum(len(n["calls"]) for n in nodes.values())
    return {"kind": "schema", "nodes": nodes, "edges": [], "focus": None, "depth": 2,
            "counts": {"nodes": len(nodes), "edges": edges, "dead_suspects": 0, "unresolved": 0},
            "workspace": {"instance": INSTANCE, "org": ORG, "label": "Sample org"}}


def graph_analytics(views, vid, relations, lineage):
    byid = {v["VIEW_ID"]: v for v in views}
    nodes = {}
    for v in views:
        if v["VIEW_TYPE"] not in ("Table", "QueryTable"):
            continue
        i = v["VIEW_ID"]
        cols = [c for t, c in [(a, ca) for a, ca, b, cb in FKS if a == v["VIEW_NAME"]]]
        fields = []
        for name, colset in TABLES + [(q[0], []) for q in QUERIES]:
            if name != v["VIEW_NAME"]:
                continue
            for c in (colset or ["Col_1", "Col_2", "Col_3"]):
                tgt = next((vid[b] for a, ca, b, cb in FKS
                            if a == v["VIEW_NAME"] and ca == c), None)
                fields.append({"api_name": c, "data_type": "BIGINT" if c.endswith("_Id") else "PLAIN",
                               "mandatory": False, "lookup": tgt})
        nodes[i] = {"id": i, "name": v["VIEW_NAME"], "api_name": v["VIEW_NAME"],
                    "display_name": v["VIEW_NAME"],
                    "namespace": "query" if v["VIEW_TYPE"] == "QueryTable" else "table",
                    "category": v["VIEW_TYPE"], "system": bool(v.get("SYSTEM")), "fields": fields,
                    "joins": [], "calls": [], "called_by": [],
                    "dead_suspect": False, "unresolved": [], "ambiguous": []}
    for r in relations:
        a, b = r["from"], r["to"]
        if a in nodes and b in nodes:
            nodes[a]["calls"].append(b)
            nodes[b]["called_by"].append(a)
            nodes[a]["joins"].append({"direction": "out", "column": r["fromColumn"], "other": b,
                                      "otherName": byid[b]["VIEW_NAME"],
                                      "otherColumn": r["toColumn"], "relation": r["relation"]})
            nodes[b]["joins"].append({"direction": "in", "column": r["toColumn"], "other": a,
                                      "otherName": byid[a]["VIEW_NAME"],
                                      "otherColumn": r["fromColumn"], "relation": r["relation"]})
    for n in nodes.values():
        n["dead_suspect"] = not n["calls"] and not n["called_by"]
    edges = sum(len(n["calls"]) for n in nodes.values())
    return {"kind": "schema", "nodes": nodes, "edges": [], "focus": None, "depth": 2,
            "counts": {"nodes": len(nodes), "edges": edges,
                       "dead_suspects": sum(1 for n in nodes.values() if n["dead_suspect"]),
                       "unresolved": 0},
            "workspace": {"name": "Sample workspace", "id": "99000001",
                          "label": "Sample workspace"}}


def main():
    index, mods = build_crm(ROOT / "crm" / "{}-{}".format(INSTANCE, ORG))
    views, vid, relations, lineage = build_analytics(ROOT / "analytics" / "sample-workspace")
    js(ROOT / "graph-crm-calls.json", graph_crm(index))
    js(ROOT / "graph-crm-schema.json", graph_crm_schema())
    js(ROOT / "graph-analytics.json", graph_analytics(views, vid, relations, lineage))
    print("CRM        : {} functions, {} modules, {} workflows, {} schedules, {} connections".format(
        len(FUNCS), len(MODULES), len(WORKFLOWS), len(SCHEDULES), len(CONNECTIONS)))
    print("Analytics  : {} views ({} tables, {} query tables, {} reports, {} dashboards), {} relations".format(
        len(views), len(TABLES), len(QUERIES), len(REPORTS), len(DASHBOARDS), len(relations)))
    print("graphData  : graph-crm-calls.json, graph-crm-schema.json, graph-analytics.json")


if __name__ == "__main__":
    main()
