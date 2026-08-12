#!/usr/bin/env python3
"""betgirl KBO 경기 자동 연동 + 자동 정산.

네이버 스포츠 공식 일정 API(공개)에서 KBO 경기를 가져와:
  1) 새 경기를 보드에 게시한다 (기본 배당 1.85/1.85 — 운영자가 open 동안 조정 가능)
  2) 시작 시각이 바뀐 open 경기를 갱신한다
  3) 취소(폭염·우천 등)된 경기를 자동 처리한다 — 전액 환급 + '취소' 표시 + 증빙
  4) 종료된 경기(RESULT)를 자동 정산한다 — 승패 확정·수수료·결과 표시·증빙(네이버 결과 링크).
     무승부(DRAW)는 승패 마켓 관행대로 전액 반환(void) 처리한다.

인증 (~/.env.local 또는 환경변수, 아래 중 하나면 동작):
  BETGIRL_BOT_EMAIL / BETGIRL_BOT_PASSWORD  ← 권장. 봇 운영자로 로그인해
     정산 RPC(betgirl_settle_event)를 그대로 재사용 — 수수료·락·가드 로직 단일화.
  SUPABASE_SERVICE_ROLE_KEY                 ← 경기 게시/취소의 폴백.

로컬 launchd(com.betgirl.kbosync)와 GitHub Actions 크론이 함께 돌아도 안전하다
(멱등: 이미 게시/정산된 건 건너뜀 + events 자연키 unique 인덱스).
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


def env_get(name: str) -> str | None:
    import os
    if os.environ.get(name):
        return os.environ[name].strip()
    env = Path.home() / "betgirl" / ".env.local"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return None


def service_key() -> str | None:
    return env_get("SUPABASE_SERVICE_ROLE_KEY")


def bot_token() -> str | None:
    """봇 운영자로 로그인해 access token 을 얻는다 (정산 RPC 호출용)."""
    email = env_get("BETGIRL_BOT_EMAIL")
    password = env_get("BETGIRL_BOT_PASSWORD")
    if not email or not password:
        return None
    try:
        d = http(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            {"apikey": ANON_KEY, "Content-Type": "application/json"},
            json.dumps({"email": email, "password": password}).encode(),
            "POST",
        )
        return d.get("access_token")
    except Exception as e:  # noqa: BLE001
        print(f"봇 로그인 실패: {e}")
        return None


def http(url: str, headers: dict, data: bytes | None = None, method: str = "GET"):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        body = r.read().decode()
        return json.loads(body) if body.strip() else None


def naver_games() -> list[dict]:
    # 어제·그제 끝난 경기(심야 종료·크론 누락 캐치업)도 정산해야 하므로 -2일부터 본다
    start = datetime.now(KST).date() - timedelta(days=2)
    end = datetime.now(KST).date() + timedelta(days=SYNC_DAYS_AHEAD)
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


def sb(path: str, key: str, method: str = "GET", payload=None, prefer: str | None = None,
       bearer: str | None = None):
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {bearer or key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(payload).encode() if payload is not None else None
    return http(f"{SUPABASE_URL}/rest/v1/{path}", headers, data, method)


def main() -> int:
    key = service_key()
    token = bot_token()
    games = naver_games()
    events = sb("betgirl_events?select=id,home,away,start_at,status,result_code", ANON_KEY)

    def find_event(home: str, away: str, date: str):
        for e in events:
            if e["home"] == home and e["away"] == away and e["start_at"][:10] == date:
                return e
        return None

    to_create, to_cancel, to_retime, to_settle = [], [], [], []

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

        # 종료된 경기 → 승패 자동 정산 (무승부는 전액 반환)
        if g["statusCode"] == "RESULT" and ev and ev["status"] != "settled":
            to_settle.append((ev, g["winner"], proof,
                              f"{g['awayTeamName']} {g['awayTeamScore']} : {g['homeTeamScore']} {g['homeTeamName']}"))
            continue

        if g["statusCode"] != "BEFORE":     # 진행 중 경기는 생성 대상 아님
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
        elif ev["status"] == "open" and datetime.fromisoformat(ev["start_at"]) != datetime.fromisoformat(start_iso):
            # 타임존 정규화 비교 (UTC 저장값 vs KST 표기값을 문자열로 비교하면 매번 오탐)
            to_retime.append((ev["id"], start_iso))

    print(f"신규 {len(to_create)} / 취소 {len(to_cancel)} / 시각변경 {len(to_retime)} / 정산 {len(to_settle)}")

    # 정산은 봇 운영자 RPC 경유 (수수료·결과기록·가드 = DB 로직 단일 소스)
    for ev, winner, proof, score in to_settle:
        if not token:
            print(f"  ⚠️ 정산 보류(봇 자격증명 없음): {ev['home']} vs {ev['away']}")
            continue
        try:
            r = sb("rpc/betgirl_settle_event", ANON_KEY, "POST", {
                "p_event_id": ev["id"],
                "p_winner_code": None if winner == "DRAW" else winner,
                "p_cancel": winner == "DRAW",
                "p_proof_url": proof,
            }, bearer=token)
            row = r[0] if isinstance(r, list) else r
            label = "무승부 전액반환" if winner == "DRAW" else f"{winner} 승"
            print(f"  정산: {ev['home']} vs {ev['away']} [{score}] → {label} "
                  f"(픽 {row['settled_count']}건, 적중 {row['win_count']}, 지급 {row['total_payout']}벳)")
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ 정산 실패 {ev['home']} vs {ev['away']}: {e}")

    if not key and not token:
        print("자격증명 미설정 — 점검만 하고 종료")
        return 0 if not (to_create or to_cancel or to_retime) else 1

    # 경기 게시·시각변경·취소: 봇 토큰이 있으면 봇(RLS 운영자)으로, 없으면 service key 로
    wkey, wbearer = (ANON_KEY, token) if token else (key, None)

    for row in to_create:
        try:
            sb("betgirl_events", wkey, "POST", row, prefer="return=minimal", bearer=wbearer)
            print(f"  게시: {row['round_key']} {row['home']} vs {row['away']}")
        except Exception as e:  # noqa: BLE001 — 동시 실행 중복(unique) 은 무해
            print(f"  게시 건너뜀 {row['home']} vs {row['away']}: {e}")

    for ev_id, start_iso in to_retime:
        sb(f"betgirl_events?id=eq.{ev_id}", wkey, "PATCH", {"start_at": start_iso},
           prefer="return=minimal", bearer=wbearer)
        print(f"  시각 변경: event {ev_id} → {start_iso}")

    for ev, proof in to_cancel:
        if token:
            # 취소도 정산 RPC(p_cancel)로 — 환급·결과기록·락이 DB 한 곳에서 처리된다
            try:
                r = sb("rpc/betgirl_settle_event", ANON_KEY, "POST", {
                    "p_event_id": ev["id"], "p_winner_code": None,
                    "p_cancel": True, "p_proof_url": proof,
                }, bearer=token)
                row = r[0] if isinstance(r, list) else r
                print(f"  취소 처리: {ev['home']} vs {ev['away']} (환급 {row['settled_count']}건)")
            except Exception as e:  # noqa: BLE001
                print(f"  ⚠️ 취소 실패 {ev['home']} vs {ev['away']}: {e}")
            continue

        # 폴백: service key 직접 기록 (봇 자격증명 없는 환경)
        picks = sb(f"betgirl_bets?select=seq,stake&event_id=eq.{ev['id']}", ANON_KEY)
        settled = sb(
            f"betgirl_settlements?select=bet_seq&bet_seq=in.({','.join(str(p['seq']) for p in picks) or '0'})",
            ANON_KEY)
        done = {s["bet_seq"] for s in settled}
        for p in picks:
            if p["seq"] in done:
                continue
            sb("betgirl_settlements", key, "POST", {
                "bet_seq": p["seq"], "result": "void", "payout": p["stake"],
                "settled_at": datetime.now(KST).isoformat(timespec="seconds"),
                "proof_url": proof, "note": "경기 취소 자동 환급",
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
