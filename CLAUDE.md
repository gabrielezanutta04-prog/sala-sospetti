# Istruzioni per Claude Code

Progetto: gioco stile Among Us a soli pulsanti, per telefoni nella stessa stanza. Leggi `README.md`
per schermate, regole già decise, struttura del codice, prove e pubblicazione.

- Lingua dell'interfaccia e dei commenti: italiano.
- Le regole stanno solo in `gioco/regole.ts`: il server le applica, il sito disegna la vista che riceve.
- Non cambiare le regole di gioco elencate nel README senza che vengano chieste.
- Le schermate di civili e assassini devono restare identiche a meno che l'assassino
  non abbia reso visibile il riquadro Uccidi con la pressione lunga.
- Il repository è pubblico: niente dati personali, token o percorsi locali nei file versionati.
- Prima di consegnare: `npm test`, `npm run test:rete`, `npm run test:telefoni` e il controllo dei tipi
  indicato nel README, con prova a 400 px di larghezza (è compresa nelle misure di `test:telefoni`).
