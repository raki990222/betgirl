-- betgirl 006 — 테스트 정산 (SQL Editor 에서 1회 실행)
--
-- /admin 의 일괄 정산 RPC 는 "경기 시작 전 결과 확정"을 서버에서 거부하므로
-- (그게 정상 동작), 시작 전 테스트 정산은 이 SQL 로만 가능하다.
--
-- seq 1: raki · KT 위즈 승 · 10,000벳 @1.90 → 적중 (회수 19,000벳)
-- seq 2: raki · LG 트윈스 승 · 50,000벳 @1.75 → 미적중 (회수 0)
--
-- ⚠️ 원장은 추가 전용이라 이 두 행도 영구히 공개 기록으로 남는다.
--    note 에 테스트임을 명시해 둔다. 실운영 전 전체 리셋을 원하면 별도 요청할 것.

insert into public.betgirl_settlements (bet_seq, result, payout, settled_at, note)
values (1, 'win', 19000, now(), '테스트 정산 — 실제 경기 결과 아님');

insert into public.betgirl_settlements (bet_seq, result, payout, settled_at, note)
values (2, 'lose', 0, now(), '테스트 정산 — 실제 경기 결과 아님');

-- 확인: 잔고 959,000벳 (1,000,000 − 60,000 베팅 + 19,000 회수) 이면 정상
select handle, granted, staked, returned, balance from public.betgirl_balances;
select seq, bettor, pick, stake, odds, status, payout, net
  from public.betgirl_ledger order by seq;
