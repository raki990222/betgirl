-- SQL 트리거와 프런트엔드(assets/app.js)의 정규화·해시 규칙이 일치하는지 확인한다.
-- schema.sql 실행 직후, 실데이터를 넣기 전에 1회 돌릴 것.
-- 트랜잭션을 롤백하므로 원장에 흔적이 남지 않는다.

begin;

insert into public.betgirl_bets
  (bettor, event_key, match_label, market, pick, stake, odds, placed_at)
values
  ('지연', '프로토 승부식 2026-12회차', '토트넘 vs 아스널', '승무패', '토트넘 승',
   10000, 1.85, timestamptz '2026-08-05 12:34:56+00');

select
  canonical,
  row_hash,
  canonical = 'bet|지연|프로토 승부식 2026-12회차|토트넘 vs 아스널|승무패|토트넘 승|10000|1.85|2026-08-05T12:34:56Z|'
    as canonical_ok,
  row_hash  = '3418ff5e9e5d39c502ac49027c7117addfe320ca5d0cbfeadd848b4f4d359364'
    as hash_ok
from public.betgirl_bets
order by seq desc
limit 1;

-- 추가 전용 방어 확인: 아래 두 줄은 각각 에러가 나야 정상이다.
-- update public.betgirl_bets set stake = 1 where seq = (select max(seq) from public.betgirl_bets);
-- delete from public.betgirl_bets where seq = (select max(seq) from public.betgirl_bets);

rollback;
