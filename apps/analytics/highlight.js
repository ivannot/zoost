/* highlight.js - minimal SQL highlighter for the query text Zoho Analytics returns.
 * Tokenizes the RAW source and HTML-escapes each piece, so it is injection-safe.
 * window.highlightSql(code) -> HTML string.
 *
 * **It colours only what can be established by reading.** Comments, strings, quoted identifiers,
 * numbers and a fixed list of keywords - and nothing else. No parser, no table-name resolution, no
 * guess at which dialect a fragment belongs to: the panel's promise about SQL is that it shows you
 * what Zoho Analytics holds, not that it understands it, and a highlighter that pretends otherwise
 * would be the first thing here to claim more than it can check. «Better one highlight less than one
 * that is wrong» - the author, agreeing to exactly that trade.
 *
 * The twin is the CRM's `highlightDeluge`: same shape, same escaping, same colour classes, so the
 * two products' code panes look like one product. What differs is the vocabulary, which is the only
 * thing that should.
 */
(function () {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Reserved words, kept to what Zoho Analytics' own documentation lists for query tables plus the
  // ANSI core every dialect shares. Deliberately short: a word coloured as a keyword when it is a
  // column name is a highlight that is wrong, and this file's whole argument is against those.
  const KW = [
    'select', 'from', 'where', 'group', 'by', 'having', 'order', 'asc', 'desc', 'limit', 'offset',
    'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'using', 'union', 'all',
    'intersect', 'except', 'distinct', 'as', 'and', 'or', 'not', 'in', 'exists', 'between', 'like',
    'ilike', 'is', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'with',
    'over', 'partition', 'window', 'rows', 'range', 'preceding', 'following', 'unbounded', 'current',
    'row', 'cast', 'interval', 'values', 'into', 'insert', 'update', 'delete', 'set', 'create',
    'table', 'view', 'index', 'drop', 'alter', 'primary', 'key', 'foreign', 'references', 'default',
    'unique', 'check', 'constraint', 'if', 'coalesce', 'nullif',
  ].join('|');

  // Aggregates and the handful of scalar functions that are keywords in every dialect. A name
  // followed by `(` that is not one of these is left alone: it may be a user function, and colouring
  // it would be asserting something about a dialect nobody here has read end to end.
  const FN = [
    'count', 'sum', 'avg', 'min', 'max', 'round', 'floor', 'ceil', 'abs', 'length', 'lower', 'upper',
    'trim', 'substring', 'concat', 'now', 'current_date', 'current_timestamp', 'extract', 'date',
    'year', 'month', 'day', 'hour', 'minute', 'second', 'row_number', 'rank', 'dense_rank',
  ].join('|');

  const RE = new RegExp(
    '(--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' +                 // 1 comments: -- to end of line, /* … */
    "|('(?:[^']|'')*')" +                                  // 2 strings, with '' as the escape SQL uses
    '|("(?:[^"]|"")*")' +                                  // 3 quoted identifiers - what Zoho writes
    '|\\b(\\d+\\.?\\d*)\\b' +                              // 4 numbers
    '|\\b(' + FN + ')\\b(?=\\s*\\()' +                     // 5 known functions, only when called
    '|\\b(' + KW + ')\\b',                                 // 6 keywords
    'gi'
  );

  window.highlightSql = function (code) {
    let out = '', last = 0, m;
    RE.lastIndex = 0;
    while ((m = RE.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += `<span class="c-com">${esc(m[0])}</span>`;
      else if (m[2]) out += `<span class="c-str">${esc(m[0])}</span>`;
      // A quoted identifier is a name, not a string: in a Zoho Analytics query almost every table and
      // column is one, and painting them all as strings would leave the query one colour. They get
      // the type colour, which is what the CRM uses for the things a language names rather than
      // computes.
      else if (m[3]) out += `<span class="c-type">${esc(m[0])}</span>`;
      else if (m[4]) out += `<span class="c-num">${esc(m[0])}</span>`;
      else if (m[5]) out += `<span class="c-fn">${esc(m[0])}</span>`;
      else out += `<span class="c-kw">${esc(m[0])}</span>`;
      last = RE.lastIndex;
    }
    out += esc(code.slice(last));
    return out;
  };
})();
