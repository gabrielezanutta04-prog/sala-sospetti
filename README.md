# Sala Sospetti — prototipo

Gioco di deduzione stile Among Us, solo a pulsanti (nessuna mappa): ognuno gioca
dal proprio telefono nella stessa stanza fisica.

Stato attuale: **prototipo front-end in un solo file** (`index.html`), senza backend.
Il pannello "Simulatore" a destra finge gli altri giocatori e il server; nel sito
vero va rimosso e sostituito da una comunicazione reale tra i telefoni.

## Come provarlo
Apri `index.html` nel browser (doppio clic basta, non servono server né build).

## Schermate
1. **Home** — nome del giocatore, "Crea stanza" (diventi host) o "Entra" con codice a 5 caratteri.
2. **Sala d'attesa** — lista giocatori, codice stanza con Copia, numero task scelto dall'host (campo libero, minimo 1), tasto **Start** solo per l'host (minimo 3 giocatori).
3. **Rivelazione ruolo** — Civile o Assassino, con le istruzioni; unico momento in cui il ruolo è visibile.
4. **Partita** — pulsanti rotondi **Report** (sempre) ed **Emergency meeting** (ogni 10 min, timer condiviso), riquadro task con spunta → timer 2 min → nuova task, tasto **Sono morto** (uscita dalle votazioni, irreversibile), tasto **Esci** nella barra in alto (con conferma).
5. **Riunione** — voto per eliminare (non ci si vota da soli, c'è "Salta il voto", parità = nessuno eliminato); l'esito mostra il ruolo dell'eliminato per 8 s, poi si torna in partita.
6. **Fine partita** — "I civili hanno vinto" / "Gli assassini hanno vinto", ruoli di tutti svelati, 10 s e si torna in sala d'attesa.

In tutte le schermate della stanza c'è la **barra verde** delle task, condivisa, che cresce con le spunte di chiunque (assassini compresi).

## Regole implementate
- Traguardo barra = ⌈ civili × numero scelto dall'host ÷ 2 ⌉, fissato allo Start.
- Civili vincono se: barra piena **oppure** nessun assassino vivo.
- Assassini vincono se: assassini vivi ≥ civili vivi (controllato dopo ogni votazione, "Sono morto", uscita).
- Assassini: 1 di default (2 selezionabile dal simulatore; da portare in sala d'attesa).
- **Uccidi** (solo assassini): tasto con 5 min di attesa a inizio partita, dopo ogni uso e dopo ogni riunione. Non segna nessuno: fa solo partire il timer; la vittima preme "Sono morto".
- Il riquadro Uccidi è **nascosto** e si mostra/nasconde con una **pressione lunga (~0,65 s) sulla barra in alto**; per i civili lo stesso gesto non fa nulla, così le schermate sono identiche. Torna nascosto a ogni riunione.
- Nessun indizio sul ruolo fuori dalla schermata di assegnazione (tranne esito votazione e fine partita).
- Chi esce: sparisce da lista e voti; se era host, il ruolo passa al giocatore successivo.

## Struttura del codice (`index.html`)
- `<style>`: token colore in `:root` (tema scuro di base, chiaro via `prefers-color-scheme` / `data-theme`).
- Costanti in testa allo script: `COOLDOWN` (Emergency 10 min), `TASK_MS` (2 min), `KILL_CD` (5 min), `RESULT_MS`, `END_MS`, `MIN_PLAYERS`, `TASKS_DEFAULT`, `LONG_PRESS_MS`, lista `TASKS` (testi di esempio).
- `S` = stato unico della partita (`fresh()` lo crea). Tutto ciò che è "condiviso" (giocatori, barra, timer Emergency, riunione) è ciò che dovrà vivere sul server.
- `A` = azioni (handler dei `data-act` dei pulsanti); quelle con prefisso `sim` appartengono al simulatore.
- `V` = viste, una funzione per schermata che restituisce HTML; `render()` le monta.
- `tick()` ogni 250 ms aggiorna i timer senza ri-renderizzare tutto.
- Simulatore: `renderSim()` + azioni `sim*` + `autoJoinTick()`. Da eliminare nella versione con backend.

## Prossimi passi suggeriti
- Backend realtime (es. WebSocket / Firebase / Supabase Realtime) per stanze, giocatori, barra, timer condivisi e votazioni.
- Spostare la scelta del numero di assassini in sala d'attesa.
- Testi definitivi delle task.
- Nome definitivo del gioco ("Sala Sospetti" è provvisorio).
