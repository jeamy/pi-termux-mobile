# Spaces-Steuerung: Läufe, Worker und Vorgänge

Die Seite **Spaces-Steuerung** (`runtime/public/steuerung.html`, im Menü unter „Spaces“ → „Läufe, Worker und
Vorgänge steuern“) bedient eine phi-spaces-Föderation vom Handy aus. Sie schickt **Admin-Aufträge** an den
**Koordinator**, also an den Kontroll-Host, mit dem das Gerät unter „Spaces“ gekoppelt ist. Das Handy selbst rechnet
nichts und startet keine Prozesse. Die Hosts der Föderation führen die Aufträge aus.

Voraussetzung: Das Gerät ist unter „Spaces“ gekoppelt und hat die Admin-Rolle. Im WLAN ist der Koordinator unter
seiner LAN-Adresse erreichbar, etwa `tcp://192.168.8.28:PORT`.

## Wie ein Auftrag abläuft

1. Ein Knopf schickt einen Auftrag. Der Koordinator nimmt ihn an und vergibt eine **Auftrags-ID**.
2. Die Seite fragt bis zu 30 Sekunden lang nach dem Ergebnis, solange sie sichtbar ist. Erst wenn das Ergebnis da
   ist, meldet sie **„erledigt“**. Ein abgelehnter Auftrag zeigt den Grund rot an.
3. Kommt in dieser Zeit kein Ergebnis, oder wird die Seite verlassen, läuft der Auftrag auf dem Koordinator weiter.
   Er steht dann unter **Übersicht → Vorgänge**. **Ausgang erneut abfragen** fragt dort mit **derselben** ID nach;
   der Auftrag wird dadurch nicht doppelt ausgeführt. Bei einem offenen Ausgang nicht einfach neu starten.

Was nicht rückgängig zu machen ist (einen Lauf stoppen, alle Worker beenden, einen Space löschen), fragt die Seite
vorher in einem roten Kasten nach. Erst **Ja** schickt den Auftrag ab.

Die Seite hat fünf Reiter. Ein Reiter lädt seine Listen, wenn er zum ersten Mal geöffnet wird; **↻** lädt neu.

## Übersicht

| Bereich | Bedeutung |
|---|---|
| **Hinweise** | Warnungen des Koordinators, z. B. ein Host ohne Lebenszeichen oder ein hängender Lauf. **Kritisch** heißt: etwas steht still. **Hinweis** heißt: beobachten. Eine leere Liste beweist nicht, dass alles läuft, denn ein Host erscheint erst, wenn sein Heartbeat abgelaufen ist. |
| **Vorgänge** | Die Aufträge, die **dieses Gerät** gesendet hat: Art, Stand, Zeit, Auftrags-ID und gegebenenfalls Fehler. |

Mögliche Stände eines Auftrags:

| Stand | Bedeutung |
|---|---|
| Angenommen | Der Koordinator hat den Auftrag, die Ausführung hat noch nicht begonnen. |
| Wird ausgeführt | Der Auftrag läuft, z. B. wartet eine Pause auf die Bestätigung der Members. |
| Erledigt | Fertig, mit Ergebnis. |
| Fehlgeschlagen | Abgelehnt oder gescheitert; der Grund steht unter „Fehler“. |
| Bereits erledigt | Dieselbe Auftrags-ID wurde schon einmal ausgeführt; es ist nichts doppelt passiert. |
| Klärung nötig | Der Ausgang ist unklar, z. B. nach einer Wiederherstellung. Ein Admin muss ihn prüfen. |

## Läufe

Ein **Lauf** ist eine verteilte Rechenaufgabe, derzeit das **Primzahlsieb**. Seine Tasks liegen in den Spaces seiner
**Members**, und Worker holen sie dort ab. Pausieren, Fortsetzen und Stoppen gehen an alle Members gemeinsam (eine
„Barriere“). Sie gelten erst, wenn **jeder** Member bestätigt hat.

### Die Karte eines Laufs

| Feld | Bedeutung |
|---|---|
| Name und Abzeichen | Die Lauf-ID und der Stand (Tabelle unten). |
| Members | Die Space-IDs, in denen die Tasks des Laufs liegen. Sie stehen ab dem Start fest. |
| Revision | Zählt jede Zustandsänderung des Laufs hoch (Start, Pause, Fortsetzen, …). Ein Auftrag wird an eine Revision gebunden, damit zwei Geräte sich nicht überholen. |
| Offen | Ein Schritt, den noch nicht alle Members bestätigt haben: welcher, mit welcher Revision, wie viele bestätigt haben und wer fehlt. |
| Recovery | Nur nach einer Wiederherstellung (Restore) eines Hosts: der Abgleich und seine Phase. |

### Stände eines Laufs

| Stand | Bedeutung | Was man tun kann |
|---|---|---|
| Wird vorbereitet | Die Tasks werden auf den Members angelegt; danach startet der Lauf von selbst. | Stoppen |
| Läuft | Worker holen Tasks und rechnen. | Pausieren, Pause planen, Stoppen, Ergebnis |
| Pausiert gerade | Die Pause ist verschickt, es fehlen noch Bestätigungen. | Stand abfragen |
| Pause unvollständig | Mindestens ein Member hat die Pause nicht bestätigt (offline, Fehler). | Stand abfragen |
| Pausiert | Es werden keine neuen Tasks vergeben; laufende Tasks wurden zu Ende gerechnet. | Fortsetzen, Fortsetzen planen, Stoppen, Ergebnis |
| Wird fortgesetzt | Das Fortsetzen ist verschickt, es fehlen noch Bestätigungen. | Stand abfragen |
| Wird gestoppt | Das Stoppen ist verschickt. | warten, ↻ |
| Gestoppt | Endgültig beendet; der Lauf kann nicht wieder gestartet werden. | Ergebnis |
| Abgleich | Nach einer Wiederherstellung werden die Stände der Members verglichen. | warten, ↻ |
| Entscheidung nötig | Nach einer Wiederherstellung passen die Stände der Members nicht zusammen. | eine Recovery-Entscheidung (unten) |

### Knöpfe

- **Pausieren** / **Fortsetzen**: gehen an alle Members und gelten, sobald alle bestätigt haben.
- **Stand abfragen**: fragt die fehlenden Bestätigungen erneut ab, ohne etwas zu ändern.
- **Pause planen** / **Fortsetzen planen**: Zeitpunkt in der lokalen Zeit des Geräts. Der Koordinator führt den
  Schritt zu diesem Zeitpunkt selbst aus, auch wenn das Handy dann aus ist.
- **Stoppen**: fragt den Koordinator zuerst, ob ein Stopp jetzt angenommen würde und mit welcher Revision. Das ist
  nur ein Probelauf, der nichts ändert. Danach folgt die Rückfrage, erst **Endgültig stoppen** stoppt. Ein gestoppter
  Lauf kann nicht wieder starten. Das Ergebnis bleibt abrufbar.
- **Ergebnis**: liest das bisher gespeicherte Ergebnis aus den Members.

  | Feld | Bedeutung |
  |---|---|
  | Vollständiges Ergebnis / Teilergebnis | Ob alle Teile da sind. Ein Teilergebnis ist ausdrücklich unvollständig. |
  | Teile | Gefundene von erwarteten Ergebnisteilen (je Task eines). |
  | Fehlend | Die ersten fehlenden Teile. |
  | Zusammenfassung | Die Kennzahlen des Siebs, z. B. die Zahl der gefundenen Primzahlen. |
  | Manifest | Hash der Laufbeschreibung (Bereich, Blockgröße, Members). |
  | Ergebnis-Hash | Hash des Ergebnisses. Zwei Exporte mit gleichem Hash enthalten dasselbe. |

### Recovery-Entscheidung („Entscheidung nötig“)

Die Karte zeigt die **Stände der Members**, wie der Koordinator sie geprüft hat: den Gate-Stand jedes Members, einen
offenen Schritt („offen: pause“) und ob der Member schon gestoppt ist. Die Entscheidung wird an genau diesen
geprüften Stand gebunden. Ändert er sich vorher, lehnt der Koordinator sie ab, und man prüft neu.

- **Als pausiert festlegen**: Der Lauf gilt als pausiert; alle Members werden auf „pausiert“ gebracht.
- **Fortsetzen**: Der Lauf läuft weiter, erst nachdem alle Members die Pause-Barriere passiert haben.
- **Endgültig stoppen**: wie Stoppen.

### Neuen Primzahlsieb-Lauf starten

| Feld | Bedeutung |
|---|---|
| Lauf-ID | Name des Laufs, eindeutig. Er beginnt mit einem Buchstaben oder einer Ziffer, danach sind auch `. _ : -` erlaubt, höchstens 96 Zeichen. Vorgeschlagen wird `sieb-JJJJMMTT-HHMM`. Derselbe Name startet keinen zweiten Lauf: Ein wiederholter Start mit gleicher ID und gleichen Werten ist derselbe Lauf. |
| Von | Die kleinste geprüfte Zahl (ab 0). |
| Bis (ohne) | Die Obergrenze, **ausschließlich**: 1 bis 1001 prüft 1 bis 1000. |
| Blockgröße | Zahlen je Task (1 bis 4096). Kleinere Blöcke ergeben mehr Tasks und verteilen sich feiner, größere bedeuten weniger Verwaltung. |
| Members | Die Space-IDs, auf die die Tasks verteilt werden, durch Komma oder Zeilenumbruch getrennt. Die Spaces müssen Members der Föderation sein. |

Unter den Feldern rechnet die Seite mit, wie viele Zahlen und Tasks das ergibt. Nach dem Start steht der Lauf auf
„Wird vorbereitet“ und wechselt von selbst auf „Läuft“. Damit gerechnet wird, braucht er **Worker** (nächster Reiter).

## Worker

Ein **Worker** ist ein Prozess auf einem Host, der Tasks aus einem Space holt und abarbeitet. Eine **Zuweisung**
legt fest, wie viele Worker welcher Art auf welchem Host für welchen Space laufen sollen (der Soll-Zustand). Der
Host gleicht das selbst ab und meldet den Ist-Zustand zurück.

### Die Karte einer Zuweisung

| Feld | Bedeutung |
|---|---|
| Abzeichen | **Wie gewünscht**: Ist gleich Soll. **Weicht ab**: Es laufen mehr oder weniger als gewünscht, etwa beim Hoch- oder Herunterfahren. **Wird übernommen**: Der Host hat die letzte Änderung noch nicht gemeldet. **Kein Bericht**: Vom Host kam nichts. |
| Gewünscht | Soll-Anzahl × Workerart. |
| Läuft | Wie der Host es meldet: aktive Worker, Worker, die nach ihrem Task aufhören, und erledigte Tasks. |
| Abgelehnt | Warum der Host die Zuweisung nicht ausführt, z. B. eine unbekannte Workerart. |
| Host / Space / Lauf | Wo die Worker laufen, woher sie Tasks holen und an welchen Lauf sie gebunden sind. |
| Bericht | Zeit des letzten Berichts des Hosts. „Keiner“ heißt nicht, dass die Worker beendet sind; der Host kann offline sein und weiterrechnen. |

**Anzahl ändern** füllt das Formular unten mit dieser Zuweisung vor.

### Zuweisung anlegen oder ändern

| Feld | Bedeutung |
|---|---|
| Name der Zuweisung | Frei wählbar. Ein vorhandener Name ändert diese Zuweisung, ein neuer legt eine an. |
| Host-ID | Der Host, auf dem die Worker laufen sollen, mit seiner ID in der Föderation. |
| Workerart | Welches Programm der Worker ausführt; für das Primzahlsieb `sieve`. Der Host muss die Art kennen, sonst lehnt er ab („Abgelehnt“). |
| Ziel-Space-ID | Der Space, aus dem die Worker ihre Tasks holen, meist ein Member des Laufs. |
| Lauf-ID (optional) | Bindet die Worker an einen Lauf: Sie nehmen nur dessen Tasks und halten an, solange er pausiert ist. |
| Anzahl | Wie viele Worker laufen sollen (0 bis 64). **0** beendet alle, jeden erst nach seinem laufenden Task. Nichts wird mitten in der Arbeit abgebrochen. |

## Spaces

Benannte Spaces auf den Hosts anlegen und außer Betrieb nehmen. Der Lebenslauf eines Spaces ist
**aktiv → archiviert → gelöscht**.

| Feld / Knopf | Bedeutung |
|---|---|
| Host-ID | Der Host, auf dem der Space liegt oder liegen soll. |
| Alias | Lesbarer Name (Kleinbuchstaben, Ziffern, `. _ -`, höchstens 64 Zeichen). Gibt es den Alias auf dem Host schon, liefert **Space anlegen** den vorhandenen Space zurück („Gab es schon“) statt eines zweiten. Die Meldung nennt die **Space-ID**. |
| Space-ID | Die feste ID des Spaces aus der Meldung beim Anlegen, nicht der Alias. |
| Archivieren | Der Space nimmt keine neuen Einträge mehr an; Lesen bleibt möglich. |
| Reaktivieren | Ein archivierter Space wird wieder aktiv. |
| Löschen | Nur bei einem **archivierten, leeren** Space, der zu keinem Lauf gehört. Die ID bleibt reserviert und wird nie neu vergeben. Nicht rückgängig zu machen; die Seite fragt vorher nach. |

## Mehr

### Deployment

Eine **Deployment-Config** beschreibt eine Föderation als JSON: Hosts, Spaces, Worker. Das ist dieselbe Datei, die
`npm run bootstrap` in phi-spaces liest (`scripts/bootstrap-spaces.ts`). Keine Geheimnisse einfügen: Schlüssel und
Tokens gehören nicht in die Config.

- **Plan anzeigen** listet die Schritte, die zum Zustand der Config fehlen, und zeigt, ob etwas blockiert. Es ändert
  nichts. Jede Zeile ist `Status` → `Schlüssel: Detail`.
- **Angewendeten Stand exportieren** holt den Stand, den der Koordinator für dieses Deployment zuletzt angewendet hat.
  Aus der Config wird nur das Feld `deployment` (der Name) gelesen.

### Audit

Die letzten 50 Admin-Aufträge **aller** Geräte, mit Art, Stand, Zeit, Absender (**Von**: Peer-ID), Auftrags-ID und
Fehler. Damit lässt sich nachvollziehen, wer wann was ausgelöst hat.

## Fehlermeldungen

| Meldung | Ursache |
|---|---|
| Das Gerät ist noch nicht gekoppelt | Unter „Spaces“ zuerst einen Schlüssel anlegen und koppeln. |
| Keine Verbindung zum Koordinator | Der Koordinator läuft nicht, oder der Port ist falsch. |
| Koordinator nicht erreichbar | Das Gerät ist nicht im selben Netz (WLAN) wie der Koordinator. |
| Abgelehnt: … | Der Koordinator hat den Auftrag geprüft und abgelehnt, z. B. fehlende Rechte, ein falscher Stand des Laufs oder eine unbekannte Space-ID. Der Text nennt den Grund. |
| Ausgang noch offen | Kein Ergebnis in 30 Sekunden. Nicht neu starten, sondern unter Übersicht → Vorgänge erneut abfragen. |

Fachlicher Hintergrund in phi-spaces: `docs/betrieb-und-mobile-steuerung.en.md` (§6 Primzahlsieb, §7.2 Bedienelemente).
