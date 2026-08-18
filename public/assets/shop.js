// betgirl — 상품 교환소 + 가차 (포인트 전용, 커밋-리빌 공정성)
import { sb, initNav, currentUser, won, esc, kst } from './app.js';

const $ = (s) => document.querySelector(s);
let me = { session: null, profile: null, isOperator: false };
let gachaPolicy = null;   // { half: {prob, ratio}, ten: {...} }
let seedReady = false;

const MODE_LABEL = { sure: '확정', half: '도전 50%', ten: '도전 10%' };

const ITEM_FALLBACK = '/items/placeholder.svg';

/**
 * 상품 이미지 경로. 같은 출처의 절대경로(/items/…)나 https URL만 통과시킨다.
 * `//evil.com/x.png`(프로토콜 상대)·`javascript:` 같은 값이 DB에 들어와도 렌더되지 않는다.
 */
const itemImage = (u) => {
  const s = String(u ?? '').trim();
  if (!s) return ITEM_FALLBACK;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    return new URL(s).protocol === 'https:' ? s : ITEM_FALLBACK;
  } catch {
    return ITEM_FALLBACK;
  }
};

// SQL 과 문자 그대로 같은 비용을 낸다: round(cost * ratio / 100) * 100, 반올림은 half-away.
// float 오차를 피하려 ratio 를 정수 밀리(0.580→580)로 받아 정수 연산만 쓴다.
const modeCost = (cost, ratioMilli) =>
  Math.max(100, Math.floor((cost * ratioMilli + 50000) / 100000) * 100);

async function loadGacha() {
  try {
    const [{ data: pol }, { data: seeds }] = await Promise.all([
      sb.from('betgirl_gacha_policy').select('mode,prob,cost_ratio,effective_from')
        .order('effective_from', { ascending: false }).limit(30),
      sb.from('betgirl_gacha_commitments').select('seq,seed_hash,drawn_count,created_at,revealed_at')
        .order('seq', { ascending: false }).limit(10),
    ]);
    if (pol?.length) {
      gachaPolicy = {};
      for (const p of pol)
        if (!gachaPolicy[p.mode])
          gachaPolicy[p.mode] = { prob: Number(p.prob), ratioMilli: Math.round(Number(p.cost_ratio) * 1000) };
    }
    seedReady = !!seeds?.some((s) => !s.revealed_at);
    renderFairness(seeds ?? []);
  } catch {
    gachaPolicy = null;
  }
}

function renderFairness(seeds) {
  const el = $('#fairness');
  if (!el) return;
  if (!seeds.length) {
    el.innerHTML = '<div class="empty">아직 발급된 시드가 없습니다.</div>';
    return;
  }
  el.innerHTML = seeds
    .map(
      (s) => `<div class="slip-row">
        <div class="slip-info">
          <strong class="hash" style="font-size:12px">시드 #${s.seq} · ${esc(String(s.seed_hash).slice(0, 20))}…</strong>
          <div class="dim">추첨 ${s.drawn_count}회 · ${esc(kst(s.created_at))} 커밋${
            s.revealed_at ? ` · ${esc(kst(s.revealed_at))} 공개(검증 가능)` : ' · 진행 중'}</div>
        </div>
        <span class="badge ${s.revealed_at ? 'win' : 'pending'}">${s.revealed_at ? '공개됨' : '진행 중'}</span>
      </div>`
    )
    .join('');
}

/* ------------------------------------------------------------------ 계정 */
function renderAccount() {
  const el = $('#account');
  if (!me.session || !me.profile) {
    el.innerHTML = `
      <div class="whoami">
        <span>교환을 신청하려면 <a href="/">경기 보드</a>에서 로그인·참가 등록을 먼저 하세요.
        구경은 자유입니다.</span>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="whoami">
      <span><strong>${esc(me.profile.handle)}</strong> 님</span>
      <span class="spacer" style="margin-left:auto"></span>
      <a class="balance" href="/ledger#wallet=${encodeURIComponent(me.profile.handle)}">소지금 <strong id="balanceVal">…</strong></a>
    </div>`;
  refreshBalance();
}

async function refreshBalance() {
  const el = $('#balanceVal');
  if (!el || !me.profile) return;
  const { data } = await sb
    .from('betgirl_balances').select('balance').eq('handle', me.profile.handle).maybeSingle();
  el.textContent = data ? won(data.balance) : '—';
}

/* ------------------------------------------------------------------ 대차 */
async function loadSolvency() {
  const { data, error } = await sb.from('betgirl_shop_solvency').select('*').single();
  const el = $('#solvency');
  if (error || !data) {
    el.innerHTML = `<div class="empty">대차 정보를 불러오지 못했습니다.</div>`;
    return;
  }
  const krw = (n) => Number(n).toLocaleString('ko-KR') + '원';
  const head = Number(data.headroom_krw);
  el.innerHTML = `
    <div class="stat"><div class="label">광고 수익 누적</div><div class="value">${krw(data.revenue_krw)}</div></div>
    <div class="stat"><div class="label">상품 지급 누적</div><div class="value">${krw(data.fulfilled_krw)}</div>
      <div class="sub">${won(data.fulfilled_bet)} 소진</div></div>
    <div class="stat"><div class="label">지급 여력</div>
      <div class="value ${head >= 0 ? 'pos' : 'neg'}">${krw(head)}</div>
      <div class="sub">대기 중 신청 ${won(data.pending_bet)}</div></div>`;
}

/* ------------------------------------------------------------------ 상품 */
async function loadItems() {
  const { data, error } = await sb
    .from('betgirl_items').select('*').eq('active', true).order('cost', { ascending: true }).limit(100);
  const el = $('#items');
  if (error) {
    el.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    el.innerHTML = `<div class="empty">등록된 상품이 아직 없습니다. 곧 채워집니다.</div>`;
    $('#itemsNote').textContent = '';
    return;
  }
  const canBuy = !!me.profile;
  const gacha = gachaPolicy && seedReady;
  el.innerHTML = data
    .map((i) => {
      const out = i.stock !== null && i.stock <= 0;
      const dis = canBuy && !out ? '' : 'disabled';
      const gambleBtns = gacha
        ? ['half', 'ten']
            .map((m) => {
              const p = gachaPolicy[m];
              if (!p) return '';
              const c = modeCost(i.cost, p.ratioMilli);
              return `<button class="ghost" data-item="${i.id}" data-mode="${m}"
                        data-name="${esc(i.name)}" data-cost="${c}" ${dis}>
                        ${MODE_LABEL[m]} · ${won(c)}</button>`;
            })
            .join('')
        : '';
      return `<div class="item-card">
        <img class="item-thumb" src="${esc(itemImage(i.image_url))}" alt=""
             width="320" height="200" loading="lazy" decoding="async">
        <h3>${esc(i.name)}</h3>
        ${i.note ? `<div class="dim" style="font-size:12px">${esc(i.note)}</div>` : ''}
        <div class="item-cost">${won(i.cost)}</div>
        <div class="item-stock">${i.stock === null ? '수량 제한 없음' : out ? '품절' : `남은 수량 ${i.stock}`}</div>
        <button data-item="${i.id}" data-mode="sure" data-name="${esc(i.name)}" data-cost="${i.cost}" ${dis}>
          ${out ? '품절' : canBuy ? `확정 교환 · ${won(i.cost)}` : '로그인 필요'}
        </button>
        ${gambleBtns}
      </div>`;
    })
    .join('');
  $('#itemsNote').textContent = `${data.length}개 상품${gacha ? ' · 확률 도전 가능' : ''}`;
}

// 이미지가 404 나면 기본 이미지로 대체한다 (error 는 버블링하지 않으므로 캡처 단계로 받는다).
$('#items').addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && !img.src.endsWith(ITEM_FALLBACK)) img.src = ITEM_FALLBACK;
  },
  true
);

$('#items').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-item]');
  if (!btn || btn.disabled) return;
  const { item, mode, name, cost } = btn.dataset;
  const prob = mode === 'sure' ? 100 : Math.round((gachaPolicy?.[mode]?.prob ?? 0) * 100);

  const msg =
    mode === 'sure'
      ? `${name}\n${won(Number(cost))}을 차감하고 확정 교환을 신청합니다.`
      : `${name} — ${MODE_LABEL[mode]}\n비용 ${won(Number(cost))} · 당첨 확률 ${prob}%\n` +
        `미당첨 시 비용은 반환되지 않습니다. 결과는 커밋된 시드로 즉시 확정되며 시드 공개 후 누구나 검증할 수 있습니다.`;
  if (!confirm(msg + '\n되돌릴 수 없습니다. 진행할까요?')) return;

  btn.disabled = true;

  let result;
  if (mode === 'sure' && !seedReady) {
    // 시드 미준비 시 확정 교환은 기존 경로로
    const { data, error } = await sb.rpc('betgirl_shop_request', { p_item_id: Number(item) });
    btn.disabled = false;
    if (error) return void alert('신청 실패: ' + error.message);
    alert(`신청 완료 (#${data}).`);
  } else {
    const clientSeed = [...crypto.getRandomValues(new Uint8Array(8))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const { data, error } = await sb.rpc('betgirl_gacha_draw', {
      p_item_id: Number(item), p_mode: mode, p_client_seed: clientSeed,
    });
    btn.disabled = false;
    if (error) return void alert('실패: ' + error.message);
    result = Array.isArray(data) ? data[0] : data;
    alert(
      result.win
        ? `🎉 당첨! ${name}\n추첨 #${result.draw_seq} · 최대 7일 내 지급됩니다.\n(시드 해시 ${String(result.seed_hash).slice(0, 12)}… · 시드 공개 후 검증 가능)`
        : `미당첨 — ${name} (${MODE_LABEL[mode]})\n추첨 #${result.draw_seq} · ${won(Number(cost))} 소진.\n시드 공개 후 결과를 직접 검증할 수 있습니다.`
    );
  }

  refreshBalance();
  loadItems();
  loadMine();
  loadSolvency();
  loadGacha();
});

/* ------------------------------------------------------------------ 내 내역 */
const KIND_LABEL = { request: '처리 대기', fulfill: '지급 완료', reject: '반려·환급' };

async function loadMine() {
  if (!me.profile) return;
  $('#myPanel').hidden = false;

  const { data, error } = await sb
    .from('betgirl_redemptions')
    .select('seq,kind,item,cost,request_seq,created_at')
    .eq('handle', me.profile.handle)
    .order('seq', { ascending: false })
    .limit(200);

  const tb = $('#myTbl tbody');
  if (error || !data?.length) {
    tb.innerHTML = `<tr><td colspan="5" class="empty">${error ? esc(error.message) : '교환 내역이 없습니다.'}</td></tr>`;
    return;
  }

  const resolved = new Map(
    data.filter((r) => r.kind !== 'request').map((r) => [r.request_seq, r.kind])
  );
  tb.innerHTML = data
    .filter((r) => r.kind === 'request')
    .map((r) => {
      const state = resolved.get(r.seq) ?? 'request';
      const badge = state === 'fulfill' ? 'win' : state === 'reject' ? 'void' : 'pending';
      return `<tr>
        <td class="dim">${r.seq}</td>
        <td>${esc(r.item)}</td>
        <td class="num">${won(r.cost)}</td>
        <td><span class="badge ${badge}">${KIND_LABEL[state === 'request' ? 'request' : state]}</span></td>
        <td class="dim">${esc(kst(r.created_at))}</td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ 시작 */
(async () => {
  initNav('/shop');
  me = await currentUser();
  renderAccount();
  await loadGacha();
  await Promise.all([loadSolvency(), loadItems()]);
  loadMine();
})();
