-- betgirl 004 — 실제 KBO 경기 등록 (2026-08-07 금 ~ 08-09 일)
-- 출처: KBO 공식 일정 + 각 구단 기록 (나무위키 8월 경기 문서로 교차 확인)
--   금요일 18:30, 토·일 18:00 KST.
--   두산@삼성(대구) · KIA@LG(잠실) · SSG@NC(창원) · 롯데@KT(수원) · 키움@한화(대전)
-- 배당은 운영자 게시값이다 (betman 공식 배당이 아님 — note 에 명시).

-- ---------------------------------------------------------------- 예시 데이터 정리
-- 픽이 하나도 안 붙은 예시 경기는 삭제, 픽이 붙었으면 삭제 대신 마감 처리.
delete from public.betgirl_events e
 where e.note = '예시 데이터'
   and not exists (select 1 from public.betgirl_bets b where b.event_id = e.id);

update public.betgirl_events
   set status = 'closed'
 where note = '예시 데이터' and status = 'open';

-- ---------------------------------------------------------------- 8/7 (금) 18:30
insert into public.betgirl_events
  (round_key, sport, league, home, away, start_at, market, options, official_url, note)
values
  ('KBO 2026-08-07 (금)', '야구', 'KBO', '삼성 라이온즈', '두산 베어스',
   timestamptz '2026-08-07 18:30:00+09', '승패',
   '[{"code":"AWAY","label":"두산 베어스 승","odds":1.95},
     {"code":"HOME","label":"삼성 라이온즈 승","odds":1.80}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '대구 삼성라이온즈파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-07 (금)', '야구', 'KBO', 'LG 트윈스', 'KIA 타이거즈',
   timestamptz '2026-08-07 18:30:00+09', '승패',
   '[{"code":"AWAY","label":"KIA 타이거즈 승","odds":2.00},
     {"code":"HOME","label":"LG 트윈스 승","odds":1.75}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '서울 잠실야구장 · 배당은 운영자 게시값'),

  ('KBO 2026-08-07 (금)', '야구', 'KBO', 'NC 다이노스', 'SSG 랜더스',
   timestamptz '2026-08-07 18:30:00+09', '승패',
   '[{"code":"AWAY","label":"SSG 랜더스 승","odds":2.15},
     {"code":"HOME","label":"NC 다이노스 승","odds":1.65}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '창원NC파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-07 (금)', '야구', 'KBO', 'KT 위즈', '롯데 자이언츠',
   timestamptz '2026-08-07 18:30:00+09', '승패',
   '[{"code":"AWAY","label":"롯데 자이언츠 승","odds":1.85},
     {"code":"HOME","label":"KT 위즈 승","odds":1.90}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '수원 KT위즈파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-07 (금)', '야구', 'KBO', '한화 이글스', '키움 히어로즈',
   timestamptz '2026-08-07 18:30:00+09', '승패',
   '[{"code":"AWAY","label":"키움 히어로즈 승","odds":2.35},
     {"code":"HOME","label":"한화 이글스 승","odds":1.55}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '대전 한화생명볼파크 · 배당은 운영자 게시값');

-- ---------------------------------------------------------------- 8/8 (토) 18:00
insert into public.betgirl_events
  (round_key, sport, league, home, away, start_at, market, options, official_url, note)
values
  ('KBO 2026-08-08 (토)', '야구', 'KBO', '삼성 라이온즈', '두산 베어스',
   timestamptz '2026-08-08 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"두산 베어스 승","odds":1.95},
     {"code":"HOME","label":"삼성 라이온즈 승","odds":1.80}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '대구 삼성라이온즈파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-08 (토)', '야구', 'KBO', 'LG 트윈스', 'KIA 타이거즈',
   timestamptz '2026-08-08 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"KIA 타이거즈 승","odds":2.00},
     {"code":"HOME","label":"LG 트윈스 승","odds":1.75}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '서울 잠실야구장 · 배당은 운영자 게시값'),

  ('KBO 2026-08-08 (토)', '야구', 'KBO', 'NC 다이노스', 'SSG 랜더스',
   timestamptz '2026-08-08 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"SSG 랜더스 승","odds":2.15},
     {"code":"HOME","label":"NC 다이노스 승","odds":1.65}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '창원NC파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-08 (토)', '야구', 'KBO', 'KT 위즈', '롯데 자이언츠',
   timestamptz '2026-08-08 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"롯데 자이언츠 승","odds":1.85},
     {"code":"HOME","label":"KT 위즈 승","odds":1.90}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '수원 KT위즈파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-08 (토)', '야구', 'KBO', '한화 이글스', '키움 히어로즈',
   timestamptz '2026-08-08 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"키움 히어로즈 승","odds":2.35},
     {"code":"HOME","label":"한화 이글스 승","odds":1.55}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '대전 한화생명볼파크 · 배당은 운영자 게시값');

-- ---------------------------------------------------------------- 8/9 (일) 18:00
insert into public.betgirl_events
  (round_key, sport, league, home, away, start_at, market, options, official_url, note)
values
  ('KBO 2026-08-09 (일)', '야구', 'KBO', '삼성 라이온즈', '두산 베어스',
   timestamptz '2026-08-09 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"두산 베어스 승","odds":1.95},
     {"code":"HOME","label":"삼성 라이온즈 승","odds":1.80}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '대구 삼성라이온즈파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-09 (일)', '야구', 'KBO', 'LG 트윈스', 'KIA 타이거즈',
   timestamptz '2026-08-09 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"KIA 타이거즈 승","odds":2.00},
     {"code":"HOME","label":"LG 트윈스 승","odds":1.75}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '서울 잠실야구장 · 배당은 운영자 게시값'),

  ('KBO 2026-08-09 (일)', '야구', 'KBO', 'NC 다이노스', 'SSG 랜더스',
   timestamptz '2026-08-09 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"SSG 랜더스 승","odds":2.15},
     {"code":"HOME","label":"NC 다이노스 승","odds":1.65}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '창원NC파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-09 (일)', '야구', 'KBO', 'KT 위즈', '롯데 자이언츠',
   timestamptz '2026-08-09 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"롯데 자이언츠 승","odds":1.85},
     {"code":"HOME","label":"KT 위즈 승","odds":1.90}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '수원 KT위즈파크 · 배당은 운영자 게시값'),

  ('KBO 2026-08-09 (일)', '야구', 'KBO', '한화 이글스', '키움 히어로즈',
   timestamptz '2026-08-09 18:00:00+09', '승패',
   '[{"code":"AWAY","label":"키움 히어로즈 승","odds":2.35},
     {"code":"HOME","label":"한화 이글스 승","odds":1.55}]'::jsonb,
   'https://www.koreabaseball.com/schedule/schedule.aspx',
   '대전 한화생명볼파크 · 배당은 운영자 게시값');

-- ---------------------------------------------------------------- 확인
select id, round_key, away || ' @ ' || home as match,
       start_at at time zone 'Asia/Seoul' as start_kst, status
  from public.betgirl_events
 where status = 'open'
 order by start_at, id;
