-- betgirl 015 — 온라인 가차샵 (포인트 전용, 증명 가능한 공정성) — SQL Editor 1회 실행
--
-- 모드(고지): 확정 100% = 상품가의 100% / 도전 50% = 58% / 도전 10% = 13.5%
--   (기대비용 116%/135% — 정책 테이블에 공개, 변경은 새 행 추가로만)
-- 공정성(커밋-리빌):
--   1) 운영자가 시드를 만들면 seed 의 SHA-256 해시가 즉시 공개된다 (시드 본문은 비공개)
--   2) 추첨 = SHA-256(seed:nonce:유저가 보낸 client_seed) 첫 4바이트 / 0xFFFFFFFF < 확률
--      → 시드가 먼저 커밋되어 운영자가 결과를 고를 수 없고, client_seed 때문에 예측도 불가
--   3) 시드를 공개(reveal)하면 그 시드는 마감되고, 누구나 모든 추첨을 재계산해 검증할 수 있다
-- 추첨 기록은 5번째 해시 체인(betgirl_draws)으로 봉인·앵커링된다.
-- 현금 결제는 없다 (복합 결제는 법무 확인 전 구현 금지 항목).

-- ---------------------------------------------------------------- 확률·비용 정책 (공개·이력)
create table if not exists public.betgirl_gacha_policy (
  seq            bigint generated always as identity primary key,
  mode           text not null check (mode in ('sure', 'half', 'ten')),
  prob           numeric(4,3) not null check (prob > 0 and prob <= 1),
  cost_ratio     numeric(4,3) not null check (cost_ratio > 0 and cost_ratio <= 1),
  effective_from timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now()
);

drop trigger if exists betgirl_gacha_policy_immutable on public.betgirl_gacha_policy;
create trigger betgirl_gacha_policy_immutable
  before update or delete on public.betgirl_gacha_policy
  for each row execute function public.betgirl_block_mutation();

alter table public.betgirl_gacha_policy enable row level security;
drop policy if exists gacha_policy_read on public.betgirl_gacha_policy;
create policy gacha_policy_read on public.betgirl_gacha_policy
  for select to anon, authenticated using (true);
drop policy if exists gacha_policy_op_insert on public.betgirl_gacha_policy;
create policy gacha_policy_op_insert on public.betgirl_gacha_policy
  for insert to authenticated with check (public.betgirl_is_operator());
grant select on public.betgirl_gacha_policy to anon, authenticated;
grant insert on public.betgirl_gacha_policy to authenticated;

insert into public.betgirl_gacha_policy (mode, prob, cost_ratio, note)
select * from (values
  ('sure', 1.000::numeric, 1.000::numeric, '확정 교환 (천장)'),
  ('half', 0.500::numeric, 0.580::numeric, '도전 50% — 기대비용 116%'),
  ('ten',  0.100::numeric, 0.135::numeric, '도전 10% — 기대비용 135%')
) v(mode, prob, cost_ratio, note)
 where not exists (select 1 from public.betgirl_gacha_policy);

-- ---------------------------------------------------------------- 시드 (커밋-리빌)
create table if not exists public.betgirl_gacha_seeds (
  seq         bigint generated always as identity primary key,
  seed        text not null,                    -- 비공개 (공개 뷰에서 reveal 후에만 노출)
  seed_hash   text not null,                    -- 커밋: 생성 즉시 공개
  drawn_count bigint not null default 0,
  created_at  timestamptz not null default now(),
  revealed_at timestamptz
);

alter table public.betgirl_gacha_seeds enable row level security;
drop policy if exists gacha_seeds_op_read on public.betgirl_gacha_seeds;
create policy gacha_seeds_op_read on public.betgirl_gacha_seeds
  for select to authenticated using (public.betgirl_is_operator());
grant select on public.betgirl_gacha_seeds to authenticated;

-- 공개 뷰: 해시는 항상, 시드 본문은 공개 후에만
create or replace view public.betgirl_gacha_commitments as
select seq, seed_hash, drawn_count, created_at, revealed_at,
       case when revealed_at is not null then seed end as seed
  from public.betgirl_gacha_seeds;
grant select on public.betgirl_gacha_commitments to anon, authenticated;

create or replace function public.betgirl_gacha_new_seed()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_seed text;
  v_hash text;
begin
  if not public.betgirl_is_operator() then
    raise exception '운영자만 시드를 만들 수 있습니다.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('betgirl_gacha'));
  if exists (select 1 from public.betgirl_gacha_seeds where revealed_at is null) then
    raise exception '진행 중인 시드가 있습니다. 먼저 공개(reveal)해 마감하세요.';
  end if;
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  insert into public.betgirl_gacha_seeds (seed, seed_hash) values (v_seed, v_hash);
  return v_hash;
end;
$$;

create or replace function public.betgirl_gacha_reveal_seed()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seed text;
begin
  if not public.betgirl_is_operator() then
    raise exception '운영자만 시드를 공개할 수 있습니다.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('betgirl_gacha'));
  update public.betgirl_gacha_seeds
     set revealed_at = now()
   where revealed_at is null
  returning seed into v_seed;
  if v_seed is null then
    raise exception '공개할 진행 중 시드가 없습니다.';
  end if;
  return v_seed;
end;
$$;

grant execute on function public.betgirl_gacha_new_seed() to authenticated;
grant execute on function public.betgirl_gacha_reveal_seed() to authenticated;

-- ---------------------------------------------------------------- 추첨 원장 (5번째 체인)
create table if not exists public.betgirl_draws (
  seq        bigint generated always as identity primary key,
  user_id    uuid references auth.users(id),
  handle     text        not null,
  item       text        not null,
  item_cost  bigint      not null,              -- 당첨 시 지급 원가 산정용
  mode       text        not null check (mode in ('sure', 'half', 'ten')),
  cost       bigint      not null check (cost > 0),
  seed_seq   bigint      not null references public.betgirl_gacha_seeds(seq),
  nonce      bigint      not null,
  client_seed text       not null,
  roll       text        not null,
  win        boolean     not null,
  created_at timestamptz not null default now(),
  prev_hash  text not null,
  canonical  text not null,
  row_hash   text not null
);

create or replace function public.betgirl_chain_draw()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_draws'));
  select coalesce(max(d.seq), 0) + 1 into new.seq from public.betgirl_draws d;
  new.created_at := date_trunc('second', now());

  select d.row_hash into v_prev
    from public.betgirl_draws d order by d.seq desc limit 1;

  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.canonical := concat_ws('|',
    'draw', new.handle, new.item, new.item_cost::text, new.mode, new.cost::text,
    new.seed_seq::text, new.nonce::text, new.client_seed, new.roll,
    case when new.win then 'W' else 'L' end,
    to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  new.row_hash := encode(extensions.digest(new.prev_hash || new.canonical, 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists betgirl_draws_chain on public.betgirl_draws;
create trigger betgirl_draws_chain
  before insert on public.betgirl_draws
  for each row execute function public.betgirl_chain_draw();

drop trigger if exists betgirl_draws_immutable on public.betgirl_draws;
create trigger betgirl_draws_immutable
  before update or delete on public.betgirl_draws
  for each row execute function public.betgirl_block_mutation();

alter table public.betgirl_draws enable row level security;
drop policy if exists betgirl_draws_read on public.betgirl_draws;
create policy betgirl_draws_read on public.betgirl_draws
  for select to anon, authenticated using (true);
-- INSERT 정책 없음: 추첨은 betgirl_gacha_draw() RPC(정의자) 경유만
grant select on public.betgirl_draws to anon, authenticated;

-- ---------------------------------------------------------------- 교환 원장과 연결
alter table public.betgirl_redemptions
  add column if not exists via_draw_seq bigint references public.betgirl_draws(seq);

create unique index if not exists betgirl_redemptions_one_per_draw
  on public.betgirl_redemptions (via_draw_seq) where via_draw_seq is not null;

-- 가드 갱신: 가차 당첨 건은 (a) 추첨 기록에서 내용을 복사 (b) 잔고 무차감 (c) 반려 불가
create or replace function public.betgirl_redemption_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  req       public.betgirl_redemptions%rowtype;
  d         public.betgirl_draws%rowtype;
  v_balance bigint;
begin
  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));

  if new.kind = 'request' then
    if new.via_draw_seq is not null then
      -- 가차 당첨 확정 건: 비용은 추첨에서 이미 지불됨 → 잔고 무차감, 내용은 추첨 기록 복사
      select * into d from public.betgirl_draws where seq = new.via_draw_seq and win;
      if not found then
        raise exception '당첨된 추첨 기록이 아닙니다: %', new.via_draw_seq;
      end if;
      if not public.betgirl_is_operator() and d.user_id is distinct from auth.uid() then
        raise exception '본인의 당첨 건만 등록할 수 있습니다.' using errcode = '42501';
      end if;
      new.user_id := d.user_id;
      new.handle  := d.handle;
      new.item    := d.item;
      new.cost    := d.item_cost;
      new.request_seq := null;
      return new;
    end if;

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
    if new.kind = 'reject' and req.via_draw_seq is not null then
      raise exception '가차 당첨 건은 반려할 수 없습니다. 지급이 불가하면 운영자 벳 지급으로 보상하세요.';
    end if;

    new.user_id := req.user_id;
    new.handle  := req.handle;
    new.item    := req.item;
    new.cost    := req.cost;
    -- via_draw_seq 는 request 행에만 둔다. fulfill/reject 행에 복사하면
    -- betgirl_redemptions_one_per_draw(via_draw_seq unique)와 충돌해 처리가 영구 실패한다.
    new.via_draw_seq := null;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------- 추첨 RPC
create or replace function public.betgirl_gacha_draw(
  p_item_id     bigint,
  p_mode        text,
  p_client_seed text
)
returns table (draw_seq bigint, win boolean, cost bigint, roll text, seed_hash text, nonce bigint)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  it        public.betgirl_items%rowtype;
  pol       record;
  sd        public.betgirl_gacha_seeds%rowtype;
  v_handle  text := public.betgirl_my_handle();
  v_client  text := btrim(coalesce(p_client_seed, ''));
  v_cost    bigint;
  v_balance bigint;
  v_nonce   bigint;
  v_roll    text;
  v_win     boolean;
  v_seq     bigint;
begin
  if v_handle is null then
    raise exception '참가 등록 후 이용할 수 있습니다.' using errcode = '42501';
  end if;
  if v_client = '' or length(v_client) > 64 then
    raise exception 'client_seed 는 1~64자여야 합니다.';
  end if;

  select * into pol
    from public.betgirl_gacha_policy
   where mode = p_mode and effective_from <= now()
   order by effective_from desc, seq desc limit 1;
  if not found then
    raise exception '알 수 없는 모드입니다: %', p_mode;
  end if;

  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));      -- 전역 잔고 락
  perform pg_advisory_xact_lock(hashtext('betgirl_gacha'));     -- 시드 직렬화

  select * into it from public.betgirl_items where id = p_item_id for update;
  if not found or not it.active then
    raise exception '판매 중인 상품이 아닙니다.';
  end if;
  if it.stock is not null and it.stock <= 0 then
    raise exception '품절된 상품입니다.';
  end if;

  v_cost := greatest(100, (round(it.cost * pol.cost_ratio / 100.0) * 100))::bigint;

  select balance into v_balance from public.betgirl_balances where handle = v_handle;
  if v_cost > v_balance then
    raise exception '소지금이 부족합니다. (보유 %벳, 필요 %벳)', v_balance, v_cost
      using errcode = '42501';
  end if;

  select * into sd from public.betgirl_gacha_seeds
   where revealed_at is null order by seq desc limit 1 for update;
  if not found then
    raise exception '추첨 시드가 준비되지 않았습니다. 잠시 후 다시 시도하세요.';
  end if;

  v_nonce := sd.drawn_count + 1;
  update public.betgirl_gacha_seeds set drawn_count = v_nonce where seq = sd.seq;

  v_roll := encode(extensions.digest(sd.seed || ':' || v_nonce || ':' || v_client, 'sha256'), 'hex');
  v_win  := (('x' || left(v_roll, 8))::bit(32)::bigint::numeric / 4294967295.0) < pol.prob;

  insert into public.betgirl_draws
    (user_id, handle, item, item_cost, mode, cost, seed_seq, nonce, client_seed, roll, win)
  values
    (auth.uid(), v_handle, it.name, it.cost, p_mode, v_cost, sd.seq, v_nonce, v_client, v_roll, v_win)
  returning seq into v_seq;

  if v_win then
    insert into public.betgirl_redemptions (kind, via_draw_seq, handle, item, cost)
    values ('request', v_seq, v_handle, it.name, it.cost);
    if it.stock is not null then
      update public.betgirl_items set stock = stock - 1 where id = it.id;
    end if;
  end if;

  return query select v_seq, v_win, v_cost, v_roll, sd.seed_hash, v_nonce;
end;
$$;

grant execute on function public.betgirl_gacha_draw(bigint, text, text) to authenticated;

-- ---------------------------------------------------------------- 잔고 v4 / 내역 v3
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
left join (select bettor, sum(stake) staked from public.betgirl_bets
            where event_id is not null group by bettor) b on b.bettor = p.handle
left join (select bt.bettor, sum(st.payout) returned
             from public.betgirl_settlements st
             join public.betgirl_bets bt on bt.seq = st.bet_seq
            where bt.event_id is not null group by bt.bettor) s on s.bettor = p.handle
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
  from public.betgirl_bets b where b.event_id is not null
union all
select 'payout', bt.bettor, s.settled_at,
       case s.result when 'win' then '적중 — ' when 'void' then '무효 반환 — '
                     when 'cancel' then '취소 반환 — ' else '미적중 — ' end
         || bt.match_label || ' · ' || bt.pick,
       s.payout, bt.seq
  from public.betgirl_settlements s
  join public.betgirl_bets bt on bt.seq = s.bet_seq
 where bt.event_id is not null
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

grant select on public.betgirl_balances, public.betgirl_wallet_history to anon, authenticated;

select 'ok' as status, (select count(*) from public.betgirl_gacha_policy) as policy_rows;
