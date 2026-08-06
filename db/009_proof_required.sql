-- betgirl 009 — 정산 증빙 필수화 (SQL Editor 1회 실행)
-- 결정(2026-08-06): 증빙 = 공식 결과 페이지 URL (네이버/FotMob/KBO 공홈 등).
-- SLA = 경기 종료 후 공식 홈페이지 기재 시점부터 1시간 내 정산.
-- 이 마이그레이션은 일괄 정산 RPC 에서 증빙 URL 없는 정산을 거부한다.

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

  -- 모든 정산에는 공식 결과 페이지 증빙이 필수다 (재실행 시 기존 증빙이 있으면 허용)
  if (p_proof_url is null or btrim(p_proof_url) = '')
     and not exists (
       select 1 from public.betgirl_events e0
        where e0.id = p_event_id and e0.result_proof_url is not null
     ) then
    raise exception '공식 결과 페이지 URL(증빙)이 필요합니다. 네이버·KBO 공식 홈페이지 등의 결과 링크를 입력하세요.'
      using errcode = '23514';
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
