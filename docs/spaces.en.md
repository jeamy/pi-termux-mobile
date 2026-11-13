# The Spaces page

[English](spaces.en.md) · [Deutsch](de-docs/spaces.md)

Under **Spaces** (bottom bar) the phone connects to a **phi-spaces federation**: a group of hosts that hold spaces
together (stores for entries, tasks and results). The page has two parts:

- **Spaces** (`runtime/public/spaces.html`): the device gets a key, is paired with the coordinator and can then open
  a space. This document is about this part.
- **Spaces control** (`steuerung.html`, reached through “Control runs, workers and operations ›”): runs, workers,
  spaces and deployment through admin commands. Every field there is explained in [steuerung.en.md](steuerung.en.md).

## Terms

| Term | Meaning |
|---|---|
| **Coordinator** | The control host of the federation. It keeps the control space, knows every paired device and accepts admin commands. |
| **Data host** | A host that holds the space the phone wants to open. It can be the coordinator itself or another host. |
| **Peer ID** | The name of this device in the federation, for example `phone`. The coordinator recognises the device by this name. |
| **Host ID** | The fixed identifier of a host. On every connection the device checks that it is really talking to this host and not to one that has put itself in between. |
| **Endpoint** | Where the host can be reached, always as `tcp://ADDRESS:PORT`. On Wi-Fi this is the LAN address of the computer, e.g. `tcp://192.168.8.28:4100`. |
| **Device key** | A key pair in the **Android Keystore**. The private part never leaves the device; with it the device proves on every connection who it is (“key proof”). |
| **Pairing code** | A one-time code of the coordinator with which it takes in the key of this device. It is never stored. |

## Three steps (and a fourth for Remote)

The page always shows only the step that is due. At the top is the **status card** with the current state and the
stored connection data.

### 1 · Prepare device

Creates the device key. The coordinator shows the three values when a device is added there.

| Field | Meaning |
|---|---|
| Name of this device (peer ID) | Free to choose, 1 to 128 characters from `A-Z a-z 0-9 _ . : -`. Must match the name the coordinator used for the pairing code. |
| Host ID of the coordinator | The identifier of the coordinator. The key is bound to this host: it signs sign-ins to exactly this host only. |
| Endpoint of the coordinator | `tcp://ADDRESS:PORT` of the coordinator. On Wi-Fi its LAN address. |

**Create device key** creates the key in the Keystore and stores the profile (private, readable only by the app).
The top then shows “Key ready”.

A device has one profile. For another coordinator the existing profile must be dissolved first.

### 2 · Pair

| Field / button | Meaning |
|---|---|
| Pairing code or QR content | The code from the coordinator. Alternatively the whole QR content (`{"v":1,…}`): the page then also checks that it belongs to the prepared coordinator (endpoint and control space) and rejects a foreign one. |
| Pair | Registers the device key with the code at the coordinator. If that succeeds, the top shows **“Paired”**. |
| Check pairing status | If the connection broke off during pairing (“Pairing in progress”): asks with the same request whether the coordinator accepted it. The code is not needed again for this. |

On the first pairing the device remembers the ID of the control space. If another control space answers later, it
aborts.

### 3 · Connect a space

Appears as soon as the device is paired. This is where you set which space **Open space** shows.

| Field | Meaning |
|---|---|
| Host ID of the data host | The identifier of the host that holds the space. The device key is additionally enabled for this host. |
| Endpoint of the data host | `tcp://ADDRESS:PORT` of the data host. |
| Space (ID or alias) | Which space is opened, by its fixed ID or its readable name. |

**Save** stores the values in the profile. They can be overwritten at any time.

### 4 · Remote sessions over Space

Appears as soon as the device is paired. With it the **Remote** page reaches the agent sessions of a computer
without SSH: through a space of the federation, signed in with the device key and a grant of the coordinator, as
with “Open space”. For this the computer runs pi-serverd with `PI_SERVERD_REMOTE_SPACE=local` as a member of the
federation. Its sessions then live in the space `remote` of its own store.

| Field | Meaning |
|---|---|
| Host ID of the agent host | The identifier of the computer in the federation. The device key is enabled for this host. |
| Endpoint of the agent host | `tcp://ADDRESS:PORT` of its gate, on Wi-Fi its LAN address. |
| Space of the sessions | The space the calls go through, usually `remote`. Only the phone and the agent host have access there. |

After **Save** the computer appears on the **Remote** page in the host list as “<host ID> (over Space)”. Selecting it
and tapping **connect** makes the page connect through the space instead of SSH. Sessions, models, prompts, abort
and history work as before. Nothing is installed or started; the computer must already be running. The SSH route
through the hosts under “Clients” stays available alongside.

A demo of this route on Wi-Fi, with scripts, is described in [remote-demo.en.md](remote-demo.en.md).

### Space tools of the sessions on another space server

The sessions of pi-serverd otherwise use their space tools (`space_write`, `space_wait`, `space_notify` …) in the
computer's own store (`~/.pi-serverd/space.sqlite`). With `PI_SERVERD_AGENT_SPACE=unix:/path.sock` or
`tcp:HOST:PORT` (plus `PI_SERVERD_AGENT_SPACE_NAME` for a named space there) they use the space of another space
server instead. pi-serverd is **one** agent host there; the connection needs the role `agentHost`, for example
`space-server --agent-host` or `phi-space-server --agent-host`.

- Each session acts there as an agent of its own, `conversation-<id>`: its own mailbox, its own transactions. What a
  session has taken only that session can commit.
- An event pump reads the mailbox of every session that has used the space and passes each event on as input exactly
  once, with the same text as in the own store (“[space event …”, “[space] your wait …”).
- Which sessions are watched is kept in `~/.pi-serverd/agent-space.json`. After a restart the events that arose in
  the meantime arrive as well. If the file belongs to another server or space, it is not taken over.
- A deleted session ends its loop; what had been handed to it goes back to the space.

The test `runtime/test-remote-space.mjs` checks this against the TypeScript server and, with
`PHI_SPACES_SERVER_CMD`, against the Rust server.

### The phone's own space server

The app ships the Rust space server `phi-space-server` (`runtime/bin/phi-space-server`, built from the phi-spaces
checkout during the build; M1 in phi-spaces `docs/m1-mobile.en.md`). The app's service (`PiService`) starts it next
to node as a process of its own and restarts it when it ends (wait 1 s, doubled up to 30 s).

- Store: `home/.pi-mobile/space-server.sqlite` in the app's files. A restart keeps the data.
- Reachable only through the Unix socket `home/.pi-mobile/space-server.sock`, not over the network.
- The phone's chat sessions get the space tools through it, each as an agent of its own (as with pi-serverd above);
  the watched sessions are kept in `home/.pi-mobile/agent-space.json`. If the server is not reachable at the moment,
  the chat goes on; the prompt then says “unreachable now”.
- A crash of node leaves the space server running, and vice versa.
- Log: `log/space-server.log`; restarts are recorded in `log/service-error.txt`.
- An APK without the file (`PHI_SPACE_SERVER_SKIP=1` during the build, or without a phi-spaces checkout, NDK or
  cargo) behaves as before: no space server, no space tools in the chat.

Checked on an Android test phone (2026-11-13): `kill -9` of the server (back after one second, data kept), `kill -9`
of node (server keeps running), quitting the app and starting it again (one process each), and two minutes of forced
deep sleep (`dumpsys deviceidle force-idle`, battery as unplugged): the bridge and the space server kept answering.
The service runs in the foreground with a partial wakelock; it does not need an exemption from battery optimisation
for this. Vendor power-saving features can still kill apps; that cannot be checked with `dumpsys`.

## Paired: what you can do

| Button | Effect |
|---|---|
| **Open space** | Signs in to the coordinator, gets a short-lived permission (“grant”) there and with it reads the space on the data host: name, number of entries and the first 100 entries. Each entry shows its **type** (bold) and its fields. Nothing can be changed here; the page only reads. |
| **Control runs, workers and operations ›** | Opens the Spaces control, see [steuerung.en.md](steuerung.en.md). The device needs the admin role for it. |

### Advanced

| Button | Effect |
|---|---|
| Check key proof | Signs in to the coordinator and confirms that key and pairing still hold. Useful for testing the connection. Changes nothing. |
| Renew key | Creates a new device key and has the coordinator exchange it for the old one. The old key is no longer valid afterwards. If the connection breaks off midway, the top shows “A key renewal is open”; then **Evaluate renewal**. A second renewal starts only when the first one is finished. |
| Evaluate renewal | Asks whether the coordinator has taken over the open renewal. If so, the device works with the new key from then on. After a finished renewal it shows its result. |

While a request is running, the pressed button shows “Running …”. The result appears in words directly above the
buttons (green: succeeded, red: error) and also in the message line at the top, which stays visible while scrolling.
The same applies to “Check pairing status”.

**Raw response** shows the runtime's last response as JSON, for troubleshooting.

## Status card

| State | Meaning |
|---|---|
| Not paired | There is no device key yet: step 1. |
| Key ready | The key is created but not paired yet: step 2. |
| Pairing in progress | The pairing was sent, the answer is missing: “Check pairing status”. |
| Paired | The device can open spaces and, with the admin role, use the control. |

Below it are **Device** (peer ID), **Coordinator** (endpoint) and **Space** (the chosen space on its data host, or
“none yet”).

## Error messages

| Message | Cause and remedy |
|---|---|
| Give the endpoint as tcp://ADDRESS:PORT … | The endpoint has another format. Only `tcp://`, with port, without user, path or parameters. |
| No connection: is the coordinator running …? | The address answers, but nothing listens on the port. Start the server or check the port. |
| Address not reachable: is the device on the same Wi-Fi? | The device does not reach the address: another network, a firewall or a wrong IP. |
| The QR content belongs to another coordinator than the prepared one | The QR code comes from another coordinator than the one entered in step 1. |
| device is already paired | The device is already paired; pairing a second time is not needed. |
| another space operation is in progress | The runtime is handling another Spaces request right now. Wait a moment. |
| control space identity mismatch | Another control space than at pairing answers at the address. Wrong host or a newly set up coordinator. |

## Privacy and security

- The private key lives in the Android Keystore and cannot be read out. Only the public key, peer ID, hosts,
  endpoints and operation IDs are stored, in a file only the app can read.
- Pairing codes are never stored.
- Every connection checks the host ID of the other side; a key signs only for the hosts it is enabled for
  (coordinator and the entered data host).
