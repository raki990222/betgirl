-- betgirl 011 — 보상·교환의 공개 원장 편입 (SQL Editor 1회 실행, 010 이후)
--
-- 벳의 "발생(적립)"과 "소멸(교환)"까지 베팅과 동일한 체계로 만든다:
--   · betgirl_credits 에 SHA-256 해시 체인 추가 (기존 행 소급 체인화)
--   · betgirl_redemptions 신설 — 기프티콘 교환 신청/완료/반려, 추가 전용 + 해시 체인
--   · 잔고·소지금 내역·앵커링·브라우저 검증이 4개 체인(베팅·정산·적립·교환)을 모두 다룬다
--   · 걸음 적립 일일 한도(100벳) DB 강제 — 앱이 뚫려도 DB가 막는다
--
-- 앱(걸음 수집·보물상자)은 별도 프로젝트다. 앱이 붙을 때도 적립은 이 테이블에
-- reason='걸음 적립' 으로 INSERT 하는 것뿐이며, 그 순간부터 자동으로 공개·체인·앵커링된다.

-- ---------------------------------------------------------------- credits 체인화
alter table public.betgirl_credits
  add column if not exists expires_at timestamptz,        -- 유효기간 정책(법무 검토 후) 자리
  add column if not exists prev_hash  text,
  add column if not exists canonical  text,
  add column if not exists row_hash   text;

create or replace function public.betgirl_chain_credit()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_credits'));

  -- identity seq 는 락 획득 '전'에 배정되므로, 락 순서와 seq 순서가 어긋나면 체인이
  -- 영구 분기한다. 락 안에서 seq 를 커밋된 최대값+1 로 재배정해 두 순서를 일치시킨다.
  select coalesce(max(c.seq), 0) + 1 into new.seq from public.betgirl_credits c;

  -- 적립 시각은 서버가 기록한다 (백데이트로 일일 캡을 우회할 수 없게).
  new.created_at := date_trunc('second', now());

  select c.row_hash into v_prev
    from public.betgirl_credits c
   order by c.seq desc
   limit 1;

  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.canonical := concat_ws('|',
    'credit',
    new.handle,
    new.amount::text,
    new.reason,
    to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  new.row_hash := encode(extensions.digest(new.prev_hash || new.canonical, 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists betgirl_credits_chain on public.betgirl_credits;
create trigger betgirl_credits_chain
  before insert on public.betgirl_credits
  for each row execute function public.betgirl_chain_credit();

-- 기존 행 소급 체인화 (immutability 트리거를 잠시 내리고 seq 순서로 계산)
alter table public.betgirl_credits disable trigger betgirl_credits_immutable;
do $$
declare
  r      record;
  v_prev text := repeat('0', 64);
  v_can  text;
begin
  for r in select * from public.betgirl_credits order by seq loop
    v_can := concat_ws('|',
      'credit', r.handle, r.amount::text, r.reason,
      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    update public.betgirl_credits
       set prev_hash = v_prev,
           canonical = v_can,
           row_hash  = encode(extensions.digest(v_prev || v_can, 'sha256'), 'hex')
     where seq = r.seq;
    select row_hash into v_prev from public.betgirl_credits where seq = r.seq;
  end loop;
end;
$$;
alter table public.betgirl_credits enable trigger betgirl_credits_immutable;

-- 백필 완료 후 체인 컬럼을 NOT NULL 로 승격 — "체인 없는 적립 행"이 존재할 수 없게 한다.
-- (검증 화면이 결측 행을 건너뛰는 게 아니라, 애초에 결측 행이 못 들어온다)
alter table public.betgirl_credits
  alter column prev_hash set not null,
  alter column canonical set not null,
  alter column row_hash  set not null;

-- ---------------------------------------------------------------- 걸음 적립 일일 한도
create or replace function public.betgirl_steps_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today bigint;
begin
  -- 캡 검사 전에 직렬화 락을 먼저 잡는다 (체인 트리거와 같은 키 — 재획득 무해).
  -- 안 잡으면 동시 요청 N개가 전부 캡 검사를 통과하는 TOCTOU 가 된다.
  perform pg_advisory_xact_lock(hashtext('betgirl_credits'));

  -- reason 공백·변형('걸음적립', '걸음 보상' 등)으로 캡을 피할 수 없게 정규화 매칭.
  -- created_at 은 체인 트리거가 now() 로 강제하므로 백데이트 우회도 불가능.
  if replace(new.reason, ' ', '') like '걸음%' then
    select coalesce(sum(amount), 0) into v_today
      from public.betgirl_credits
     where handle = new.handle
       and replace(reason, ' ', '') like '걸음%'
       and (created_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date;

    if v_today + new.amount > 100 then
      raise exception '걸음 적립 일일 한도(100벳)를 초과합니다. (오늘 %벳 적립됨)', v_today
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- 'a_' 접두로 체인 트리거(betgirl_credits_chain)보다 먼저 실행
drop trigger if exists betgirl_credits_a_steps_cap on public.betgirl_credits;
create trigger betgirl_credits_a_steps_cap
  before insert on public.betgirl_credits
  for each row execute function public.betgirl_steps_cap();

-- ---------------------------------------------------------------- 교환 원장
create table if not exists public.betgirl_redemptions (
  seq         bigint generated always as identity primary key,
  kind        text   not null check (kind in ('request', 'fulfill', 'reject')),
  user_id     uuid references auth.users(id),
  handle      text   not null,
  item        text   not null,                    -- 교환 상품명 (예: 스타벅스 아메리카노)
  cost        bigint not null check (cost > 0),   -- 차감 벳
  request_seq bigint references public.betgirl_redemptions(seq),
  proof_url   text,                               -- 발송 증빙 (fulfill)
  note        text,
  created_at  timestamptz not null default now(),
  prev_hash   text not null,
  canonical   text not null,
  row_hash    text not null
);

-- 신청 1건당 처리(fulfill/reject)는 1건만
create unique index if not exists betgirl_redemptions_one_resolution
  on public.betgirl_redemptions (request_seq)
  where kind in ('fulfill', 'reject');

-- 검증·처리 규칙 (체인 트리거보다 먼저: 'a_' 접두)
create or replace function public.betgirl_redemption_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  req       public.betgirl_redemptions%rowtype;
  v_balance bigint;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));   -- 전역 잔고 락 (베팅과 동일 키)

  if new.kind = 'request' then
    new.user_id := coalesce(new.user_id, auth.uid());
    new.request_seq := null;

    if not public.betgirl_is_operator() then
      if new.handle is distinct from public.betgirl_my_handle() then
        raise exception '본인 이름으로만 교환을 신청할 수 있습니다.' using errcode = '42501';
      end if;
    end if;

    select balance into v_balance from public.betgirl_balances where handle = new.handle;
    if v_balance is null then
      raise exception '참가자 프로필이 없습니다.';
    end if;
    if new.cost > v_balance then
      raise exception '소지금이 부족합니다. (보유 %벳, 신청 %벳)', v_balance, new.cost
        using errcode = '42501';
    end if;

  else  -- fulfill / reject
    if not public.betgirl_is_operator() then
      raise exception '교환 처리는 운영자만 할 수 있습니다.' using errcode = '42501';
    end if;
    if new.request_seq is null then
      raise exception '처리할 신청 번호(request_seq)가 필요합니다.';
    end if;

    select * into req from public.betgirl_redemptions
     where seq = new.request_seq and kind = 'request';
    if not found then
      raise exception '존재하지 않는 교환 신청입니다: %', new.request_seq;
    end if;

    -- 신청 내용을 서버가 복사한다 (클라이언트 값 무시)
    new.user_id := req.user_id;
    new.handle  := req.handle;
    new.item    := req.item;
    new.cost    := req.cost;
  end if;

  return new;
end;
$$;

create or replace function public.betgirl_chain_redemption()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_redemptions'));

  -- 락 순서 = seq 순서 보장 (credits 와 동일한 분기 방지)
  select coalesce(max(r.seq), 0) + 1 into new.seq from public.betgirl_redemptions r;

  new.created_at := date_trunc('second', now());

  select r.row_hash into v_prev
    from public.betgirl_redemptions r
   order by r.seq desc
   limit 1;

  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.canonical := concat_ws('|',
    'redeem',
    new.kind,
    new.handle,
    new.item,
    new.cost::text,
    coalesce(new.request_seq::text, ''),
    to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  new.row_hash := encode(extensions.digest(new.prev_hash || new.canonical, 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists betgirl_redemptions_a_guard on public.betgirl_redemptions;
create trigger betgirl_redemptions_a_guard
  before insert on public.betgirl_redemptions
  for each row execute function public.betgirl_redemption_guard();

drop trigger if exists betgirl_redemptions_b_chain on public.betgirl_redemptions;
create trigger betgirl_redemptions_b_chain
  before insert on public.betgirl_redemptions
  for each row execute function public.betgirl_chain_redemption();

drop trigger if exists betgirl_redemptions_immutable on public.betgirl_redemptions;
create trigger betgirl_redemptions_immutable
  before update or delete on public.betgirl_redemptions
  for each row execute function public.betgirl_block_mutation();

alter table public.betgirl_redemptions enable row level security;

drop policy if exists betgirl_redemptions_public_read on public.betgirl_redemptions;
create policy betgirl_redemptions_public_read
  on public.betgirl_redemptions for select to anon, authenticated using (true);

drop policy if exists betgirl_redemptions_insert on public.betgirl_redemptions;
create policy betgirl_redemptions_insert
  on public.betgirl_redemptions for insert to authenticated
  with check (
    public.betgirl_is_operator()
    or (kind = 'request' and user_id = auth.uid())
  );

grant select on public.betgirl_redemptions to anon, authenticated;
grant insert on public.betgirl_redemptions to authenticated;

-- ---------------------------------------------------------------- 잔고 v3
-- 잔고 = 지급 − 픽 베팅 + 정산 회수 − 교환 신청 + 교환 반려 환급
create or replace view public.betgirl_balances as
select
  p.handle,
  p.user_id,
  coalesce(cr.granted, 0)  as granted,
  coalesce(b.staked, 0)    as staked,
  coalesce(s.returned, 0)  as returned,
  coalesce(cr.granted, 0) - coalesce(b.staked, 0) + coalesce(s.returned, 0)
    - coalesce(rd.requested, 0) + coalesce(rd.refunded, 0) as balance
from public.betgirl_profiles p
left join (select handle, sum(amount) granted from public.betgirl_credits group by handle) cr
       on cr.handle = p.handle
left join (
  select bettor, sum(stake) staked
    from public.betgirl_bets where event_id is not null group by bettor
) b on b.bettor = p.handle
left join (
  select bt.bettor, sum(st.payout) returned
    from public.betgirl_settlements st
    join public.betgirl_bets bt on bt.seq = st.bet_seq
   where bt.event_id is not null
   group by bt.bettor
) s on s.bettor = p.handle
left join (
  select handle,
         sum(cost) filter (where kind = 'request') as requested,
         sum(cost) filter (where kind = 'reject')  as refunded
    from public.betgirl_redemptions
   group by handle
) rd on rd.handle = p.handle;

-- ---------------------------------------------------------------- 소지금 내역 v2
create or replace view public.betgirl_wallet_history as
select 'credit' as kind, c.handle, c.created_at as at, c.reason as label,
       c.amount as delta, null::bigint as bet_seq
  from public.betgirl_credits c
union all
select 'stake', b.bettor, b.placed_at, '픽 — ' || b.match_label || ' · ' || b.pick,
       -b.stake, b.seq
  from public.betgirl_bets b
 where b.event_id is not null
union all
select 'payout', bt.bettor, s.settled_at,
       case s.result
         when 'win'    then '적중 — '
         when 'void'   then '무효 반환 — '
         when 'cancel' then '취소 반환 — '
         else               '미적중 — '
       end || bt.match_label || ' · ' || bt.pick,
       s.payout, bt.seq
  from public.betgirl_settlements s
  join public.betgirl_bets bt on bt.seq = s.bet_seq
 where bt.event_id is not null
union all
select case r.kind when 'request' then 'redeem_request'
                   when 'reject'  then 'redeem_refund'
                   else 'redeem_done' end,
       r.handle, r.created_at,
       case r.kind when 'request' then '교환 신청 — '
                   when 'reject'  then '교환 반려 환급 — '
                   else '교환 완료 — ' end || r.item,
       case r.kind when 'request' then -r.cost
                   when 'reject'  then r.cost
                   else 0 end,
       r.seq
  from public.betgirl_redemptions r;

grant select on public.betgirl_balances, public.betgirl_wallet_history to anon, authenticated;

-- ---------------------------------------------------------------- 베팅·정산 체인도 seq 재배정
-- 같은 분기 레이스가 002의 두 트리거에도 있었다 (identity 가 락보다 먼저 배정됨).
-- 락 안에서 seq 를 재배정해 네 체인 모두 "락 순서 = seq 순서"를 보장한다.
create or replace function public.betgirl_chain_bet()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  select coalesce(max(b.seq), 0) + 1 into new.seq from public.betgirl_bets b;

  new.placed_at := date_trunc('second', new.placed_at);

  select b.row_hash into v_prev
    from public.betgirl_bets b
   order by b.seq desc
   limit 1;

  new.prev_hash := coalesce(v_prev, repeat('0', 64));

  new.canonical := concat_ws('|',
    'bet',
    new.bettor,
    new.event_key,
    new.match_label,
    new.market,
    new.pick,
    new.stake::text,
    to_char(new.odds, 'FM999999990.00'),
    to_char(new.placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    coalesce(new.ticket_no, '')
  );

  new.row_hash := encode(extensions.digest(new.prev_hash || new.canonical, 'sha256'), 'hex');
  return new;
end;
$$;

create or replace function public.betgirl_chain_settlement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_settlements'));

  select coalesce(max(s.seq), 0) + 1 into new.seq from public.betgirl_settlements s;

  new.settled_at := date_trunc('second', new.settled_at);

  select s.row_hash into v_prev
    from public.betgirl_settlements s
   order by s.seq desc
   limit 1;

  new.prev_hash := coalesce(v_prev, repeat('0', 64));

  new.canonical := concat_ws('|',
    'settle',
    new.bet_seq::text,
    new.result,
    new.payout::text,
    to_char(new.settled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  new.row_hash := encode(extensions.digest(new.prev_hash || new.canonical, 'sha256'), 'hex');
  return new;
end;
$$;

-- ---------------------------------------------------------------- 확인
select handle, granted, staked, returned, balance from public.betgirl_balances;
select seq, handle, amount, reason,
       left(prev_hash, 8) as prev8, left(row_hash, 8) as hash8
  from public.betgirl_credits order by seq;
