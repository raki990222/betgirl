-- betgirl 007 — 소지금 내역(지갑 히스토리) 뷰 + 테스트 정산 (SQL Editor 에서 1회 실행)
--
-- 1) betgirl_wallet_history: 참가자별 "왜 소지금이 이 금액인지"를 한 줄씩 설명하는 공개 뷰.
--    지급(+) / 픽 베팅(−) / 정산 회수(+)를 시간순으로 합치면 현재 잔고가 나온다.
-- 2) 테스트 정산: seq 1 적중(+19,000벳), seq 2 미적중(0벳). 이미 실행했다면 건너뛴다(멱등).

-- ---------------------------------------------------------------- 소지금 내역 뷰
create or replace view public.betgirl_wallet_history as
select
  'credit'     as kind,
  c.handle,
  c.created_at as at,
  c.reason     as label,
  c.amount     as delta,
  null::bigint as bet_seq
from public.betgirl_credits c
union all
select
  'stake',
  b.bettor,
  b.placed_at,
  '픽 — ' || b.match_label || ' · ' || b.pick,
  -b.stake,
  b.seq
from public.betgirl_bets b
where b.event_id is not null
union all
select
  'payout',
  bt.bettor,
  s.settled_at,
  case s.result
    when 'win'    then '적중 — '
    when 'void'   then '무효 반환 — '
    when 'cancel' then '취소 반환 — '
    else               '미적중 — '
  end || bt.match_label || ' · ' || bt.pick,
  s.payout,
  bt.seq
from public.betgirl_settlements s
join public.betgirl_bets bt on bt.seq = s.bet_seq
where bt.event_id is not null;

grant select on public.betgirl_wallet_history to anon, authenticated;

-- ---------------------------------------------------------------- 테스트 정산 (멱등)
-- /admin 일괄 정산은 경기 시작 전 확정을 서버가 거부하므로(정상 방어) 테스트는 SQL 로만 가능.
-- ⚠️ 원장은 추가 전용 — 이 두 행도 영구 공개 기록으로 남는다 (note 에 테스트임을 명시).
insert into public.betgirl_settlements (bet_seq, result, payout, settled_at, note)
values (1, 'win', 19000, now(), '테스트 정산 — 실제 경기 결과 아님')
on conflict (bet_seq) do nothing;

insert into public.betgirl_settlements (bet_seq, result, payout, settled_at, note)
values (2, 'lose', 0, now(), '테스트 정산 — 실제 경기 결과 아님')
on conflict (bet_seq) do nothing;

-- ---------------------------------------------------------------- 확인
-- 기대: 잔고 959,000 (1,000,000 − 60,000 + 19,000)
select handle, granted, staked, returned, balance from public.betgirl_balances;

-- 기대: 지급 +1,000,000 → 픽 −10,000 → 픽 −50,000 → 적중 +19,000 → 미적중 +0
select at at time zone 'Asia/Seoul' as at_kst, kind, label, delta,
       sum(delta) over (partition by handle order by at, kind) as running_balance
  from public.betgirl_wallet_history
 where handle = 'raki'
 order by at, kind;
