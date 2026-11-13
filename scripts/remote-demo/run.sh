#!/usr/bin/env bash
# Remote-conversation demo over WLAN (docs/remote-demo.md): a LAN coordinator from phi-spaces, pi-serverd as the agent
# host with the scripted model (no model calls, no cost), and the phone driven over adb.
#
#   scripts/remote-demo/run.sh --device <adb-serial> --phone-ip <phone ip> [--lan 192.168.8.28]
#                              [--phi-spaces ../phi-spaces] [--dir ~/phi-demo/remote-<time>] [--keep]
#
# --keep leaves coordinator and agent host running after the phone's part (Ctrl-C ends them), for trying the pages
# by hand. Everything (store, keys, logs) stays in --dir. Afterwards: scripts/remote-demo/phone.mjs --device … --restore
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LAN=192.168.8.28 PHONE_IP= DEVICE="${ANDROID_SERIAL:-}" KEEP=0
PHI="${PHI_SPACES_ROOT:-$ROOT/../phi-spaces}" DIR="$HOME/phi-demo/remote-$(date +%Y%m%d-%H%M%S)"
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --lan) LAN="$2"; shift 2 ;;
    --phone-ip) PHONE_IP="$2"; shift 2 ;;
    --phi-spaces) PHI="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEVICE" ] || { echo "--device SERIAL is required (adb devices)" >&2; exit 2; }
[ -n "$PHONE_IP" ] || { echo "--phone-ip is required (the phone\'s WLAN address; the coordinator pins the phone by it)" >&2; exit 2; }
[ -f "$PHI/test/testbed/device/b9-coordinator.ts" ] || { echo "phi-spaces checkout not found at $PHI (--phi-spaces)" >&2; exit 2; }
mkdir -p "$DIR/agent"
echo "demo directory: $DIR"

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM
wait_for() { # file pattern seconds
  for _ in $(seq 1 $(( $3 * 10 ))); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
  echo "timeout waiting for '$2' in $1:" >&2; cat "$1" >&2; return 1
}

echo "▸ coordinator on $LAN (phone pinned by $PHONE_IP), Space 'remote' for the agent host"
( cd "$PHI" && B9_REMOTE_SOCKET="$DIR/remote.sock" exec node --experimental-strip-types --no-warnings \
    test/testbed/device/b9-coordinator.ts "$DIR/coordinator" "$LAN" "$PHONE_IP" ) > "$DIR/coordinator.log" 2>&1 &
PIDS+=($!)
wait_for "$DIR/coordinator.log" '"ready":true' 60
READY="$(grep '"ready":true' "$DIR/coordinator.log" | head -1)"
ENDPOINT="$(node -e 'console.log(JSON.parse(process.argv[1]).endpoint)' "$READY")"
CONTROL="$(node -e 'console.log(JSON.parse(process.argv[1]).controlHostId)' "$READY")"
PEER="$(node -e 'console.log(JSON.parse(process.argv[1]).phonePeer)' "$READY")"
FRESH="$(node -e 'console.log(JSON.parse(process.argv[1]).fresh ? "--fresh" : "")' "$READY")"
echo "  $ENDPOINT, host $CONTROL, phone peer $PEER"

echo "▸ agent host: pi-serverd with the scripted model, calls over the Space 'remote'"
HOME="$DIR/agent" PI_TEST_FAUX=1 PI_WORKDIR="$DIR/agent" PI_SERVERD_SOCK="$DIR/agent/pi-serverd.sock" PI_SERVERD_ID='' \
  PI_PROVIDER='' PI_MODEL='' PI_SERVERD_REMOTE_SPACE="unix:$DIR/remote.sock" PI_SERVERD_REMOTE_SPACE_NAME=remote \
  node "$ROOT/runtime/pi-serverd.mjs" > "$DIR/agent-host.log" 2>&1 &
PIDS+=($!)
wait_for "$DIR/agent-host.log" 'remote calls over' 60

echo "▸ phone"
node "$HERE/phone.mjs" --device "$DEVICE" --endpoint "$ENDPOINT" --control "$CONTROL" --peer "$PEER" \
  --token-file "$DIR/coordinator/bootstrap-token.txt" $FRESH | tee "$DIR/phone.log"

if [ "$KEEP" = 1 ]; then
  echo "coordinator and agent host keep running (logs in $DIR); Ctrl-C ends them"
  wait
fi
