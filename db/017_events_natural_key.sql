-- betgirl 017 — 경기 자연키 unique (SQL Editor 1회 실행)
-- 로컬 launchd 와 GitHub Actions 크론이 동시에 돌 때 같은 경기가 이중 게시되는 것을 DB가 차단한다.
create unique index if not exists betgirl_events_natural_key
  on public.betgirl_events (start_at, home, away);

select 'ok' as status;
