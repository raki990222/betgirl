// betgirl — 경기 보드 + 픽 등록
import { sb, initNav, currentUser, won, esc, safeUrl } from './app.js';

const $ = (s) => document.querySelector(s);

let board = [];                 // betgirl_board 행
let me = { session: null, profile: null, isOperator: false };
const slip = new Map();         // event_id → { ev, opt, stake }

// 무코드 가입(5,000벳)도 픽을 걸 수 있도록 최소 단위를 낮게 잡는다. 100벳 단위만 허용.
const DEFAULT_STAKE = 5000;
const MIN_STAKE = 1000;
const STAKE_STEP = 100;

/** ?invite=CODE 초대 링크로 들어오면 코드를 저장해 가입·참가 등록에 자동 채움 */
const urlInvite = new URLSearchParams(location.search).get('invite');
if (urlInvite && /^[A-Za-z0-9]{4,16}$/.test(urlInvite)) {
  localStorage.setItem('betgirl_invite', urlInvite.toUpperCase());
}

/* ------------------------------------------------------------------ 시각 */
const startLabel = (ts) => {
  const d = new Date(ts);
  return d.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

const kstShort = (ts) =>
  new Date(ts).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });

const untilLabel = (ts) => {
  const ms = new Date(ts) - Date.now();
  if (ms <= 0) return '마감';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `${Math.floor(h / 24)}일 뒤`;
  if (h >= 1) return `${h}시간 뒤`;
  return `${Math.max(1, Math.floor(ms / 60000))}분 뒤`;
};

/* ------------------------------------------------------------------ 계정 */
function renderAccount() {
  const el = $('#account');

  if (!me.session) {
    el.innerHTML = `
      <section class="panel">
        <div class="panel-head">
          <h2 id="authTitle">픽을 등록하려면 로그인하세요</h2>
          <div class="spacer"></div>
          <button class="ghost" id="authToggle">계정 만들기</button>
        </div>
        <div style="padding:18px">
          <div id="authMsg"></div>
          <form id="authForm" class="row" style="align-items:end">
            <div class="field" style="margin:0">
              <label for="authEmail">이메일</label>
              <input id="authEmail" type="email" autocomplete="username" required />
            </div>
            <div class="field" style="margin:0">
              <label for="authPw">비밀번호</label>
              <input id="authPw" type="password" autocomplete="current-password" required minlength="8" />
            </div>
            <div class="field" style="margin:0" id="authPw2Field" hidden>
              <label for="authPw2">비밀번호 확인</label>
              <input id="authPw2" type="password" autocomplete="new-password" minlength="8" />
            </div>
            <div class="field" style="margin:0" id="authInviteField" hidden>
              <label for="authInvite">초대 코드 (선택)</label>
              <input id="authInvite" maxlength="16" placeholder="있으면 20,000벳"
                     style="text-transform:uppercase" autocomplete="off" />
            </div>
            <div class="field" style="margin:0"><button type="submit" style="width:100%" id="authSubmit">로그인</button></div>
          </form>
        </div>
        <div class="note" id="authNote">
          참여 순서: ① 이메일 가입 → ② 확인 메일 클릭 → ③ 로그인 → ④ 참가 등록.
          가입 벳: 코드 없이 <strong>5,000벳</strong>, 초대 코드가 있으면 <strong>20,000벳</strong>
          (초대한 친구도 10,000벳). 가입 때 코드를 입력해두면 ④에서 자동으로 채워집니다.
          구경만 하실 거면 로그인 없이 <a href="/ledger">공개 원장</a>을 보세요.
        </div>
      </section>`;

    let signupMode = false;
    $('#authToggle').addEventListener('click', () => {
      signupMode = !signupMode;
      $('#authTitle').textContent = signupMode ? '계정 만들기' : '픽을 등록하려면 로그인하세요';
      $('#authSubmit').textContent = signupMode ? '가입 (확인 메일 발송)' : '로그인';
      $('#authToggle').textContent = signupMode ? '로그인으로' : '계정 만들기';
      $('#authPw2Field').hidden = !signupMode;
      $('#authInviteField').hidden = !signupMode;
      $('#authPw2').required = signupMode;
      $('#authPw').autocomplete = signupMode ? 'new-password' : 'current-password';
      $('#authMsg').innerHTML = '';
    });

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#authEmail').value.trim();
      const password = $('#authPw').value;
      $('#authMsg').innerHTML = '';

      if (signupMode) {
        if (password !== $('#authPw2').value) {
          $('#authMsg').innerHTML = `<div class="msg err">비밀번호가 서로 다릅니다. 다시 확인해주세요.</div>`;
          return;
        }
        // 초대 코드는 가입이 아니라 참가 등록에서 소모된다. 여기서 받아두면
        // 로그인 후 참가 등록 폼에 자동으로 채워진다.
        const invite = $('#authInvite').value.trim().toUpperCase();
        if (invite) localStorage.setItem('betgirl_invite', invite);

        const { error } = await sb.auth.signUp({
          email, password,
          options: { emailRedirectTo: location.origin + '/' },
        });
        $('#authMsg').innerHTML = error
          ? `<div class="msg err">${esc(error.message)}</div>`
          : `<div class="msg ok">확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 이 페이지에서 로그인하세요.${invite ? ' 초대 코드는 저장해뒀습니다.' : ''}</div>`;
        return;
      }

      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        $('#authMsg').innerHTML = `<div class="msg err">${esc(error.message)}</div>`;
        return;
      }
      location.reload();
    });
    return;
  }

  if (!me.profile) {
    el.innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>참가 등록</h2></div>
        <div style="padding:18px">
          <div id="handleMsg"></div>
          <p class="dim" style="margin-top:0">
            참가자 이름은 원장에 공개되며 <strong>한 번 정하면 바꿀 수 없습니다.</strong>
            초대 코드가 있으면 <strong>20,000벳</strong>, 없이 등록하면 <strong>5,000벳</strong>이 지급됩니다.
            누가 누구를 초대했는지는 투명성을 위해 공개됩니다.
          </p>
          <form id="handleForm" class="row" style="align-items:end">
            <div class="field" style="margin:0">
              <label for="handle">참가자 이름 (20자 이내)</label>
              <input id="handle" maxlength="20" required placeholder="예: 지연" />
            </div>
            <div class="field" style="margin:0">
              <label for="inviteCode">초대 코드 (선택)</label>
              <input id="inviteCode" maxlength="16" placeholder="있으면 20,000벳"
                     style="text-transform:uppercase" autocomplete="off" />
            </div>
            <div class="field" style="margin:0"><button type="submit" style="width:100%">참가 등록</button></div>
          </form>
        </div>
      </section>`;

    // 가입 때 입력해둔 초대 코드가 있으면 자동으로 채운다
    const savedInvite = localStorage.getItem('betgirl_invite');
    if (savedInvite) $('#inviteCode').value = savedInvite;

    $('#handleForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const { error } = await sb.rpc('betgirl_join', {
        p_handle: $('#handle').value.trim(),
        p_invite_code: $('#inviteCode').value.trim() || null,
      });
      btn.disabled = false;
      if (error) {
        const dup = error.code === '23505';
        $('#handleMsg').innerHTML =
          `<div class="msg err">${esc(dup ? '이미 사용 중인 이름입니다.' : error.message)}</div>`;
        return;
      }
      localStorage.removeItem('betgirl_invite');
      location.reload();
    });
    return;
  }

  el.innerHTML = `
    <div class="whoami">
      <span><strong>${esc(me.profile.handle)}</strong> 님으로 픽을 등록합니다.</span>
      ${me.isOperator ? '<span class="badge void">운영자</span>' : ''}
      <span class="spacer" style="margin-left:auto"></span>
      <button class="ghost" id="inviteOpen" style="padding:5px 12px;font-size:13px">친구 초대 +10,000벳</button>
      <a class="balance" href="/ledger#wallet=${encodeURIComponent(me.profile.handle)}"
         title="소지금 내역 보기">소지금 <strong id="balanceVal">…</strong></a>
    </div>
    <section class="panel" id="invitePanel" hidden>
      <div class="panel-head"><h2>친구 초대</h2>
        <div class="spacer"></div>
        <button id="inviteMake">초대 링크 만들기</button>
      </div>
      <div style="padding:0 18px">
        <div id="myInviteMsg" style="margin-top:14px"></div>
        <p class="dim">
          친구가 이 링크로 참가 등록하면 친구는 <strong>20,000벳</strong>, 나는 <strong>10,000벳</strong>을 받습니다.
          미사용 코드는 5장까지 보유할 수 있고, 초대 관계는 공개됩니다.
        </p>
      </div>
      <div id="myInvites"></div>
    </section>`;
  refreshBalance();

  $('#inviteOpen').addEventListener('click', () => {
    const p = $('#invitePanel');
    p.hidden = !p.hidden;
    if (!p.hidden) loadMyInvites();
  });

  $('#inviteMake').addEventListener('click', async () => {
    const btn = $('#inviteMake');
    btn.disabled = true;
    const { data, error } = await sb.rpc('betgirl_issue_invite', { p_memo: null });
    btn.disabled = false;
    if (error) {
      $('#myInviteMsg').innerHTML = `<div class="msg err">${esc(error.message)}</div>`;
      return;
    }
    $('#myInviteMsg').innerHTML = `<div class="msg ok">초대 링크가 생성되었습니다. 아래에서 복사하세요.</div>`;
    loadMyInvites();
  });
}

async function loadMyInvites() {
  const box = document.querySelector('#myInvites');
  const { data, error } = await sb
    .from('betgirl_invites')
    .select('code,created_at,used_by,used_at')
    .eq('issuer', me.session.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data?.length) {
    box.innerHTML = `<div class="empty">${error ? esc(error.message) : '아직 만든 초대가 없습니다.'}</div>`;
    return;
  }

  box.innerHTML = data
    .map((i) => {
      const link = `${location.origin}/?invite=${i.code}`;
      return `<div class="slip-row">
        <div class="slip-info">
          <strong class="hash" style="font-size:13px">${esc(i.code)}</strong>
          <div class="dim">${i.used_at ? `사용됨 · ${esc(kstShort(i.used_at))} · +10,000벳 지급` : esc(link)}</div>
        </div>
        ${i.used_at
          ? '<span class="badge win">완료</span>'
          : `<button class="ghost" data-copy="${esc(link)}">링크 복사</button>`}
      </div>`;
    })
    .join('');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = '복사됨!';
    setTimeout(() => (btn.textContent = '링크 복사'), 1500);
  } catch {
    prompt('복사가 차단되었습니다. 직접 복사하세요:', btn.dataset.copy);
  }
});

async function refreshBalance() {
  const el = document.querySelector('#balanceVal');
  if (!el || !me.profile) return;
  const { data, error } = await sb
    .from('betgirl_balances')
    .select('balance')
    .eq('handle', me.profile.handle)
    .maybeSingle();
  el.textContent = error || !data ? '—' : won(data.balance);
}

/* ------------------------------------------------------------------ 경기 */
async function loadBoard() {
  const { data, error } = await sb
    .from('betgirl_board')
    .select('*')
    .order('start_at', { ascending: true })
    .limit(500);

  if (error) {
    $('#matches').innerHTML = `<div class="empty" style="color:var(--lose)">${esc(error.message)}</div>`;
    return;
  }
  board = data;

  const rounds = [...new Set(board.map((e) => e.round_key))];
  $('#fRound').insertAdjacentHTML(
    'beforeend',
    rounds.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')
  );

  renderMatches();
}

function renderMatches() {
  const round = $('#fRound').value;
  const view = $('#fView').value;

  const list = board.filter((e) => {
    if (round && e.round_key !== round) return false;
    if (view === 'open' && !e.open_for_picks) return false;
    if (view === 'done' && e.status !== 'settled') return false;
    return true;
  });

  if (!list.length) {
    $('#matches').innerHTML = `<div class="empty">표시할 경기가 없습니다.</div>`;
    return;
  }

  // 회차 → 경기
  const groups = new Map();
  for (const e of list) {
    if (!groups.has(e.round_key)) groups.set(e.round_key, []);
    groups.get(e.round_key).push(e);
  }

  // 오늘 기준 정렬: 오늘·다가올 회차를 임박한 순으로 먼저, 지난 회차는 최근 순으로 뒤에.
  // (지난 경기는 숨기지 않되 아래로 내린다)
  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
  const dayOf = (evs) => new Date(evs[0].start_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  const ordered = [...groups].sort(([, a], [, b]) => {
    const da = dayOf(a);
    const db = dayOf(b);
    const pa = da < todayKey ? 1 : 0;   // 지난 날짜는 뒤로
    const pb = db < todayKey ? 1 : 0;
    if (pa !== pb) return pa - pb;
    // 다가올 회차는 오름차순(임박한 순), 지난 회차는 내림차순(최근 순)
    return pa === 0 ? da.localeCompare(db) : db.localeCompare(da);
  });

  $('#matches').innerHTML = ordered
    .map(([roundKey, evs]) => {
      const day = dayOf(evs);
      const tag =
        day === todayKey ? '<span class="badge pending">오늘</span>'
        : day < todayKey ? '<span class="badge void">종료</span>'
        : '';
      return `
      <div class="round-head">${esc(roundKey)} <span class="dim">${evs.length}경기</span> ${tag}</div>
      ${evs
        .slice()
        .sort((x, y) => new Date(x.start_at) - new Date(y.start_at))
        .map(matchCard)
        .join('')}`;
    })
    .join('');
}

function matchCard(e) {
  const picked = slip.get(e.id);
  const opts = Array.isArray(e.options) ? e.options : [];

  // 결과가 기록된 경우만 '결과 확정'으로 취급한다 (구버전 RPC 가 결과 없이 settled 만
  // 남긴 행이 있으면 마감 상태로만 표시)
  const settled = e.status === 'settled' && !!e.result_code;
  const cancelled = settled && e.result_code === 'CANCEL';
  const winOpt = settled && !cancelled ? opts.find((o) => o.code === e.result_code) : null;

  const buttons = opts
    .map((o) => {
      const on = picked && picked.opt.code === o.code;
      const won_ = winOpt && winOpt.code === o.code;
      return `<button class="opt${on ? ' on' : ''}${won_ ? ' won' : ''}${settled && !won_ ? ' lost' : ''}"
                data-event="${e.id}" data-code="${esc(o.code)}"
                ${e.open_for_picks ? '' : 'disabled'}>
        <span class="opt-label">${won_ ? '✓ ' : ''}${esc(o.label)}</span>
        <span class="opt-odds">${Number(o.odds).toFixed(2)}</span>
      </button>`;
    })
    .join('');

  const badge = settled
    ? cancelled
      ? '<span class="badge void">경기 취소</span>'
      : '<span class="badge win">결과 확정</span>'
    : `<span class="badge ${e.open_for_picks ? 'pending' : 'void'}">${esc(untilLabel(e.start_at))}</span>`;

  const resultLine = settled
    ? `<div class="match-result">
         결과: <strong>${esc(cancelled ? '경기 취소 — 전 픽 원금 반환' : (winOpt?.label ?? e.result_code))}</strong>
         ${e.result_at ? `<span class="dim"> · ${esc(kstShort(e.result_at))} 확정</span>` : ''}
         ${safeUrl(e.result_proof_url) ? ` · <a href="${esc(safeUrl(e.result_proof_url))}" target="_blank" rel="noopener noreferrer">결과 증빙</a>` : ''}
       </div>`
    : '';

  return `
    <article class="match${e.open_for_picks ? '' : ' closed'}${settled ? ' settled' : ''}">
      <div class="match-top">
        <span class="dim">${esc(e.league)} · ${esc(e.market)}</span>
        <span class="spacer"></span>
        <span class="dim">${esc(startLabel(e.start_at))}</span>
        ${badge}
      </div>
      <div class="match-teams">${esc(e.home)} <span class="dim">vs</span> ${esc(e.away)}</div>
      <div class="opts">${buttons}</div>
      ${resultLine}
      <div class="match-foot dim">
        등록된 픽 ${e.pick_count}건 · 합계 ${won(e.staked)}
        ${safeUrl(e.official_url) ? ` · <a href="${esc(safeUrl(e.official_url))}" target="_blank" rel="noopener noreferrer">공식 정보</a>` : ''}
      </div>
    </article>`;
}

/* ------------------------------------------------------------------ 슬립 */
function toggleOption(eventId, code) {
  const ev = board.find((e) => e.id === eventId);
  if (!ev || !ev.open_for_picks) return;

  const opt = (ev.options || []).find((o) => o.code === code);
  if (!opt) return;

  const cur = slip.get(eventId);
  if (cur && cur.opt.code === code) slip.delete(eventId);
  else slip.set(eventId, { ev, opt, stake: cur?.stake ?? DEFAULT_STAKE });

  renderMatches();
  renderSlip();
}

function renderSlip() {
  const body = $('#slipBody');
  const foot = $('#slipFoot');
  $('#clearSlip').hidden = slip.size === 0;

  if (!slip.size) {
    body.innerHTML = `<div class="empty">경기에서 배당을 눌러 픽을 담으세요.</div>`;
    foot.hidden = true;
    return;
  }

  body.innerHTML = [...slip.values()]
    .map(
      ({ ev, opt, stake }) => `
      <div class="slip-row">
        <div class="slip-info">
          <strong>${esc(opt.label)}</strong>
          <div class="dim">${esc(ev.home)} vs ${esc(ev.away)} · 배당 ${Number(opt.odds).toFixed(2)}</div>
        </div>
        <input class="slip-stake" type="number" min="${MIN_STAKE}" step="${STAKE_STEP}" value="${stake}" data-event="${ev.id}" />
        <button class="slip-x ghost" data-remove="${ev.id}" aria-label="빼기">×</button>
      </div>`
    )
    .join('');

  const total = [...slip.values()].reduce((a, s) => a + Number(s.stake || 0), 0);
  $('#slipTotal').textContent = won(total);
  foot.hidden = false;

  const submit = $('#submitSlip');
  const ready = !!(me.session && me.profile);
  submit.disabled = !ready;
  submit.textContent = !me.session ? '로그인 후 등록 가능'
    : !me.profile ? '참가자 이름을 먼저 정하세요'
    : `픽 ${slip.size}건 등록`;
}

/* ------------------------------------------------------------------ 등록 */
async function submitSlip() {
  const btn = $('#submitSlip');
  btn.disabled = true;
  $('#slipMsg').innerHTML = '';

  const entries = [...slip.values()];
  const invalid = entries.filter(({ stake }) => Number(stake) % 100 !== 0 || Number(stake) < MIN_STAKE);
  if (invalid.length) {
    $('#slipMsg').innerHTML =
      `<div class="msg err">베팅은 최소 ${MIN_STAKE.toLocaleString('ko-KR')}벳, 100벳 단위로만 가능합니다.</div>`;
    btn.disabled = false;
    return;
  }

  const done = [];
  const failed = [];

  // 한 건씩 순차 등록해 실패(잔고 부족·마감 등)를 픽별로 보고한다.
  for (const { ev, opt, stake } of entries) {
    const { data, error } = await sb
      .from('betgirl_bets')
      .insert({
        bettor: me.profile.handle,
        event_id: ev.id,
        option_code: opt.code,
        stake: Number(stake),
      })
      .select('seq')
      .single();

    if (error) failed.push({ ev, opt, message: error.message });
    else {
      done.push(data.seq);
      slip.delete(ev.id);
    }
  }

  const parts = [];
  if (done.length) parts.push(`<div class="msg ok">${done.length}건 등록 완료 (#${done.join(', #')})</div>`);
  for (const f of failed) {
    parts.push(`<div class="msg err">${esc(f.ev.away)} @ ${esc(f.ev.home)} — ${esc(f.message)}</div>`);
  }
  $('#slipMsg').innerHTML = parts.join('');

  await loadBoardRefresh();
  refreshBalance();
  renderSlip();
  btn.disabled = false;
}

async function loadBoardRefresh() {
  const { data } = await sb
    .from('betgirl_board')
    .select('*')
    .order('start_at', { ascending: true })
    .limit(500);
  if (data) board = data;
  renderMatches();
}

/* ------------------------------------------------------------------ 이벤트 */
$('#matches').addEventListener('click', (e) => {
  const btn = e.target.closest('button.opt');
  if (!btn || btn.disabled) return;
  toggleOption(Number(btn.dataset.event), btn.dataset.code);
});

$('#slipBody').addEventListener('click', (e) => {
  const x = e.target.closest('[data-remove]');
  if (!x) return;
  slip.delete(Number(x.dataset.remove));
  renderMatches();
  renderSlip();
});

$('#slipBody').addEventListener('input', (e) => {
  const input = e.target.closest('.slip-stake');
  if (!input) return;
  const entry = slip.get(Number(input.dataset.event));
  if (entry) entry.stake = Number(input.value);
  const total = [...slip.values()].reduce((a, s) => a + Number(s.stake || 0), 0);
  $('#slipTotal').textContent = won(total);
});

$('#clearSlip').addEventListener('click', () => {
  slip.clear();
  renderMatches();
  renderSlip();
});

$('#submitSlip').addEventListener('click', submitSlip);
$('#fRound').addEventListener('change', renderMatches);
$('#fView').addEventListener('change', renderMatches);

/* ------------------------------------------------------------------ 시작 */
(async () => {
  initNav('/');
  me = await currentUser();
  renderAccount();
  await loadBoard();
  renderSlip();
})();
