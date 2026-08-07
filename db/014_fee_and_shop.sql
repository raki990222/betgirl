-- betgirl 014 — 수수료 투명 정산 + 상품 교환소 + 광고 수익 공개 원장 (SQL Editor 1회 실행)
--
-- 1) 수수료: 적중 픽 정산 시 "베팅액의 5%"를 차감. 정책(비율·시행일)은 공개 테이블에
--    추가 전용으로 기록되어 몰래 못 바꾼다. 수수료는 정산 행에 fee 로 표시된다.
--    (체인 canonical 은 payout 을 봉인하므로 규칙 변경 없음 — fee 는 표시용 파생값)
-- 2) 교환소: 상품 카탈로그 + 신청 RPC(카탈로그 가격을 서버가 복사 — 가격 위조 불가).
-- 3) 광고 수익 원장: 수익(현금)을 공개 기록 — "상품을 나눠줘도 마이너스가 안 나는지"를
--    누구나 대차로 확인할 수 있게 한다 (지급 여력 뷰 공개).

-- ---------------------------------------------------------------- 수수료 정책 (공개·이력)
create table if not exists public.betgirl_fee_policy (
  seq            bigint generated always as identity primary key,
  rate           numeric(4,3) not null check (rate >= 0 and rate < 0.5),
  effective_from timestamptz  not null default now(),
  note           text,
  created_at     timestamptz  not null default now()
);

drop trigger if exists betgirl_fee_policy_immutable on public.betgirl_fee_policy;
create trigger betgirl_fee_policy_immutable
  before update or delete on public.betgirl_fee_policy
  for each row execute function public.betgirl_block_mutation();

alter table public.betgirl_fee_policy enable row level security;
drop policy if exists betgirl_fee_policy_read on public.betgirl_fee_policy;
create policy betgirl_fee_policy_read
  on public.betgirl_fee_policy for select to anon, authenticated using (true);
drop policy if exists betgirl_fee_policy_op_insert on public.betgirl_fee_policy;
create policy betgirl_fee_policy_op_insert
  on public.betgirl_fee_policy for insert to authenticated
  with check (public.betgirl_is_operator());

grant select on public.betgirl_fee_policy to anon, authenticated;
grant insert on public.betgirl_fee_policy to authenticated;

insert into public.betgirl_fee_policy (rate, note)
select 0.05, '초기 정책 — 적중 픽 정산 시 베팅액의 5% 수수료'
 where not exists (select 1 from public.betgirl_fee_policy);

alter table public.betgirl_settlements
  add column if not exists fee bigint not null default 0;

-- ---------------------------------------------------------------- 정산 RPC v5 (수수료)
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
      v_win := null; v_fee := 0; v_pay := r.stake;          -- 취소: 수수료 없이 전액 반환
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

  update public.betgirl_events
     set status = 'settled',
         result_code = coalesce(ev.result_code, v_code),
         result_at = coalesce(ev.result_at, now()),
         result_proof_url = coalesce(ev.result_proof_url, p_proof_url)
   where id = p_event_id;

  return query select n_all, n_win, v_total;
end;
$$;

grant execute on function public.betgirl_settle_event(bigint, text, boolean, text) to authenticated;

-- 원장 뷰에 수수료 노출 (기존 컬럼 순서 유지, 끝에 추가)
create or replace view public.betgirl_ledger as
select
  b.seq, b.bettor, b.event_key, b.sport, b.league, b.match_label, b.market, b.pick,
  b.stake, b.odds, b.placed_at, b.ticket_no, b.proof_url, b.note,
  b.prev_hash, b.canonical, b.row_hash,
  s.seq as settlement_seq, s.result, s.payout, s.settled_at,
  s.proof_url as settle_proof_url,
  case when s.seq is null then 'pending' else s.result end as status,
  case when s.seq is null then null else s.payout - b.stake end as net,
  s.fee
from public.betgirl_bets b
left join public.betgirl_settlements s on s.bet_seq = b.seq;

grant select on public.betgirl_ledger to anon, authenticated;

-- ---------------------------------------------------------------- 상품 카탈로그
create table if not exists public.betgirl_items (
  id         bigint generated always as identity primary key,
  name       text    not null,
  cost       bigint  not null check (cost > 0),
  stock      int     check (stock is null or stock >= 0),   -- null = 무제한
  image_url  text,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.betgirl_items enable row level security;
drop policy if exists betgirl_items_read on public.betgirl_items;
create policy betgirl_items_read
  on public.betgirl_items for select to anon, authenticated using (true);
drop policy if exists betgirl_items_op_write on public.betgirl_items;
create policy betgirl_items_op_write
  on public.betgirl_items for insert to authenticated
  with check (public.betgirl_is_operator());
drop policy if exists betgirl_items_op_update on public.betgirl_items;
create policy betgirl_items_op_update
  on public.betgirl_items for update to authenticated
  using (public.betgirl_is_operator()) with check (public.betgirl_is_operator());

grant select on public.betgirl_items to anon, authenticated;
grant insert, update on public.betgirl_items to authenticated;

-- 교환 신청 RPC — 카탈로그의 이름·가격을 서버가 복사한다 (가격 위조 불가)
create or replace function public.betgirl_shop_request(p_item_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  it       public.betgirl_items%rowtype;
  v_handle text := public.betgirl_my_handle();
  v_seq    bigint;
begin
  if v_handle is null then
    raise exception '참가 등록 후 이용할 수 있습니다.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('betgirl_bets'));   -- 전역 잔고 락

  select * into it from public.betgirl_items where id = p_item_id for update;
  if not found or not it.active then
    raise exception '판매 중인 상품이 아닙니다.';
  end if;
  if it.stock is not null and it.stock <= 0 then
    raise exception '품절된 상품입니다.';
  end if;

  insert into public.betgirl_redemptions (kind, user_id, handle, item, cost)
  values ('request', auth.uid(), v_handle, it.name, it.cost)
  returning seq into v_seq;

  if it.stock is not null then
    update public.betgirl_items set stock = stock - 1 where id = it.id;
  end if;

  return v_seq;
end;
$$;

grant execute on function public.betgirl_shop_request(bigint) to authenticated;

-- ---------------------------------------------------------------- 광고 수익 공개 원장
create table if not exists public.betgirl_revenue (
  seq        bigint generated always as identity primary key,
  at_date    date    not null,
  source     text    not null,          -- 예: 애드센스, 오퍼월, 제휴
  amount_krw bigint  not null check (amount_krw > 0),
  proof_url  text,
  note       text,
  created_at timestamptz not null default now()
);

drop trigger if exists betgirl_revenue_immutable on public.betgirl_revenue;
create trigger betgirl_revenue_immutable
  before update or delete on public.betgirl_revenue
  for each row execute function public.betgirl_block_mutation();

alter table public.betgirl_revenue enable row level security;
drop policy if exists betgirl_revenue_read on public.betgirl_revenue;
create policy betgirl_revenue_read
  on public.betgirl_revenue for select to anon, authenticated using (true);
drop policy if exists betgirl_revenue_op_insert on public.betgirl_revenue;
create policy betgirl_revenue_op_insert
  on public.betgirl_revenue for insert to authenticated
  with check (public.betgirl_is_operator());

grant select on public.betgirl_revenue to anon, authenticated;
grant insert on public.betgirl_revenue to authenticated;

-- 지급 여력 대차 (기준가 10벳=1원): 누구나 "마이너스인지" 확인 가능
create or replace view public.betgirl_shop_solvency as
select
  coalesce((select sum(amount_krw) from public.betgirl_revenue), 0)             as revenue_krw,
  coalesce((select sum(cost) from public.betgirl_redemptions where kind = 'fulfill'), 0) as fulfilled_bet,
  coalesce((select sum(cost) from public.betgirl_redemptions where kind = 'fulfill'), 0) / 10 as fulfilled_krw,
  coalesce((select sum(r.cost) from public.betgirl_redemptions r
             where r.kind = 'request'
               and not exists (select 1 from public.betgirl_redemptions x
                                where x.request_seq = r.seq and x.kind in ('fulfill','reject'))), 0) as pending_bet,
  coalesce((select sum(amount_krw) from public.betgirl_revenue), 0)
    - coalesce((select sum(cost) from public.betgirl_redemptions where kind = 'fulfill'), 0) / 10 as headroom_krw;

grant select on public.betgirl_shop_solvency to anon, authenticated;

select 'ok' as status;
