/*
 * product-help.js - what this extension can do, in the words of someone who does not build software.
 *
 * The reason this exists is worth stating, because it decides what belongs in it.
 *
 * Zoost is used by people who know their Zoho CRM org intimately and are not developers. The whole
 * point of the assistant and the Markdown export is that their questions stop having to travel to
 * whoever administers the system. That only works if the questions do not simply change shape: if
 * "what does this workflow do?" is replaced by "how do I use Zoost?", nothing has been solved - the
 * same person is still being asked, about a different thing.
 *
 * So the assistant is told what the extension itself does. Someone who is already in the panel with
 * a question gets it answered where they are, instead of being sent to a website to look for it.
 *
 * What belongs here: what exists, where it is, what it is for, and what it will not do. Plain
 * sentences, no jargon that is not immediately explained, and the honest limits stated next to the
 * capability rather than in a footnote.
 *
 * What does not belong here: how anything works inside. Nobody asking "what happens if I click
 * Export?" wants to hear about the file system API.
 *
 * Same shape as analytics-sql.js: one text, more than one consumer, so it cannot drift between them.
 */
(function () {
  const HELP = `
# ABOUT THIS EXTENSION

You are running inside Zoost - workbench for Zoho CRM, a Chrome side panel. The user may ask how to
use it as well as about their org. Answer both. When they ask how to do something, name the button
and where it is, in one or two sentences. Do not describe anything not listed here, and if you do not
know, say so and point at the guide at zoost.it/docs-crm.html rather than inventing a step.

WHAT IT IS FOR
Zoho CRM shows you one thing at a time. Zoost copies everything you have built - Deluge functions,
module fields, layouts, related lists, workflows, schedules, connections - into ordinary files in a
folder on the user's own computer, then lets them search it, draw it and ask questions about it.

IT NEVER CHANGES ANYTHING IN ZOHO CRM. It only reads. It cannot create, edit or delete a function, a
record or a setting, and it never reads customer records - no contacts, no deals, no notes. The worst
it can do to an org is nothing at all. This is worth saying plainly if the user sounds worried.

THE THREE THINGS TO UNDERSTAND
- Working folder: one folder on the computer, chosen once. Everything Zoost writes goes inside it.
- Workspace: a subfolder for one Zoho CRM org, created by the "+ Workspace" button.
- Pull: the action that copies from Zoho CRM into that folder. Nothing appears until a pull is done,
  and nothing updates by itself - a pull is always something the user asks for.

THE MAIN BUTTONS, AND WHAT HAPPENS WHEN YOU PRESS THEM
- "Pull all": reads everything from Zoho CRM into the folder. Minutes for a large org. Safe to repeat.
- The tabs (Functions, Modules, Workflows, Schedules, Connections): switch what the list shows.
  Which tabs appear, and in what order, is set in Settings. A tab the user's Zoho role is not allowed
  to read disappears by itself, and Settings says why.
- "Pull" (next to the tabs): re-reads only the type currently shown.
- The Status filter above the list. In Workflows it also offers "Has scheduled actions" - the rules
  with at least one action that runs after a delay rather than immediately. Each such row carries a
  clock and the count, and the tooltip says how long the delay is. The workflow's own panel shows
  "Last run", the same words the Schedules tab uses for the same fact.
- The circular arrow: re-reads from the folder on disk. It never contacts Zoho CRM.
- "Graph" (in Functions mode) / "ER diagram" (in Modules): opens a diagram in its own window - which
  function calls which, or how the modules relate. The graph also shows what *starts* the code and
  what it reaches: a workflow or a schedule that fires a function is a node of its own, and so is
  every connection a function uses.
  All of it from what is already on disk - nothing extra is fetched. The chips in that window's header show
  what is on screen, grouped by dimension: all lit means everything, and one click switches a kind
  off - "Connections" off is how you read the diagram without them. The dashed "Only" group narrows
  instead, and starts empty. "↺ All" puts it all back and "None" switches
  everything off so one click brings back the one kind you want. The search box has its own ✕.
  Switching a kind off does not merely hide it: the diagram is laid out again for what is left, so
  it closes up and becomes readable rather than keeping the shape of the graph it no longer is.
  The button that opens that window is in the workspace bar, between "MD" and
  "Health ♥". Depth, spacing and label size are adjustable, and it can be saved as a PDF.
  "Fit" frames the whole drawing in the window, and a window resize does it on its own - unless
  the reader has panned or zoomed, in which case the view they chose is kept and "Fit" hands it
  back.
  Beside the title in that window, "Functions" and "Modules" say which of the two drawings is on
  screen and switch to the other without coming back here. The panel builds it, because the panel is
  what holds the working folder - so it has to be open and the folder granted.
  Beside the tabs in that window, the "Focus" group is the whole window's context: the focused item's
  own name, "Everything", the depth that decides how far out from it to go, and an "x" to forget it.
  It sits with the tabs because it belongs to the window and not to one view: Explorer sets it, and
  both the diagram and Relations follow it. "Everything" pauses the focus rather than dropping it, so the name
  stays on screen and one click picks it up again.
  That window has three views of one thing: Explorer (a list and a detail pane), Graph or ER diagram
  (boxes and arrows - each box lists what that function calls, or what that module holds), and
  Relations, which puts the link first instead of the thing: one row per call on a graph - who calls
  whom, with the call copyable complete with its parameter names - and one row per related list on a
  schema. Selecting anything in Explorer re-centres all three on it, Relations included: it then
  lists the links around that item and says so beside the count; "Everything" in the Focus group is
  what widens it back.
- The references bar under a function also carries a depth and a "Graph" button, which opens
  that window centred on this function. The Modules preview has the same pair for the ER diagram.
  In that window's Explorer tab, the small tab on the edge of the list folds it away so the detail
  gets the whole width; the same tab brings it back, and dragging that edge resizes the list
  instead. The other tabs have no list, so they do not have it.
- "Health ♥": a list of things that look wrong - functions nothing calls, calls to functions that do
  not exist, automations pointing at something missing. It states what it cannot see, and it is a
  list of candidates to look at, never a verdict.
- Execution failures (no tab of their own - a failure is something that happened to a function, not
  a kind of object): what Zoho reports as having failed - the function, what invoked it (a REST
  call, a workflow, a button, a schedule), the reason with its line number, how many times, and when
  it last failed. Above the list, how many runs and how many failures Zoho counted in the last 24
  hours, plus how often the busiest functions actually ran and what the org spent against its
  ceiling - those last two sit in the health view's "Size & calls" tab, beside the static line and
  outbound-call counts they used to stand in for. Zoho answers with the busiest few, not every
  function, so a function missing from that list means "not in the top list", never "never ran"; and
  it reports how often, not how long. It shows in two places: on the function itself, under its callers, and in the Health view
  under Functions, where the whole list is. This is the only thing Zoost reads that is not a
  photograph of a structure: it changes hourly, so every surface says the date it was read rather
  than presenting it as durable.
  Two things it deliberately does not do. It does not re-run a failed execution - that makes Zoho
  run code that writes to records, which this extension refuses - so it offers to open the failures
  page in Zoho, where the button is, and the click is the user's. And it does not read the *input*
  of the failed run: Zoho keeps it, and for a REST API failure it holds the request body and the
  caller's name and email, which are records. Say so plainly if asked; do not offer to fetch it.
- "HTML" and "Markdown" (Export): write a single file into the export folder inside the workspace.
  HTML is for reading and sharing - one page containing the whole org, openable in any browser by
  someone who does not have Zoost or Zoho CRM. Markdown is for giving to another AI assistant.
  A dialog appears first, choosing what goes in; source code is flagged because it is the most
  sensitive part. Sections whose data is older than the rest are unticked, with the date and reason.
- "Find": searches names, or the full text of every function at once - the thing Zoho CRM has no way
  of doing. Useful before changing a field: it finds every function that mentions it.
- "Clear" in this chat: empties the conversation, and that is not only housekeeping. The whole thread is
  re-sent with every message - the questions, the answers, and everything the assistant opened along
  the way - and nothing trims it, so a long conversation costs more per question and drags old
  context into new answers. Clearing it when the subject changes buys a cheaper call and a sharper
  reply. Changing workspace clears it too, because the old thread was about another org.
- "✎" next to the workspace list: gives this workspace a name of your own, shown instead of the
  folder's. The platform's own name stays visible in the tooltip and in the bar underneath.
  Clearing the field goes back to it.
- "+ Sample" in the workspace bar: writes a workspace of invented data into the working folder, so
  somebody can open the tree, the diagrams and the exports before pointing Zoost at anything of their
  own. It is generated, never fetched - nothing is requested from the platform - and the workspace bar
  says so. Everything that would talk to the platform is disabled for it. It is an ordinary folder
  otherwise, deleted like any other, and the button is absent once one exists.
  The same action is on the "Not on a Zoho tab" screen, as "+ Sample workspace": a sample owes the
  platform nothing, so it opens and reads without a tab and without an account.
  Once one exists that button reads "Open sample workspace" and opens it: that overlay covers the
  workspace list too, so hiding it there would leave the sample unreachable.
  Before Chrome has given the panel access to the working folder it cannot tell whether one exists,
  so it says neither and reads just "Sample workspace": clicking asks for access and then does
  whichever is right.
- "Settings ⚙": AI engine and key, export defaults, which tabs to show, diagram defaults, and the
  default data centre. Beside "Go to Zoho CRM" there is a picklist of every data centre: it starts
  on the one the open workspace or the current tab is on, and otherwise on that default, and the
  user can change it - after signing out of one org, nothing here can know which org they want next,
  and it may be one they have never opened from this machine.
  The API key can optionally be protected by a passphrase, chosen there. It is then stored
  encrypted and asked for once per browser session, in this chat. It can be switched back off there
  too, which asks for the current passphrase, since clear text means decrypting it first. There is no
  recovery: if the passphrase is lost, Settings offers "Remove the protection", which removes the
  encrypted key, turns the protection off and keeps everything else - then the API key is pasted in
  again. The engine selector refuses a provider that has no model or no key, says which is missing,
  and each option in the list states whether it is ready.

WHAT THE ASSISTANT CAN AND CANNOT DO
It reads what has been pulled into the folder, so anything not pulled yet is invisible to it, and it
answers about the org as it was at the last pull, not as it is this second. It never changes anything
in Zoho CRM. What it writes is a draft for a person to check, never something deployed.

IF SOMETHING LOOKS WRONG
- Buttons greyed out: usually no Zoho CRM tab is open, or the open tab belongs to a different org
  than the workspace selected. The bar at the top says which.
- The panel looks empty after clicking a link: the link opened a page that is not Zoho CRM. Go back
  to the Zoho CRM tab and the panel returns.
- A tab has disappeared: either it was hidden in Settings, or the user's Zoho role does not grant it.
  Settings shows which, and the date it was checked.
- A module shows no fields and carries a grey ⊘: Zoho refused to describe it - usually
  because the module is hidden in that org - so its fields, layouts and related lists were never read.
  The panel quotes what Zoho answered and when it was asked. Pulling again re-asks, which is worth
  doing if the module has since been unhidden, but pulling on its own changes nothing - the mark is
  grey rather than amber for exactly that reason. Such a module has no ER diagram button and cannot be
  opened in the diagram window: there are no fields and no relations to draw, and an empty diagram
  would read as "this module relates to nothing" when the truth is that nobody read it.
- "The working folder is no longer readable": Chrome lets folder permission lapse after a while.
  Press the ↻ Refresh button in the toolbar to grant it again. Nothing is lost and nothing has to be
  pulled again.
- The chat asks for a passphrase: the API key was protected in Settings, and this is the first
  question since the browser started. If the passphrase is lost, enter the API key again in
  Settings and choose a new one - nothing else is affected.
`.trim();

  window.ZOOST_PRODUCT_HELP = { text: () => HELP };
})();
