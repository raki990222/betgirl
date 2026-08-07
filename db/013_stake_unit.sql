-- betgirl 013 — 베팅 100벳 단위 강제 (SQL Editor 1회 실행)
-- 234벳, 1508벳 같은 임의 단위 베팅을 DB가 거부한다. (기존 행은 전부 100 배수라 무영향)

alter table public.betgirl_bets
  drop constraint if exists betgirl_bets_stake_unit;
alter table public.betgirl_bets
  add constraint betgirl_bets_stake_unit check (stake % 100 = 0);

-- 픽 등록 경로에는 한국어 메시지로 먼저 거른다 (제약 위반보다 친절하게)
create or replace function public.betgirl_stake_unit_guard()
returns trigger
language plpgsql
as $$
begin
  if new.stake % 100 <> 0 then
    raise exception '베팅은 100벳 단위로만 가능합니다. (입력: %벳)', new.stake
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 'a0_' 접두: fill(a_fill)·chain 트리거보다 먼저 실행
drop trigger if exists betgirl_bets_a0_stake_unit on public.betgirl_bets;
create trigger betgirl_bets_a0_stake_unit
  before insert on public.betgirl_bets
  for each row execute function public.betgirl_stake_unit_guard();

-- ---------------------------------------------------------------- 주말 경기 취소 반영
-- 8/7~8/9 KBO 15경기 전체 폭염 취소 (네이버 스포츠 공식 일정 확인, 2026-08-06).
-- 미정산 픽 0건이라 환급 대상 없음. 이후 취소는 kbo_sync 스케줄러가 자동 처리한다.
update public.betgirl_events
   set status = 'settled', result_code = 'CANCEL', result_at = now(),
       result_proof_url = 'https://m.sports.naver.com/kbaseball/schedule/index?date=2026-08-07'
 where status = 'open'
   and (start_at at time zone 'Asia/Seoul')::date between '2026-08-07' and '2026-08-09';

select count(*) filter (where result_code = 'CANCEL') as cancelled_events,
       count(*) as total_events
  from public.betgirl_events;
