// betgirl — 경기 보드 + 픽 등록
import { sb, initNav, currentUser, won, esc, safeUrl } from './app.js';

const $ = (s) => document.querySelector(s);

let board = [];                 // betgirl_board 행
let me = { session: null, profile: null, isOperator: false };
const slip = new Map();         // event_id → { ev, opt, stake }

const DEFAULT_STAKE = 100000;   // 벳 (1원=10벳 감각, 10만벳 = 1만원 느낌)
const MIN_STAKE = 10000;
const STAKE_STEP = 10000;

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
            <div class="field" style="margin:0"><button type="submit" style="width:100%" id="authSubmit">로그인</button></div>
          </form>
        </div>
        <div class="note" id="authNote">
          픽 등록에는 <strong>초대 코드</strong>가 필요합니다 (가입 후 참가 등록 단계에서 입력).
          구경만 하실 거면 로그인 없이 <a href="/ledger">공개 원장</a>을 보세요.
        </div>
      </section>`;

    let signupMode = false;
    $('#authToggle').addEventListener('click', () => {
      signupMode = !signupMode;
      $('#authTitle').textContent = signupMode ? '계정 만들기' : '픽을 등록하려면 로그인하세요';
      $('#authSubmit').textContent = signupMode ? '가입 (확인 메일 발송)' : '로그인';
      $('#authToggle').textContent = signupMode ? '로그인으로' : '계정 만들기';
      $('#authMsg').innerHTML = '';
    });

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#authEmail').value.trim();
      const password = $('#authPw').value;
      $('#authMsg').innerHTML = '';

      if (signupMode) {
        const { error } = await sb.auth.signUp({
          email, password,
          options: { emailRedirectTo: location.origin + '/' },
        });
        $('#authMsg').innerHTML = error
          ? `<div class="msg err">${esc(error.message)}</div>`
          : `<div class="msg ok">확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 이 페이지에서 로그인하세요.</div>`;
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
            등록에는 운영자에게 받은 <strong>초대 코드</strong>가 필요하고, 등록 즉시 1,000,000벳이 지급됩니다.
            누가 누구를 초대했는지는 투명성을 위해 공개됩니다.
          </p>
          <form id="handleForm" class="row" style="align-items:end">
            <div class="field" style="margin:0">
              <label for="handle">참가자 이름 (20자 이내)</label>
              <input id="handle" maxlength="20" required placeholder="예: 지연" />
            </div>
            <div class="field" style="margin:0">
              <label for="inviteCode">초대 코드</label>
              <input id="inviteCode" maxlength="16" required placeholder="예: 3F9A2C1B"
                     style="text-transform:uppercase" autocomplete="off" />
            </div>
            <div class="field" style="margin:0"><button type="submit" style="width:100%">참가 등록</button></div>
          </form>
        </div>
      </section>`;

    $('#handleForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const { error } = await sb.rpc('betgirl_join', {
        p_handle: $('#handle').value.trim(),
        p_invite_code: $('#inviteCode').value.trim(),
      });
      btn.disabled = false;
      if (error) {
        const dup = error.code === '23505';
        $('#handleMsg').innerHTML =
          `<div class="msg err">${esc(dup ? '이미 사용 중인 이름입니다.' : error.message)}</div>`;
        return;
      }
      location.reload();
    });
    return;
  }

  el.innerHTML = `
    <div class="whoami">
      <span><strong>${esc(me.profile.handle)}</strong> 님으로 픽을 등록합니다.</span>
      ${me.isOperator ? '<span class="badge void">운영자</span>' : ''}
      <span class="spacer" style="margin-left:auto"></span>
      <a class="balance" href="/ledger#wallet=${encodeURIComponent(me.profile.handle)}"
         title="소지금 내역 보기">소지금 <strong id="balanceVal">…</strong></a>
    </div>`;
  refreshBalance();
}

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

  $('#matches').innerHTML = [...groups]
    .map(
      ([roundKey, evs]) => `
      <div class="round-head">${esc(roundKey)} <span class="dim">${evs.length}경기</span></div>
      ${evs.map(matchCard).join('')}`
    )
    .join('');
}

function matchCard(e) {
  const picked = slip.get(e.id);
  const opts = Array.isArray(e.options) ? e.options : [];

  const settled = e.status === 'settled';
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
