-- betgirl 012 — 초대 이벤트 (SQL Editor 1회 실행, 011 이후)
--
-- 지급 구조 개편 (2026-08-06 확정):
--   · 코드 없이 참가 등록: 5,000벳
--   · 초대 코드로 참가 등록: 신규 20,000벳 + 초대한 사람 10,000벳
--   · 일반 참가자도 초대 코드(링크) 발급 가능 — 단 미사용 코드 5장까지 (운영자 무제한)
--
-- 어뷰징 노트: 무코드 가입(5,000벳)과 자기초대(+30,000벳)는 다계정으로 반복 가능하다.
-- 방어선 = ① 모든 지급이 공개 원장(credits 체인)에 남고 ② 초대 그래프 공개
-- ③ 벳의 실가치 전환(기프티콘 교환)은 운영자 수동 심사 — 파밍 트리는 교환 시점에 걸러진다.
-- 본인인증 계약 후 identity_verified 게이트로 강화 예정.

-- ---------------------------------------------------------------- 발급: 참가자 개방
create or replace function public.betgirl_issue_invite(p_memo text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code   text;
  v_unused int;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- 쿼터 검사~발급을 직렬화한다. 안 잡으면 병렬 호출 N개가 전부 count<5 를 통과해
  -- 미사용 5장 제한이 무효가 된다 (join 과 같은 키 — invites→credits 순서라 교착 없음).
  perform pg_advisory_xact_lock(hashtext('betgirl_invites'));

  if not public.betgirl_is_operator() then
    if public.betgirl_my_handle() is null then
      raise exception '참가 등록 후에 초대 코드를 만들 수 있습니다.' using errcode = '42501';
    end if;

    select count(*) into v_unused
      from public.betgirl_invites
     where issuer = auth.uid() and used_by is null;

    if v_unused >= 5 then
      raise exception '미사용 초대 코드는 5장까지만 보유할 수 있습니다. 기존 코드가 사용된 뒤 다시 만드세요.'
        using errcode = '42501';
    end if;
  end if;

  loop
    v_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));
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

-- ---------------------------------------------------------------- 참가 등록: 코드 선택제
create or replace function public.betgirl_join(p_handle text, p_invite_code text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid            uuid := auth.uid();
  v_code           text := upper(btrim(coalesce(p_invite_code, '')));
  v_inviter_handle text;
  inv              public.betgirl_invites%rowtype;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('betgirl_invites'));

  if exists (select 1 from public.betgirl_profiles where user_id = v_uid) then
    raise exception '이미 참가자로 등록된 계정입니다.';
  end if;

  if v_code = '' then
    -- 코드 없이 등록: 5,000벳
    insert into public.betgirl_profiles (user_id, handle)
    values (v_uid, btrim(p_handle));

    insert into public.betgirl_credits (user_id, handle, amount, reason)
    values (v_uid, btrim(p_handle), 5000, '가입 축하 벳');
    return;
  end if;

  -- 코드가 입력됐는데 유효하지 않으면 조용히 5,000벳으로 낮추지 않고 오류를 낸다 (오타 교정 기회)
  select * into inv
    from public.betgirl_invites
   where code = v_code and used_by is null
   for update;

  if not found then
    raise exception '유효하지 않거나 이미 사용된 초대 코드입니다. 코드 없이 등록하려면 칸을 비워두세요.';
  end if;

  if inv.issuer = v_uid then
    raise exception '자신이 만든 초대 코드는 사용할 수 없습니다.';
  end if;

  insert into public.betgirl_profiles (user_id, handle, invited_by)
  values (v_uid, btrim(p_handle), inv.issuer);

  update public.betgirl_invites
     set used_by = v_uid, used_at = now()
   where code = inv.code;

  -- 신규 참가자 20,000벳
  insert into public.betgirl_credits (user_id, handle, amount, reason)
  values (v_uid, btrim(p_handle), 20000, '가입 축하 벳 (초대)');

  -- 초대한 참가자 10,000벳 (프로필이 있는 발급자만)
  select handle into v_inviter_handle
    from public.betgirl_profiles where user_id = inv.issuer;

  if v_inviter_handle is not null then
    insert into public.betgirl_credits (user_id, handle, amount, reason)
    values (inv.issuer, v_inviter_handle, 10000, '친구 초대 리워드');
  end if;
end;
$$;

grant execute on function public.betgirl_join(text, text) to authenticated;

-- ---------------------------------------------------------------- 확인
select 'ok' as status;
