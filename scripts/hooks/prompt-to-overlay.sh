#!/bin/sh
# Claude Code UserPromptSubmit hook: forward the typed prompt to the obs-overlay
# prompt widget. Must never block or fail the prompt — always exits 0, 1s timeout.
# Script goes via -c so the hook JSON on stdin reaches python untouched.
OVERLAY_URL="${OVERLAY_URL:-http://127.0.0.1:8722/prompt}"
export OVERLAY_URL
/usr/bin/python3 -c '
import json, os, sys, urllib.request

try:
    prompt = json.load(sys.stdin).get("prompt", "")
    if prompt.strip():
        req = urllib.request.Request(
            os.environ["OVERLAY_URL"],
            data=json.dumps({"text": prompt[:1000]}).encode(),
            headers={"content-type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=1)
except Exception:
    pass
' 2>/dev/null
exit 0
