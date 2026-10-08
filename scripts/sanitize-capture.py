#!/usr/bin/env python3
"""
Sanitize the capture before publishing.

Two jobs, applied identically to every shipped file so cross-references stay
consistent (the same conversation id maps to the same placeholder everywhere):

  1. De-brand. The captured answer mentioned real product names. They are replaced
     with neutral names *of the same length in code points*, so every recorded
     source offset (genui_components start/end_index, diagnostic line/column)
     remains exactly valid. The mapping itself is private: it is read from
     `scripts/brand-map.json` (git-ignored), a JSON list of [original, replacement]
     pairs, so publishing this script does not publish the names it removes.

  2. Redact. Request/response headers that identify the account or device are
     replaced; ids (conversation, message, account, device, session, request) are
     mapped to stable fake UUIDs; IPs, cf-ray and tokens are blanked.

Prints a report and exits non-zero if anything that looks sensitive survives.
"""
import hashlib
import json
import os
import re
import sys

SRC = sys.argv[1]   # original project root
DST = sys.argv[2]   # publish root

# --- 1. de-branding: (pattern, replacement) — replacement keeps code-point length
BRAND_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brand-map.json")
BRAND = [tuple(pair) for pair in json.load(open(BRAND_FILE, encoding="utf-8"))] if os.path.exists(BRAND_FILE) else []
for a, b in BRAND:
    assert len(a) == len(b), (a, b)

# --- 2. redaction
SENSITIVE_HEADERS = {
    "authorization", "cookie", "set-cookie", "chatgpt-account-id", "oai-did",
    "oai-device-id", "oai-client-version", "oai-echo-logs", "x-openai-proxy-wasm",
    "cf-ray", "x-request-id", "openai-sentinel-chat-requirements-token",
    "openai-sentinel-proof-token", "openai-sentinel-turnstile-token", "x-conduit-token",
}
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
JWT = re.compile(r"eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*")
CF_RAY = re.compile(r"\b[0-9a-f]{16}-[A-Z]{3}\b")

uuid_map = {}

def fake_uuid(real):
    if real not in uuid_map:
        h = hashlib.sha256(("intelligent-ui-demo:" + real).encode()).hexdigest()
        uuid_map[real] = f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:32]}"
    return uuid_map[real]

def debrand(s):
    for a, b in BRAND:
        s = s.replace(a, b)
    return s

def redact_text(s):
    s = JWT.sub("<redacted:jwt>", s)
    s = UUID.sub(lambda m: fake_uuid(m.group(0)), s)
    s = IPV4.sub(lambda m: "0.0.0.0" if not m.group(0).startswith(("127.", "0.")) else m.group(0), s)
    s = CF_RAY.sub("0000000000000000-XXX", s)
    return s

def scrub_headers(obj):
    """Walk JSON; replace values of sensitive {name,value} header pairs."""
    if isinstance(obj, list):
        return [scrub_headers(x) for x in obj]
    if isinstance(obj, dict):
        if isinstance(obj.get("name"), str) and "value" in obj and obj["name"].lower() in SENSITIVE_HEADERS:
            return {**obj, "value": "<redacted>"}
        out = {}
        for k, v in obj.items():
            if k in ("address",) and isinstance(v, dict):
                out[k] = {"ip": "0.0.0.0", "port": v.get("port")}
            elif k in ("scriptLogs",):
                out[k] = []
            else:
                out[k] = scrub_headers(v)
        return out
    return obj

def process(rel, json_mode):
    src = os.path.join(SRC, rel)
    dst = os.path.join(DST, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    text = open(src, encoding="utf-8").read()
    if json_mode:
        data = scrub_headers(json.loads(text))
        text = json.dumps(data, ensure_ascii=False, indent=None if os.path.getsize(src) > 200_000 else 1)
    text = redact_text(debrand(text))
    open(dst, "w", encoding="utf-8").write(text)
    return dst

SHIP = {
    # artifacts produced by the model + compiler (not OpenAI's runtime code)
    "artifacts/genui-source.dil.md": False,
    "artifacts/genui-compiled.js": False,
    "artifacts/genui-constants.json": True,
    "artifacts/genui-fallback.md": False,
    # protocol records
    "captures/conversation-final.json": True,
    "captures/stream-final-state.json": True,
    "captures/record-421-view-state.json": True,
    "captures/records-subset.json": True,
    # analysis
    "ANALYSIS.md": False,
    "ARTICLE.md": False,
    "RUNNER-SANDBOX.md": False,
}

written = [process(rel, js) for rel, js in SHIP.items()]

# --- verification: nothing sensitive or branded survives
FORBIDDEN = [
    *[(re.compile(re.escape(a), re.I), "brand") for a, _ in BRAND],
    (JWT, "jwt"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "api key"),
    (re.compile(r"gh[opsu]_[A-Za-z0-9]{20,}"), "github token"),
    (re.compile(r"[\w.+-]+@(?!example\.)[\w-]+\.(?:com|net|org|io|cn|dev)\b"), "email"),
]
problems = []
for path in written:
    s = open(path, encoding="utf-8").read()
    for rx, label in FORBIDDEN:
        for m in rx.finditer(s):
            problems.append(f"{os.path.relpath(path, DST)}: {label}: {s[max(0, m.start()-30):m.end()+30]!r}")
    for m in re.finditer(r'"name":\s*"([\w-]+)",\s*"value":\s*"([^"]*)"', s):
        if m.group(1).lower() in SENSITIVE_HEADERS and m.group(2) != "<redacted>":
            problems.append(f"{os.path.relpath(path, DST)}: header {m.group(1)} not redacted")

print(f"wrote {len(written)} files, remapped {len(uuid_map)} uuids")
if problems:
    print("PROBLEMS:")
    for p in problems[:40]:
        print("  " + p)
    sys.exit(1)
print("verification: clean")
