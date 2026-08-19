# Scan completo e correzioni — 19 agosto 2026

## Esito

Lo scan è partito da `main` aggiornato al commit `d253360` e ha riguardato il codice consegnato delle
due estensioni, i generatori dei workspace campione, il sito e gli strumenti di verifica. Ho escluso,
come richiesto, il disallineamento delle immagini e il precedente punto 6 relativo a release/tag e
artefatti.

Ho riprodotto e corretto i problemi sotto. Non restano difetti noti emersi da questo scan. Questo non
equivale alla garanzia matematica che non esistano bug: i limiti verificabili sono indicati in fondo.

## Difetti trovati e risolti

### 1. Analytics: `get_relations` per nome non raggiungeva il proprio handler — alta

**Problema.** La precedenza tra `||` e l'operatore ternario assegnava sempre `null` alla vista per
`get_relations`. La chiamata documentata con `{ name: "T1" }` rispondeva `View not found: T1`. La
prova precedente controllava soltanto che uscisse una stringa non vuota, quindi accettava anche la
risposta sbagliata.

**Correzione.** La distinzione è ora soltanto tra tool globali e tool legati a una vista; una ricerca
relazioni con nome risolve davvero la vista. Riferimenti:
[dispatcher](apps/analytics/sidepanel.js#L2129-L2146),
[handler](apps/analytics/sidepanel.js#L2212-L2215),
[test semantico](tests/panel.test.mjs#L7057-L7111).

### 2. Analytics: un file SQL assente o illeggibile risultava comunque “cercato” — alta

**Problema.** La presenza della riga in `sql/index.json` veniva confusa con la riuscita apertura del
file `.sql`. La ricerca full text poteva dichiarare di avere cercato tutte le query, `get_view` poteva
omettere del tutto la sezione SQL e Health/export potevano non mostrare il buco.

**Correzione.** È stato introdotto uno stato condiviso distinto fra non-query, SQL letto e SQL non
letto. Le superfici che hanno bisogno del testo eseguono la verifica asincrona del file. Gli errori di
disco sono visibili in ricerca e Health, vengono contati una volta sola e sono ritentati: un errore
temporaneo non diventa un verdetto permanente della sessione. Un fallimento esplicito del pull vince
invece su un vecchio corpo SQL, evitando di servire testo plausibile ma obsoleto.

Riferimenti:
[lettura e retry](apps/analytics/sidepanel.js#L1204-L1231),
[cache full text e copertura](apps/analytics/sidepanel.js#L1366-L1398),
[stato comune](apps/analytics/sidepanel.js#L1979-L1987),
[Health](apps/analytics/sidepanel.js#L2631-L2640),
[test file mancante](tests/panel.test.mjs#L7114-L7137),
[test conteggio e recupero](tests/panel.test.mjs#L7139-L7170),
[test Health](tests/panel.test.mjs#L7172-L7184).

### 3. Analytics: un pull interrotto durante le scritture lasciava utilizzabile una fotografia ibrida — alta

**Problema.** Il marcatore `.pull-state.json` proteggeva correttamente la riapertura successiva, ma
non il pannello già aperto. Se una scrittura falliva dopo `state: writing`, le vecchie strutture
restavano in memoria mentre alcuni file SQL erano già nuovi; assistente ed export potevano quindi
combinare due momenti diversi.

**Correzione.** Ogni errore successivo al marcatore porta con sé `mirrorIncomplete`; `pullAll()`
svuota immediatamente la fotografia viva e mostra il blocco fino a un nuovo Pull all. Il marcatore
`complete` viene scritto solo dopo dati, indice e pulizia.

Riferimenti:
[blocco della memoria](apps/analytics/sidepanel.js#L876-L880),
[gestione dell'interruzione](apps/analytics/sidepanel.js#L939-L951),
[transazione su disco](apps/analytics/sidepanel.js#L1090-L1123),
[test](tests/panel.test.mjs#L6275-L6296).

### 4. CRM: la pulizia di una funzione rinominata poteva lasciare metadati orfani — media

**Problema.** Sorgente `.dg` e sidecar `.meta.json` erano rimossi nello stesso `try`. Se il primo
veniva eliminato e il secondo falliva, al retry il `NotFound` del sorgente poteva impedire di tentare
nuovamente i metadati. Anche la pulizia del Pull all inghiottiva gli errori e poteva concludersi in
verde con residui sul disco.

**Correzione.** Le due metà sono rimosse indipendentemente, `NotFound` è successo idempotente e viene
accodato l'esatto path non terminato. La stessa funzione è usata dal rename e dal Pull all; i residui
sono riportati e rendono incompleto il verdetto di accesso.

Riferimenti:
[rimozione indipendente](apps/crm/sidepanel.js#L3092-L3113),
[pulizia nel Pull all](apps/crm/sidepanel.js#L2751-L2761),
[test di retry della metà restante](tests/panel.test.mjs#L7017-L7040).

### 5. Analytics: il fallimento della pulizia SQL veniva coperto dal successo finale — media

**Problema.** Se un vecchio `.sql` non poteva essere rimosso, il warning veniva subito sovrascritto
dal messaggio conclusivo del pull. Inoltre `WS_MOVED` poteva essere degradato a normale errore di
cleanup.

**Correzione.** `pruneSql()` restituisce il numero di fallimenti, rilancia il cambio workspace e usa
lo status legato all'operazione. `pullAll()` conserva il conteggio nella fotografia e termina in
warning, non in verde.

Riferimenti:
[cleanup](apps/analytics/sidepanel.js#L1076-L1088),
[propagazione al pull](apps/analytics/sidepanel.js#L934-L937),
[test](tests/panel.test.mjs#L7307-L7320).

### 6. CRM: il confine del workspace non comprendeva tutte le letture di configurazione — alta

**Problema.** I pull catturavano correttamente root e generazione per le scritture, ma diversi
controlli su `.zoost.json` passavano ancora dal resolver globale. Il selettore disabilitato rendeva
la corsa difficile dalla UI, ma il contratto non reggeva a una riattivazione programmatica. Anche
`noteAccess()` pubblicava ottimisticamente in memoria il nuovo verdetto prima che la configurazione
fosse davvero scritta; un errore di disco poteva quindi nascondere una scheda fino alla riapertura.

**Correzione.** Tutti i pull CRM leggono binding e indici tramite la stessa operazione usata per le
scritture. `patchCfg()` legge tramite `opReadCfg(op)` quando riceve un'operazione. Il verdetto di
accesso viene pubblicato soltanto dopo il commit della configurazione e viene scartato se
l'operazione è stata superata.

Riferimenti:
[merge operation-bound](apps/crm/sidepanel.js#L760-L768),
[pubblicazione dopo commit](apps/crm/sidepanel.js#L425-L454),
[Pull funzioni](apps/crm/sidepanel.js#L2733-L2741),
[azioni](apps/crm/automation.js#L376-L388),
[connessioni](apps/crm/connections.js#L8-L24),
[moduli](apps/crm/modules.js#L9-L17),
[test derivato su tutti i pull](tests/panel.test.mjs#L5743-L5760),
[test comportamentale del verdetto](tests/panel.test.mjs#L2984-L2999).

### 7. Documentazione e sample non descrivevano il nuovo protocollo di commit — media

**Problema.** Il codice aveva introdotto `.pull-state.json`, ma il generatore del workspace campione
e le guide EN/IT non lo producevano o descrivevano. Il conteggio pubblico del sample Analytics era
quindi rimasto a 13 file invece dei 14 reali.

**Correzione.** Il sample scrive un marcatore `complete`; decisioni e guide spiegano la semantica
transazionale; le pagine demo, il digest di traduzione e la sitemap derivata sono aggiornati.

Riferimenti:
[sample](apps/analytics/sample-org.js#L224-L231),
[decisione](docs/decisions.md#L53-L58),
[guida EN](site/docs-analytics.html#L183),
[guida IT](site/it/docs-analytics.html#L196),
[conteggio EN](site/try.html#L80),
[conteggio IT](site/it/try.html#L81),
[test del sample](tests/panel.test.mjs#L2604).

### 8. Strumenti di review: file descriptor non chiusi e un id inutile — bassa

**Problema.** `asynccheck.py` apriva i due HTML senza chiuderli, generando `ResourceWarning` durante
la suite. Lo sweep dead-code segnalava inoltre `tab_cols`: l'id non aveva alcun lettore, perché la
scheda Columns è gestita genericamente da classe e `data-tab`.

**Correzione.** La lettura usa un context manager e l'id privo di funzione è stato rimosso.
Riferimenti: [asynccheck](tools/asynccheck.py#L46-L50),
[tab Columns](apps/analytics/sidepanel.html#L539).

### 9. Il vincolo di workspace si perdeva nelle chiamate transitive — alta

**Problema.** Diverse funzioni ricevevano correttamente l'operazione che identifica root e
generazione del workspace, ma chiamavano un secondo loader senza passarla. Quel loader ne creava una
nuova leggendo il workspace visibile in quel momento. Il selettore bloccato durante un pull riduceva
la probabilità dalla UI, ma non proteggeva rebuild, Health, export e assistente, né una riattivazione
programmatica del selettore. Il risultato possibile era una risposta composta con file di due
workspace o pubblicata nel workspace subentrato.

**Correzione.** L'operazione viene ora propagata lungo l'intera catena: moduli, schedule, workflow,
action users, Health, export e strumenti AI di entrambe le estensioni. Anche i messaggi di errore e
il rename verificano di essere ancora nel workspace di partenza. Il test non mantiene una lista
manuale dei caller: deriva le funzioni operation-aware dalle firme e segnala ogni chiamata che perde
`op`. È stato provato rosso rimuovendo intenzionalmente `op` da `rebuildModules(op)`.

Riferimenti:
[moduli CRM](apps/crm/modules.js#L87),
[schedule e action users](apps/crm/automation.js#L13),
[catena AI CRM](apps/crm/ai.js#L182),
[catena AI Analytics](apps/analytics/sidepanel.js#L2057),
[export Analytics](apps/analytics/sidepanel.js#L2553),
[rename Analytics](apps/analytics/sidepanel.js#L2789),
[rename CRM](apps/crm/sidepanel.js#L3793),
[test derivato](tests/panel.test.mjs#L7344).

### 10. Analytics: un errore di lettura globale contaminava il workspace successivo — alta

**Problema.** `readJson()` scriveva ogni errore in un accumulatore globale. Una lettura accessoria
di configurazione poteva così far apparire il workspace seguente come illeggibile; una lettura lenta
superata da un cambio workspace poteva inoltre revocare `rootGranted` nel workspace nuovo.

**Correzione.** La lettura scarta ogni effetto se l'operazione non è più corrente e consegna
l'eventuale errore soltanto al caller che lo ha osservato. `loadFromDisk()` raccoglie localmente i
fallimenti delle quattro parti della propria fotografia e pubblica quel solo verdetto.

Riferimenti:
[lettura isolata](apps/analytics/sidepanel.js#L325),
[caricamento della fotografia](apps/analytics/sidepanel.js#L1164),
[test comportamentale](tests/panel.test.mjs#L3552).

### 11. Analytics: i refresh parziali potevano lasciare memoria e disco in due momenti diversi — alta

**Problema.** `pullOne()` e `retryFailed()` modificavano `sqls`, `deps` e `pullFailed` prima di
scrivere lineage, file SQL e indice. Un disco pieno, un indice illeggibile o un permesso revocato a
metà lasciavano quindi il pannello sul nuovo stato mentre il mirror era solo parzialmente aggiornato.
Inoltre un `sql/index.json` illeggibile veniva degradato al fallback vuoto e poteva essere
sovrascritto, perdendo le righe non coinvolte dal refresh.

**Correzione.** I due flussi costruiscono copie locali, scrivono sotto il marcatore
`.pull-state.json` e pubblicano le globali soltanto dopo il marcatore `complete`. Un fallimento blocca
subito la fotografia viva e richiede Pull all. La lettura non-NotFound dell'indice abortisce la
scrittura invece di trasformarsi in `{}`.

Riferimenti:
[refresh singolo](apps/analytics/sidepanel.js#L974),
[retry](apps/analytics/sidepanel.js#L1020),
[commit parziale](apps/analytics/sidepanel.js#L1091),
[test ordine e marcatore](tests/panel.test.mjs#L6323),
[test indice illeggibile](tests/panel.test.mjs#L6354).

## Verifiche finali

- `658` test Node verdi.
- `240` test Python verdi, `2` skip dipendenti dalla configurazione della macchina.
- `460` test del pannello, compresi i nuovi casi, verdi.
- `twincheck`, `asynccheck`, `sitecheck`, `samplecheck`, `csscheck`, `namecheck`,
  `featurecheck`, `htmlcheck`, `sitemap --check`, `stamp --check`, `notescheck` e sweep dead-code:
  nessun finding.
- Probe in Chrome reale: CRM e Analytics entrambi verdi.
- Packaging Store di entrambe le estensioni riuscito; gli zip temporanei sono stati rimossi.
- Audit del sito pubblico: host, route, URL canonici e file pubblicati sono raggiungibili. I file
  modificati in questo scan differiscono intenzionalmente dal sito live finché non saranno
  committati e distribuiti.
- `imgcheck`: due finding noti (screenshot CRM e Analytics da rigenerare), esclusi su richiesta.

## Limiti residui: cosa non si può stabilire soltanto da questo scan

1. Le fixture e il probe non possono riprodurre tutte le forme e tutti i limiti delle risposte delle
   API Zoho su organizzazioni reali, ruoli diversi, rate limit e data center diversi.
2. Le modifiche al sito non possono risultare uguali al sito pubblico prima del deploy.
3. Non è stata eseguita una sessione manuale autenticata contro un'organizzazione CRM e un workspace
   Analytics reali; il probe usa il workspace campione e verifica il wiring nel browser.

## Stato del lavoro

Le modifiche descritte sono quelle preparate per il commit di questo scan. I tre report precedenti
già non tracciati sono stati lasciati invariati e non fanno parte della consegna.
