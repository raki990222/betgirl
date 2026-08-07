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

select 'ok' as status;
