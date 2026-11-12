# Die Spaces-Seite

Unter **Spaces** (unterste Leiste) verbindet sich das Handy mit einer **phi-spaces-Föderation**: einem Verbund von
Hosts, die gemeinsam Spaces halten (Ablagen für Einträge, Aufgaben und Ergebnisse). Die Seite hat zwei Teile:

- **Spaces** (`runtime/public/spaces.html`): Das Gerät bekommt einen Schlüssel, wird mit dem Koordinator gekoppelt
  und kann dann einen Space öffnen. Davon handelt diese Seite.
- **Spaces-Steuerung** (`steuerung.html`, erreichbar über „Läufe, Worker und Vorgänge steuern ›“): Läufe, Worker,
  Spaces und Deployment über Admin-Aufträge. Jedes Feld dort erklärt [steuerung.md](steuerung.md).

## Begriffe

| Begriff | Bedeutung |
|---|---|
| **Koordinator** | Der Kontroll-Host der Föderation. Er führt den Kontroll-Space, kennt alle gekoppelten Geräte und nimmt Admin-Aufträge an. |
| **Daten-Host** | Ein Host, auf dem der Space liegt, den das Handy öffnen will. Er kann der Koordinator selbst sein oder ein anderer Host. |
| **Peer-ID** | Der Name dieses Geräts in der Föderation, etwa `handy`. Unter diesem Namen erkennt der Koordinator das Gerät. |
| **Host-ID** | Die feste Kennung eines Hosts. Das Gerät prüft bei jeder Verbindung, dass es wirklich mit diesem Host spricht, und nicht mit einem, der sich dazwischen geschaltet hat. |
| **Endpunkt** | Wo der Host erreichbar ist, immer als `tcp://ADRESSE:PORT`. Im WLAN ist das die LAN-Adresse des Rechners, z. B. `tcp://192.168.8.28:4100`. |
| **Geräteschlüssel** | Ein Schlüsselpaar im **Android Keystore**. Der private Teil verlässt das Gerät nie; das Gerät beweist damit bei jeder Verbindung, wer es ist („Schlüsselbeweis“). |
| **Kopplungscode** | Ein einmaliger Code des Koordinators, mit dem er den Schlüssel dieses Geräts aufnimmt. Er wird nie gespeichert. |

## Ablauf in drei Schritten (und ein vierter für Remote)

Die Seite zeigt immer nur den Schritt, der gerade dran ist. Oben steht die **Statuskarte** mit dem Stand und den
gespeicherten Verbindungsdaten.

### 1 · Gerät vorbereiten

Legt den Geräteschlüssel an. Die drei Werte zeigt der Koordinator an, wenn man dort ein Gerät hinzufügt.

| Feld | Bedeutung |
|---|---|
| Name dieses Geräts (Peer-ID) | Frei wählbar, 1 bis 128 Zeichen aus `A-Z a-z 0-9 _ . : -`. Muss mit dem Namen übereinstimmen, den der Koordinator für den Kopplungscode verwendet hat. |
| Host-ID des Koordinators | Die Kennung des Koordinators. Der Schlüssel wird an diesen Host gebunden: Er unterschreibt nur Anmeldungen bei genau diesem Host. |
| Endpunkt des Koordinators | `tcp://ADRESSE:PORT` des Koordinators. Im WLAN seine LAN-Adresse. |

**Geräteschlüssel anlegen** erzeugt den Schlüssel im Keystore und speichert das Profil (privat, nur für die App
lesbar). Danach steht oben „Schlüssel bereit“.

Ein Gerät hat ein Profil. Für einen anderen Koordinator muss das bestehende Profil erst aufgelöst werden.

### 2 · Koppeln

| Feld / Knopf | Bedeutung |
|---|---|
| Kopplungscode oder QR-Inhalt | Der Code vom Koordinator. Alternativ der ganze QR-Inhalt (`{"v":1,…}`): Dann prüft die Seite zusätzlich, dass er zum vorbereiteten Koordinator (Endpunkt und Kontroll-Space) gehört, und lehnt einen fremden ab. |
| Koppeln | Meldet den Geräteschlüssel mit dem Code beim Koordinator an. Gelingt das, steht oben **„Gekoppelt“**. |
| Stand der Kopplung prüfen | Wenn die Verbindung während des Koppelns abriss („Kopplung läuft“): fragt mit derselben Anfrage nach, ob der Koordinator sie angenommen hat. Der Code wird dafür nicht erneut gebraucht. |

Beim ersten Koppeln merkt sich das Gerät die ID des Kontroll-Spaces. Antwortet später ein anderer Kontroll-Space,
bricht es ab.

### 3 · Space verbinden

Erscheint, sobald das Gerät gekoppelt ist. Hier steht, welchen Space **Space öffnen** zeigt.

| Feld | Bedeutung |
|---|---|
| Host-ID des Daten-Hosts | Die Kennung des Hosts, auf dem der Space liegt. Der Geräteschlüssel wird zusätzlich für diesen Host freigegeben. |
| Endpunkt des Daten-Hosts | `tcp://ADRESSE:PORT` des Daten-Hosts. |
| Space (ID oder Alias) | Welcher Space geöffnet wird, mit seiner festen ID oder seinem lesbaren Namen. |

**Speichern** legt die Werte im Profil ab. Sie lassen sich jederzeit überschreiben.

### 4 · Remote-Sitzungen über Space

Erscheint, sobald das Gerät gekoppelt ist. Damit erreicht die Seite **Remote** die Agent-Sitzungen eines Rechners
ohne SSH: über einen Space der Föderation, angemeldet mit dem Geräteschlüssel und einem Grant des Koordinators,
wie bei „Space öffnen“. Auf dem Rechner läuft dafür pi-serverd mit `PI_SERVERD_REMOTE_SPACE=local` als Member der
Föderation. Seine Sitzungen liegen dann im Space `remote` seines eigenen Speichers.

| Feld | Bedeutung |
|---|---|
| Host-ID des Agent-Hosts | Die Kennung des Rechners in der Föderation. Der Geräteschlüssel wird für diesen Host freigegeben. |
| Endpunkt des Agent-Hosts | `tcp://ADRESSE:PORT` seines Gates, im WLAN seine LAN-Adresse. |
| Space der Sitzungen | Der Space, über den die Aufrufe laufen, meist `remote`. Nur das Handy und der Agent-Host haben dort Zugang. |

Nach **Speichern** steht der Rechner auf der Seite **Remote** in der Host-Auswahl als „<Host-ID> (über Space)“.
Wählt man ihn und tippt **connect**, verbindet sich die Seite über den Space statt über SSH. Sitzungen, Modelle,
Prompts, Abbrechen und Verlauf funktionieren wie bisher. Es wird nichts installiert oder gestartet; der Rechner
muss bereits laufen. Der SSH-Weg über die Hosts unter „Clients“ bleibt daneben bestehen.

Eine Demo dieses Wegs im WLAN, mit Skripten, beschreibt [remote-demo.md](remote-demo.md).

### Space-Werkzeuge der Sitzungen auf einem anderen Space-Server

Die Sitzungen von pi-serverd nutzen ihre Space-Werkzeuge (`space_write`, `space_wait`, `space_notify` …) sonst im
eigenen Speicher des Rechners (`~/.pi-serverd/space.sqlite`). Mit `PI_SERVERD_AGENT_SPACE=unix:/pfad.sock` oder
`tcp:HOST:PORT` (dazu `PI_SERVERD_AGENT_SPACE_NAME` für einen benannten Space dort) nutzen sie stattdessen den Space
eines anderen Space-Servers. pi-serverd ist dort **ein** Agent-Host; die Verbindung braucht die Rolle `agentHost`,
etwa `space-server --agent-host` oder `phi-space-server --agent-host`.

- Jede Sitzung handelt dort als eigener Agent `conversation-<id>`: eigenes Postfach, eigene Transaktionen. Was eine
  Sitzung genommen hat, kann nur sie committen.
- Eine Ereignispumpe liest das Postfach jeder Sitzung, die den Space benutzt hat, und reicht jedes Ereignis genau
  einmal als Eingabe weiter, mit demselben Text wie im eigenen Speicher („[space event …“, „[space] your wait …“).
- Welche Sitzungen beobachtet werden, steht in `~/.pi-serverd/agent-space.json`. Nach einem Neustart kommen auch die
  Ereignisse an, die in der Zwischenzeit entstanden sind. Gilt die Datei für einen anderen Server oder Space, wird sie
  nicht übernommen.
- Eine gelöschte Sitzung beendet ihre Schleife; was ihr übergeben war, geht an den Space zurück.

Der Test `runtime/test-remote-space.mjs` prüft das gegen den TypeScript-Server und, mit `PHI_SPACES_SERVER_CMD`,
gegen den Rust-Server.

## Gekoppelt: was man tun kann

| Knopf | Wirkung |
|---|---|
| **Space öffnen** | Meldet sich beim Koordinator an, holt dort eine kurzlebige Berechtigung („Grant“) und liest damit den Space auf dem Daten-Host: Name, Zahl der Einträge und die ersten 100 Einträge. Jeder Eintrag zeigt seinen **Typ** (fett) und seine Felder. Ändern lässt sich hier nichts; die Seite liest nur. |
| **Läufe, Worker und Vorgänge steuern ›** | Öffnet die Spaces-Steuerung, siehe [steuerung.md](steuerung.md). Dafür braucht das Gerät die Admin-Rolle. |

### Erweitert

| Knopf | Wirkung |
|---|---|
| Schlüsselbeweis prüfen | Meldet sich beim Koordinator an und bestätigt, dass Schlüssel und Kopplung noch gelten. Nützlich zum Testen der Verbindung. Ändert nichts. |
| Schlüssel erneuern | Legt einen neuen Geräteschlüssel an und lässt ihn vom Koordinator gegen den alten tauschen. Der alte Schlüssel gilt danach nicht mehr. Bricht die Verbindung mittendrin ab, steht oben „Eine Schlüsselerneuerung ist offen“; dann **Erneuerung auswerten**. Eine zweite Erneuerung startet erst, wenn die erste abgeschlossen ist. |
| Erneuerung auswerten | Fragt nach, ob der Koordinator die offene Erneuerung übernommen hat. Wenn ja, arbeitet das Gerät ab dann mit dem neuen Schlüssel. Nach einer abgeschlossenen Erneuerung zeigt es deren Ergebnis. |

Während eine Anfrage läuft, zeigt der gedrückte Knopf „Läuft …“. Das Ergebnis erscheint in Worten direkt über den
Knöpfen (grün: gelungen, rot: Fehler) und zusätzlich oben in der Meldungszeile, die beim Scrollen sichtbar bleibt.
Dasselbe gilt für „Stand der Kopplung prüfen“.

**Antwort im Rohformat** zeigt die letzte Antwort der Runtime als JSON, für die Fehlersuche.

## Statuskarte

| Stand | Bedeutung |
|---|---|
| Nicht gekoppelt | Es gibt noch keinen Geräteschlüssel: Schritt 1. |
| Schlüssel bereit | Der Schlüssel ist angelegt, aber noch nicht gekoppelt: Schritt 2. |
| Kopplung läuft | Die Kopplung wurde gesendet, die Antwort fehlt: „Stand der Kopplung prüfen“. |
| Gekoppelt | Das Gerät kann Spaces öffnen und, mit Admin-Rolle, die Steuerung nutzen. |

Darunter stehen **Gerät** (Peer-ID), **Koordinator** (Endpunkt) und **Space** (gewählter Space auf seinem
Daten-Host, oder „noch keiner“).

## Fehlermeldungen

| Meldung | Ursache und Abhilfe |
|---|---|
| Endpunkt als tcp://ADRESSE:PORT angeben … | Der Endpunkt hat ein anderes Format. Nur `tcp://`, mit Port, ohne Benutzer, Pfad oder Parameter. |
| Keine Verbindung: Läuft der Koordinator …? | Die Adresse antwortet, aber auf dem Port lauscht nichts. Server starten oder Port prüfen. |
| Adresse nicht erreichbar: Ist das Gerät im selben WLAN? | Das Gerät erreicht die Adresse nicht: anderes Netz, Firewall oder falsche IP. |
| QR-Inhalt gehört zu einem anderen Koordinator | Der QR-Code stammt von einem anderen Koordinator als dem in Schritt 1 eingetragenen. |
| device is already paired | Das Gerät ist schon gekoppelt; ein zweites Koppeln ist nicht nötig. |
| another space operation is in progress | Die Runtime bearbeitet gerade eine andere Spaces-Anfrage. Kurz warten. |
| control space identity mismatch | Unter der Adresse antwortet ein anderer Kontroll-Space als beim Koppeln. Falscher Host oder ein neu aufgesetzter Koordinator. |

## Datenschutz und Sicherheit

- Der private Schlüssel liegt im Android Keystore und kann nicht ausgelesen werden. Gespeichert werden nur
  öffentlicher Schlüssel, Peer-ID, Hosts, Endpunkte und Vorgangs-IDs, in einer Datei, die nur die App lesen kann.
- Kopplungscodes werden nie gespeichert.
- Jede Verbindung prüft die Host-ID des Gegenübers; ein Schlüssel unterschreibt nur für die Hosts, für die er
  freigegeben ist (Koordinator und eingetragener Daten-Host).
