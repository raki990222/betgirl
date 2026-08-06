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
        <div class="panel-head"><h2>픽을 등록하려면 로그인하세요</h2></div>
        <div style="padding:18px">
          <div id="authMsg"></div>
          <form id="authForm" class="row" style="align-items:end">
            <div class="field" style="margin:0">
              <label for="authEmail">이메일</label>
              <input id="authEmail" type="email" autocomplete="username" required />
            </div>
            <div class="field" style="margin:0">
              <label for="authPw">비밀번호</label>
              <input id="authPw" type="password" autocomplete="current-password" required />
            </div>
            <div class="field" style="margin:0"><button type="submit" style="width:100%">로그인</button></div>
          </form>
        </div>
        <div class="note">계정은 운영자가 발급합니다. 구경만 하실 거면 로그인 없이 <a href="/ledger">공개 원장</a>을 보세요.</div>
      </section>`;

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithPassword({
        email: $('#authEmail').value.trim(),
        password: $('#authPw').value,
      });
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
        <div class="panel-head"><h2>참가자 이름 정하기</h2></div>
        <div style="padding:18px">
          <div id="handleMsg"></div>
          <p class="dim" style="margin-top:0">
            원장에 공개될 이름입니다. <strong>한 번 정하면 바꿀 수 없습니다</strong> — 과거 기록과 어긋나기 때문입니다.
          </p>
          <form id="handleForm" class="row" style="align-items:end">
            <div class="field" style="margin:0">
              <label for="handle">참가자 이름 (20자 이내)</label>
              <input id="handle" maxlength="20" required placeholder="예: 지연" />
            </div>
            <div class="field" style="margin:0"><button type="submit" style="width:100%">확정</button></div>
          </form>
        </div>
      </section>`;

    $('#handleForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const handle = $('#handle').value.trim();
      const { error } = await sb
        .from('betgirl_profiles')
        .insert({ user_id: me.session.user.id, handle });
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
      <span class="balance">소지금 <strong id="balanceVal">…</strong></span>
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
  const openOnly = $('#fOpen').checked;

  const list = board.filter((e) => {
    if (round && e.round_key !== round) return false;
    if (openOnly && !e.open_for_picks) return false;
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

  const buttons = opts
    .map((o) => {
      const on = picked && picked.opt.code === o.code;
      return `<button class="opt${on ? ' on' : ''}" data-event="${e.id}" data-code="${esc(o.code)}"
                ${e.open_for_picks ? '' : 'disabled'}>
        <span class="opt-label">${esc(o.label)}</span>
        <span class="opt-odds">${Number(o.odds).toFixed(2)}</span>
      </button>`;
    })
    .join('');

  return `
    <article class="match${e.open_for_picks ? '' : ' closed'}">
      <div class="match-top">
        <span class="dim">${esc(e.league)} · ${esc(e.market)}</span>
        <span class="spacer"></span>
        <span class="dim">${esc(startLabel(e.start_at))}</span>
        <span class="badge ${e.open_for_picks ? 'pending' : 'void'}">${esc(untilLabel(e.start_at))}</span>
      </div>
      <div class="match-teams">${esc(e.home)} <span class="dim">vs</span> ${esc(e.away)}</div>
      <div class="opts">${buttons}</div>
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
$('#fOpen').addEventListener('change', renderMatches);

/* ------------------------------------------------------------------ 시작 */
(async () => {
  initNav('/');
  me = await currentUser();
  renderAccount();
  await loadBoard();
  renderSlip();
})();
