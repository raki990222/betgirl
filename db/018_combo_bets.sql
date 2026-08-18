-- betgirl 018 — 조합(다중 경기) 픽 (SQL Editor 1회 실행)
--
-- 지금까지는 한 경기당 한 픽(싱글)만 가능했다. 이 마이그레이션은 여러 경기를 묶어
-- "전부 맞아야 적중"인 조합 픽을 추가한다.
--
-- 설계 원칙 — 해시 체인 규칙(canonical)은 건드리지 않는다
--   조합 티켓은 betgirl_bets 의 '한 행'이다. event_id 는 null 이고, 어떤 다리(leg)로
--   구성됐는지는 pick 문자열에 전부 박혀 있다:
--     match_label = '조합 3경기'
--     market      = '조합'
--     pick        = 'LG vs 두산 · LG 승 (1.85) + KIA vs SSG · KIA 승 (2.10) + …'
--     odds        = 각 다리 배당의 곱 (소수 2자리 반올림)
--   pick 과 odds 가 기존 canonical 규칙 그대로 서명되므로, 다리 목록을 나중에 고치면
--   서명된 원문과 어긋난다. 별도 테이블(betgirl_bet_legs)은 화면 표시·정산용 색인이고
--   위변조 방어는 여전히 bets 체인이 담당한다. → 프런트 canonicalBet 수정 불필요.
--
-- 정산 규칙
--   · 한 다리라도 미적중 → 조합 미적중 (지급 0)
--   · 취소된 경기는 배당 1.00 으로 제외 (남은 다리로 재계산)
--   · 전 다리 취소 → 무효, 원금 반환
--   · 전 다리 적중 → 적중, 지급 = floor(베팅액 × 적용배당) − 수수료(싱글과 동일 정책)
--   · 조합은 모든 다리의 결과가 확정된 뒤에 자동 정산된다 (경기 정산 RPC 끝에서 일괄 처리)

-- ---------------------------------------------------------------- 1) 조합 다리
create table if not exists public.betgirl_bet_legs (
  seq         bigint generated always as identity primary key,
  bet_seq     bigint       not null references public.betgirl_bets(seq),
  leg_no      int          not null,
  event_id    bigint       not null references public.betgirl_events(id),
  option_code text         not null,
  match_label text         not null,          -- 담을 때의 대진 (표시용 사본)
  pick        text         not null,          -- 담을 때의 선택 라벨
  odds        numeric(6,2) not null check (odds >= 1),
  created_at  timestamptz  not null default now(),
  unique (bet_seq, leg_no),
  unique (bet_seq, event_id)                  -- 같은 경기를 한 조합에 두 번 담을 수 없다
);

create index if not exists betgirl_bet_legs_event_idx on public.betgirl_bet_legs (event_id);
create index if not exists betgirl_bet_legs_bet_idx   on public.betgirl_bet_legs (bet_seq);

-- 다리도 추가 전용 (bets 와 같은 방어)
drop trigger if exists betgirl_bet_legs_immutable on public.betgirl_bet_legs;
create trigger betgirl_bet_legs_immutable
  before update or delete on public.betgirl_bet_legs
  for each row execute function public.betgirl_block_mutation();

alter table public.betgirl_bet_legs enable row level security;

drop policy if exists betgirl_bet_legs_read on public.betgirl_bet_legs;
create policy betgirl_bet_legs_read
  on public.betgirl_bet_legs for select to anon, authenticated using (true);
-- insert 정책 없음: 조합 등록 RPC(security definer)로만 기록된다.

grant select on public.betgirl_bet_legs to anon, authenticated;

-- ---------------------------------------------------------------- 2) 픽 채움 트리거 v3
-- event_id 가 null 인 삽입은 지금까지 "운영자 수동 기록"뿐이었다. 조합 티켓도 event_id 가
-- null 이므로, 조합 등록 RPC 가 세운 트랜잭션 로컬 플래그를 보고 통과시킨다.
-- (PostgREST 클라이언트는 이 GUC 를 세울 수 없다 — RPC 안에서만 켜진다)
create or replace function public.betgirl_fill_from_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev        public.betgirl_events%rowtype;
  opt       jsonb;
  v_balance bigint;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  if new.user_id is null then
    new.user_id := auth.uid();
  end if;

  if new.event_id is null then
    -- 조합 티켓: RPC 가 이미 다리·잔고·마감을 전부 검증했다.
    if coalesce(current_setting('betgirl.combo_bet', true), '') = '1' then
      new.placed_at := now();
      return new;
    end if;

    -- 수동 기록(실구매 증빙, 원 단위)은 운영자 전용. 벳 잔고 회계와 분리되어 있다.
    if not public.betgirl_is_operator() then
      raise exception '보드에 게시된 경기를 선택해야 픽을 등록할 수 있습니다.'
        using errcode = '42501';
    end if;
    new.placed_at := coalesce(new.placed_at, now());
    return new;
  end if;

  select * into ev from public.betgirl_events where id = new.event_id;
  if not found then
    raise exception '존재하지 않는 경기입니다.';
  end if;

  if ev.status <> 'open' then
    raise exception '마감된 경기에는 픽을 등록할 수 없습니다.' using errcode = '42501';
  end if;

  if now() >= ev.start_at then
    raise exception '경기가 이미 시작되었습니다. 시작 전에만 픽을 등록할 수 있습니다.'
      using errcode = '42501';
  end if;

  select o into opt
    from jsonb_array_elements(ev.options) o
   where o->>'code' = new.option_code
   limit 1;

  if opt is null then
    raise exception '경기에 없는 선택지입니다: %', new.option_code;
  end if;

  select balance into v_balance
    from public.betgirl_balances where handle = new.bettor;

  if v_balance is null then
    raise exception '참가자 프로필이 없습니다.';
  end if;

  if new.stake > v_balance then
    raise exception '소지금이 부족합니다. (보유 %벳, 베팅 %벳)', v_balance, new.stake
      using errcode = '42501';
  end if;

  new.event_key   := ev.round_key;
  new.sport       := ev.sport;
  new.league      := ev.league;
  new.match_label := ev.home || ' vs ' || ev.away;
  new.market      := ev.market;
  new.pick        := opt->>'label';
  new.odds        := (opt->>'odds')::numeric;
  new.placed_at   := now();

  return new;
end;
$$;

-- ---------------------------------------------------------------- 3) 조합 등록 RPC
-- p_legs 예: '[{"event_id":12,"code":"HOME"},{"event_id":15,"code":"AWAY"}]'
-- 경기명·선택지 라벨·배당은 전부 서버가 게시된 경기에서 복사한다 (클라이언트가 못 속임).
create or replace function public.betgirl_place_combo(
  p_stake bigint,
  p_legs  jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handle  text := public.betgirl_my_handle();
  v_uid     uuid := auth.uid();
  n         int;
  r         record;
  ev        public.betgirl_events%rowtype;
  opt       jsonb;
  v_odds    numeric := 1;
  v_parts   text[]  := '{}';
  v_seen    bigint[] := '{}';
  v_first   timestamptz;
  v_round   text;
  v_sport   text;
  v_league  text;
  v_balance bigint;
  v_seq     bigint;
begin
  if v_handle is null then
    raise exception '참가 등록 후 픽을 등록할 수 있습니다.' using errcode = '42501';
  end if;

  if p_legs is null or jsonb_typeof(p_legs) <> 'array' then
    raise exception '조합 픽 형식이 올바르지 않습니다.';
  end if;

  n := jsonb_array_length(p_legs);
  if n < 2 then
    raise exception '조합은 2경기 이상 담아야 합니다. (담긴 경기 %건)', n;
  end if;
  if n > 10 then
    raise exception '조합은 최대 10경기까지 담을 수 있습니다. (담긴 경기 %건)', n;
  end if;

  if p_stake is null or p_stake <= 0 then
    raise exception '베팅액이 올바르지 않습니다.';
  end if;
  if p_stake % 100 <> 0 then
    raise exception '베팅은 100벳 단위로만 가능합니다. (입력: %벳)', p_stake
      using errcode = '23514';
  end if;

  -- 싱글 픽 등록·정산과 같은 락. 잔고 확인~삽입이 직렬화된다.
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  for r in
    select (x->>'event_id')::bigint as event_id,
           upper(btrim(x->>'code')) as code,
           ord
      from jsonb_array_elements(p_legs) with ordinality t(x, ord)
     order by ord
  loop
    if r.event_id is null or coalesce(r.code, '') = '' then
      raise exception '조합 픽 형식이 올바르지 않습니다.';
    end if;

    if r.event_id = any (v_seen) then
      raise exception '같은 경기를 조합에 두 번 담을 수 없습니다.';
    end if;
    v_seen := v_seen || r.event_id;

    select * into ev from public.betgirl_events where id = r.event_id;
    if not found then
      raise exception '존재하지 않는 경기가 포함되어 있습니다.';
    end if;

    if ev.status <> 'open' then
      raise exception '마감된 경기가 포함되어 있습니다: % vs %', ev.home, ev.away
        using errcode = '42501';
    end if;

    if now() >= ev.start_at then
      raise exception '이미 시작된 경기가 포함되어 있습니다: % vs %', ev.home, ev.away
        using errcode = '42501';
    end if;

    select o into opt
      from jsonb_array_elements(ev.options) o
     where o->>'code' = r.code
     limit 1;

    if opt is null then
      raise exception '경기에 없는 선택지입니다: % (% vs %)', r.code, ev.home, ev.away;
    end if;

    v_odds  := v_odds * (opt->>'odds')::numeric;
    v_parts := v_parts || format('%s vs %s · %s (%s)',
                                 ev.home, ev.away, opt->>'label',
                                 to_char((opt->>'odds')::numeric, 'FM999990.00'));

    -- 회차·종목 표기는 가장 먼저 시작하는 경기 기준
    if v_first is null or ev.start_at < v_first then
      v_first  := ev.start_at;
      v_round  := ev.round_key;
      v_sport  := ev.sport;
      v_league := ev.league;
    end if;
  end loop;

  v_odds := round(v_odds, 2);
  if v_odds > 9999.99 then
    raise exception '조합 배당이 너무 큽니다(%). 경기 수를 줄여주세요.', v_odds;
  end if;

  select balance into v_balance from public.betgirl_balances where handle = v_handle;
  if v_balance is null then
    raise exception '참가자 프로필이 없습니다.';
  end if;
  if p_stake > v_balance then
    raise exception '소지금이 부족합니다. (보유 %벳, 베팅 %벳)', v_balance, p_stake
      using errcode = '42501';
  end if;

  perform set_config('betgirl.combo_bet', '1', true);

  insert into public.betgirl_bets
    (bettor, user_id, event_id, option_code, event_key, sport, league,
     match_label, market, pick, stake, odds, placed_at)
  values
    (v_handle, v_uid, null, null, v_round, v_sport, v_league,
     format('조합 %s경기', n), '조합', array_to_string(v_parts, ' + '),
     p_stake, v_odds, now())
  returning seq into v_seq;

  perform set_config('betgirl.combo_bet', '', true);

  insert into public.betgirl_bet_legs
    (bet_seq, leg_no, event_id, option_code, match_label, pick, odds)
  select v_seq, t.ord::int, e.id, upper(btrim(t.x->>'code')),
         e.home || ' vs ' || e.away,
         opt.o->>'label', (opt.o->>'odds')::numeric
    from jsonb_array_elements(p_legs) with ordinality t(x, ord)
    join public.betgirl_events e on e.id = (t.x->>'event_id')::bigint
   cross join lateral (
     select o from jsonb_array_elements(e.options) o
      where o->>'code' = upper(btrim(t.x->>'code')) limit 1
   ) opt(o);

  -- 다리가 하나라도 빠지면 티켓의 pick 문자열과 실제 구성이 어긋난다. 그럴 바엔 통째로 롤백한다.
  if (select count(*) from public.betgirl_bet_legs where bet_seq = v_seq) <> n then
    raise exception '조합 구성에 실패했습니다. 다시 시도해주세요.';
  end if;

  return v_seq;
end;
$$;

grant execute on function public.betgirl_place_combo(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------- 4) 조합 정산 스윕
-- 모든 다리의 결과가 확정된 미정산 조합을 한 번에 정산한다. 멱등(이미 정산된 건 건너뜀).
create or replace function public.betgirl_settle_combos(p_proof_url text default null)
returns table (settled_count int, win_count int, total_payout bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text := coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '');
  v_rate  numeric;
  c       record;
  l       record;
  v_odds  numeric;
  v_hit   int;
  v_void  int;
  v_lost  boolean;
  v_res   text;
  v_fee   bigint;
  v_pay   bigint;
  n_all   int := 0;
  n_win   int := 0;
  v_total bigint := 0;
begin
  if not public.betgirl_is_operator() and v_role <> 'service_role' then
    raise exception '운영자만 정산할 수 있습니다.' using errcode = '42501';
  end if;

  select rate into v_rate
    from public.betgirl_fee_policy
   where effective_from <= now()
   order by effective_from desc, seq desc
   limit 1;
  v_rate := coalesce(v_rate, 0);

  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  for c in
    select b.seq, b.stake
      from public.betgirl_bets b
     where exists (select 1 from public.betgirl_bet_legs g where g.bet_seq = b.seq)
       and not exists (select 1 from public.betgirl_settlements s where s.bet_seq = b.seq)
       and not exists (
             select 1
               from public.betgirl_bet_legs g
               join public.betgirl_events e on e.id = g.event_id
              where g.bet_seq = b.seq
                and e.result_code is null)          -- 아직 결과 없는 다리가 하나라도 있으면 보류
     order by b.seq
  loop
    v_odds := 1;
    v_hit  := 0;
    v_void := 0;
    v_lost := false;

    for l in
      select g.option_code, g.odds, e.result_code
        from public.betgirl_bet_legs g
        join public.betgirl_events e on e.id = g.event_id
       where g.bet_seq = c.seq
       order by g.leg_no
    loop
      if l.result_code = 'CANCEL' then
        v_void := v_void + 1;                        -- 취소 다리는 배당 1.00 처리
      elsif l.result_code = l.option_code then
        v_odds := v_odds * l.odds;
        v_hit  := v_hit + 1;
      else
        v_lost := true;
        exit;
      end if;
    end loop;

    if v_lost then
      v_res := 'lose'; v_fee := 0; v_pay := 0;
    elsif v_hit = 0 then
      v_res := 'void'; v_fee := 0; v_pay := c.stake; -- 전 다리 취소 → 원금 반환
    else
      v_res  := 'win';
      v_odds := round(v_odds, 2);
      v_fee  := floor(c.stake * v_rate)::bigint;
      v_pay  := greatest(floor(c.stake * v_odds)::bigint - v_fee, 0);
    end if;

    insert into public.betgirl_settlements (bet_seq, result, payout, fee, settled_at, proof_url, note)
    values (
      c.seq, v_res, v_pay, v_fee, now(), p_proof_url,
      case v_res
        when 'win'  then format('조합 정산 · 적용 배당 %s (적중 %s다리%s) · 수수료 %s벳(%s%%)',
                                to_char(v_odds, 'FM999990.00'), v_hit,
                                case when v_void > 0 then format(', 취소 %s다리 제외', v_void) else '' end,
                                v_fee, round(v_rate * 100, 1))
        when 'void' then '조합 전 경기 취소 — 원금 반환'
        else '조합 정산 — 한 다리 이상 미적중'
      end
    );

    n_all := n_all + 1;
    if v_res = 'win' then n_win := n_win + 1; end if;
    v_total := v_total + v_pay;
  end loop;

  return query select n_all, n_win, v_total;
end;
$$;

grant execute on function public.betgirl_settle_combos(text) to authenticated, service_role;

-- ---------------------------------------------------------------- 5) 경기 정산 RPC v6
-- 014(v5)와 같고, 마지막에 조합 스윕을 돌려 "마지막 다리가 확정된" 조합을 함께 정산한다.
-- 반환 건수에는 이번 트랜잭션에서 정산된 조합 티켓도 합산된다.
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
  cb      record;
  v_code  text;
  v_rate  numeric;
  v_win   boolean;
  v_fee   bigint;
  v_pay   bigint;
  n_all   int := 0;
  n_win   int := 0;
  v_total bigint := 0;
begin
  if not public.betgirl_is_operator() then
    raise exception '운영자만 정산할 수 있습니다.' using errcode = '42501';
  end if;

  if (p_proof_url is null or btrim(p_proof_url) = '')
     and not exists (select 1 from public.betgirl_events e0
                      where e0.id = p_event_id and e0.result_proof_url is not null) then
    raise exception '공식 결과 페이지 URL(증빙)이 필요합니다.' using errcode = '23514';
  end if;

  select rate into v_rate
    from public.betgirl_fee_policy
   where effective_from <= now()
   order by effective_from desc, seq desc
   limit 1;
  v_rate := coalesce(v_rate, 0);

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
     )
     -- 결과는 났는데 조합이 아직 안 붙은 경우가 있으므로, 미정산 조합이 남아 있으면 재실행 허용
     and not exists (
       select 1 from public.betgirl_bet_legs g
        where g.event_id = p_event_id
          and not exists (select 1 from public.betgirl_settlements s where s.bet_seq = g.bet_seq)
     ) then
    raise exception '이미 정산된 경기입니다.';
  end if;

  v_code := case when p_cancel then 'CANCEL' else p_winner_code end;

  if ev.result_code is not null and v_code is distinct from ev.result_code then
    raise exception '기존 확정 결과(%)와 다른 결과로는 재정산할 수 없습니다.', ev.result_code;
  end if;

  if not p_cancel then
    if p_winner_code is null
       or not exists (select 1 from jsonb_array_elements(ev.options) o
                       where o->>'code' = p_winner_code) then
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
      v_win := null; v_fee := 0; v_pay := r.stake;
    else
      v_win := (r.option_code = p_winner_code);
      if v_win then
        v_fee := floor(r.stake * v_rate)::bigint;
        v_pay := greatest(floor(r.stake * r.odds)::bigint - v_fee, 0);
      else
        v_fee := 0; v_pay := 0;
      end if;
    end if;

    insert into public.betgirl_settlements (bet_seq, result, payout, fee, settled_at, proof_url, note)
    values (
      r.seq,
      case when p_cancel then 'void' when v_win then 'win' else 'lose' end,
      v_pay, v_fee, now(), p_proof_url,
      case when p_cancel then '경기 취소 일괄 정산'
           when v_win then format('경기 결과 일괄 정산 · 수수료 %s벳(%s%%)', v_fee, round(v_rate * 100, 1))
           else '경기 결과 일괄 정산' end
    );

    n_all := n_all + 1;
    if v_win then n_win := n_win + 1; end if;
    v_total := v_total + v_pay;
  end loop;

  -- 결과를 먼저 기록해야 조합 스윕이 이 경기를 '확정'으로 본다.
  update public.betgirl_events
     set status = 'settled',
         result_code = coalesce(ev.result_code, v_code),
         result_at = coalesce(ev.result_at, now()),
         result_proof_url = coalesce(ev.result_proof_url, p_proof_url)
   where id = p_event_id;

  select * into cb from public.betgirl_settle_combos(p_proof_url);
  n_all   := n_all + coalesce(cb.settled_count, 0);
  n_win   := n_win + coalesce(cb.win_count, 0);
  v_total := v_total + coalesce(cb.total_payout, 0);

  return query select n_all, n_win, v_total;
end;
$$;

grant execute on function public.betgirl_settle_event(bigint, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------- 6) 뷰 갱신
-- 조합 티켓은 event_id 가 null 이라 기존 "보드 픽" 판별식(event_id is not null)에서 빠진다.
-- 다리가 있는 행도 보드 픽으로 본다. (운영자 수동 기록만 계속 제외)
create or replace view public.betgirl_balances as
select
  p.handle, p.user_id,
  coalesce(cr.granted, 0)  as granted,
  coalesce(b.staked, 0)    as staked,
  coalesce(s.returned, 0)  as returned,
  coalesce(cr.granted, 0) - coalesce(b.staked, 0) + coalesce(s.returned, 0)
    - coalesce(rd.requested, 0) + coalesce(rd.refunded, 0)
    - coalesce(dr.drawn, 0) as balance
from public.betgirl_profiles p
left join (select handle, sum(amount) granted from public.betgirl_credits group by handle) cr
       on cr.handle = p.handle
left join (select bettor, sum(stake) staked from public.betgirl_bets b
            where b.event_id is not null
               or exists (select 1 from public.betgirl_bet_legs g where g.bet_seq = b.seq)
            group by bettor) b on b.bettor = p.handle
left join (select bt.bettor, sum(st.payout) returned
             from public.betgirl_settlements st
             join public.betgirl_bets bt on bt.seq = st.bet_seq
            where bt.event_id is not null
               or exists (select 1 from public.betgirl_bet_legs g where g.bet_seq = bt.seq)
            group by bt.bettor) s on s.bettor = p.handle
left join (select handle,
                  sum(cost) filter (where kind = 'request' and via_draw_seq is null) as requested,
                  sum(cost) filter (where kind = 'reject'  and via_draw_seq is null) as refunded
             from public.betgirl_redemptions group by handle) rd on rd.handle = p.handle
left join (select handle, sum(cost) drawn from public.betgirl_draws group by handle) dr
       on dr.handle = p.handle;

create or replace view public.betgirl_wallet_history as
select 'credit' as kind, c.handle, c.created_at as at, c.reason as label,
       c.amount as delta, null::bigint as bet_seq
  from public.betgirl_credits c
union all
select 'stake', b.bettor, b.placed_at, '픽 — ' || b.match_label || ' · ' || b.pick, -b.stake, b.seq
  from public.betgirl_bets b
 where b.event_id is not null
    or exists (select 1 from public.betgirl_bet_legs g where g.bet_seq = b.seq)
union all
select 'payout', bt.bettor, s.settled_at,
       case s.result when 'win' then '적중 — ' when 'void' then '무효 반환 — '
                     when 'cancel' then '취소 반환 — ' else '미적중 — ' end
         || bt.match_label || ' · ' || bt.pick,
       s.payout, bt.seq
  from public.betgirl_settlements s
  join public.betgirl_bets bt on bt.seq = s.bet_seq
 where bt.event_id is not null
    or exists (select 1 from public.betgirl_bet_legs g where g.bet_seq = bt.seq)
union all
select 'draw', d.handle, d.created_at,
       case when d.win then '가차 당첨 🎉 — ' else '가차 미당첨 — ' end
         || d.item || ' (' || case d.mode when 'sure' then '확정' when 'half' then '50%' else '10%' end || ')',
       -d.cost, d.seq
  from public.betgirl_draws d
union all
select case r.kind when 'request' then 'redeem_request'
                   when 'reject'  then 'redeem_refund' else 'redeem_done' end,
       r.handle, r.created_at,
       case r.kind when 'request' then case when r.via_draw_seq is null then '교환 신청 — ' else '가차 상품 확정 — ' end
                   when 'reject'  then '교환 반려 환급 — ' else '상품 지급 완료 — ' end || r.item,
       case when r.via_draw_seq is not null then 0
            when r.kind = 'request' then -r.cost
            when r.kind = 'reject'  then r.cost
            else 0 end,
       r.seq
  from public.betgirl_redemptions r;

-- 보드의 '등록된 픽 N건 · 합계'에 조합 다리도 포함한다.
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
  e.result_code, e.result_at, e.result_proof_url
from public.betgirl_events e;

-- 원장 화면이 조합 티켓의 다리와 다리별 결과를 보여줄 수 있게 하는 공개 뷰
create or replace view public.betgirl_legs as
select
  g.seq, g.bet_seq, g.leg_no, g.event_id, g.match_label, g.pick, g.odds,
  e.start_at, e.result_code,
  case
    when e.result_code is null            then 'pending'
    when e.result_code = 'CANCEL'         then 'void'
    when e.result_code = g.option_code    then 'win'
    else 'lose'
  end as leg_status
from public.betgirl_bet_legs g
join public.betgirl_events e on e.id = g.event_id;

grant select on public.betgirl_balances, public.betgirl_wallet_history to anon, authenticated;
grant select on public.betgirl_board, public.betgirl_legs to anon, authenticated;

-- ---------------------------------------------------------------- 확인
select 'ok' as status,
       (select count(*) from public.betgirl_bet_legs) as legs,
       (select count(*) from public.betgirl_bets where event_id is null) as non_board_bets;
