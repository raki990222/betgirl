#!/usr/bin/env python3
"""betgirl KBO 경기 자동 연동 + 자동 정산.

네이버 스포츠 공식 일정 API(공개)에서 KBO 경기를 가져와:
  1) 새 경기를 보드에 게시한다 (배당=팀 전력·선발 ERA·최근 폼·상대전적 경기별 산출)
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
SYNC_DAYS_AHEAD = 7
HOME_ADVANTAGE = 0.030     # KBO 홈 승률 보정
MARGIN = 0.05              # 북 마진(오버라운드) — 두 배당 합 implied ≈ 1.05
ODDS_MIN, ODDS_MAX = 1.25, 3.50   # 실제 KBO 승패 시장(betman 등) 통상 범위로 클램프
LEAGUE_ERA = 4.60          # 리그 평균 자책점 근사 — 소표본 선발 ERA 를 이쪽으로 수축
PRIOR_INN = 30.0           # ERA 수축 강도(가상 이닝)
# 확률 가중치: 팀 전력(log5) / 선발 ERA / 최근 5경기 / 시즌 상대전적
W_TEAM, W_STARTER, W_FORM, W_H2H = 0.50, 0.30, 0.12, 0.08

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


def standings() -> dict[str, float]:
    """teamId → 시즌 승률(wra). 실패하면 빈 dict(→ 배당 0.5 균형 폴백)."""
    try:
        d = http(
            "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/2026/teams?type=regular",
            {"User-Agent": "Mozilla/5.0"},
        )
        return {t["teamId"]: float(t["wra"]) for t in d["result"]["seasonTeamStats"]}
    except Exception as e:  # noqa: BLE001
        print(f"순위 조회 실패(배당 균형 폴백): {e}")
        return {}


def game_preview(game_id: str) -> dict:
    """경기 프리뷰(선발 성적·최근 5경기·상대전적). 실패하면 빈 dict → 팀 전력만으로 산출."""
    try:
        d = http(f"https://api-gw.sports.naver.com/schedule/games/{game_id}/preview",
                 {"User-Agent": "Mozilla/5.0"})
        return (d.get("result") or {}).get("previewData") or {}
    except Exception:  # noqa: BLE001
        return {}


def _innings(v) -> float:
    """야구식 이닝 표기(.1=⅓, .2=⅔)를 실수로."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    frac = round((v % 1) * 10)
    return int(v) + (frac / 3 if frac in (1, 2) else 0.0)


def _starter_era(starter: dict | None) -> float | None:
    """선발의 시즌 ERA 를 이닝 수로 신뢰도 수축한 값. 선발 미발표면 None."""
    st = (starter or {}).get("currentSeasonStats") or {}
    inn = _innings(st.get("inn"))
    try:
        era = float(st.get("era"))
    except (TypeError, ValueError):
        return None
    if inn <= 0:
        return None
    return (era * inn + LEAGUE_ERA * PRIOR_INN) / (inn + PRIOR_INN)


def _recent_form(games: list | None) -> float | None:
    """최근 5경기 승률(무=0.5)."""
    pts = {"승": 1.0, "무": 0.5, "패": 0.0}
    vals = [pts[g["result"]] for g in (games or []) if g.get("result") in pts]
    return sum(vals) / len(vals) if vals else None


def compute_odds(home_code: str, away_code: str, wra: dict[str, float],
                 preview: dict) -> tuple[float, float]:
    """경기별 승패 배당 — 실제 북(betman 등)이 가격에 반영하는 요소들의 가중 평균.

    팀 전력(시즌 승률 log5 + 홈 어드밴티지)을 바탕으로 그 경기의 선발투수 ERA·
    최근 5경기 폼·시즌 상대전적을 섞는다. 같은 3연전이라도 선발이 달라 배당이
    경기마다 달라진다. 프리뷰가 없으면(원거리 일정) 팀 전력만으로 내고, 선발이
    발표되면 정기 배당 갱신(to_reodds)이 자동 반영한다.
    """
    hw = min(max(wra.get(home_code, 0.5) + HOME_ADVANTAGE, 0.05), 0.95)
    aw = min(max(wra.get(away_code, 0.5), 0.05), 0.95)
    p_team = hw * (1 - aw) / (hw * (1 - aw) + aw * (1 - hw))   # log5
    parts = [(W_TEAM, p_team)]

    he = _starter_era(preview.get("homeStarter"))
    ae = _starter_era(preview.get("awayStarter"))
    if he and ae:
        parts.append((W_STARTER, ae / (he + ae)))              # ERA 낮은 쪽이 유리

    hf = _recent_form(preview.get("homeTeamPreviousGames"))
    af = _recent_form(preview.get("awayTeamPreviousGames"))
    if hf is not None and af is not None:
        parts.append((W_FORM, (hf + (1 - af)) / 2))

    vs = preview.get("seasonVsResult") or {}
    try:
        h2h_w, h2h_l = int(vs.get("hw")), int(vs.get("hl"))
    except (TypeError, ValueError):
        h2h_w = h2h_l = 0
    if h2h_w + h2h_l >= 4:                                     # 표본 4경기부터, 수축(+3/+6)
        parts.append((W_H2H, (h2h_w + 3) / (h2h_w + h2h_l + 6)))

    p_home = sum(w * v for w, v in parts) / sum(w for w, _ in parts)
    p_away = 1 - p_home

    def odds(p: float) -> float:
        o = 1.0 / (p * (1 + MARGIN))
        return round(min(max(o, ODDS_MIN), ODDS_MAX), 2)

    oh, oa = odds(p_home), odds(p_away)
    if oh == oa:                                  # 표기 동률 방지
        oh, oa = round(oh - 0.01, 2), round(oa + 0.01, 2)
    return oh, oa


def naver_games() -> list[dict]:
    # 캐치업 창 -7일: 러너·맥이 며칠 통째로 죽어도(주말 정전 등) 복구가 창 밖으로 새지 않게.
    # (2026-08-16~17 실사고: 클라우드 시크릿 미등록+맥 꺼짐 겹침 → -2일 창이 8/14~15를 놓침)
    start = datetime.now(KST).date() - timedelta(days=7)
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
    wra = standings()
    events = sb("betgirl_events?select=id,home,away,start_at,status,result_code,options", ANON_KEY)

    def find_event(home: str, away: str, date: str):
        for e in events:
            if e["home"] == home and e["away"] == away and e["start_at"][:10] == date:
                return e
        return None

    to_create, to_cancel, to_retime, to_settle, to_reodds = [], [], [], [], []

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

        # 배당은 시작 전 경기에만 필요 — 경기별 프리뷰(선발·폼·상대전적)를 반영
        oh, oa = compute_odds(g["homeTeamCode"], g["awayTeamCode"], wra,
                              game_preview(g["gameId"]))

        options = [
            {"code": "HOME", "label": f"{home} 승", "odds": oh},
            {"code": "AWAY", "label": f"{away} 승", "odds": oa},
        ]

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
                "options": options,
                "official_url": proof,
                "note": f"{g['stadium']} · 네이버 스포츠 공식 일정 자동 연동 · 배당=팀 전력·선발 ERA·최근 폼·상대전적 산출(시작 전 자동 갱신)",
            })
        elif ev["status"] == "open":
            if datetime.fromisoformat(ev["start_at"]) != datetime.fromisoformat(start_iso):
                to_retime.append((ev["id"], start_iso))
            # 시작 전이면 최신 순위로 배당을 갱신한다 (등록된 픽은 자기 배당을 이미 봉인해 무영향)
            cur = {o.get("code"): round(float(o.get("odds", 0)), 2) for o in (ev.get("options") or [])}
            if cur.get("HOME") != oh or cur.get("AWAY") != oa:
                to_reodds.append((ev["id"], options))

    print(f"신규 {len(to_create)} / 취소 {len(to_cancel)} / 시각변경 {len(to_retime)} "
          f"/ 배당갱신 {len(to_reodds)} / 정산 {len(to_settle)}")

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

    for ev_id, options in to_reodds:
        sb(f"betgirl_events?id=eq.{ev_id}", wkey, "PATCH", {"options": options},
           prefer="return=minimal", bearer=wbearer)
        print(f"  배당 갱신: event {ev_id} → {options[0]['odds']} / {options[1]['odds']}")

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

    # 조합 픽은 모든 다리의 결과가 확정된 뒤에 정산된다. 봇 토큰 경로는 정산 RPC 안에서
    # 스윕이 함께 돌지만, service key 폴백으로 결과를 직접 기록한 경우엔 따로 한 번 돌린다.
    if not token and key:
        try:
            r = sb("rpc/betgirl_settle_combos", key, "POST", {"p_proof_url": None})
            row = (r[0] if isinstance(r, list) else r) or {}
            if row.get("settled_count"):
                print(f"  조합 정산: {row['settled_count']}건 "
                      f"(적중 {row['win_count']}, 지급 {row['total_payout']}벳)")
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ 조합 정산 실패: {e}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
