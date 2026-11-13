# Spaces control: runs, workers and operations

[English](steuerung.en.md) · [Deutsch](de-docs/steuerung.md)

The **Spaces control** page (`runtime/public/steuerung.html`, in the menu under “Spaces” → “Control runs, workers and
operations”) operates a phi-spaces federation from the phone. It sends **admin commands** to the **coordinator**,
that is, to the control host the device is paired with under “Spaces”. The phone itself computes nothing and starts
no processes. The hosts of the federation carry out the commands.

Prerequisite: the device is paired under “Spaces” and has the admin role. On Wi-Fi the coordinator is reachable at
its LAN address, e.g. `tcp://192.168.8.28:PORT`.

## How a command runs

1. A button sends a command. The coordinator accepts it and assigns a **command ID**.
2. The page asks for the result for up to 30 seconds, as long as it is visible. Only once the result is there does
   it report **“done”**. A refused command shows the reason in red.
3. If no result arrives in that time, or the page is left, the command goes on running on the coordinator. It then
   appears under **Overview → Operations**. **Ask for the outcome again** asks there with the **same** ID; the
   command is not run twice by this. Do not simply start anew while an outcome is open.

For what cannot be undone (stopping a run, ending all workers, deleting a space), the page asks first in a red box.
Only **Yes, run it** (or the button named there, such as **Stop for good**) sends the command.

The page has five tabs. A tab loads its lists when it is opened for the first time; **↻** reloads.

## Overview

| Section | Meaning |
|---|---|
| **Alerts** | Warnings of the coordinator, e.g. a host without a sign of life or a stuck run. **Critical** means: something has come to a halt. **Notice** means: keep an eye on it. An empty list does not prove that everything runs, because a host appears only once its heartbeat has expired. |
| **Operations** | The commands **this device** sent: kind, state, time, command ID and, where applicable, error. |

Possible states of a command:

| State | Meaning |
|---|---|
| Accepted | The coordinator has the command; execution has not begun yet. |
| Being applied | The command is running, e.g. a pause is waiting for the members' confirmation. |
| Done | Finished, with a result. |
| Failed | Refused or failed; the reason is under “Error”. |
| Already done | The same command ID was already carried out once; nothing happened twice. |
| Needs clarification | The outcome is unclear, e.g. after a restore. An admin must check it. |

## Runs

A **run** is a distributed computation, currently the **prime sieve**. Its tasks lie in the spaces of its
**members**, and workers fetch them there. Pause, resume and stop go to all members together (a “barrier”). They
hold only once **every** member has confirmed.

### The card of a run

| Field | Meaning |
|---|---|
| Name and badge | The run ID and the state (table below). |
| Members | The space IDs that hold the tasks of the run. They are fixed from the start. |
| Revision | Counts up with every state change of the run (start, pause, resume, …). A command is bound to a revision so that two devices do not overtake each other. |
| Pending | A step not yet confirmed by all members: which one, with which revision, how many have confirmed and who is missing. |
| Recovery | Only after a restore of a host: the reconciliation and its phase. |

### States of a run

| State | Meaning | What you can do |
|---|---|---|
| Being prepared | The tasks are being created on the members; then the run starts by itself. | Stop |
| Running | Workers fetch tasks and compute. | Pause, Schedule pause, Stop, Result |
| Pausing | The pause was sent; confirmations are still missing. | Query state |
| Pause incomplete | At least one member has not confirmed the pause (offline, error). | Query state |
| Paused | No new tasks are handed out; running tasks were computed to the end. | Resume, Schedule resume, Stop, Result |
| Resuming | The resume was sent; confirmations are still missing. | Query state |
| Stopping | The stop was sent. | wait, ↻ |
| Stopped | Ended for good; the run cannot be started again. | Result |
| Reconciling | After a restore the states of the members are compared. | wait, ↻ |
| Decision needed | After a restore the states of the members do not agree. | a recovery decision (below) |

### Buttons

- **Pause** / **Resume**: go to all members and hold as soon as all have confirmed.
- **Query state**: asks again for the missing confirmations, without changing anything.
- **Schedule pause** / **Schedule resume**: a time in the device's local time. The coordinator carries out the step
  at that time by itself, even if the phone is off then.
- **Stop**: first asks the coordinator whether a stop would be accepted now and with which revision. This is only a
  dry run that changes nothing. Then comes the confirmation; only **Stop for good** stops. A stopped run cannot start
  again. The result stays available.
- **Result**: reads the result stored so far from the members.

  | Field | Meaning |
  |---|---|
  | Complete result / Partial result | Whether all parts are there. A partial result is explicitly incomplete. |
  | Parts | Found of expected result parts (one per task). |
  | Missing | The first missing parts. |
  | Summary | The figures of the sieve, e.g. the number of primes found. |
  | Manifest | Hash of the run description (range, block size, members). |
  | Result hash | Hash of the result. Two exports with the same hash contain the same. |

### Recovery decision (“Decision needed”)

The card shows the **States of the members** as the coordinator checked them: each member's gate state, a pending
step (“open: pause”) and whether the member is already stopped. The decision is bound to exactly this checked state.
If it changes first, the coordinator refuses the decision, and you check again.

- **Set as paused**: the run counts as paused; all members are brought to “paused”.
- **Resume**: the run goes on, only after all members have passed the pause barrier.
- **Stop for good**: like Stop.

### Start a new prime sieve run

| Field | Meaning |
|---|---|
| Run ID | Name of the run, unique. It begins with a letter or digit, then `. _ : -` are allowed too, at most 96 characters. The suggestion is `sieve-YYYYMMDD-HHMM` (`sieb-…` with the German UI). The same name does not start a second run: a repeated start with the same ID and the same values is the same run. |
| From | The smallest number checked (from 0). |
| To (exclusive) | The upper bound, **exclusive**: 1 to 1001 checks 1 to 1000. |
| Block size | Numbers per task (1 to 4096). Smaller blocks give more tasks and spread more finely; larger ones mean less overhead. |
| Members (space IDs) | The space IDs the tasks are spread over, separated by commas or line breaks. The spaces must be members of the federation. |

Below the fields the page works out how many numbers and tasks that gives. After the start the run is “Being
prepared” and changes to “Running” by itself. For any computing to happen it needs **workers** (next tab).

## Workers

A **worker** is a process on a host that fetches tasks from a space and works through them. An **assignment** sets
how many workers of which kind are to run on which host for which space (the desired state). The host reconciles
this by itself and reports back the actual state.

### The card of an assignment

| Field | Meaning |
|---|---|
| Badge | **As wanted**: actual equals desired. **Differs**: more or fewer run than wanted, e.g. while scaling up or down. **Being taken over**: the host has not reported the last change yet. **No report**: nothing came from the host. |
| Wanted | Desired count × worker kind. |
| Running | As the host reports it: active workers, workers that stop after their task, and tasks done. |
| Refused | Why the host does not carry out the assignment, e.g. an unknown worker kind. |
| Host / Space / Run | Where the workers run, where they fetch tasks from and which run they are bound to. |
| Report | Time of the host's last report. “none” does not mean the workers have ended; the host can be offline and go on computing. |

**Change count** fills the form below with this assignment.

### Create or change an assignment

| Field | Meaning |
|---|---|
| Name of the assignment | Freely chosen. An existing name changes that assignment, a new one creates one. |
| Host ID | The host the workers are to run on, by its ID in the federation. |
| Worker kind | Which program the worker runs; for the prime sieve `sieve`. The host must know the kind, or it refuses (“Refused”). |
| Target space ID | The space the workers fetch their tasks from, usually a member of the run. |
| Run ID (optional) | Binds the workers to a run: they take only its tasks and halt while it is paused. |
| Count | How many workers are to run (0 to 64). **0** ends them all, each only after its current task. Nothing is cut off in the middle of its work. |

## Spaces

Create named spaces on the hosts and take them out of service. The life of a space is
**active → archived → deleted**.

| Field / button | Meaning |
|---|---|
| Host ID | The host the space lives or is to live on. |
| Alias | Readable name (lower-case letters, digits, `. _ -`, at most 64 characters). If the alias exists on the host already, **Create space** returns the existing space (“Existed already”) instead of a second one. The message names the **space ID**. |
| Space ID | The fixed ID of the space from the message on creation, not the alias. |
| Archive | The space takes no new entries any more; reading stays possible. |
| Reactivate | An archived space becomes active again. |
| Delete | Only for an **archived, empty** space that belongs to no run. The ID stays reserved and is never assigned again. Cannot be undone; the page asks first. |

## More

### Deployment

A **deployment config** describes a federation as JSON: hosts, spaces, workers. It is the same file that
`npm run bootstrap` in phi-spaces reads (`scripts/bootstrap-spaces.ts`). Paste no secrets: keys and tokens do not
belong in the config.

- **Show plan** lists the steps missing to reach the state of the config and shows whether anything blocks. It
  changes nothing. Each line is `Status` → `Key: Detail`.
- **Export the applied state** fetches the state the coordinator last applied for this deployment. Only the field
  `deployment` (the name) is read from the config.

### Audit

The last 50 admin commands of **all** devices, with kind, state, time, sender (**By**: peer ID), command ID and
error. This shows who triggered what and when.

## Error messages

| Message | Cause |
|---|---|
| The device is not paired yet | Under “Spaces”, first create a key and pair. |
| No connection to the coordinator | The coordinator is not running, or the port is wrong. |
| Coordinator not reachable | The device is not on the same network (Wi-Fi) as the coordinator. |
| Refused: … | The coordinator checked the command and refused it, e.g. missing rights, a wrong state of the run or an unknown space ID. The text names the reason. |
| Outcome still open | No result within 30 seconds. Do not start anew, but ask again under Overview → Operations. |

Background in phi-spaces: `docs/betrieb-und-mobile-steuerung.en.md` (§6 prime sieve, §7.2 controls).
