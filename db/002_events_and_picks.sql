-- betgirl 002 — 경기 보드 + 참가자 픽 등록
-- 001(schema.sql) 실행 후 이어서 1회 실행한다.
--
-- 추가되는 것
--   betgirl_events    공식 경기 일정과 배당 (운영자만 등록, 공개 읽기)
--   betgirl_profiles  로그인 계정 ↔ 참가자 핸들 매핑 (이름 도용 차단)
--   betgirl_operators 운영자 화이트리스트
--   betgirl_bets 에 user_id / event_id / option_code 추가
--
-- 핵심 보증
--   · 픽은 경기 시작 전에만 등록된다 (DB가 거부)
--   · 픽의 경기명·선택지·배당은 게시된 경기 정보에서 서버가 직접 채운다 (클라이언트가 못 속임)
--   · 남의 이름으로 픽을 넣을 수 없다
--   · 정산은 운영자만 입력한다
--
-- 001의 canonical(해시 원문) 규칙은 건드리지 않는다. 추가 컬럼은 해시 대상이 아니다.

-- ---------------------------------------------------------------- 운영자
create table if not exists public.betgirl_operators (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  memo       text,
  created_at timestamptz not null default now()
);

create or replace function public.betgirl_is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.betgirl_operators o where o.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------- 참가자 프로필
create table if not exists public.betgirl_profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  handle     text not null unique check (char_length(handle) between 1 and 20),
  created_at timestamptz not null default now()
);

-- 핸들을 바꾸면 과거 원장의 참가자명과 어긋나므로 변경을 막는다.
create or replace function public.betgirl_block_handle_change()
returns trigger
language plpgsql
as $$
begin
  if new.handle is distinct from old.handle then
    raise exception '참가자 핸들은 변경할 수 없습니다. 과거 원장 기록과 어긋납니다.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists betgirl_profiles_handle_lock on public.betgirl_profiles;
create trigger betgirl_profiles_handle_lock
  before update on public.betgirl_profiles
  for each row execute function public.betgirl_block_handle_change();

create or replace function public.betgirl_my_handle()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.handle from public.betgirl_profiles p where p.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------- 경기 보드
create table if not exists public.betgirl_events (
  id           bigint generated always as identity primary key,
  round_key    text        not null,                  -- 회차/이벤트 라벨
  sport        text        not null default '야구',
  league       text        not null default 'KBO',
  home         text        not null,
  away         text        not null,
  start_at     timestamptz not null,                  -- 경기 시작 (KST 기준으로 입력)
  market       text        not null default '승무패',
  options      jsonb       not null,                  -- [{"code":"HOME","label":"LG 승","odds":1.85}, …]
  status       text        not null default 'open'
                 check (status in ('open', 'closed', 'settled')),
  official_url text,                                  -- 공식 일정/결과 출처
  note         text,
  created_at   timestamptz not null default now(),
  constraint betgirl_events_options_is_array check (jsonb_typeof(options) = 'array')
);

create index if not exists betgirl_events_start_idx on public.betgirl_events (start_at);

-- 마감된 경기의 배당을 사후에 바꾸면 픽의 근거가 흔들린다. 배당·선택지 수정은 open 상태에서만.
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
  return new;
end;
$$;

drop trigger if exists betgirl_events_guard on public.betgirl_events;
create trigger betgirl_events_guard
  before update on public.betgirl_events
  for each row execute function public.betgirl_events_guard();

-- ---------------------------------------------------------------- bets 확장
alter table public.betgirl_bets
  add column if not exists user_id     uuid references auth.users(id),
  add column if not exists event_id    bigint references public.betgirl_events(id),
  add column if not exists option_code text;

-- 같은 경기에 같은 사람이 중복으로 픽을 넣는 것을 막는다.
create unique index if not exists betgirl_bets_one_pick_per_event
  on public.betgirl_bets (event_id, user_id)
  where event_id is not null and user_id is not null;

-- 경기 연결 픽은 서버가 값을 채운다. 클라이언트는 event_id / option_code / stake 만 보낸다.
-- 트리거 이름이 'betgirl_bets_a_fill' 인 이유: 같은 BEFORE INSERT 중 이름순으로 먼저 실행되어
-- 해시 체인 트리거(betgirl_bets_chain)가 완성된 값을 보게 해야 하기 때문이다.
create or replace function public.betgirl_fill_from_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev  public.betgirl_events%rowtype;
  opt jsonb;
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;

  if new.event_id is null then
    return new;                                   -- 운영자 수동 기록 경로
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

  -- 게시된 정보로 덮어쓴다. 클라이언트가 보낸 경기명·배당은 무시된다.
  new.event_key   := ev.round_key;
  new.sport       := ev.sport;
  new.league      := ev.league;
  new.match_label := ev.away || ' @ ' || ev.home;
  new.market      := ev.market;
  new.pick        := opt->>'label';
  new.odds        := (opt->>'odds')::numeric;
  new.placed_at   := coalesce(new.placed_at, now());

  return new;
end;
$$;

drop trigger if exists betgirl_bets_a_fill on public.betgirl_bets;
create trigger betgirl_bets_a_fill
  before insert on public.betgirl_bets
  for each row execute function public.betgirl_fill_from_event();

-- ---------------------------------------------------------------- 해시 체인 직렬화
-- 001의 체인 트리거는 "직전 행"을 SELECT 해서 prev_hash 를 만든다. 동시에 두 건이 들어오면
-- 둘 다 같은 prev_hash 를 집어 체인이 갈라질 수 있으므로 트랜잭션 단위 advisory lock 으로
-- 직렬화한다. (같은 이유로 클라이언트는 여러 픽을 한 번의 다중행 INSERT 로 보내면 안 된다 —
-- 같은 명령 안에서 먼저 삽입된 행은 뒤 행의 BEFORE 트리거에 보이지 않는다. 한 건씩 보낼 것.)
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

-- ---------------------------------------------------------------- RLS 재설정
alter table public.betgirl_events     enable row level security;
alter table public.betgirl_profiles   enable row level security;
alter table public.betgirl_operators  enable row level security;

-- 경기: 공개 읽기 / 운영자만 쓰기
drop policy if exists betgirl_events_public_read on public.betgirl_events;
create policy betgirl_events_public_read
  on public.betgirl_events for select to anon, authenticated using (true);

drop policy if exists betgirl_events_op_insert on public.betgirl_events;
create policy betgirl_events_op_insert
  on public.betgirl_events for insert to authenticated
  with check (public.betgirl_is_operator());

drop policy if exists betgirl_events_op_update on public.betgirl_events;
create policy betgirl_events_op_update
  on public.betgirl_events for update to authenticated
  using (public.betgirl_is_operator()) with check (public.betgirl_is_operator());

-- 프로필: 핸들은 공개(원장에 이름이 나오므로), 본인만 최초 1회 생성
drop policy if exists betgirl_profiles_public_read on public.betgirl_profiles;
create policy betgirl_profiles_public_read
  on public.betgirl_profiles for select to anon, authenticated using (true);

drop policy if exists betgirl_profiles_self_insert on public.betgirl_profiles;
create policy betgirl_profiles_self_insert
  on public.betgirl_profiles for insert to authenticated
  with check (user_id = auth.uid());

-- 운영자 명단: 본인 것만 조회 가능(누가 운영자인지 전체 공개할 이유가 없다)
drop policy if exists betgirl_operators_self_read on public.betgirl_operators;
create policy betgirl_operators_self_read
  on public.betgirl_operators for select to authenticated
  using (user_id = auth.uid());

-- 베팅: 본인 핸들로만 등록. 운영자는 대리 기록 가능.
drop policy if exists betgirl_bets_admin_insert on public.betgirl_bets;
drop policy if exists betgirl_bets_insert on public.betgirl_bets;
create policy betgirl_bets_insert
  on public.betgirl_bets for insert to authenticated
  with check (
    public.betgirl_is_operator()
    or (user_id = auth.uid() and bettor = public.betgirl_my_handle())
  );

-- 정산: 운영자만
drop policy if exists betgirl_settlements_admin_insert on public.betgirl_settlements;
drop policy if exists betgirl_settlements_insert on public.betgirl_settlements;
create policy betgirl_settlements_insert
  on public.betgirl_settlements for insert to authenticated
  with check (public.betgirl_is_operator());

-- ---------------------------------------------------------------- 경기 보드 뷰
create or replace view public.betgirl_board as
select
  e.id, e.round_key, e.sport, e.league, e.home, e.away, e.start_at,
  e.market, e.options, e.status, e.official_url, e.note,
  (e.status = 'open' and now() < e.start_at)          as open_for_picks,
  count(b.seq)                                        as pick_count,
  coalesce(sum(b.stake), 0)                           as staked
from public.betgirl_events e
left join public.betgirl_bets b on b.event_id = e.id
group by e.id;

-- ---------------------------------------------------------------- 권한
grant select on public.betgirl_events, public.betgirl_profiles to anon, authenticated;
grant select on public.betgirl_board to anon, authenticated;
grant select on public.betgirl_operators to authenticated;
grant insert on public.betgirl_events, public.betgirl_profiles to authenticated;
grant update on public.betgirl_events to authenticated;
grant usage, select on all sequences in schema public to authenticated;
