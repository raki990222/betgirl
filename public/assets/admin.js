// betgirl — 운영 콘솔 (기록 추가 전용)
import { sb, won, kst, esc } from './app.js';

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
async function gate() {
  const { data } = await sb.auth.getSession();
  const on = !!data.session;
  $('#loginPanel').hidden = on;
  $('#adminArea').hidden = !on;
  $('#logout').hidden = !on;
  if (on) {
    $('#placed_at').value ||= nowLocal();
    $('#settled_at').value ||= nowLocal();
    loadPending();
  }
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

$('#logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await sb.auth.signOut();
  location.reload();
});

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

gate();
