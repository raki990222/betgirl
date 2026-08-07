// betgirl — 상품 교환소
import { sb, initNav, currentUser, won, esc, kst } from './app.js';

const $ = (s) => document.querySelector(s);
let me = { session: null, profile: null, isOperator: false };

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
  el.innerHTML = data
    .map((i) => {
      const out = i.stock !== null && i.stock <= 0;
      return `<div class="item-card">
        <h3>${esc(i.name)}</h3>
        ${i.note ? `<div class="dim" style="font-size:12px">${esc(i.note)}</div>` : ''}
        <div class="item-cost">${won(i.cost)}</div>
        <div class="item-stock">${i.stock === null ? '수량 제한 없음' : out ? '품절' : `남은 수량 ${i.stock}`}</div>
        <button data-item="${i.id}" data-name="${esc(i.name)}" data-cost="${i.cost}"
          ${canBuy && !out ? '' : 'disabled'}>
          ${out ? '품절' : canBuy ? '교환 신청' : '로그인 필요'}
        </button>
      </div>`;
    })
    .join('');
  $('#itemsNote').textContent = `${data.length}개 상품`;
}

$('#items').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-item]');
  if (!btn || btn.disabled) return;
  const { item, name, cost } = btn.dataset;
  if (!confirm(`${name}\n${won(Number(cost))}을 차감하고 교환을 신청합니다.\n신청 후 최대 7일 내 지급되며, 되돌릴 수 없습니다.`)) return;

  btn.disabled = true;
  const { data, error } = await sb.rpc('betgirl_shop_request', { p_item_id: Number(item) });
  btn.disabled = false;
  if (error) {
    alert('신청 실패: ' + error.message);
    return;
  }
  alert(`신청 완료 (#${data}). 소지금이 차감되었고, 처리 결과는 아래 내역에서 확인하세요.`);
  refreshBalance();
  loadItems();
  loadMine();
  loadSolvency();
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
  await Promise.all([loadSolvency(), loadItems()]);
  loadMine();
})();
