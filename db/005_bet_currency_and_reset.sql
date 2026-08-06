-- betgirl 005 — 벳(BET) 포인트 전환 + 테스트 기록 리셋 + 경기 단위 정산
-- 001~004 실행 후 1회 실행한다.
--
-- 이 마이그레이션 이후 모든 금액(stake/payout/credit)의 단위는 사이트 포인트 '벳'이다.
-- 벳은 현금이 아니며 환전되지 않는다 (1원 = 10벳 감각, 추후 상품 교환 센터 예정).
--
-- 하는 일
--   1) 테스트 픽/원장 리셋 (실기록 없음 확인: raki 테스트 2건뿐) + 예시 경기 삭제
--   2) 옵션 순서를 HOME 좌측으로 통일 (betman 표기 관행)
--   3) betgirl_credits (벳 지급 내역, 추가 전용·공개) + 가입 축하 1,000,000벳 자동 지급
--   4) betgirl_balances (핸들별 잔고 = 지급 − 베팅 + 회수)
--   5) 픽 등록 시 잔고 검사 (소지금 초과 베팅 차단)
--   6) 경기명 표기를 '홈 vs 원정' 으로 (신규 기록부터)
--   7) betgirl_settle_event() — 경기 결과 한 번에 정산하는 운영자 RPC

-- ---------------------------------------------------------------- 1) 리셋
truncate table public.betgirl_settlements, public.betgirl_bets restart identity;

delete from public.betgirl_events where note = '예시 데이터';

-- ---------------------------------------------------------------- 2) HOME 좌측 정렬
update public.betgirl_events e
   set options = (
     select jsonb_agg(o order by case o->>'code'
                                   when 'HOME' then 1
                                   when 'DRAW' then 2
                                   else 3 end)
       from jsonb_array_elements(e.options) o
   )
 where e.status = 'open';

-- ---------------------------------------------------------------- 3) 벳 지급 내역
create table if not exists public.betgirl_credits (
  seq        bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  handle     text        not null,
  amount     bigint      not null check (amount > 0),
  reason     text        not null,
  created_at timestamptz not null default now()
);

drop trigger if exists betgirl_credits_immutable on public.betgirl_credits;
create trigger betgirl_credits_immutable
  before update or delete on public.betgirl_credits
  for each row execute function public.betgirl_block_mutation();

-- 가입(핸들 확정) 시 자동 지급
create or replace function public.betgirl_welcome_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.betgirl_credits (user_id, handle, amount, reason)
  values (new.user_id, new.handle, 1000000, '가입 축하 벳');
  return new;
end;
$$;

drop trigger if exists betgirl_profiles_welcome on public.betgirl_profiles;
create trigger betgirl_profiles_welcome
  after insert on public.betgirl_profiles
  for each row execute function public.betgirl_welcome_credit();

-- 기존 참가자 소급 지급 (이미 받은 사람은 제외)
insert into public.betgirl_credits (user_id, handle, amount, reason)
select p.user_id, p.handle, 1000000, '가입 축하 벳'
  from public.betgirl_profiles p
 where not exists (
   select 1 from public.betgirl_credits c
    where c.handle = p.handle and c.reason = '가입 축하 벳'
 );

-- ---------------------------------------------------------------- 4) 잔고 뷰
-- 벳 회계는 보드 픽(event_id 있는 기록)만 집계한다.
-- 운영자 수동 기록(event_id null)은 실구매(원 단위) 증빙이라 벳 잔고와 섞지 않는다.
create or replace view public.betgirl_balances as
select
  p.handle,
  p.user_id,
  coalesce(cr.granted, 0)                                as granted,
  coalesce(b.staked, 0)                                  as staked,
  coalesce(s.returned, 0)                                as returned,
  coalesce(cr.granted, 0) - coalesce(b.staked, 0) + coalesce(s.returned, 0) as balance
from public.betgirl_profiles p
left join (select handle, sum(amount) granted from public.betgirl_credits group by handle) cr
       on cr.handle = p.handle
left join (
  select bettor, sum(stake) staked
    from public.betgirl_bets
   where event_id is not null
   group by bettor
) b on b.bettor = p.handle
left join (
  select bt.bettor, sum(st.payout) returned
    from public.betgirl_settlements st
    join public.betgirl_bets bt on bt.seq = st.bet_seq
   where bt.event_id is not null
   group by bt.bettor
) s on s.bettor = p.handle;

-- ---------------------------------------------------------------- 5)+6) 픽 채움 트리거 갱신
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
  -- 모든 베팅 기록을 하나의 락으로 직렬화한다. 체인 트리거와 같은 키라 같은 트랜잭션의
  -- 재획득은 무해하고, 잔고 검사~삽입~정산 RPC 가 전부 이 락 뒤에서 순차 실행된다.
  -- (락 획득 후의 SELECT 는 READ COMMITTED 에서 최신 커밋 상태를 보므로
  --  병렬 요청 2개가 같은 잔고를 읽는 이중 지출이 차단된다)
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  if new.user_id is null then
    new.user_id := auth.uid();
  end if;

  if new.event_id is null then
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

  -- 소지금 검사 (같은 트랜잭션의 체인 락과 별개로, 잔고는 커밋된 기록 기준)
  select balance into v_balance
    from public.betgirl_balances where handle = new.bettor;

  if v_balance is null then
    raise exception '참가자 프로필이 없습니다.';
  end if;

  if new.stake > v_balance then
    raise exception '소지금이 부족합니다. (보유 %벳, 베팅 %벳)', v_balance, new.stake
      using errcode = '42501';
  end if;

  -- 게시된 정보로 덮어쓴다. 클라이언트가 보낸 경기명·배당은 무시된다.
  new.event_key   := ev.round_key;
  new.sport       := ev.sport;
  new.league      := ev.league;
  new.match_label := ev.home || ' vs ' || ev.away;
  new.market      := ev.market;
  new.pick        := opt->>'label';
  new.odds        := (opt->>'odds')::numeric;
  -- 픽 시각은 서버가 기록한다. '경기 시작 전 픽' 증명이 이 값에 걸려 있으므로
  -- 클라이언트 지정을 허용하지 않는다.
  new.placed_at   := now();

  return new;
end;
$$;

-- ---------------------------------------------------------------- 7) 경기 단위 정산 RPC
-- winner_code: 'HOME'/'DRAW'/'AWAY' 중 하나, 또는 null + p_cancel=true → 전 픽 무효(원금 반환)
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
  v_win   boolean;
  v_pay   bigint;
  n_all   int := 0;
  n_win   int := 0;
  v_total bigint := 0;
begin
  if not public.betgirl_is_operator() then
    raise exception '운영자만 정산할 수 있습니다.' using errcode = '42501';
  end if;

  -- 픽 등록 트리거와 같은 락을 '먼저' 잡는다 (락 순서: bets → 이벤트 행).
  -- 정산 중에는 어떤 픽도 삽입될 수 없어 낙오 픽이 생기지 않고,
  -- 픽 쪽도 bets 락을 먼저 잡으므로 (advisory → FK 행잠금) 교착이 없다.
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  select * into ev from public.betgirl_events where id = p_event_id for update;
  if not found then
    raise exception '존재하지 않는 경기입니다.';
  end if;

  -- settled 여도 미정산 픽이 남아 있으면 복구 재실행을 허용한다.
  if ev.status = 'settled'
     and not exists (
       select 1 from public.betgirl_bets b
        where b.event_id = p_event_id
          and not exists (select 1 from public.betgirl_settlements s where s.bet_seq = b.seq)
     ) then
    raise exception '이미 정산된 경기입니다.';
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

  -- 미정산 픽을 순서대로 정산한다 (체인 트리거가 advisory lock 으로 직렬화)
  for r in
    select b.seq, b.stake, b.odds, b.option_code
      from public.betgirl_bets b
     where b.event_id = p_event_id
       and not exists (select 1 from public.betgirl_settlements s where s.bet_seq = b.seq)
     order by b.seq
  loop
    if p_cancel then
      v_win := null;
      v_pay := r.stake;                                   -- 무효: 원금 반환
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

  update public.betgirl_events set status = 'settled' where id = p_event_id;

  return query select n_all, n_win, v_total;
end;
$$;

-- ---------------------------------------------------------------- RLS / 권한
alter table public.betgirl_credits enable row level security;

drop policy if exists betgirl_credits_public_read on public.betgirl_credits;
create policy betgirl_credits_public_read
  on public.betgirl_credits for select to anon, authenticated using (true);

drop policy if exists betgirl_credits_op_insert on public.betgirl_credits;
create policy betgirl_credits_op_insert
  on public.betgirl_credits for insert to authenticated
  with check (public.betgirl_is_operator());

grant select on public.betgirl_credits, public.betgirl_balances to anon, authenticated;
grant insert on public.betgirl_credits to authenticated;
grant execute on function public.betgirl_settle_event(bigint, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------- 확인
select handle, granted, staked, returned, balance from public.betgirl_balances;
select id, round_key, home, away, options->0->>'label' as left_option, status
  from public.betgirl_events order by start_at, id limit 5;
