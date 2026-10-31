# Sala Sospetti

Gioco di deduzione stile Among Us, solo a pulsanti (nessuna mappa): ognuno gioca
dal proprio telefono nella stessa stanza fisica, senza login.

Il sito è statico: Next.js esportato su GitHub Pages. Le stanze vivono su un Cloudflare Worker,
con un Durable Object per stanza e un WebSocket per telefono. Il telefono non decide nulla:
manda azioni e disegna la vista personale che riceve, che non contiene mai i ruoli altrui.

## Come provarlo
```
npm install
npm run server   # server di stanza su http://127.0.0.1:8787
npm run dev      # sito su http://localhost:3000
```
Poi apri `http://localhost:3000/?server=ws://127.0.0.1:8787`, una scheda per giocatore.

## Prove
- `npm test`: serate intere di agenti contro le regole (`--rapido`, `--seme N` per ricreare un caso).
- `npm run test:rete`: socket veri contro wrangler locale.
- `npm run test:telefoni`: Chrome su più misure e temi, con confronto civile/assassino. Foto in `test/risultati/`.
- `npx --no-install tsc --noEmit --incremental false`: tipi di `app/` e `gioco/`.

`test:rete` e `test:telefoni` usano le stesse porte (8788, 3100): vanno lanciate una alla volta.

## Pubblicazione
- Sito: push su `main`, ci pensa il workflow "Pubblica su Pages". In locale `PAGES_BASE_PATH` va impostato da PowerShell: Git Bash lo riscrive.
- Server: `npx wrangler deploy`. Quando il sito dipende da una novità del server, prima il server e poi il sito.

## Schermate
1. **Home** — nome del giocatore, "Crea stanza" (diventi host) o "Entra" con codice a 5 caratteri.
2. **Sala d'attesa** — lista giocatori, codice stanza con Copia, Condividi e QR, numero task e numero assassini scelti dall'host (task: campo libero, minimo 1, 32 di default), tasto **Start** solo per l'host (minimo 3 giocatori).
3. **Rivelazione ruolo** — Civile o Assassino, con le istruzioni; unico momento in cui il ruolo è visibile.
4. **Partita** — pulsanti rotondi **Report** (sempre) ed **Emergency meeting** (ogni 10 min, timer condiviso), riquadro task con spunta → timer 2 min → nuova task, tasto **Sono morto** (uscita dal gioco, irreversibile), tasto **Esci** nella barra in alto (con conferma).
5. **Riunione** — voto per eliminare (non ci si vota da soli, c'è "Salta il voto", parità = nessuno eliminato, anche contro i salti; se i salti sono di più non esce nessuno); l'esito mostra il ruolo dell'eliminato per 8 s, poi si torna in partita.
6. **Fine partita** — "I civili hanno vinto" / "Gli assassini hanno vinto", ruoli di tutti svelati, 10 s e si torna in sala d'attesa.

In tutte le schermate della stanza c'è la **barra verde** delle task, condivisa, che cresce con le spunte di chiunque (assassini compresi).

## Regole implementate
- Traguardo barra = ⌈ civili × numero scelto dall'host ÷ 2 ⌉, fissato allo Start.
- Civili vincono se: barra piena **oppure** nessun assassino vivo.
- Assassini vincono se: assassini vivi ≥ civili vivi (controllato dopo ogni votazione, "Sono morto", uscita).
- Assassini: 1 di default, 2 selezionabile dall'host in sala d'attesa.
- **Uccidi** (solo assassini): tasto con 5 min di attesa a inizio partita, dopo ogni uso e dopo ogni riunione. Il timer è personale per ogni assassino. Non segna nessuno: fa solo partire il timer; la vittima preme "Sono morto".
- Il riquadro Uccidi è **nascosto** e si mostra/nasconde con una **pressione lunga (~0,65 s) sulla barra in alto**; per i civili lo stesso gesto non fa nulla, così le schermate sono identiche. Si nasconde anche con la piccola x nel suo angolo. Torna nascosto a ogni riunione.
- Nessun indizio sul ruolo fuori dalla schermata di assegnazione (tranne esito votazione e fine partita).
- Chi esce: sparisce da lista e voti; se era host, il ruolo passa al giocatore successivo.
- **Missioni segrete** (easter egg): dopo una spunta, una volta su 12 circa, al posto di una task arriva una missione su un altro giocatore connesso, vivo o morto ma non ancora noto a tutti. Vale come una task normale e il ruolo non conta. Se il nominato viene eliminato al voto o esce, torna una task normale.
- **Sono morto** si può premere anche in riunione: chi aveva votato quel giocatore vota di nuovo.
- Chi muore si siede per terra e resta fermo guardando un muro, così si capisce subito; quando si apre una riunione tutti lo sanno, e può alzarsi e guardare in silenzio per il resto della partita. Chi esce col voto non si siede. Chi è fuori non fa più task, non vota e non apre riunioni.
- Voto: chi è senza segnale da 45 s vale come Salta. Per chi è connesso non c'è nessun timer.
- Host: senza segnale da 30 s il ruolo passa al giocatore successivo, che può togliere chi è offline.
- Rientro: dallo stesso browser si riprende il posto da soli. Da un altro browser si rientra scrivendo lo stesso nome, se quel posto è offline da 30 s: a partita in corso è l'unico modo di entrare.

## Struttura del codice
- `gioco/regole.ts`: tutte le regole, funzioni pure sullo stato di una stanza (`entra`, `applica`, `scadi`, `vista`, `computeWinner`). Le costanti sono in testa: `COOLDOWN` (Emergency 10 min), `TASK_MS` (2 min), `KILL_CD` (5 min), `RESULT_MS`, `END_MS`, `OFFLINE_MS`, `ASSENTE_VOTO_MS`, `MIN_PLAYERS`, `TASKS_DEFAULT`, `LONG_PRESS_MS`, lista `TASKS`.
- `server/stanza.ts`: Worker e Durable Object `Stanza`. Ogni evento carica lo stato, applica le regole, salva e manda a ogni telefono la sua vista. Niente resta in memoria tra un evento e l'altro: l'oggetto può ibernarsi. Una stanza muta da 6 ore si cancella.
- `app/page.tsx`: ingresso, rientro, errori. `app/connessione.ts`: socket, riconnessioni, memoria locale. `app/schermate.tsx`: tutte le schermate. `app/stile.css`: token colore in `:root` (tema scuro di base, chiaro via `prefers-color-scheme` / `data-theme`).
- `test/`: `serata.ts` e `agenti.ts` (regole), `rete.ts` (server), `telefoni.ts` (sito).

## Prossimi passi suggeriti
- Testi definitivi delle task.
- Nome definitivo del gioco ("Sala Sospetti" è provvisorio).
