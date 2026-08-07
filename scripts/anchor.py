#!/usr/bin/env python3
"""betgirl 체인 앵커링.

베팅·정산 해시 체인의 tip(마지막 row_hash)과 행 개수를 읽어
~/betgirl-anchor 저장소의 anchors.jsonl 에 한 줄 추가하고 커밋·푸시한다.

- 앵커 레코드끼리도 sha256 으로 연결해 앵커 파일 자체의 중간 삭제를 드러낸다.
- ots(OpenTimestamps) CLI 가 있으면 anchors.jsonl 스냅샷을 비트코인 체인에도 스탬프한다.
- 읽기는 anon 키(공개 데이터)만 사용한다. 쓰기 권한은 어디에도 없다.

launchd(com.betgirl.anchor)가 매일 실행한다. 수동 실행도 안전(멱등: 같은 tip 이면 스킵).
"""
import hashlib
import json
import shutil
import ssl
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # certifi 없으면 시스템 기본 (python.org 파이썬은 인증서 미설치일 수 있음)
    SSL_CTX = ssl.create_default_context()

SUPABASE_URL = "https://scpijkzdxalswmnljafu.supabase.co"
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjcGlqa3pkeGFsc3dtbmxqYWZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MDg5NDksImV4cCI6MjEwMTQ4NDk0OX0."
    "w9MAXZorH9-VunRq-Z6_VH7pWGUYLSYlNsvfmSWkYwE"
)
ANCHOR_DIR = Path.home() / "betgirl-anchor"
ANCHOR_FILE = ANCHOR_DIR / "anchors.jsonl"
KST = timezone(timedelta(hours=9))


def rest(path: str, headers: dict | None = None) -> tuple[list, dict]:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": ANON_KEY, **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        return json.loads(r.read().decode()), dict(r.headers)


def chain_state(table: str) -> dict:
    # 행 개수: Range 0-0 + count=exact → Content-Range: 0-0/N
    _, h = rest(f"{table}?select=seq&limit=1", {"Prefer": "count=exact", "Range": "0-0"})
    total = int(h.get("Content-Range", "0-0/0").split("/")[-1])

    if total == 0:
        return {"rows": 0, "last_seq": None, "tip": None}

    rows, _ = rest(f"{table}?select=seq,row_hash&order=seq.desc&limit=1")
    return {"rows": total, "last_seq": rows[0]["seq"], "tip": rows[0]["row_hash"]}


def last_anchor() -> dict | None:
    if not ANCHOR_FILE.exists():
        return None
    lines = ANCHOR_FILE.read_text().strip().splitlines()
    return json.loads(lines[-1]) if lines else None


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ANCHOR_DIR), *args],
                          capture_output=True, text=True)


def chain_state_optional(table: str) -> dict | None:
    """011 이전(체인 컬럼 없음)에는 None — 앵커에서 제외."""
    try:
        return chain_state(table)
    except Exception:
        return None


def main() -> int:
    chains = {
        "bets": chain_state("betgirl_bets"),
        "settlements": chain_state("betgirl_settlements"),
    }
    for extra in ("credits", "redemptions", "draws"):
        st = chain_state_optional(f"betgirl_{extra}")
        if st is not None and (st["rows"] == 0 or st["tip"] is not None):
            chains[extra] = st

    prev = last_anchor()
    if prev and all(prev.get(k, {}).get("tip") == v["tip"] for k, v in chains.items()):
        print("변화 없음 — 앵커 스킵")
        return 0

    record = {
        "at": datetime.now(KST).isoformat(timespec="seconds"),
        **chains,
        "prev_anchor_sha256": sha256(json.dumps(prev, ensure_ascii=False, sort_keys=True)) if prev else None,
    }
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)

    ANCHOR_DIR.mkdir(exist_ok=True)
    with ANCHOR_FILE.open("a") as f:
        f.write(line + "\n")
    print("앵커 기록: " + " / ".join(f"{k} {v['rows']}행" for k, v in chains.items()))

    # OpenTimestamps (선택): ots 가 설치되어 있으면 스냅샷 스탬프
    day = datetime.now(KST).strftime("%Y%m%d")
    snap = ANCHOR_DIR / "ots" / f"anchors-{day}.txt"
    try:
        snap.parent.mkdir(exist_ok=True)
        snap.write_text(ANCHOR_FILE.read_text())
        ots_bin = shutil.which("ots") or str(Path.home() / "Library/Python/3.14/bin/ots")
        ots_env = {**__import__("os").environ}
        try:
            ots_env["SSL_CERT_FILE"] = certifi.where()   # python.org 파이썬 인증서 미설치 우회
        except NameError:
            pass
        r = subprocess.run([ots_bin, "stamp", str(snap)],
                           capture_output=True, text=True, timeout=120, env=ots_env)
        if r.returncode == 0:
            print(f"OpenTimestamps 스탬프: {snap.name}.ots")
        else:
            snap.unlink(missing_ok=True)
            print(f"ots 스탬프 실패(선택 기능, 계속 진행): {r.stderr.strip()[:200]}")
    except FileNotFoundError:
        snap.unlink(missing_ok=True)
        print("ots 미설치 — OpenTimestamps 생략 (pip3 install opentimestamps-client)")
    except Exception as e:  # noqa: BLE001 — 앵커 커밋은 OTS 실패와 무관하게 진행
        print(f"ots 오류(계속 진행): {e}")

    git("add", "-A")
    git("-c", "user.name=betgirl-anchor", "-c", "user.email=raki@cizion.com",
        "commit", "-m",
        f"anchor {record['at']} " + " ".join(f"{k}={v['rows']}" for k, v in chains.items()))
    push = git("push", "origin", "main")
    if push.returncode != 0:
        print(f"⚠️ push 실패 — 로컬 커밋은 보존됨, 다음 실행 때 재시도: {push.stderr.strip()[:200]}")
        return 0
    print("GitHub 푸시 완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
