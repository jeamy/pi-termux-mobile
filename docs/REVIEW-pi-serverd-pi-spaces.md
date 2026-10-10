# Review: pi-serverd.mjs und pi-spaces.mjs

Stand: Repo `master` (Commit `ac40865`). Analysiert wurden `runtime/pi-serverd.mjs` (252 Zeilen) und `runtime/pi-spaces.mjs` (1472 Zeilen, esbuild-Bundle).

Hinweis: `pi-spaces.mjs` ist ein Bundle ohne Quellcode im Repo. Zeilenangaben beziehen sich auf das Bundle. Korrekturen sollten in der Quelle erfolgen und danach neu gebündelt werden. Es wurden keine Tests oder Proof-of-Concepts ausgeführt; die Befunde beruhen auf dem Lesen des Codes und der Abhängigkeiten.

---

## Hoch

### H1. Cross-Agent-Prompt-Injection über Event-Zustellung

- **Ort:** `pi-spaces.mjs:1206-1215` (`shown`, `describe`), `:1245` (`conv.submit`)
- **Befund:** Felder fremder Einträge werden als `input` in die Konversation eines anderen Agenten eingespeist. Der einzige Schutz ist der Text `[data, not instructions]`.
- `en.type` wird nicht escaped (Zeile 1208). Ein Typ mit `\n` kann eine gefälschte Systemzeile wie `[space] your wait … was served` oder `from the host` vortäuschen. `fields` läuft dagegen durch `JSON.stringify`.
- **Verkettung:** `pi-serverd.mjs:51,55` gibt `process.env` an die Agenten-Ausführung weiter. `pi-serverd.mjs:49` und `~/.pi/agent/auth.json` liegen im selben Benutzerkontext. Ein injizierter Agent mit Shell-Zugriff kann dadurch Secrets lesen und exfiltrieren.
- **Fix:** `type` auf ein enges Zeichenset beschränken (z. B. `[a-z0-9._-]{1,128}`). Fremdinhalt ausschließlich als JSON-String ausgeben. Agenten-Umgebung ohne Server-Secrets starten.

### H2. Dauerhafte Sperren durch Take/Read unter Transaktion

- **Ort:** `pi-spaces.mjs` Tool `space_txn` (Parameter `leaseMs`, `ms("forever")` in Zeile ~1053), `grant`/`until` (Zeile 63), `find` (Locking-Logik)
- **Befund:** `leaseMs: "forever"` ist ohne Obergrenze erlaubt. Ein Agent kann Einträge per `take` unter einer solchen Transaktion sperren und nie committen. Andere `take`s liefern dann `locked` und enden im Timeout.
- `read` unter Transaktion blockiert `take` ebenfalls (`readBy`).
- Begrenzt sind nur 20 Transaktionen pro Owner (`maxTxnsPerOwner`), nicht die Zahl der gesperrten Einträge pro Transaktion.
- **Fix:** maximale Lease-Dauer (z. B. 1 h) auch für `forever`, maximale Zahl Einträge pro Transaktion.

### H3. Speicher-Erschöpfung durch einen einzelnen Agenten

- **Ort:** `pi-spaces.mjs:65` (`DEFAULT_LIMITS`), `:202` (`maxSpaceBytes`-Prüfung)
- **Befund:** `maxEntriesPerOwner` (1000) × `maxEntryBytes` (64 KiB) = 64 MiB = `maxSpaceBytes`. Ein Agent kann den gesamten Space füllen, andere Schreibvorgänge schlagen dann mit `LimitError` fehl.
- Es gibt kein Byte-Kontingent pro Owner und keine Obergrenze für die Zahl der Owner.
- `ttlMs: "forever"` läuft nie ab. Es gibt keinen Reaper für beendete Konversationen.
- **Fix:** Byte-Kontingent pro Owner, Obergrenze für `forever`, Cleanup beim Löschen einer Session (siehe M3).

### H4. Keine Vertraulichkeit zwischen Konversationen (Designfrage)

- **Ort:** Lese-Tools `space_list`, `space_read`, `space_take`, `space_notify`
- **Befund:** Jede Konversation kann alle Einträge im Space lesen und abonnieren. Das ist vermutlich beabsichtigt, muss aber bestätigt werden, falls Agenten Geheimnisse im Space ablegen.

---

## Mittel

### M1. Stiller Verlust von Waitern nach fehlgeschlagener Zustellung

- **Ort:** `pi-spaces.mjs:1264-1290` (`deliverEvents`, `MAX_TRIES`)
- **Befund:** Nach 5 Fehlversuchen wird das Event verworfen. Der Agent erfährt davon nichts, es gibt nur einen Log-Eintrag.
- Bei Take-Waitern wird die Transaktion freigegeben, der Eintrag geht nicht verloren, der Wait ist aber weg.
- **Fix:** Dead-Letter-Eintrag oder Benachrichtigung an den Owner.

### M2. Migration unvollständiger Altdaten

- **Ort:** `pi-spaces.mjs:84` (`migrate`, `waiters: v.waiters ?? d.waiters`), `:307` (`txnLeaseMs`), `:274` (`mayUse`)
- **Befund:**
  - Fehlt `txnLeaseMs` bei einem Waiter, wird `until(now, undefined)` zu `NaN`. Die daraus entstehende Transaktion läuft nie ab, ihre Einträge bleiben dauerhaft gesperrt.
  - Transaktionen ohne Owner (`owner ?? null`) kann niemand mehr committen oder abbrechen, da `mayUse(null, as)` immer `false` liefert.
- **Fix:** Migration normalisiert alle Felder (`txnLeaseMs`, `owner`, `target`, `handback`). Prüfen, ob es überhaupt Zustände vor Version 5 gibt.

### M3. Verwaiste Registrierungen nach Session-Löschung

- **Ort:** `pi-serverd.mjs:194-203` (`delete`)
- **Befund:** Waiter und Notify-Registrierungen einer gelöschten Konversation bleiben bestehen. Ihre Events laufen in `dropped` und erzeugen Take-und-Release-Zyklen. Eigene Einträge bleiben im Space, bis sie ablaufen.
- **Fix:** Beim Löschen alle Waiter, Registrierungen und Transaktionen mit `target`/`owner == id` entfernen.

### M4. Fehlende Eingabevalidierung in `pi-serverd.mjs`

- `:153` `Number(arg.after ?? -1)` wird nicht auf `NaN`/Endlichkeit geprüft.
- `:114` leerer `prompt`-Text wird akzeptiert.
- `:118-123` `submit` mit Default-`whenBusy` queued unbegrenzt in der Inbox, ohne Obergrenze.
- `:130` und `:139` `configure` akzeptiert beliebige Provider und Modell-IDs, ohne gegen den Katalog zu prüfen.
- **Fix:** Validierung aller Eingaben, Obergrenzen für Inbox und Textlänge.

### M5. Server-Umgebung an Agenten-Tools vererbt

- **Ort:** `pi-serverd.mjs:51,55` (`new NodeExecutionEnv({ env: process.env })`)
- **Befund:** Alle Server-Umgebungsvariablen erreichen die Agenten-Ausführung. Bitte prüfen, ob `NodeExecutionEnv` filtert. Falls nicht, ist das ein direkter Secret-Leak-Pfad (siehe H1).
- **Fix:** Explizite Allowlist für die Agenten-Umgebung.

### M6. Principal in Request-Claims nicht authentifiziert (latent)

- **Ort:** Bundle, Abschnitt `src/claims.ts` (`checkPrincipal`, `issueGeneration`)
- **Befund:** Die Isolation von Request-Claims vertraut einer selbst deklarierten `peerId`. Aktuell ist `issueGeneration` über den Socket nicht erreichbar, daher nur latent. Sobald Clients Principals setzen dürfen, bricht die Isolation.
- **Fix:** Principal aus dem authentifizierten Transport ableiten, nicht aus der Anfrage.

---

## Niedrig

- **L1. `ttlMs: 0` schreibt still nichts** (`pi-spaces.mjs` `write`, `if (expires <= now) return …`): Es wird eine ID zurückgegeben, aber nichts gespeichert. Besser Fehler oder explizite Validierung.
- **L2. `txnLeaseMs: 0`** (`:307`) erzeugt eine sofort abgelaufene Transaktion. Validierung auf `> 0`.
- **L3. Gesperrte Einträge verfallen trotzdem** (`expire`, `:164`): Läuft die Lease eines unter Transaktion entnommenen Eintrags ab, wird er entfernt. Ein späterer Abort kann ihn nicht mehr zurückgeben.
- **L4. Thundering Herd**: Jeder Commit auf dem Space-Dokument weckt alle blockierenden Operationen. `calmDown` mit Jitter mildert das nur.
- **L5. Socket-Modus-Fenster** (`node_modules/@earendil-works/pi-server/dist/transports/unix/listener.js:60`): Der Socket wird mit dem Default-umask gebunden und erst danach auf `0600` gesetzt. Das Fenster ist klein und durch das `0700`-Verzeichnis abgesichert, außer `PI_SERVERD_SOCK` zeigt auf ein fremdes Verzeichnis.
- **L6. Claim-Dokumente** (`Claim`, Scope `task`) werden pro `taskId` angelegt. Ob sie je aufgeräumt werden, ist nicht geprüft.

---

## Geprüft, unkritisch

- **Abort blockiert nicht hinter einem laufenden Prompt**: `prompt`, `abort`, `compact`, `configure` laufen über `withSessionMutation`. `conv.submit` ist aber nur eine dauerhafte Admission (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:456-459`) und wartet nicht auf den Turn.
- **Socket-Berechtigungen**: Verzeichnis `0700`, Socket `0600`, Owner-Lock mit PID-Prüfung über `pidRuns`.
- **Exactly-once bei Zustellung**: `requestId: pi-spaces:${eventId}:${seq}` dedupliziert Wiederholungen.
- **Autorisierung über `as`**: Transaktionen, Leases und Waiter prüfen den Owner konsistent (`mayUse`, `requireTxn`, `leased`).

---

## Empfohlene Reihenfolge

1. H1 (Injection, Umgebung) und H2 (Lease-Obergrenze), jeweils klein umsetzbar.
2. H3 (Byte-Kontingent, Cleanup) zusammen mit M3 (Session-Löschung).
3. M2 (Migration) und M1 (Dead-Letter).
4. H4 als Designentscheidung bestätigen lassen.
5. Mittlere und niedrige Punkte bei Gelegenheit.
