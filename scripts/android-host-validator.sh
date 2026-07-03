#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REDROID_IMAGE:-redroid/redroid:12.0.0-latest}"
NAME="${REDROID_TEST_NAME:-brproxies-redroid-validator}"
VOLUME="${REDROID_TEST_VOLUME:-brproxies_redroid_validator_data}"
PORT="${REDROID_TEST_PORT:-5555}"

echo "== BrProxies Android host validator =="
echo "image=$IMAGE name=$NAME port=$PORT"

command -v docker >/dev/null || { echo "FAIL docker missing"; exit 1; }
command -v adb >/dev/null || { echo "FAIL adb missing"; exit 1; }
command -v scrcpy >/dev/null || echo "WARN scrcpy missing; screen-open will not work"

docker info >/dev/null || { echo "FAIL docker daemon unavailable"; exit 1; }

if [ ! -e /dev/binder ] || [ ! -e /dev/hwbinder ] || [ ! -e /dev/vndbinder ]; then
  echo "WARN binder devices missing; trying modprobe"
  sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" || true
  sudo modprobe ashmem_linux || true
fi

[ -e /dev/binder ] || { echo "FAIL /dev/binder missing"; exit 1; }
[ -e /dev/hwbinder ] || { echo "FAIL /dev/hwbinder missing"; exit 1; }
[ -e /dev/vndbinder ] || { echo "FAIL /dev/vndbinder missing"; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null

docker run -d --privileged \
  --name "$NAME" \
  -v "$VOLUME:/data" \
  -p "127.0.0.1:${PORT}:5555" \
  "$IMAGE" >/dev/null

echo "waiting for Android boot..."
for _ in $(seq 1 60); do
  adb connect "127.0.0.1:${PORT}" >/dev/null || true
  BOOTED="$(adb -s "127.0.0.1:${PORT}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [ "$BOOTED" = "1" ]; then
    echo "PASS boot_completed"
    break
  fi
  sleep 2
done

BOOTED="$(adb -s "127.0.0.1:${PORT}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
[ "$BOOTED" = "1" ] || { docker logs "$NAME" --tail=120; echo "FAIL Android did not boot"; exit 1; }

adb -s "127.0.0.1:${PORT}" exec-out screencap -p >/tmp/brproxies-redroid-validator.png
[ -s /tmp/brproxies-redroid-validator.png ] || { echo "FAIL screenshot empty"; exit 1; }

echo "PASS screenshot /tmp/brproxies-redroid-validator.png"
echo "PASS host can run ReDroid MVP"
echo "cleanup: docker rm -f $NAME && docker volume rm $VOLUME"
