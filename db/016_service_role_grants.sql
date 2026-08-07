-- betgirl 016 — service_role 권한 복구 (SQL Editor 1회 실행)
--
-- 프로젝트 생성 시 "Automatically expose new tables" 를 꺼서 service_role 에도
-- 테이블 GRANT 가 없다 (RLS 우회와 GRANT 는 별개 층). KBO 자동 연동(kbo_sync.py)이
-- 경기 게시·취소 환급을 쓰려면 필요하다.
-- 추가 전용 보호는 트리거가 담당하므로 update/delete 를 허용해도 원장 불변은 유지된다.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

select 'service_role grants ok' as status;
