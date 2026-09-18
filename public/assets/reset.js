// betgirl — 비밀번호 재설정 (/reset)
//
// ① 이메일 입력 → resetPasswordForEmail(redirectTo=/reset) → Supabase 가 재설정 메일 발송
// ② 메일 링크 → Supabase 가 /reset#access_token=…&type=recovery 로 돌려보냄
//    → 클라이언트(app.js sb)가 세션을 만들고 PASSWORD_RECOVERY 를 알림 → 새 비밀번호 → updateUser
//
// 🔴 2026-09-18 Supabase 새 프로젝트 이전 때 비밀번호 해시는 옮길 수 없었다 —
//    이전 전 가입자는 여기서 한 번 다시 정해야 로그인할 수 있다.
// 🔴 새 비밀번호 칸은 메일 링크(PASSWORD_RECOVERY)로 들어왔을 때만 연다.
//    로그인만 된 상태로 여는 경로를 만들면, 켜진 브라우저를 잠깐 쓴 사람이 비밀번호를 바꿔 주인을 잠글 수 있다.
import { sb, initNav, esc } from './app.js';

const $ = (s) => document.querySelector(s);

const MIN_PW = 8;          // 가입 화면(board.js)과 같은 기준
const RESEND_WAIT = 60;    // Supabase 는 같은 주소로 60초에 한 번만 재설정 메일을 보낸다

// 메일 링크의 결과는 주소 해시(#)로 온다. 클라이언트가 세션을 만든 뒤 해시를 지우므로
// 이 모듈이 실행되는 지금(= app.js 의 네트워크 확인이 끝나기 전) 읽어 둔다.
const hashParams = new URLSearchParams(location.hash.slice(1));
const queryParams = new URLSearchParams(location.search);
const linkType = hashParams.get('type');
const linkError =
  hashParams.get('error_code') || hashParams.get('error') ||
  queryParams.get('error_code') || queryParams.get('error');

/* ------------------------------------------------------------------ 화면 */
const VIEWS = ['requestForm', 'newPwForm', 'doneView'];
function show(id) {
  for (const v of VIEWS) $(`#${v}`).hidden = v !== id;
  $('#loading').hidden = true;
  $('#note').hidden = id !== 'requestForm';
}
function say(html, kind = 'ok') {
  $('#msg').innerHTML = html ? `<div class="msg ${kind}">${html}</div>` : '';
}

/* ------------------------------------------------------------ 오류 문구 */
// Supabase 오류는 영문이다 — 사용자가 다음에 뭘 해야 하는지 한 줄로 바꿔 준다.
function linkErrorText(code) {
  if (code === 'otp_expired' || code === 'access_denied')
    return '메일의 링크가 만료됐거나 이미 사용됐습니다. 아래에서 재설정 메일을 다시 받아 주세요.';
  return '링크를 확인하지 못했습니다. 아래에서 재설정 메일을 다시 받아 주세요.';
}

function requestErrorText(error) {
  const code = error?.code || '';
  const msg = String(error?.message || '');
  const wait = msg.match(/after (\d+) seconds?/i);
  if (wait) return `너무 자주 요청했습니다. ${wait[1]}초 뒤에 다시 시도해 주세요.`;
  if (code === 'over_email_send_rate_limit' || /email rate limit/i.test(msg))
    return '메일 발송 한도에 걸렸습니다. 잠시 뒤에 다시 시도해 주세요.';
  if (code === 'over_request_rate_limit' || error?.status === 429)
    return '요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.';
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg))
    return '이메일 주소 형식을 확인해 주세요.';
  if (/sending|smtp|mail/i.test(msg) || error?.status >= 500)
    return '메일을 보내지 못했습니다. 잠시 뒤에 다시 시도하고, 계속되면 운영자에게 알려 주세요.';
  return msg || '요청을 처리하지 못했습니다.';
}

function updateErrorText(error) {
  const code = error?.code || '';
  const msg = String(error?.message || '');
  if (code === 'same_password' || /different from the old password/i.test(msg))
    return '이전과 다른 비밀번호를 정해 주세요.';
  if (code === 'weak_password' || /at least \d+ characters|weak/i.test(msg))
    return '비밀번호가 너무 약합니다. 더 길게, 또는 숫자·기호를 섞어 주세요.';
  if (code === 'session_not_found' || code === 'session_expired' ||
      /session missing|jwt expired|not authenticated/i.test(msg) ||
      error?.name === 'AuthSessionMissingError' || error?.status === 401 || error?.status === 403)
    return '재설정 링크의 유효 시간이 지났습니다. 재설정 메일을 다시 받아 주세요.';
  return msg || '비밀번호를 바꾸지 못했습니다.';
}
const isSessionGone = (error) =>
  updateErrorText(error).startsWith('재설정 링크의 유효 시간이 지났습니다');

/* ------------------------------------------------------ ② 새 비밀번호 */
let recovery = null;       // 메일 링크로 받은 세션 — 이게 있어야만 새 비밀번호 칸을 연다

function enterNewPassword(session) {
  if (recovery || !session) return;
  recovery = session;
  history.replaceState(null, '', location.pathname);   // 주소창의 링크 흔적 정리
  $('#title').textContent = '새 비밀번호 정하기';
  $('#acct').value = session.user?.email || '';
  say('');
  show('newPwForm');
  $('#pw').focus();
}

// 링크 처리가 끝나면 app.js 의 클라이언트가 알려준다(모듈 실행 직후 구독 → 놓치지 않는다)
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') enterNewPassword(session);
});

$('#newPwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#pw').value;
  if (pw.length < MIN_PW) return say(`비밀번호는 ${MIN_PW}자 이상이어야 합니다.`, 'err');
  if (pw !== $('#pw2').value) return say('두 비밀번호가 서로 다릅니다. 다시 확인해 주세요.', 'err');

  const btn = $('#newPwBtn');
  btn.disabled = true;
  say('');
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    btn.disabled = false;
    say(esc(updateErrorText(error)), 'err');
    if (isSessionGone(error)) { recovery = null; show('requestForm'); }
    return;
  }
  $('#pw').value = '';
  $('#pw2').value = '';
  $('#title').textContent = '비밀번호를 바꿨습니다';
  say('');
  show('doneView');
  setTimeout(() => location.replace('/'), 2500);
});

/* ------------------------------------------------------ ① 재설정 메일 */
function cooldown(btn, seconds) {
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `다시 보내기 (${left})`;
  const t = setInterval(() => {
    left -= 1;
    if (left > 0) { btn.textContent = `다시 보내기 (${left})`; return; }
    clearInterval(t);
    btn.disabled = false;
    btn.textContent = label === '재설정 메일 받기' ? '재설정 메일 다시 받기' : label;
  }, 1000);
}

$('#requestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim();
  if (!email) return;
  const btn = $('#requestBtn');
  btn.disabled = true;
  say('');
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}/reset`,
  });
  if (error) {
    btn.disabled = false;
    return say(esc(requestErrorText(error)), 'err');
  }
  // 가입 여부는 알려주지 않는다(Supabase 도 없는 주소에 똑같이 성공을 돌려준다) — 계정 존재 탐색 방지
  say(`<strong>${esc(email)}</strong> 로 가입된 계정이 있으면 재설정 메일이 곧 도착합니다.
       메일의 링크를 누르면 이 화면에서 새 비밀번호를 정할 수 있습니다. 안 보이면 스팸함도 확인해 주세요.`);
  cooldown(btn, RESEND_WAIT);
});

/* ------------------------------------------------------------------ 시작 */
async function main() {
  initNav('');
  const { data } = await sb.auth.getSession();   // 링크 처리(세션 생성)가 끝날 때까지 기다린다
  const session = data?.session || null;

  if (linkType === 'recovery' && session) return enterNewPassword(session);
  if (recovery) return;                           // 이벤트가 먼저 와서 이미 열림

  if (linkError || linkType === 'recovery') {
    history.replaceState(null, '', location.pathname);
    say(esc(linkErrorText(linkError)), 'err');
  }
  if (session?.user?.email) $('#email').value = session.user.email;
  show('requestForm');
}

main();
