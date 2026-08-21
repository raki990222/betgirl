-- 020: 경기 참고 정보 (선발 투수 · 최근 5경기 득/실점 · 시즌 상대전적 · 순위)
--
-- kbo_sync 가 네이버 경기 프리뷰(배당 산출에 이미 쓰는 데이터)를 요약해
-- betgirl_events.preview(jsonb) 에 저장하고, 보드 카드의 접이식 패널로 노출한다.
-- 경기 시작 전에만 갱신되므로 시작 후에는 "경기 전 참고 정보"의 기록으로 남는다.
--
-- ⚠️ 실행 전 프로젝트 확인: betgirl(scpijkzdxalswmnljafu) — livereAI 아님!
-- 실행: Supabase SQL Editor. 멱등(재실행 무해).

alter table public.betgirl_events
  add column if not exists preview jsonb;

comment on column public.betgirl_events.preview is
  '경기 전 참고 정보 요약(선발·최근5경기·상대전적·순위). kbo_sync 가 시작 전 자동 갱신. 출처=네이버 스포츠';

-- 보드 뷰에 preview 노출 (018_combo_bets.sql 정의 + 끝에 preview 한 컬럼 추가.
-- create or replace view 는 기존 컬럼 순서를 못 바꾸므로 반드시 맨 끝에 둔다)
create or replace view public.betgirl_board as
select
  e.id, e.round_key, e.sport, e.league, e.home, e.away, e.start_at,
  e.market, e.options, e.status, e.official_url, e.note,
  (e.status = 'open' and now() < e.start_at)                                   as open_for_picks,
  (select count(*) from public.betgirl_bets b where b.event_id = e.id)
    + (select count(*) from public.betgirl_bet_legs g where g.event_id = e.id)  as pick_count,
  (select coalesce(sum(b.stake), 0) from public.betgirl_bets b where b.event_id = e.id)
    + (select coalesce(sum(bb.stake), 0)
         from public.betgirl_bet_legs g
         join public.betgirl_bets bb on bb.seq = g.bet_seq
        where g.event_id = e.id)                                               as staked,
  e.result_code, e.result_at, e.result_proof_url,
  e.preview
from public.betgirl_events e;

grant select on public.betgirl_board to anon, authenticated;

-- ---------------------------------------------------------------- 확인
select 'ok' as status,
       exists(select 1 from information_schema.columns
               where table_name = 'betgirl_events' and column_name = 'preview') as has_column;
