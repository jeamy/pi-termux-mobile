# Demo: remote sessions over a Space, over WLAN

[English](remote-demo.en.md) · [Deutsch](de-docs/remote-demo.md)

This demo checks the "remote over Space" path (see [spaces.en.md](spaces.en.md), section 4) on a real phone. It
runs over WLAN, without SSH, and needs no model. These parts are real: the phone's key in the Android Keystore, the
app's runtime on the phone, the network path from the phone to the computer, the gate with its key proof, and the
coordinator's grants. Only the model (a scripted one that answers with `echo: …`) and the pages are replaced. The
script drives the app's bridge, the same HTTP interface the pages use.

The design is described in phi-spaces `docs/m1-mobile.en.md`, "Remote conversations over a Space".

## Setup

```
Phone (app, Keystore key)                       Computer on the LAN (192.168.8.28)
  Remote page ── remoteOverSpace ──TCP 17460──▶ b9 coordinator (phi-spaces test/testbed/device/b9-coordinator.ts)
                                                   Gate: key proof, a grant per call
                                                   Space `remote` in the coordinator's memory
                                                        ▲ private Unix socket remote.sock (peer `agent-host`)
                                                   pi-serverd (PI_TEST_FAUX=1, scripted model)
```

The phone writes every call (`list`, `create`, `attach`, `prompt`, `history` …) as a `RemoteCall` entry into the
Space `remote`. pi-serverd takes it, runs it and answers with a `RemoteAnswer`.

One difference from production: here the Space `remote` lives in the coordinator's memory, and pi-serverd reaches it
over a private socket. In production the agent host is a Member of the federation of its own, with its own gate
(`PI_SERVERD_FEDERATION_CONFIG`).

## Prerequisites

- The phone is reachable over WLAN adb (`adb devices` lists it, e.g. as `<ip>:<port>` or an `adb-…` name), and the app
  is installed and started. The bridge's port file (`files/home/.pi-mobile/port`) belongs to a running process.
- A phi-spaces checkout sits next to this repository (`../phi-spaces`); otherwise pass it with `--phi-spaces`. Its
  dependencies are installed.
- Port 17460 of the computer is reachable on the LAN (no firewall in between).
- The phone does not need to be unlocked: adb and the bridge also run with the screen locked.

## Running

```sh
scripts/remote-demo/run.sh --device <adb-serial> --phone-ip <phone-ip>
# Options: --lan 192.168.8.28 (address of the computer), --phi-spaces ../phi-spaces,
#          --dir ~/phi-demo/remote-<time> (store, keys, logs), --keep (services keep running afterwards)
```

Afterwards, put the phone's previous profile back:

```sh
node scripts/remote-demo/phone.mjs --device <adb-serial> --restore
```

## Flow

`run.sh` starts the two services on the computer. Then it calls `phone.mjs`. When it ends (also with Ctrl-C), it
stops both services again.

1. **Coordinator.**
   - Command: `B9_REMOTE_SOCKET=<dir>/remote.sock node --experimental-strip-types test/testbed/device/b9-coordinator.ts <dir>/coordinator <LAN> <phone-ip>`
   - It listens on `tcp://<LAN>:17460` as host `b9-coord`.
   - The phone is registered by its LAN address as peer `phone-b9`. Until it is paired it has the role
     `space-enroll`, afterwards `space-admin`.
   - It writes a pairing code to `<dir>/coordinator/bootstrap-token.txt`.
   - It creates the Space `remote` and serves it to the agent host on `remote.sock`.
   - It is ready as soon as it writes the line `{"ready":true,…}`.
2. **Agent host.**
   - Command: `pi-serverd.mjs` with `PI_TEST_FAUX=1`, `PI_SERVERD_REMOTE_SPACE=unix:<dir>/remote.sock` and `PI_SERVERD_REMOTE_SPACE_NAME=remote`.
   - `HOME` and the working directory are in `<dir>/agent`. This way the agent host touches none of your own
     sessions.
   - It is ready as soon as the log shows `remote calls over …`.
3. **Phone** (`phone.mjs`):
   1. Reads the bridge's port and token through `adb shell run-as org.pimobile.app` and forwards the port to the
      computer with `adb forward`.
   2. **Profile:**
      - If the phone is set up for another coordinator, the script moves its `space-profile.json` to
        `space-profile.before-remote-demo.json`. If a file is already there, it stops and overwrites nothing.
      - If the coordinator is new (fresh store) and the profile comes from an earlier demo, it moves the profile to
        `space-profile.remote-demo-old.json`.
   3. `prepare` creates a new key in the Android Keystore.
   4. `enroll` pairs the phone with the code from `bootstrap-token.txt`.
   5. `authenticate` performs the key proof at the gate.
   6. `remoteHost` saves the agent host: host `b9-coord`, its endpoint, Space `remote`. This corresponds to Spaces,
      section 4.
   7. `POST /api/remote/connect-space` connects the Remote page over the Space. This is the same path as choosing
      "b9-coord (over Space)". The answer is the `list` of sessions.
   8. `create` creates the session "demo über Space", `attach` chooses it.
   9. `prompt` sends the message with a `requestId`. Then the script polls `history` until it contains
      `echo: <message>` (at most 30 s).
   10. `disconnect`. At the end it prints `✓ demo passed`.

Sample output (shortened):

```
▸ key proof at the coordinator
{"authenticated":true,"keyId":"…","peerId":"phone-b9"}
▸ Remote: connect over the Space (key proof at the agent host, a grant per call; no SSH)
connected to b9-coord; sessions: []
session 2 created and chosen
▸ prompt: „hallo vom Handy über den Space“
answer of the agent host: „echo: hallo vom Handy über den Space“
✓ demo passed: paired over WLAN, remote conversation over the Space, one prompt answered
```

## By hand on the pages

With `--keep`, the coordinator and the agent host keep running until Ctrl-C ends them. Then "b9-coord (over Space)"
can be chosen on the phone under **Remote**, and the demo session can be continued with your own messages. Do not
forget `--restore` afterwards.

## What is left behind

- On the computer, `<dir>` (default `~/phi-demo/remote-<time>`) stays, with the store, the coordinator's key and the
  logs `coordinator.log`, `agent-host.log` and `phone.log`. Every run creates a new directory.
- On the phone, these stay:
  - the profiles `space-profile.remote-demo-old.json` and, until `--restore`, `space-profile.before-remote-demo.json`;
  - the Keystore key of the demo pairing;
  - the ports the script forwarded over adb. The script releases them again at the end.

## The SSH path with a saved client

`scripts/remote-demo/phone-ssh.mjs` checks the Remote page's second path. The phone connects over SSH to a client
from **Clients**. Through the tunnel it reaches pi-serverd's conversation socket and makes the same calls there over
a Space. Real computers, real SSH and the provisioning of pi-serverd on the host are involved.

```sh
node scripts/remote-demo/phone-ssh.mjs --device <adb-serial> --target lux@192.168.8.28 [--allow-update] [--prompt "Text"]
```

1. `POST /api/remote/connect` with `copyAuth: false`: the script never copies `auth.json` to the host.
   - If pi-serverd is missing on the host or outdated, it is provisioned there: upload the files, `npm install`,
     start in tmux. The host's lines appear as `host: …`.
   - A running, outdated daemon is replaced only with `--allow-update`, because running work on the host is
     interrupted by that. Without this option the script stops with a hint.
2. The host's models are listed.
3. A session of its own, "ssh-test …": `create`, `attach`, `state`, `history`.
4. Without `--prompt`: an `events` long poll without events. The host holds it for 25 s and then answers with an
   empty list. With `--prompt`, a prompt goes to the host's model instead, with the host's own credentials. That can
   cost tokens.
5. `rename`, `delete` (the session is no longer listed afterwards), `disconnect`.

The daemon keeps running on the host afterwards, as after every connection of the Remote page. It can be ended with
**Stop** on the Remote page or `POST /api/remote/stop`.

Results of 2026-11-12:

| Client | Result |
|---|---|
| `lux@192.168.8.28` | passed. On the first run pi-serverd was provisioned anew (24 s, `npm install` 12 s). On the second the daemon was healthy, the health check ran over the calls, connected after 5 s. There is no `space.sock` there. |
| `lux@192.168.8.34` (rb5, Raspberry Pi, Debian 13, aarch64) | passed. On 2026-11-12 the first attempt stopped because Node 22.18.0 was too old (≥ 22.19.0 needed). Then Node was set to v22.23.5 through nvm (`nvm install 22`; 22.18.0 stays installed). The first connection set up pi-serverd anew: files, `npm install`, tmux installed through apt; connected after 52 s. On the second run the daemon was healthy, connected after 5 s. No model on the host (no credentials), no `space.sock`. |
| `mux@192.168.1.174` (mux) | passed, over VPN. No daemon was running. The first connection set up pi-serverd anew (`npm install` 5 s, connected after 31 s); on the second run it was healthy (12 s). The existing session was left untouched. |
| `mux@192.168.1.173` (virtual) | passed, over VPN. No daemon was running; tmux is missing there and could not be installed, so pi-serverd runs with nohup. First connection after 60 s, second after 25 s. The existing session was left untouched. |

## Failures

| Message | Cause |
|---|---|
| `fetch failed` / `other side closed` at the bridge | The app is not running, and the port file is stale. Start the app (`adb shell am start -n org.pimobile.app/.MainActivity`), read `files/log/node.log`. |
| `421` | The bridge accepts only requests to `127.0.0.1:<its port>`. `phone.mjs` therefore sets the Host header itself. |
| `unknown key for this peer` | The phone is still paired with an earlier coordinator. `run.sh` passes `--fresh` when the store is fresh. |
| `the generation signature or binding is invalid` in `agent-host.log` | The agent host's space service runs under a different authority than the gate's. That is why both are `b9` in the coordinator. |
| `timeout: no answer to list` | The agent host takes no calls. Read `agent-host.log`. |
| `pi-serverd on … is outdated and does not answer this app` | A daemon from before the rework is still running, and the update was declined. Connect again with `--allow-update` (or, on the page, by agreeing to the update). |
| `Node.js >=22.19.0 required` | The Node version on the host is too old. Update Node there. |
