#!/bin/bash
SP="$(dirname "$0")"; cd "$SP"
for i in 0 1 2 3; do
  port=$((9340+i))
  "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --mute-audio --remote-debugging-port=$port --autoplay-policy=no-user-gesture-required --user-data-dir="$(cygpath -w "$SP")\prof$port" --no-first-run --disable-background-timer-throttling --disable-renderer-backgrounding about:blank > chrome$port.log 2>&1 &
done
for i in 0 1 2 3; do
  port=$((9340+i))
  until curl -s http://127.0.0.1:$port/json >/dev/null; do sleep 1; done
  (node drive.mjs $port list$i.json res$i.jsonl 50 > drive$i.log 2>&1) &
  sleep 5
done
wait
