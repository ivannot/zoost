# Privacy-critical report logic has one boundary

The two side panels each kept the problem-report redactor, report builder and bounded status buffer
inside their orchestration file. The implementations were byte-identical, but their location made a
privacy-sensitive change compete with workspace, pull and DOM code. The function and view list
models were already separate, but their accepted rows, filters and callbacks were implicit.

Each extension now ships its own `report.js`, loaded as a readable classic script before the panel.
No runtime code is shared between products and no build step was added. The panel tests locate the
report declarations through the page's script composition, and the Worker comparison reads the new
owner directly. CRM `sidepanel.js` fell from 7,272 to 7,132 lines and Analytics from 3,572 to 3,432.

`report.js`, `list-model.js`, and the already separated workspace, navigation and search-state
modules now opt into `@ts-check`. JSDoc contracts describe the problem-report whitelist, list rows,
filter options, sort keys, dependency facts and callback boundaries. TypeScript was run as a
temporary no-emit check over each app's two touched pure modules in its own classic-script scope; it
produced no diagnostics, while the shipped extensions remain dependency-free plain JavaScript.

The extraction also made two derived surfaces speak: the site file count moved to 26 CRM scripts and
21 Analytics scripts, and a checker whose number vocabulary stopped at 25 could not recognise the
correct new sentence. Its vocabulary now reaches the tree it is checking. The browser probe then
loaded both composed panels, pulled both samples and opened both diagrams without an exception.

React remains outside the product. The executed pilot already measured about 195 KB of shipped
runtime without replacing filesystem, bridge or state adapters; this tranche obtained the useful
separation and contracts with no runtime cost.

## The rules it left behind

A privacy boundary and a pure decision model own explicit contracts in their own readable script;
the page is the authority for composition, and a framework is added only after a measured pilot
removes more maintenance cost than it introduces.
