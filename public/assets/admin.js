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
  loadSettleEvents();
  loadInvites();
  loadRedemptions();
  loadItems();
  loadRevenue();
  loadSeeds();
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

  // 표기 관행: 좌측(첫 번째)이 HOME
  const options = [
    { code: 'HOME', label: `${home} 승`, odds: Number($('#ev_odds_home').value) },
    { code: 'AWAY', label: `${away} 승`, odds: Number($('#ev_odds_away').value) },
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
        <td><span class="badge ${e.open_for_picks ? 'pending' : e.status === 'settled' ? 'win' : 'void'}">${
          e.open_for_picks ? '등록 가능'
          : e.status === 'settled' ? '정산 완료'
          : e.status === 'closed' ? '마감'
          : '시작됨'
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

/* ------------------------------------------------------------ 경기 결과 정산 */
let settleEvents = [];

async function loadSettleEvents() {
  const { data, error } = await sb
    .from('betgirl_board')
    .select('id,round_key,home,away,start_at,status,options,pick_count,open_for_picks')
    .neq('status', 'settled')
    .order('start_at', { ascending: true })
    .limit(200);

  if (error) {
    $('#evSettleNote').textContent = '경기 목록 조회 실패: ' + error.message;
    return;
  }

  settleEvents = data;
  const sel = $('#se_event');
  sel.innerHTML = data.length
    ? data
        .map((e) =>
          `<option value="${e.id}">` +
          esc(`#${e.id} ${e.home} vs ${e.away} · ${kst(e.start_at)} · 픽 ${e.pick_count}건${e.open_for_picks ? ' · 시작 전' : ''}`) +
          '</option>'
        )
        .join('')
    : '<option value="">정산할 경기가 없습니다</option>';

  $('#evSettleNote').textContent =
    `미정산 ${data.length}경기 · 시작 전 경기는 '경기 취소'만 가능합니다.`;
  fillWinnerOptions();
}

function fillWinnerOptions() {
  const ev = settleEvents.find((e) => e.id === Number($('#se_event').value));
  const sel = $('#se_winner');
  if (!ev) {
    sel.innerHTML = '';
    return;
  }
  const opts = Array.isArray(ev.options) ? ev.options : [];
  sel.innerHTML =
    opts.map((o) => `<option value="${esc(o.code)}">${esc(o.label)}</option>`).join('') +
    '<option value="__cancel">경기 취소 (전 픽 원금 반환)</option>';
}

$('#se_event').addEventListener('change', fillWinnerOptions);
$('#reloadSettleEvents').addEventListener('click', loadSettleEvents);

$('#evSettleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const eventId = Number($('#se_event').value);
  const winner = $('#se_winner').value;
  if (!eventId || !winner) return msg('#evSettleMsg', '경기와 결과를 선택하세요.', 'err');

  const ev = settleEvents.find((x) => x.id === eventId);
  const label = ev ? `${ev.home} vs ${ev.away}` : `#${eventId}`;
  const resultLabel = $('#se_winner').selectedOptions[0]?.textContent ?? winner;
  if (!confirm(`${label}\n결과: ${resultLabel}\n\n이 경기의 미정산 픽을 전부 정산합니다. 되돌릴 수 없습니다.`)) return;

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  msg('#evSettleMsg', '');

  const { data, error } = await sb.rpc('betgirl_settle_event', {
    p_event_id: eventId,
    p_winner_code: winner === '__cancel' ? null : winner,
    p_cancel: winner === '__cancel',
    p_proof_url: $('#se_proof').value.trim() || null,
  });

  btn.disabled = false;
  if (error) return msg('#evSettleMsg', '정산 실패: ' + error.message, 'err');

  const r = Array.isArray(data) ? data[0] : data;
  msg(
    '#evSettleMsg',
    `정산 완료 — ${r.settled_count}건 처리, 적중 ${r.win_count}건, 지급 ${won(r.total_payout)}`,
    'ok'
  );
  $('#se_proof').value = '';
  loadSettleEvents();
  loadEvents();
  loadPending();
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

/* ------------------------------------------------------------------ 초대 코드 */
async function loadInvites() {
  const { data, error } = await sb
    .from('betgirl_invites')
    .select('code,memo,created_at,used_by,used_at')
    .order('created_at', { ascending: false })
    .limit(200);

  const tb = $('#invitesTbl tbody');
  if (error) {
    $('#invitesNote').textContent = '초대 코드 조회 실패: ' + error.message;
    return;
  }
  if (!data.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">발급된 초대 코드가 없습니다.</td></tr>';
    $('#invitesNote').textContent = '';
    return;
  }
  tb.innerHTML = data
    .map(
      (i) => `<tr>
        <td class="hash" style="font-size:13px">${esc(i.code)}</td>
        <td class="dim">${esc(i.memo ?? '—')}</td>
        <td class="dim">${esc(kst(i.created_at))}</td>
        <td>${i.used_at
          ? `<span class="badge win">사용됨</span> <span class="dim">${esc(kst(i.used_at))}</span>`
          : '<span class="badge pending">미사용</span>'}</td>
      </tr>`
    )
    .join('');
  const unused = data.filter((i) => !i.used_at).length;
  $('#invitesNote').textContent = `총 ${data.length}장 · 미사용 ${unused}장`;
}

$('#issueInvite').addEventListener('click', async () => {
  const memo = prompt('메모 (누구에게 줄 코드인지, 선택):') ?? '';
  const btn = $('#issueInvite');
  btn.disabled = true;
  const { data, error } = await sb.rpc('betgirl_issue_invite', { p_memo: memo.trim() || null });
  btn.disabled = false;
  if (error) return msg('#inviteMsg', '발급 실패: ' + error.message, 'err');
  msg('#inviteMsg', `발급 완료 — 코드: ${data}`, 'ok');
  loadInvites();
});

$('#reloadInvites').addEventListener('click', loadInvites);

/* ------------------------------------------------------------------ 교환 처리 */
async function loadRedemptions() {
  const { data, error } = await sb
    .from('betgirl_redemptions')
    .select('seq,kind,handle,item,cost,request_seq,created_at')
    .order('seq', { ascending: true })
    .limit(1000);

  const tb = $('#redeemTbl tbody');
  if (error) {
    $('#redeemNote').textContent = '교환 목록 조회 실패: ' + error.message;
    return;
  }

  const resolved = new Set(
    data.filter((r) => r.kind !== 'request').map((r) => r.request_seq)
  );
  const pending = data.filter((r) => r.kind === 'request' && !resolved.has(r.seq));

  if (!pending.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">처리 대기 중인 교환 신청이 없습니다.</td></tr>';
    $('#redeemNote').textContent = `누적 신청 ${data.filter((r) => r.kind === 'request').length}건 · 대기 0건`;
    return;
  }

  tb.innerHTML = pending
    .map(
      (r) => `<tr>
        <td class="dim">${r.seq}</td>
        <td><strong>${esc(r.handle)}</strong></td>
        <td>${esc(r.item)}</td>
        <td class="num">${won(r.cost)}</td>
        <td class="dim">${esc(kst(r.created_at))}</td>
        <td>
          <button class="ghost" data-fulfill="${r.seq}">완료</button>
          <button class="ghost" data-reject="${r.seq}">반려</button>
        </td>
      </tr>`
    )
    .join('');
  $('#redeemNote').textContent = `대기 ${pending.length}건`;
}

$('#redeemTbl').addEventListener('click', async (e) => {
  const fulfillBtn = e.target.closest('[data-fulfill]');
  const rejectBtn = e.target.closest('[data-reject]');
  if (!fulfillBtn && !rejectBtn) return;

  const seq = Number((fulfillBtn ?? rejectBtn).dataset[fulfillBtn ? 'fulfill' : 'reject']);
  let payload;
  if (fulfillBtn) {
    const proof = prompt('발송 증빙 URL (기프티콘 발송 캡처 등):') ?? '';
    if (!confirm(`#${seq} 교환을 완료 처리합니다. 되돌릴 수 없습니다.`)) return;
    payload = { kind: 'fulfill', request_seq: seq, proof_url: proof.trim() || null };
  } else {
    const note = prompt('반려 사유 (공개됩니다):') ?? '';
    if (!confirm(`#${seq} 교환을 반려하고 벳을 환급합니다. 되돌릴 수 없습니다.`)) return;
    payload = { kind: 'reject', request_seq: seq, note: note.trim() || null };
  }

  // guard 트리거가 신청 내용을 복사하지만 NOT NULL 제약을 위해 자리값을 보낸다
  const { error } = await sb.from('betgirl_redemptions').insert({
    handle: '-', item: '-', cost: 1, ...payload,
  });
  if (error) return msg('#redeemMsg', '처리 실패: ' + error.message, 'err');
  msg('#redeemMsg', `#${seq} 처리 완료`, 'ok');
  loadRedemptions();
});

$('#reloadRedemptions').addEventListener('click', loadRedemptions);

/* ------------------------------------------------------------------ 상품 관리 */
async function loadItems() {
  const { data, error } = await sb
    .from('betgirl_items').select('*').order('id', { ascending: false }).limit(200);
  const tb = $('#itemsTbl tbody');
  if (error) return void ($('#itemMsg').innerHTML = `<div class="msg err">${esc(error.message)}</div>`);
  tb.innerHTML = data.length
    ? data.map((i) => `<tr>
        <td class="dim">${i.id}</td>
        <td>${esc(i.name)}${i.note ? ` <span class="dim">${esc(i.note)}</span>` : ''}</td>
        <td class="num">${won(i.cost)}</td>
        <td class="num">${i.stock === null ? '∞' : i.stock}</td>
        <td><span class="badge ${i.active ? 'win' : 'void'}">${i.active ? '판매 중' : '비활성'}</span></td>
        <td><button class="ghost" data-toggle-item="${i.id}" data-active="${i.active}">${i.active ? '내리기' : '올리기'}</button></td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">등록된 상품이 없습니다.</td></tr>';
}

$('#itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.from('betgirl_items').insert({
    name: $('#it_name').value.trim(),
    cost: Number($('#it_cost').value),
    stock: $('#it_stock').value === '' ? null : Number($('#it_stock').value),
    note: $('#it_note').value.trim() || null,
  });
  if (error) return msg('#itemMsg', '등록 실패: ' + error.message, 'err');
  msg('#itemMsg', '상품이 등록되었습니다.', 'ok');
  ['#it_name', '#it_cost', '#it_stock', '#it_note'].forEach((s) => ($(s).value = ''));
  loadItems();
});

$('#itemsTbl').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-toggle-item]');
  if (!btn) return;
  const { error } = await sb
    .from('betgirl_items')
    .update({ active: btn.dataset.active !== 'true' })
    .eq('id', Number(btn.dataset.toggleItem));
  if (error) return msg('#itemMsg', error.message, 'err');
  loadItems();
});

$('#reloadItems').addEventListener('click', loadItems);

/* ------------------------------------------------------------------ 광고 수익 */
async function loadRevenue() {
  const { data, error } = await sb
    .from('betgirl_revenue').select('*').order('seq', { ascending: false }).limit(100);
  const tb = $('#revTbl tbody');
  if (error) return void ($('#revNote').textContent = error.message);
  tb.innerHTML = data.length
    ? data.map((r) => `<tr>
        <td class="dim">${r.seq}</td>
        <td>${esc(r.at_date)}</td>
        <td>${esc(r.source)}</td>
        <td class="num">${Number(r.amount_krw).toLocaleString('ko-KR')}원</td>
        <td class="dim">${r.proof_url ? `<a href="${esc(r.proof_url)}" target="_blank" rel="noopener noreferrer">증빙</a>` : '—'}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">기록된 수익이 없습니다.</td></tr>';
  const total = data.reduce((a, r) => a + Number(r.amount_krw), 0);
  $('#revNote').textContent = `누적 ${total.toLocaleString('ko-KR')}원 — 교환소 재원 대차에 공개됩니다.`;
}

$('#revForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.from('betgirl_revenue').insert({
    at_date: $('#rv_date').value,
    source: $('#rv_source').value.trim(),
    amount_krw: Number($('#rv_amount').value),
    proof_url: $('#rv_proof').value.trim() || null,
  });
  if (error) return msg('#revMsg', '기록 실패: ' + error.message, 'err');
  msg('#revMsg', '수익이 공개 원장에 기록되었습니다.', 'ok');
  $('#rv_amount').value = '';
  loadRevenue();
});

$('#reloadRevenue').addEventListener('click', loadRevenue);

/* ------------------------------------------------------------------ 가차 시드 */
async function loadSeeds() {
  const { data, error } = await sb
    .from('betgirl_gacha_commitments')
    .select('seq,seed_hash,drawn_count,created_at,revealed_at')
    .order('seq', { ascending: false })
    .limit(20);
  const el = $('#seedList');
  if (error) return void ($('#seedNote').textContent = error.message);
  el.innerHTML = data.length
    ? data.map((s) => `<div class="slip-row">
        <div class="slip-info">
          <strong class="hash" style="font-size:12px">#${s.seq} ${esc(String(s.seed_hash).slice(0, 24))}…</strong>
          <div class="dim">추첨 ${s.drawn_count}회 · ${esc(kst(s.created_at))}</div>
        </div>
        <span class="badge ${s.revealed_at ? 'win' : 'pending'}">${s.revealed_at ? '공개됨' : '진행 중'}</span>
      </div>`).join('')
    : '<div class="empty">발급된 시드가 없습니다. 새 시드를 발급하면 확률 도전이 열립니다.</div>';
  $('#seedNote').textContent = data.some((s) => !s.revealed_at)
    ? '진행 중 시드 있음 — 확률 도전 활성 상태'
    : '진행 중 시드 없음 — 확률 도전 비활성 (새 시드 발급 필요)';
}

$('#newSeed').addEventListener('click', async () => {
  const { data, error } = await sb.rpc('betgirl_gacha_new_seed');
  if (error) return msg('#seedMsg', error.message, 'err');
  msg('#seedMsg', `새 시드 커밋 완료 — 해시 ${String(data).slice(0, 24)}… (즉시 공개됨)`, 'ok');
  loadSeeds();
});

$('#revealSeed').addEventListener('click', async () => {
  if (!confirm('진행 중 시드를 공개(마감)합니다. 이후 해당 시드의 모든 추첨이 검증 가능해지고, 새 시드를 발급해야 확률 도전이 다시 열립니다.')) return;
  const { error } = await sb.rpc('betgirl_gacha_reveal_seed');
  if (error) return msg('#seedMsg', error.message, 'err');
  msg('#seedMsg', '시드가 공개(마감)되었습니다. 새 시드를 발급하세요.', 'ok');
  loadSeeds();
});

$('#reloadSeeds').addEventListener('click', loadSeeds);

initNav('/admin');
gate();
