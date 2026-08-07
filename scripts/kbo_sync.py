#!/usr/bin/env python3
"""betgirl KBO 경기 자동 연동.

네이버 스포츠 공식 일정 API(공개)에서 KBO 경기를 가져와:
  1) 새 경기를 보드에 게시한다 (기본 배당 1.85/1.85 — 운영자가 open 동안 조정 가능)
  2) 시작 시각이 바뀐 open 경기를 갱신한다
  3) 취소(폭염·우천 등)된 경기를 자동 처리한다 —
     미정산 픽 전액 원금 환급(void) + 경기 상태 '취소' 표시 + 증빙 링크 기록

쓰기에는 service_role 키가 필요하다: ~/betgirl/.env.local 에
  SUPABASE_SERVICE_ROLE_KEY=...
(이 파일은 gitignore 대상. 키가 없으면 읽기 점검만 하고 종료한다.)

launchd(com.betgirl.kbosync)가 하루 4회 실행한다. 멱등 — 여러 번 돌려도 안전.
"""
import json
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

SUPABASE_URL = "https://scpijkzdxalswmnljafu.supabase.co"
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjcGlqa3pkeGFsc3dtbmxqYWZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MDg5NDksImV4cCI6MjEwMTQ4NDk0OX0."
    "w9MAXZorH9-VunRq-Z6_VH7pWGUYLSYlNsvfmSWkYwE"
)
KST = timezone(timedelta(hours=9))
DEFAULT_ODDS = 1.85
SYNC_DAYS_AHEAD = 7

TEAMS = {
    "LG": "LG 트윈스", "OB": "두산 베어스", "HT": "KIA 타이거즈", "SS": "삼성 라이온즈",
    "SK": "SSG 랜더스", "LT": "롯데 자이언츠", "NC": "NC 다이노스", "KT": "KT 위즈",
    "WO": "키움 히어로즈", "HH": "한화 이글스",
}
WEEKDAY = ["월", "화", "수", "목", "금", "토", "일"]


def service_key() -> str | None:
    env = Path.home() / "betgirl" / ".env.local"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
            return line.split("=", 1)[1].strip()
    return None


def http(url: str, headers: dict, data: bytes | None = None, method: str = "GET"):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        body = r.read().decode()
        return json.loads(body) if body.strip() else None


def naver_games() -> list[dict]:
    start = datetime.now(KST).date()
    end = start + timedelta(days=SYNC_DAYS_AHEAD)
    q = urllib.parse.urlencode({
        "fields": "basic,schedule,baseball",
        "upperCategoryId": "kbaseball",
        "categoryId": "kbo",
        "fromDate": start.isoformat(),
        "toDate": end.isoformat(),
        "size": 500,
    })
    d = http(f"https://api-gw.sports.naver.com/schedule/games?{q}",
             {"User-Agent": "Mozilla/5.0"})
    return d["result"]["games"]


def sb(path: str, key: str, method: str = "GET", payload=None, prefer: str | None = None):
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(payload).encode() if payload is not None else None
    return http(f"{SUPABASE_URL}/rest/v1/{path}", headers, data, method)


def main() -> int:
    key = service_key()
    games = naver_games()
    events = sb("betgirl_events?select=id,home,away,start_at,status,result_code", ANON_KEY)

    def find_event(home: str, away: str, date: str):
        for e in events:
            if e["home"] == home and e["away"] == away and e["start_at"][:10] == date:
                return e
        return None

    to_create, to_cancel, to_retime = [], [], []

    for g in games:
        home = TEAMS.get(g["homeTeamCode"])
        away = TEAMS.get(g["awayTeamCode"])
        if not home or not away:            # 올스타전 등 미매핑 팀은 건너뜀
            continue

        date = g["gameDate"]
        start_iso = f"{g['gameDateTime']}+09:00"
        proof = f"https://m.sports.naver.com/game/{g['gameId']}"
        ev = find_event(home, away, date)

        if g["cancel"]:
            if ev and ev["status"] != "settled":
                to_cancel.append((ev, proof))
            continue

        if g["statusCode"] != "BEFORE":     # 진행 중/종료 경기는 생성 대상 아님
            continue

        if ev is None:
            wd = WEEKDAY[datetime.fromisoformat(date).weekday()]
            to_create.append({
                "round_key": f"KBO {date} ({wd})",
                "sport": "야구",
                "league": "KBO",
                "home": home,
                "away": away,
                "start_at": start_iso,
                "market": "승패",
                "options": [
                    {"code": "HOME", "label": f"{home} 승", "odds": DEFAULT_ODDS},
                    {"code": "AWAY", "label": f"{away} 승", "odds": DEFAULT_ODDS},
                ],
                "official_url": proof,
                "note": f"{g['stadium']} · 네이버 스포츠 공식 일정 자동 연동 · 배당은 운영자 게시값",
            })
        elif ev["status"] == "open" and ev["start_at"][:16] != start_iso[:16]:
            to_retime.append((ev["id"], start_iso))

    print(f"신규 {len(to_create)} / 취소 {len(to_cancel)} / 시각변경 {len(to_retime)}")

    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY 미설정 (~/betgirl/.env.local) — 점검만 하고 종료")
        return 0 if not (to_create or to_cancel or to_retime) else 1

    for row in to_create:
        sb("betgirl_events", key, "POST", row, prefer="return=minimal")
        print(f"  게시: {row['round_key']} {row['home']} vs {row['away']}")

    for ev_id, start_iso in to_retime:
        sb(f"betgirl_events?id=eq.{ev_id}", key, "PATCH", {"start_at": start_iso},
           prefer="return=minimal")
        print(f"  시각 변경: event {ev_id} → {start_iso}")

    for ev, proof in to_cancel:
        # 미정산 픽 전액 원금 환급 (체인 트리거가 각 행을 봉인)
        picks = sb(
            f"betgirl_bets?select=seq,stake&event_id=eq.{ev['id']}", ANON_KEY)
        settled = sb(
            f"betgirl_settlements?select=bet_seq&bet_seq=in.({','.join(str(p['seq']) for p in picks) or '0'})",
            ANON_KEY)
        done = {s["bet_seq"] for s in settled}
        for p in picks:
            if p["seq"] in done:
                continue
            sb("betgirl_settlements", key, "POST", {
                "bet_seq": p["seq"],
                "result": "void",
                "payout": p["stake"],
                "settled_at": datetime.now(KST).isoformat(timespec="seconds"),
                "proof_url": proof,
                "note": "경기 취소 자동 환급",
            }, prefer="return=minimal")

        patch = {"status": "settled"}
        if not ev.get("result_code"):
            patch.update({
                "result_code": "CANCEL",
                "result_at": datetime.now(KST).isoformat(timespec="seconds"),
                "result_proof_url": proof,
            })
        sb(f"betgirl_events?id=eq.{ev['id']}", key, "PATCH", patch, prefer="return=minimal")
        refunded = len([p for p in picks if p["seq"] not in done])
        print(f"  취소 처리: {ev['home']} vs {ev['away']} (환급 {refunded}건)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
