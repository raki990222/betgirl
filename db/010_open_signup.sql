-- betgirl 010 — 참여 개방: 초대 코드 게이트 + 어뷰징 방어 (SQL Editor 1회 실행)
--
-- 어뷰징 모델: 공격자가 이메일 다계정으로 가입해 웰컴벳(1,000,000)을 무한 수령하는 것.
-- 방어 설계:
--   1) 이메일 가입 자체는 열되(Supabase Auth), 계정만으로는 아무것도 못 한다.
--      참가자 등록(핸들+웰컴벳)은 반드시 "미사용 초대 코드 1장"을 소모해야 한다.
--   2) 초대 코드 발급은 당분간 운영자 전용. (추후 참가자 쿼터제로 완화 가능)
--   3) 누가 누구를 초대했는지(초대 그래프)는 공개 뷰로 노출 — 파밍 트리가 눈에 보인다.
--   4) 본인인증(PASS 등)은 인증사 계약 필요 → profiles.identity_verified 자리만 마련.
--
-- ⚠️ 함께 할 것(Supabase 대시보드): Authentication → Sign In/Providers → Email 에서
--    "Allow new users to sign up" 켜기 + "Confirm email" 켜기.

-- ---------------------------------------------------------------- 초대 코드
create table if not exists public.betgirl_invites (
  code       text primary key,
  issuer     uuid not null references auth.users(id),
  memo       text,
  created_at timestamptz not null default now(),
  used_by    uuid references auth.users(id),
  used_at    timestamptz
);

alter table public.betgirl_invites enable row level security;

-- 미사용 코드는 비밀이다: 발급자 본인·운영자만 조회 가능
drop policy if exists betgirl_invites_own_read on public.betgirl_invites;
create policy betgirl_invites_own_read
  on public.betgirl_invites for select to authenticated
  using (issuer = auth.uid() or public.betgirl_is_operator());

grant select on public.betgirl_invites to authenticated;

-- 발급 RPC (당분간 운영자 전용)
create or replace function public.betgirl_issue_invite(p_memo text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code text;
begin
  if not public.betgirl_is_operator() then
    raise exception '지금은 운영자만 초대 코드를 발급할 수 있습니다.' using errcode = '42501';
  end if;

  loop
    v_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));   -- 8자리
    begin
      insert into public.betgirl_invites (code, issuer, memo)
      values (v_code, auth.uid(), p_memo);
      return v_code;
    exception when unique_violation then
      -- 충돌 시 재시도
    end;
  end loop;
end;
$$;

grant execute on function public.betgirl_issue_invite(text) to authenticated;

-- ---------------------------------------------------------------- 프로필 확장
alter table public.betgirl_profiles
  add column if not exists invited_by        uuid references auth.users(id),
  add column if not exists identity_verified boolean not null default false;  -- 본인인증 계약 후 사용

-- 웰컴벳 자동지급 트리거 제거: 지급은 이제 초대를 소모하는 betgirl_join() 경유만
drop trigger if exists betgirl_profiles_welcome on public.betgirl_profiles;

-- 직접 INSERT 는 운영자만 (일반 참가자는 RPC 경유)
drop policy if exists betgirl_profiles_self_insert on public.betgirl_profiles;
create policy betgirl_profiles_op_insert
  on public.betgirl_profiles for insert to authenticated
  with check (public.betgirl_is_operator());

-- ---------------------------------------------------------------- 참가 등록 RPC
create or replace function public.betgirl_join(p_handle text, p_invite_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_invite_code, '')));
  inv    public.betgirl_invites%rowtype;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('betgirl_invites'));

  if exists (select 1 from public.betgirl_profiles where user_id = v_uid) then
    raise exception '이미 참가자로 등록된 계정입니다.';
  end if;

  select * into inv
    from public.betgirl_invites
   where code = v_code and used_by is null
   for update;

  if not found then
    raise exception '유효하지 않거나 이미 사용된 초대 코드입니다.';
  end if;

  insert into public.betgirl_profiles (user_id, handle, invited_by)
  values (v_uid, btrim(p_handle), inv.issuer);

  update public.betgirl_invites
     set used_by = v_uid, used_at = now()
   where code = inv.code;

  insert into public.betgirl_credits (user_id, handle, amount, reason)
  values (v_uid, btrim(p_handle), 1000000, '가입 축하 벳');
end;
$$;

grant execute on function public.betgirl_join(text, text) to authenticated;

-- ---------------------------------------------------------------- 초대 그래프 (공개)
create or replace view public.betgirl_invite_graph as
select
  pi.handle  as inviter,
  pu.handle  as invitee,
  i.used_at
from public.betgirl_invites i
join public.betgirl_profiles pu on pu.user_id = i.used_by
left join public.betgirl_profiles pi on pi.user_id = i.issuer
where i.used_by is not null;

grant select on public.betgirl_invite_graph to anon, authenticated;

-- ---------------------------------------------------------------- 확인
select 'invites' as t, count(*) from public.betgirl_invites
union all
select 'profiles', count(*) from public.betgirl_profiles;
