-- betgirl 008 — 경기 결과를 경기 자체에 기록하고 보드에 노출 (SQL Editor 1회 실행)
--
-- 지금까지는 정산해도 "누가 이겼는지"가 개별 픽의 정산 행에만 남고 경기에는 안 남았다.
-- 결과 확정 시 경기 행에 result_code / result_at / result_proof_url 을 기록하고,
-- 확정된 결과는 수정 불가로 잠근다. 보드는 정산된 경기를 숨기지 않고 결과를 보여준다.

-- ---------------------------------------------------------------- 컬럼 추가
alter table public.betgirl_events
  add column if not exists result_code      text,   -- 'HOME'/'DRAW'/'AWAY' 또는 'CANCEL'
  add column if not exists result_at        timestamptz,
  add column if not exists result_proof_url text;

-- ---------------------------------------------------------------- 결과 불변 가드
-- 기존 가드(마감 후 배당·대진 수정 금지)에 결과 확정 후 결과 수정 금지를 추가한다.
create or replace function public.betgirl_events_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'open'
     and (new.options is distinct from old.options
          or new.home  is distinct from old.home
          or new.away  is distinct from old.away
          or new.start_at is distinct from old.start_at) then
    raise exception '마감된 경기의 배당·대진·시작시각은 수정할 수 없습니다.'
      using errcode = '42501';
  end if;

  if old.status = 'settled' then
    if new.status <> 'settled' then
      raise exception '정산 완료된 경기의 상태는 되돌릴 수 없습니다.' using errcode = '42501';
    end if;
    if new.result_code is distinct from old.result_code
       or new.result_at is distinct from old.result_at then
      raise exception '확정된 결과는 수정할 수 없습니다.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------- 정산 RPC 갱신
-- 결과를 경기 행에 기록하고, 복구 재실행 시 기존 확정 결과와 다른 결과를 거부한다.
create or replace function public.betgirl_settle_event(
  p_event_id    bigint,
  p_winner_code text default null,
  p_cancel      boolean default false,
  p_proof_url   text default null
)
returns table (settled_count int, win_count int, total_payout bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  ev      public.betgirl_events%rowtype;
  r       record;
  v_code  text;
  v_win   boolean;
  v_pay   bigint;
  n_all   int := 0;
  n_win   int := 0;
  v_total bigint := 0;
begin
  if not public.betgirl_is_operator() then
    raise exception '운영자만 정산할 수 있습니다.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  select * into ev from public.betgirl_events where id = p_event_id for update;
  if not found then
    raise exception '존재하지 않는 경기입니다.';
  end if;

  if ev.status = 'settled'
     and not exists (
       select 1 from public.betgirl_bets b
        where b.event_id = p_event_id
          and not exists (select 1 from public.betgirl_settlements s where s.bet_seq = b.seq)
     ) then
    raise exception '이미 정산된 경기입니다.';
  end if;

  v_code := case when p_cancel then 'CANCEL' else p_winner_code end;

  -- 복구 재실행은 기존 확정 결과와 같아야만 허용
  if ev.result_code is not null and v_code is distinct from ev.result_code then
    raise exception '기존 확정 결과(%)와 다른 결과로는 재정산할 수 없습니다.', ev.result_code;
  end if;

  if not p_cancel then
    if p_winner_code is null
       or not exists (
         select 1 from jsonb_array_elements(ev.options) o
          where o->>'code' = p_winner_code
       ) then
      raise exception '결과 선택지가 올바르지 않습니다: %', coalesce(p_winner_code, '(없음)');
    end if;
    if now() < ev.start_at then
      raise exception '경기 시작 전에는 결과를 확정할 수 없습니다.' using errcode = '42501';
    end if;
  end if;

  for r in
    select b.seq, b.stake, b.odds, b.option_code
      from public.betgirl_bets b
     where b.event_id = p_event_id
       and not exists (select 1 from public.betgirl_settlements s where s.bet_seq = b.seq)
     order by b.seq
  loop
    if p_cancel then
      v_win := null;
      v_pay := r.stake;
    else
      v_win := (r.option_code = p_winner_code);
      v_pay := case when v_win then floor(r.stake * r.odds)::bigint else 0 end;
    end if;

    insert into public.betgirl_settlements (bet_seq, result, payout, settled_at, proof_url, note)
    values (
      r.seq,
      case when p_cancel then 'void' when v_win then 'win' else 'lose' end,
      v_pay,
      now(),
      p_proof_url,
      case when p_cancel then '경기 취소 일괄 정산' else '경기 결과 일괄 정산' end
    );

    n_all := n_all + 1;
    if v_win then n_win := n_win + 1; end if;
    v_total := v_total + v_pay;
  end loop;

  -- 복구 재실행이면 기존 결과 값을 유지한다 (가드가 변경을 거부하므로 coalesce 필수)
  update public.betgirl_events
     set status           = 'settled',
         result_code      = coalesce(ev.result_code, v_code),
         result_at        = coalesce(ev.result_at, now()),
         result_proof_url = coalesce(ev.result_proof_url, p_proof_url)
   where id = p_event_id;

  return query select n_all, n_win, v_total;
end;
$$;

grant execute on function public.betgirl_settle_event(bigint, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------- 보드 뷰에 결과 노출
-- CREATE OR REPLACE VIEW 는 기존 컬럼 순서를 유지해야 하므로 새 컬럼은 끝에 붙인다.
create or replace view public.betgirl_board as
select
  e.id, e.round_key, e.sport, e.league, e.home, e.away, e.start_at,
  e.market, e.options, e.status, e.official_url, e.note,
  (e.status = 'open' and now() < e.start_at)          as open_for_picks,
  count(b.seq)                                        as pick_count,
  coalesce(sum(b.stake), 0)                           as staked,
  e.result_code,
  e.result_at,
  e.result_proof_url
from public.betgirl_events e
left join public.betgirl_bets b on b.event_id = e.id
group by e.id;

-- ---------------------------------------------------------------- 확인
select id, home, away, status, result_code from public.betgirl_events order by start_at limit 5;
