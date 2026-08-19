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
const QUICK_STAKES = [1000, 5000, 10000, 50000];
const MAX_LEGS = 10;                    // DB(betgirl_place_combo)와 같은 상한
const MAX_ODDS_CENTS = 999999;          // odds numeric(6,2) 상한 = 9,999.99

// 'single' = 경기마다 따로 등록 / 'combo' = 담긴 경기를 한 장으로 묶어 전부 맞아야 적중
let slipMode = 'single';
let bulkStake = DEFAULT_STAKE;          // 싱글 일괄 적용 금액 (새 픽의 기본값이기도 하다)
let comboStake = DEFAULT_STAKE;         // 조합 티켓 한 장의 베팅액
let feeRate = 0.05;                     // 적중 수수료 — betgirl_fee_policy 에서 로드

/** ?invite=CODE 초대 링크로 들어오면 코드를 저장해 가입·참가 등록에 자동 채움 */
const urlInvite = new URLSearchParams(location.search).get('invite');
const inviteCode =
  urlInvite && /^[A-Za-z0-9]{4,16}$/.test(urlInvite) ? urlInvite.toUpperCase() : null;
if (inviteCode) localStorage.setItem('betgirl_invite', inviteCode);

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
    const setAuthMode = (on) => {
      signupMode = on;
      $('#authTitle').textContent = signupMode ? '계정 만들기' : '픽을 등록하려면 로그인하세요';
      $('#authSubmit').textContent = signupMode ? '가입 (확인 메일 발송)' : '로그인';
      $('#authToggle').textContent = signupMode ? '로그인으로' : '계정 만들기';
      $('#authPw2Field').hidden = !signupMode;
      $('#authInviteField').hidden = !signupMode;
      $('#authPw2').required = signupMode;
      $('#authPw').autocomplete = signupMode ? 'new-password' : 'current-password';
      $('#authMsg').innerHTML = '';
    };
    $('#authToggle').addEventListener('click', () => setAuthMode(!signupMode));

    // 초대 링크(?invite=CODE)로 들어왔으면 가입 화면을 바로 펼치고 코드를 채워둔다.
    if (inviteCode) {
      setAuthMode(true);
      $('#authInvite').value = inviteCode;
      $('#authMsg').innerHTML =
        `<div class="msg ok">초대 코드 <strong>${esc(inviteCode)}</strong> 를 확인했습니다.
         가입 후 참가 등록까지 마치면 <strong>20,000벳</strong>이 지급됩니다.</div>`;
    }

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
  // 'TEST ' 회차 = 배포 검증용 가짜 경기 — 보드에선 숨긴다 (원장·API에는 그대로 남아 검증 가능)
  board = data.filter((e) => !String(e.round_key).startsWith('TEST '));

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

  // 상단 회차 필터가 있으므로 노출 제한 없이 전부 그린다.
  let html = '';
  for (const [roundKey, evs] of ordered) {
    const day = dayOf(evs);
    const tag =
      day === todayKey ? '<span class="badge pending">오늘</span>'
      : day < todayKey ? '<span class="badge void">종료</span>'
      : '';
    const sorted = evs.slice().sort((x, y) => new Date(x.start_at) - new Date(y.start_at));
    html += `<div class="round-head">${esc(roundKey)} <span class="dim">${evs.length}경기</span> ${tag}</div>`;
    html += sorted.map(matchCard).join('');
  }
  $('#matches').innerHTML = html;
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
  else slip.set(eventId, { ev, opt, stake: cur?.stake ?? bulkStake });

  renderMatches();
  renderSlip();
}

/* ------------------------------------------------------- 배당·지급액 계산 (정수 연산)
   배당은 소수 2자리다. 부동소수로 곱하면 서버(numeric)와 1벳씩 어긋날 수 있으므로
   전부 1/100 단위 정수로 계산해 DB 의 round(,2) · floor() 와 값을 일치시킨다. */
const oddsCents = (odds) => Math.round(Number(odds) * 100);

function comboOddsCents(entries) {
  if (!entries.length) return 0;
  let num = 1n;
  for (const { opt } of entries) num *= BigInt(oddsCents(opt.odds));
  const denom = 10n ** BigInt(2 * entries.length - 2);
  return Number((num + denom / 2n) / denom);          // 사사오입 = numeric round(,2)
}

const feeOf = (stake) => Math.floor((stake * Math.round(feeRate * 10000)) / 10000);
const payoutOf = (stake, cents) =>
  Math.max(Math.floor((stake * cents) / 100) - feeOf(stake), 0);

const stakeProblem = (v) =>
  !Number.isFinite(v) || v < MIN_STAKE
    ? `베팅은 최소 ${MIN_STAKE.toLocaleString('ko-KR')}벳부터 가능합니다.`
    : v % STAKE_STEP !== 0
      ? `베팅은 ${STAKE_STEP}벳 단위로만 가능합니다.`
      : '';

/* ------------------------------------------------------------------ 슬립 렌더 */
function renderSlip() {
  const body = $('#slipBody');
  const foot = $('#slipFoot');
  const entries = [...slip.values()];

  $('#clearSlip').hidden = entries.length === 0;
  document.querySelectorAll('#slipModes .slip-mode').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === slipMode));

  if (!entries.length) {
    body.innerHTML = `<div class="empty">경기에서 배당을 눌러 픽을 담으세요.${
      slipMode === 'combo' ? '<br />조합은 2경기 이상 담아야 합니다.' : ''
    }</div>`;
    foot.hidden = true;
    foot.innerHTML = '';
    return;
  }

  const combo = slipMode === 'combo';

  body.innerHTML = entries
    .map(
      ({ ev, opt, stake }) => `
      <div class="slip-row">
        <div class="slip-info">
          <strong>${esc(opt.label)}</strong>
          <div class="dim">${esc(ev.home)} vs ${esc(ev.away)} · 배당 ${Number(opt.odds).toFixed(2)}</div>
        </div>
        ${combo
          ? `<span class="slip-odds">${Number(opt.odds).toFixed(2)}</span>`
          : `<input class="slip-stake" type="number" min="${MIN_STAKE}" step="${STAKE_STEP}"
                    value="${stake}" data-event="${ev.id}" aria-label="베팅액" />`}
        <button class="slip-x ghost" data-remove="${ev.id}" aria-label="빼기">×</button>
      </div>`
    )
    .join('');

  const chips = QUICK_STAKES
    .map((v) => `<button type="button" class="chip" data-amount="${v}">${v.toLocaleString('ko-KR')}</button>`)
    .join('');

  foot.hidden = false;
  foot.innerHTML = `
    <div class="slip-bulk">
      <label for="bulkStake">${combo ? '조합 베팅액' : '베팅액 일괄 적용'}</label>
      <div class="slip-bulk-row">
        <input id="bulkStake" type="number" min="${MIN_STAKE}" step="${STAKE_STEP}"
               value="${combo ? comboStake : bulkStake}" />
        ${combo ? '' : '<button type="button" class="ghost" id="bulkApply">전체 적용</button>'}
      </div>
      <div class="chips">${chips}</div>
      ${combo ? '' : '<div class="dim" style="font-size:12px">담긴 픽 전부에 같은 금액을 넣습니다.</div>'}
    </div>
    ${combo
      ? `<div class="slip-total">
           <span>조합 배당 <span class="dim">${entries.length}경기</span></span>
           <strong id="slipOdds">—</strong>
         </div>`
      : ''}
    <div class="slip-total"><span>${combo ? '베팅액' : '합계'}</span><strong id="slipTotal">—</strong></div>
    <div class="slip-total">
      <span>적중 시 예상 수령 <span class="dim">수수료 ${(feeRate * 100).toFixed(0)}% 반영</span></span>
      <strong id="slipPayout">—</strong>
    </div>
    <div id="slipHint" class="slip-hint"></div>
    <div style="padding:0 18px 18px"><button id="submitSlip" style="width:100%">픽 등록</button></div>`;

  updateTotals();
}

/** 금액 입력 중에는 전체를 다시 그리지 않고 합계·버튼만 갱신한다 (포커스 유지) */
function updateTotals() {
  const submit = $('#submitSlip');
  const entries = [...slip.values()];
  if (!submit || !entries.length) return;

  const combo = slipMode === 'combo';
  let total;
  let payout;
  let problem;

  if (combo) {
    const cents = comboOddsCents(entries);
    total = comboStake;
    payout = payoutOf(comboStake, cents);
    $('#slipOdds').textContent = (cents / 100).toFixed(2);
    problem = entries.length < 2
      ? '조합은 2경기 이상 담아야 합니다.'
      : entries.length > MAX_LEGS
        ? `조합은 최대 ${MAX_LEGS}경기까지 담을 수 있습니다.`
        : cents > MAX_ODDS_CENTS
          ? '조합 배당이 너무 큽니다(최대 9,999.99). 경기 수를 줄여주세요.'
          : stakeProblem(comboStake);
  } else {
    total = entries.reduce((a, s) => a + Number(s.stake || 0), 0);
    payout = entries.reduce(
      (a, s) => a + payoutOf(Number(s.stake || 0), oddsCents(s.opt.odds)), 0);
    problem = entries.map((s) => stakeProblem(Number(s.stake || 0))).find(Boolean) || '';
  }

  $('#slipTotal').textContent = won(total);
  $('#slipPayout').textContent = won(payout);

  const ready = !!(me.session && me.profile);
  $('#slipHint').textContent = ready ? problem : '';
  submit.disabled = !ready || !!problem;
  submit.textContent = !me.session ? '로그인 후 등록 가능'
    : !me.profile ? '참가자 이름을 먼저 정하세요'
    : combo ? `조합 ${entries.length}경기 등록`
      : `픽 ${entries.length}건 등록`;
}

/* ------------------------------------------------------------------ 등록 */
function submitSlip() {
  return slipMode === 'combo' ? submitCombo() : submitSingles();
}

/** 조합: 티켓 한 장으로 등록된다. 다리 검증·배당 계산은 전부 서버(RPC)가 한다. */
async function submitCombo() {
  const btn = $('#submitSlip');
  const entries = [...slip.values()];
  btn.disabled = true;
  $('#slipMsg').innerHTML = '';

  const { data, error } = await sb.rpc('betgirl_place_combo', {
    p_stake: comboStake,
    p_legs: entries.map(({ ev, opt }) => ({ event_id: ev.id, code: opt.code })),
  });

  if (error) {
    $('#slipMsg').innerHTML = `<div class="msg err">${esc(error.message)}</div>`;
    btn.disabled = false;
    return;
  }

  const odds = (comboOddsCents(entries) / 100).toFixed(2);
  $('#slipMsg').innerHTML =
    `<div class="msg ok">조합 ${entries.length}경기 등록 완료 (#${esc(String(data))} · 배당 ${odds})</div>`;
  slip.clear();

  await loadBoardRefresh();
  refreshBalance();
  renderSlip();
}

async function submitSingles() {
  const btn = $('#submitSlip');
  btn.disabled = true;
  $('#slipMsg').innerHTML = '';

  const entries = [...slip.values()];
  const invalid = entries.filter(({ stake }) => stakeProblem(Number(stake)));
  if (invalid.length) {
    $('#slipMsg').innerHTML =
      `<div class="msg err">베팅은 최소 ${MIN_STAKE.toLocaleString('ko-KR')}벳, ${STAKE_STEP}벳 단위로만 가능합니다.</div>`;
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
  updateTotals();
});

$('#clearSlip').addEventListener('click', () => {
  slip.clear();
  $('#slipMsg').innerHTML = '';
  renderMatches();
  renderSlip();
});

/* 싱글 / 조합 전환 */
$('#slipModes').addEventListener('click', (e) => {
  const btn = e.target.closest('.slip-mode');
  if (!btn || btn.dataset.mode === slipMode) return;
  slipMode = btn.dataset.mode;
  $('#slipMsg').innerHTML = '';
  renderSlip();
});

/** 일괄 적용: 싱글이면 담긴 픽 전부에, 조합이면 티켓 한 장의 베팅액으로 넣는다. */
function applyStake(v) {
  if (slipMode === 'combo') {
    comboStake = v;
    updateTotals();
    return;
  }
  bulkStake = v;
  for (const s of slip.values()) s.stake = v;
  renderSlip();
}

// 슬립 하단(#slipFoot)은 renderSlip 이 매번 다시 그리므로 컨테이너에 위임한다.
$('#slipFoot').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    const v = Number(chip.dataset.amount);
    $('#bulkStake').value = v;
    applyStake(v);
    return;
  }
  if (e.target.closest('#bulkApply')) {
    applyStake(Number($('#bulkStake').value));
    return;
  }
  if (e.target.closest('#submitSlip')) submitSlip();
});

$('#slipFoot').addEventListener('input', (e) => {
  if (!e.target.closest('#bulkStake')) return;
  const v = Number(e.target.value);
  if (slipMode === 'combo') {
    comboStake = v;
    updateTotals();
  } else {
    bulkStake = v;                      // '전체 적용'을 눌러야 픽에 반영된다
  }
});

$('#fRound').addEventListener('change', () => renderMatches());
$('#fView').addEventListener('change', () => renderMatches());

/** 적중 수수료율은 공개 정책 테이블에서 읽는다 (예상 수령액 표시가 정산과 어긋나지 않게). */
async function loadFeeRate() {
  const { data } = await sb
    .from('betgirl_fee_policy')
    .select('rate')
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false })
    .order('seq', { ascending: false })
    .limit(1);
  if (data?.length) feeRate = Number(data[0].rate);
}

/* ------------------------------------------------------------------ 시작 */
(async () => {
  initNav('/');
  me = await currentUser();
  renderAccount();
  await loadFeeRate();
  await loadBoard();
  renderSlip();
})();
