# Demo: Remote-Sitzungen über einen Space, im WLAN

Diese Demo prüft den Weg „Remote über Space“ (siehe [spaces.md](spaces.md), Abschnitt 4) auf einem echten Handy. Sie
läuft über das WLAN, ohne SSH, und braucht kein Modell. Folgende Teile sind echt: der Schlüssel des Handys im Android
Keystore, die Laufzeit der App auf dem Handy, der Netzweg vom Handy zum Rechner, der Gate mit Schlüsselbeweis und die
Grants des Koordinators. Ersetzt sind nur das Modell (ein geskriptetes, das mit `echo: …` antwortet) und die Seiten.
Das Skript steuert die Brücke der App, also dieselbe HTTP-Schnittstelle, die auch die Seiten benutzen.

Den Entwurf beschreibt phi-spaces `docs/m1-mobile.en.md`, „Remote conversations over a Space“.

## Aufbau

```
Handy (App, Keystore-Schlüssel)                 Rechner im LAN (192.168.8.28)
  Remote-Seite ── remoteOverSpace ──TCP 17460──▶ b9-Koordinator (phi-spaces test/testbed/device/b9-coordinator.ts)
                                                   Gate: Schlüsselbeweis, Grant je Aufruf
                                                   Space `remote` im Speicher des Koordinators
                                                        ▲ privater Unix-Socket remote.sock (Peer `agent-host`)
                                                   pi-serverd (PI_TEST_FAUX=1, geskriptetes Modell)
```

Das Handy schreibt jeden Aufruf (`list`, `create`, `attach`, `prompt`, `history` …) als Eintrag `RemoteCall` in den
Space `remote`. pi-serverd nimmt ihn, führt ihn aus und antwortet mit `RemoteAnswer`.

Ein Unterschied zum Betrieb: Hier liegt der Space `remote` im Speicher des Koordinators, und pi-serverd erreicht ihn
über einen privaten Socket. Im Betrieb ist der Agent-Host ein eigenes Mitglied der Föderation, mit eigenem Gate
(`PI_SERVERD_FEDERATION_CONFIG`).

## Voraussetzungen

- Das Handy ist per WLAN-adb erreichbar (`adb devices` zeigt es, z. B. `192.168.8.35:41205`), und die App ist
  installiert und gestartet. Die Port-Datei der Brücke (`files/home/.pi-mobile/port`) gehört zu einem laufenden
  Prozess.
- Ein phi-spaces-Checkout liegt neben diesem Repository (`../phi-spaces`), sonst mit `--phi-spaces` angeben. Seine
  Abhängigkeiten sind installiert.
- Der Port 17460 des Rechners ist im LAN erreichbar (keine Firewall dazwischen).
- Das Handy muss nicht entsperrt sein: adb und die Brücke laufen auch bei gesperrtem Bildschirm.

## Ausführen

```sh
scripts/remote-demo/run.sh --device 192.168.8.35:41205
# Optionen: --lan 192.168.8.28 (Adresse des Rechners), --phone-ip 192.168.8.35, --phi-spaces ../phi-spaces,
#           --dir ~/phi-demo/remote-<Zeit> (Speicher, Schlüssel, Logs), --keep (Dienste laufen danach weiter)
```

Danach das vorige Profil des Handys zurücklegen:

```sh
node scripts/remote-demo/phone.mjs --device 192.168.8.35:41205 --restore
```

## Ablauf

`run.sh` startet die beiden Dienste auf dem Rechner. Danach ruft es `phone.mjs` auf. Beim Beenden (auch mit Ctrl-C)
stoppt es beide Dienste wieder.

1. **Koordinator.**
   - Aufruf: `B9_REMOTE_SOCKET=<dir>/remote.sock node --experimental-strip-types test/testbed/device/b9-coordinator.ts <dir>/coordinator <LAN> <Handy-IP>`
   - Er lauscht auf `tcp://<LAN>:17460` als Host `b9-coord`.
   - Das Handy ist über seine LAN-Adresse als Peer `phone-b9` eingetragen. Bis es gekoppelt ist, hat es die Rolle
     `space-enroll`, danach `space-admin`.
   - Einen Kopplungscode schreibt er nach `<dir>/coordinator/bootstrap-token.txt`.
   - Er legt den Space `remote` an und bedient ihn für den Agent-Host auf `remote.sock`.
   - Bereit ist er, sobald er die Zeile `{"ready":true,…}` schreibt.
2. **Agent-Host.**
   - Aufruf: `pi-serverd.mjs` mit `PI_TEST_FAUX=1`, `PI_SERVERD_REMOTE_SPACE=unix:<dir>/remote.sock` und `PI_SERVERD_REMOTE_SPACE_NAME=remote`.
   - `HOME` und das Arbeitsverzeichnis liegen in `<dir>/agent`. So berührt der Agent-Host keine eigenen Sitzungen.
   - Bereit ist er, sobald im Log `remote calls over …` steht.
3. **Handy** (`phone.mjs`):
   1. Liest über `adb shell run-as org.pimobile.app` Port und Token der Brücke und leitet den Port per
      `adb forward` auf den Rechner um.
   2. **Profil:**
      - Ist das Handy für einen anderen Koordinator eingerichtet, verschiebt das Skript dessen `space-profile.json`
        nach `space-profile.before-remote-demo.json`. Liegt dort schon eine Datei, bricht es ab und überschreibt
        nichts.
      - Ist der Koordinator neu (frischer Speicher) und das Profil stammt von einer früheren Demo, verschiebt es
        dieses nach `space-profile.remote-demo-old.json`.
   3. `prepare` erzeugt einen neuen Schlüssel im Android Keystore.
   4. `enroll` koppelt das Handy mit dem Code aus `bootstrap-token.txt`.
   5. `authenticate` führt den Schlüsselbeweis am Gate durch.
   6. `remoteHost` speichert den Agent-Host: Host `b9-coord`, sein Endpunkt, Space `remote`. Das entspricht Spaces,
      Abschnitt 4.
   7. `POST /api/remote/connect-space` verbindet die Remote-Seite über den Space. Das ist derselbe Weg wie die
      Auswahl „b9-coord (über Space)“. Die Antwort ist das `list` der Sitzungen.
   8. `create` legt die Sitzung „demo über Space“ an, `attach` wählt sie aus.
   9. `prompt` sendet die Nachricht mit einer `requestId`. Danach fragt das Skript `history` ab, bis
      `echo: <Nachricht>` darin steht (höchstens 30 s).
   10. `disconnect`. Zum Schluss steht `✓ demo passed`.

Beispielausgabe (gekürzt):

```
▸ key proof at the coordinator
{"authenticated":true,"keyId":"f0b3783dd8da2a1fd10bb5bc0659c542","peerId":"phone-b9"}
▸ Remote: connect over the Space (key proof at the agent host, a grant per call; no SSH)
connected to b9-coord; sessions: []
session 2 created and chosen
▸ prompt: „hallo vom Handy über den Space“
answer of the agent host: „echo: hallo vom Handy über den Space“
✓ demo passed: paired over WLAN, remote conversation over the Space, one prompt answered
```

## Von Hand auf den Seiten

Mit `--keep` laufen Koordinator und Agent-Host weiter, bis Ctrl-C sie beendet. Dann ist auf dem Handy unter
**Remote** „b9-coord (über Space)“ wählbar, und die Demo-Sitzung lässt sich mit eigenen Nachrichten weiterführen.
Danach `--restore` nicht vergessen.

## Was liegen bleibt

- Auf dem Rechner bleibt `<dir>` (Standard `~/phi-demo/remote-<Zeit>`) mit Speicher, Schlüssel des Koordinators und
  den Logs `coordinator.log`, `agent-host.log` und `phone.log`. Bei jedem Lauf entsteht ein neues Verzeichnis.
- Auf dem Handy bleiben:
  - die Profile `space-profile.remote-demo-old.json` und bis `--restore` `space-profile.before-remote-demo.json`;
  - der Keystore-Schlüssel der Demo-Kopplung;
  - die Ports, die das Skript per adb umgeleitet hat. Das Skript gibt sie am Ende wieder frei.

## Fehlerbilder

| Meldung | Ursache |
|---|---|
| `fetch failed` / `other side closed` an der Brücke | Die App läuft nicht, und die Port-Datei ist alt. App starten (`adb shell am start -n org.pimobile.app/.MainActivity`), `files/log/node.log` lesen. |
| `421` | Die Brücke nimmt nur Anfragen an `127.0.0.1:<ihr Port>` an. `phone.mjs` setzt den Host-Kopf deshalb selbst. |
| `unknown key for this peer` | Das Handy ist noch mit einem früheren Koordinator gekoppelt. `run.sh` gibt bei frischem Speicher `--fresh` mit. |
| `the generation signature or binding is invalid` im `agent-host.log` | Der Space-Dienst des Agent-Hosts läuft unter einer anderen Autorität als der des Gates. Im Koordinator sind deshalb beide `b9`. |
| `timeout: no answer to list` | Der Agent-Host nimmt keine Aufrufe an. `agent-host.log` lesen. |
