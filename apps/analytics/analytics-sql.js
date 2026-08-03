/*
 * analytics-sql.js — what Zoho Analytics' query-table SQL actually allows.
 *
 * This is a guardrail, and it is the one piece of this extension that is not derived from the user's
 * own workspace. Every line below is taken from Zoho's published documentation, cited at the bottom.
 * Nothing here is written from experience or inferred from a capture: an assistant told that a
 * function exists will happily use it, and the user only finds out when Analytics refuses the query.
 * If a rule cannot be sourced, it is left out rather than guessed — an incomplete reference is
 * recoverable, an invented one is not.
 *
 * Used in three places, which is why it is a file of its own rather than a string in one of them:
 * the AI system prompt, the options page (so the user can read what the model is being told), and
 * the Markdown export (so any other agent given that file has the same constraints).
 *
 * Zoost never runs, validates or deploys SQL. Whatever comes out is a draft for the user to paste
 * into Analytics, which is the only thing that can say whether it compiles.
 */
window.ZOHO_ANALYTICS_SQL = {
  sources: [
    'https://www.zoho.com/analytics/help/query-tables.html',
    'https://help.zoho.com/portal/en/kb/analytics/knowledge-base/data-modeling-preparation/query-tables-for-data-preparation-1/articles/what-are-the-sql-dialects-supported-by-zoho-analytics',
  ],
  rules: [
    'Query tables accept **SELECT only**. No DDL and no DML — no CREATE, INSERT, UPDATE or DELETE.',
    'Dialects accepted: ANSI, Oracle, SQL Server, IBM DB2, MySQL, Sybase, Informix, PostgreSQL. **ANSI is the one Zoho recommends** and the one to write unless the user asks otherwise.',
    'Table and column names are quoted with **double quotes**, and must be whenever they contain a space or any special character — e.g. `SELECT "Order A"."Customer ID" FROM "Order A"`.',
    'Supported clauses: SELECT [DISTINCT | ALL], FROM, WHERE, GROUP BY, HAVING, ORDER BY [ASC | DESC], LIMIT. Joins: INNER JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN. UNION is supported.',
    'WHERE operators: `=`, `<`, `>`, `<=`, `>=`, `!=`, LIKE, NOT LIKE, BETWEEN.',
    '**Correlated sub-queries are not supported** — a sub-query inside the WHERE clause that references the outer query will not run.',
    '**Only non-recursive CTEs**, at most **3 per query**. A CTE may not contain a sub-query, may not be combined with PIVOT/UNPIVOT, and may not recurse.',
    'A query table may be built on another query table to a maximum of **3 levels**.',
    '`SELECT *` is discouraged for performance; name the columns.',
    'Zoho provides in-built function families — Logical, Aggregate, Tabular, String, Mathematical, Date, Duration and Business. The list shown under "Insert SQL Functions" in the Analytics UI is the set guaranteed to work; anything outside it may or may not be accepted, so prefer the listed ones and tell the user when you have used something you cannot vouch for.',
  ],
  // One block, for a system prompt or a Markdown file.
  text() {
    return 'Zoho Analytics query-table SQL — constraints (from Zoho documentation):\n'
      + this.rules.map((r) => '- ' + r.replace(/\*\*/g, '')).join('\n')
      + '\nSources: ' + this.sources.join(' , ')
      + '\nZoost does not run, validate or deploy SQL. Anything you write is a draft for the user to paste into Analytics.';
  },
  markdown() {
    return '## Zoho Analytics SQL — what query tables allow\n\n'
      + '> Taken from Zoho’s documentation, not from experience. Zoost never runs, validates or deploys SQL.\n\n'
      + this.rules.map((r) => '- ' + r).join('\n')
      + '\n\nSources:\n' + this.sources.map((u) => `- <${u}>`).join('\n') + '\n';
  },
};
