// betgirl — 운영 콘솔 (기록 추가 전용)
import { sb, initNav, currentUser, won, kst, esc } from './app.js';

const $ = (s) => document.querySelector(s);

const msg = (el, text, kind = 'ok') => {
  $(el).innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : '';
};

/** datetime-local(로컬=KST) → ISO 문자열 */
const toISO = (v) => (v ? new Date(v).toISOString() : null);

/** now를 datetime-local 값으로 */
const nowLocal = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19);
};

/* ------------------------------------------------------------------ 세션 */
let me = { session: null, profile: null, isOperator: false };

async function gate() {
  me = await currentUser();
  const on = !!me.session;

  $('#loginPanel').hidden = on;
  $('#adminArea').hidden = !on;
  if (!on) return;

  if (!me.isOperator) {
    $('#adminArea').innerHTML = `
      <section class="panel" style="max-width:520px;margin:60px auto 0">
        <div class="panel-head"><h2>운영자 권한이 없습니다</h2></div>
        <div class="note">
          이 계정은 기록을 추가할 수 없습니다. 픽은 <a href="/">경기 보드</a>에서 등록하세요.
        </div>
      </section>`;
    return;
  }

  $('#placed_at').value ||= nowLocal();
  $('#settled_at').value ||= nowLocal();
  $('#ev_start').value ||= nowLocal().slice(0, 16);
  loadPending();
  loadEvents();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('#loginMsg', '');
  const { error } = await sb.auth.signInWithPassword({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  if (error) return msg('#loginMsg', '로그인 실패: ' + error.message, 'err');
  gate();
});

/* ------------------------------------------------------------------ 경기 */
$('#ev_market').addEventListener('change', () => {
  $('#drawField').hidden = $('#ev_market').value !== '승무패';
});

$('#eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  msg('#eventMsg', '');

  const home = $('#ev_home').value.trim();
  const away = $('#ev_away').value.trim();
  const market = $('#ev_market').value;

  const options = [
    { code: 'AWAY', label: `${away} 승`, odds: Number($('#ev_odds_away').value) },
    { code: 'HOME', label: `${home} 승`, odds: Number($('#ev_odds_home').value) },
  ];
  if (market === '승무패' && Number($('#ev_odds_draw').value) >= 1) {
    options.splice(1, 0, { code: 'DRAW', label: '무승부', odds: Number($('#ev_odds_draw').value) });
  }

  const { data, error } = await sb
    .from('betgirl_events')
    .insert({
      round_key: $('#ev_round').value.trim(),
      sport: $('#ev_sport').value.trim(),
      league: $('#ev_league').value.trim(),
      home,
      away,
      start_at: toISO($('#ev_start').value),
      market,
      options,
      official_url: $('#ev_url').value.trim() || null,
      note: $('#ev_note').value.trim() || null,
    })
    .select('id')
    .single();

  btn.disabled = false;
  if (error) return msg('#eventMsg', '게시 실패: ' + error.message, 'err');

  msg('#eventMsg', `#${data.id} 경기가 보드에 게시되었습니다.`, 'ok');
  ['#ev_home', '#ev_away', '#ev_odds_home', '#ev_odds_away', '#ev_odds_draw', '#ev_url', '#ev_note']
    .forEach((s) => ($(s).value = ''));
  loadEvents();
});

async function loadEvents() {
  const { data, error } = await sb
    .from('betgirl_board')
    .select('id,round_key,home,away,start_at,status,pick_count,open_for_picks')
    .order('start_at', { ascending: false })
    .limit(200);

  const tb = $('#eventsTbl tbody');
  if (error) {
    $('#eventsNote').textContent = '경기 목록 조회 실패: ' + error.message;
    return;
  }
  if (!data.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">게시된 경기가 없습니다.</td></tr>';
    $('#eventsNote').textContent = '';
    return;
  }

  tb.innerHTML = data
    .map(
      (e) => `<tr>
        <td class="dim">${e.id}</td>
        <td>${esc(e.round_key)}</td>
        <td>${esc(e.away)} <span class="dim">@</span> ${esc(e.home)}</td>
        <td>${esc(kst(e.start_at))}</td>
        <td class="num">${e.pick_count}</td>
        <td><span class="badge ${e.open_for_picks ? 'pending' : 'void'}">${
          e.open_for_picks ? '등록 가능' : esc(e.status === 'open' ? '시작됨' : e.status)
        }</span></td>
        <td>${
          e.status === 'open'
            ? `<button class="ghost" data-close="${e.id}">마감</button>`
            : '<span class="dim">—</span>'
        }</td>
      </tr>`
    )
    .join('');

  $('#eventsNote').textContent = `${data.length}경기 · 마감하면 배당·대진 수정이 영구히 잠깁니다.`;
}

$('#eventsTbl').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-close]');
  if (!btn) return;
  btn.disabled = true;
  const { error } = await sb
    .from('betgirl_events')
    .update({ status: 'closed' })
    .eq('id', Number(btn.dataset.close));
  if (error) msg('#eventMsg', '마감 실패: ' + error.message, 'err');
  loadEvents();
});

$('#reloadEvents').addEventListener('click', loadEvents);

/* ------------------------------------------------------------------ 베팅 */
$('#betForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  msg('#betMsg', '');

  const row = {
    bettor: $('#bettor').value.trim(),
    event_key: $('#event_key').value.trim(),
    sport: $('#sport').value.trim() || null,
    league: $('#league').value.trim() || null,
    match_label: $('#match_label').value.trim(),
    market: $('#market').value,
    pick: $('#pick').value.trim(),
    stake: Number($('#stake').value),
    odds: Number($('#odds').value),
    placed_at: toISO($('#placed_at').value),
    ticket_no: $('#ticket_no').value.trim() || null,
    proof_url: $('#proof_url').value.trim() || null,
    note: $('#note').value.trim() || null,
  };

  const { data, error } = await sb.from('betgirl_bets').insert(row).select('seq').single();
  btn.disabled = false;

  if (error) return msg('#betMsg', '저장 실패: ' + error.message, 'err');

  msg('#betMsg', `#${data.seq} 원장에 추가되었습니다.`, 'ok');
  ['#match_label', '#pick', '#stake', '#odds', '#ticket_no', '#proof_url', '#note'].forEach(
    (s) => ($(s).value = '')
  );
  $('#placed_at').value = nowLocal();
  loadPending();
});

/* ------------------------------------------------------------------ 정산 */
async function loadPending() {
  const { data, error } = await sb
    .from('betgirl_ledger')
    .select('seq,bettor,match_label,pick,stake,odds,placed_at,status')
    .eq('status', 'pending')
    .order('seq', { ascending: true })
    .limit(1000);

  const sel = $('#bet_seq');
  if (error) {
    $('#pendingNote').textContent = '미확정 목록 조회 실패: ' + error.message;
    return;
  }
  sel.innerHTML = data.length
    ? data
        .map(
          (r) =>
            `<option value="${r.seq}" data-stake="${r.stake}" data-odds="${r.odds}">` +
            esc(`#${r.seq} ${r.bettor} · ${r.match_label} · ${r.pick} · ${won(r.stake)} @${Number(r.odds).toFixed(2)} · ${kst(r.placed_at)}`) +
            '</option>'
        )
        .join('')
    : '<option value="">미확정 베팅이 없습니다</option>';

  $('#pendingNote').textContent = `미확정 ${data.length}건`;
  suggestPayout();
}

/** 적중이면 베팅액×배당을 회수액 기본값으로, 무효/취소면 원금 반환 */
function suggestPayout() {
  const opt = $('#bet_seq').selectedOptions[0];
  if (!opt || !opt.value) return;
  const stake = Number(opt.dataset.stake);
  const odds = Number(opt.dataset.odds);
  const result = $('#result').value;
  const v =
    result === 'win' ? Math.floor(stake * odds)
    : result === 'lose' ? 0
    : stake; // void / cancel → 원금 반환
  $('#payout').value = v;
}

$('#result').addEventListener('change', suggestPayout);
$('#bet_seq').addEventListener('change', suggestPayout);
$('#reloadPending').addEventListener('click', loadPending);

$('#settleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const seq = $('#bet_seq').value;
  if (!seq) return msg('#settleMsg', '정산할 베팅을 선택하세요.', 'err');

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  msg('#settleMsg', '');

  const { error } = await sb.from('betgirl_settlements').insert({
    bet_seq: Number(seq),
    result: $('#result').value,
    payout: Number($('#payout').value),
    settled_at: toISO($('#settled_at').value),
    proof_url: $('#settle_proof_url').value.trim() || null,
    note: $('#settle_note').value.trim() || null,
  });
  btn.disabled = false;

  if (error) return msg('#settleMsg', '정산 실패: ' + error.message, 'err');

  msg('#settleMsg', `#${seq} 정산이 확정되었습니다.`, 'ok');
  $('#settle_proof_url').value = '';
  $('#settle_note').value = '';
  $('#settled_at').value = nowLocal();
  loadPending();
});

initNav('/admin');
gate();
