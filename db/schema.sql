-- betgirl.site — 공개 베팅 장부 스키마
-- Supabase SQL Editor에서 한 번만 실행한다.
--
-- 설계 원칙
--   1) 베팅(bets)과 정산(settlements)은 각각 append-only. UPDATE/DELETE를 트리거로 차단한다.
--   2) 각 테이블은 자체 해시 체인(prev_hash → row_hash)을 가진다. 과거 행을 하나라도
--      고치면 이후 모든 row_hash가 어긋나므로 브라우저에서 위변조를 검증할 수 있다.
--   3) 읽기는 anon 공개, 쓰기는 authenticated(운영자 로그인)만.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- 베팅 (append-only)
create table if not exists public.betgirl_bets (
  seq          bigint generated always as identity primary key,
  bettor       text        not null,                 -- 참가자 핸들
  event_key    text        not null,                 -- 예: 2026-08-05 프로토 승부식 12회차
  sport        text,
  league       text,
  match_label  text        not null,                 -- 예: 토트넘 vs 아스널
  market       text        not null default '승무패', -- 승무패 / 핸디캡 / 언더오버 …
  pick         text        not null,                 -- 실제 선택
  stake        bigint      not null check (stake > 0),
  odds         numeric(6,2) not null check (odds >= 1),
  placed_at    timestamptz not null,                 -- 베팅 시각(초 단위로 절삭)
  ticket_no    text,                                 -- betman 구매번호
  proof_url    text,                                 -- 구매내역 캡처 URL
  note         text,
  created_at   timestamptz not null default now(),
  prev_hash    text        not null,
  canonical    text        not null,
  row_hash     text        not null
);

-- ---------------------------------------------------------------- 정산 (append-only)
create table if not exists public.betgirl_settlements (
  seq         bigint generated always as identity primary key,
  bet_seq     bigint      not null unique references public.betgirl_bets(seq),
  result      text        not null check (result in ('win','lose','void','cancel')),
  payout      bigint      not null default 0 check (payout >= 0),
  settled_at  timestamptz not null,
  proof_url   text,
  note        text,
  created_at  timestamptz not null default now(),
  prev_hash   text        not null,
  canonical   text        not null,
  row_hash    text        not null
);

create index if not exists betgirl_bets_placed_at_idx on public.betgirl_bets (placed_at desc);
create index if not exists betgirl_bets_bettor_idx    on public.betgirl_bets (bettor);

-- ---------------------------------------------------------------- 해시 체인 트리거
create or replace function public.betgirl_chain_bet()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  new.placed_at := date_trunc('second', new.placed_at);

  select b.row_hash into v_prev
    from public.betgirl_bets b
   order by b.seq desc
   limit 1;

  new.prev_hash := coalesce(v_prev, repeat('0', 64));

  -- 정규화 문자열: 프런트엔드(app.js canonicalBet)와 반드시 동일해야 한다.
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

-- ---------------------------------------------------------------- append-only 강제
create or replace function public.betgirl_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% 는 추가 전용 원장입니다. 수정/삭제할 수 없습니다. (정정은 void/cancel 정산 행으로 남기세요)', tg_table_name
    using errcode = '42501';
end;
$$;

drop trigger if exists betgirl_bets_chain on public.betgirl_bets;
create trigger betgirl_bets_chain
  before insert on public.betgirl_bets
  for each row execute function public.betgirl_chain_bet();

drop trigger if exists betgirl_bets_immutable on public.betgirl_bets;
create trigger betgirl_bets_immutable
  before update or delete on public.betgirl_bets
  for each row execute function public.betgirl_block_mutation();

drop trigger if exists betgirl_settlements_chain on public.betgirl_settlements;
create trigger betgirl_settlements_chain
  before insert on public.betgirl_settlements
  for each row execute function public.betgirl_chain_settlement();

drop trigger if exists betgirl_settlements_immutable on public.betgirl_settlements;
create trigger betgirl_settlements_immutable
  before update or delete on public.betgirl_settlements
  for each row execute function public.betgirl_block_mutation();

-- ---------------------------------------------------------------- 뷰
create or replace view public.betgirl_ledger as
select
  b.seq,
  b.bettor,
  b.event_key,
  b.sport,
  b.league,
  b.match_label,
  b.market,
  b.pick,
  b.stake,
  b.odds,
  b.placed_at,
  b.ticket_no,
  b.proof_url,
  b.note,
  b.prev_hash,
  b.canonical,
  b.row_hash,
  s.seq        as settlement_seq,
  s.result,
  s.payout,
  s.settled_at,
  s.proof_url  as settle_proof_url,
  case when s.seq is null then 'pending' else s.result end as status,
  case when s.seq is null then null else s.payout - b.stake end as net
from public.betgirl_bets b
left join public.betgirl_settlements s on s.bet_seq = b.seq;

create or replace view public.betgirl_stats as
select
  bettor,
  count(*)                                              as bets,
  count(*) filter (where status = 'pending')            as pending,
  count(*) filter (where status = 'win')                as wins,
  count(*) filter (where status = 'lose')               as losses,
  count(*) filter (where status in ('void','cancel'))   as voids,
  sum(stake)                                            as staked,
  coalesce(sum(payout), 0)                              as returned,
  coalesce(sum(net), 0)                                 as net,
  round(
    100.0 * count(*) filter (where status = 'win')
    / nullif(count(*) filter (where status in ('win','lose')), 0)
  , 1)                                                  as hit_rate,
  round(
    100.0 * coalesce(sum(net) filter (where status <> 'pending'), 0)
    / nullif(sum(stake) filter (where status <> 'pending'), 0)
  , 1)                                                  as roi
from public.betgirl_ledger
group by bettor;

-- ---------------------------------------------------------------- RLS / 권한
alter table public.betgirl_bets        enable row level security;
alter table public.betgirl_settlements enable row level security;

drop policy if exists betgirl_bets_public_read on public.betgirl_bets;
create policy betgirl_bets_public_read
  on public.betgirl_bets for select to anon, authenticated using (true);

drop policy if exists betgirl_bets_admin_insert on public.betgirl_bets;
create policy betgirl_bets_admin_insert
  on public.betgirl_bets for insert to authenticated with check (true);

drop policy if exists betgirl_settlements_public_read on public.betgirl_settlements;
create policy betgirl_settlements_public_read
  on public.betgirl_settlements for select to anon, authenticated using (true);

drop policy if exists betgirl_settlements_admin_insert on public.betgirl_settlements;
create policy betgirl_settlements_admin_insert
  on public.betgirl_settlements for insert to authenticated with check (true);

-- SQL Editor로 만든 객체는 API 롤 권한이 자동 부여되지 않는다. 명시적으로 GRANT.
grant usage on schema public to anon, authenticated;
grant select on public.betgirl_bets, public.betgirl_settlements to anon, authenticated;
grant insert on public.betgirl_bets, public.betgirl_settlements to authenticated;
grant select on public.betgirl_ledger, public.betgirl_stats to anon, authenticated;

-- 해시/체인 컬럼은 트리거가 채우므로 클라이언트가 지정해도 무시된다.
-- (BEFORE INSERT 트리거가 항상 덮어씀)
