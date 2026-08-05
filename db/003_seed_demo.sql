-- betgirl 003 — 운영자 등록 + 예시 경기 시드
-- 001, 002 실행 후 1회 실행. 경기 데이터는 화면 확인용 예시다.
-- 실제 운영에서는 KBO 공식 일정 등 공식 출처의 경기만 등록할 것.

-- ---------------------------------------------------------------- 운영자 / 프로필
insert into public.betgirl_operators (user_id, memo)
select id, 'raki'
  from auth.users
 where email = 'raki@cizion.com'
on conflict (user_id) do nothing;

insert into public.betgirl_profiles (user_id, handle)
select id, 'raki'
  from auth.users
 where email = 'raki@cizion.com'
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- 예시 경기
-- 시작 시각을 now() 기준 상대값으로 넣어 언제 실행해도 '픽 등록 가능' 상태가 되게 한다.
insert into public.betgirl_events
  (round_key, sport, league, home, away, start_at, market, options, note)
values
  ('예시 2026-1회차', '야구', 'KBO', 'LG 트윈스', '두산 베어스',
   now() + interval '1 day', '승패',
   '[{"code":"HOME","label":"LG 트윈스 승","odds":1.72},
     {"code":"AWAY","label":"두산 베어스 승","odds":2.05}]'::jsonb,
   '예시 데이터'),

  ('예시 2026-1회차', '야구', 'KBO', 'KIA 타이거즈', '삼성 라이온즈',
   now() + interval '1 day 3 hours', '승패',
   '[{"code":"HOME","label":"KIA 타이거즈 승","odds":1.88},
     {"code":"AWAY","label":"삼성 라이온즈 승","odds":1.86}]'::jsonb,
   '예시 데이터'),

  ('예시 2026-1회차', '야구', 'KBO', 'SSG 랜더스', '롯데 자이언츠',
   now() + interval '2 days', '승패',
   '[{"code":"HOME","label":"SSG 랜더스 승","odds":1.95},
     {"code":"AWAY","label":"롯데 자이언츠 승","odds":1.80}]'::jsonb,
   '예시 데이터'),

  ('예시 2026-1회차', '야구', 'KBO', 'NC 다이노스', '키움 히어로즈',
   now() + interval '2 days 3 hours', '승패',
   '[{"code":"HOME","label":"NC 다이노스 승","odds":1.64},
     {"code":"AWAY","label":"키움 히어로즈 승","odds":2.20}]'::jsonb,
   '예시 데이터'),

  ('예시 2026-1회차', '야구', 'KBO', '한화 이글스', 'KT 위즈',
   now() + interval '3 days', '승패',
   '[{"code":"HOME","label":"한화 이글스 승","odds":2.10},
     {"code":"AWAY","label":"KT 위즈 승","odds":1.70}]'::jsonb,
   '예시 데이터');

select id, round_key, away || ' @ ' || home as match, start_at, status
  from public.betgirl_events
 order by start_at;
