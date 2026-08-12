// betgirl — 상품 스토어 (현금 결제, 토스페이먼츠 결제위젯)
import { sb, initNav, esc } from './app.js';
import { loadTossPayments, ANONYMOUS } from 'https://esm.sh/@tosspayments/tosspayments-sdk@2';

const $ = (s) => document.querySelector(s);
const cfg = window.BETGIRL_CONFIG || {};
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';

let widgets = null;
let current = null;   // 선택 상품

/* ------------------------------------------------------------------ 상품 목록 */
async function loadProducts() {
  const { data, error } = await sb
    .from('betgirl_products').select('*').eq('active', true).order('price_krw').limit(100);
  const el = $('#products');
  if (error) return void (el.innerHTML = `<div class="empty">${esc(error.message)}</div>`);
  if (!data.length) return void (el.innerHTML = `<div class="empty">등록된 상품이 없습니다.</div>`);

  el.innerHTML = data
    .map((p) => {
      const out = p.stock !== null && p.stock <= 0;
      return `<div class="prod">
        <h3>${esc(p.name)}</h3>
        ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
        <div class="price">${won(p.price_krw)}</div>
        <div class="desc">${p.stock === null ? '재고 충분' : out ? '품절' : `남은 수량 ${p.stock}`}</div>
        <button data-id="${p.id}" data-name="${esc(p.name)}" data-price="${p.price_krw}" ${out ? 'disabled' : ''}>
          ${out ? '품절' : '구매하기'}
        </button>
      </div>`;
    })
    .join('');
  $('#listNote').textContent = `${data.length}개 상품`;

  // ?buy=ID 딥링크: 해당 상품 주문 화면으로 바로 진입
  const buy = new URLSearchParams(location.search).get('buy');
  if (buy) {
    const btn = el.querySelector(`button[data-id="${Number(buy)}"]`);
    if (btn) btn.click();
  }
}

/* ---------------------------------------------------------- 상품 선택 → 주문/결제 */
$('#products').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn || btn.disabled) return;
  current = { id: Number(btn.dataset.id), name: btn.dataset.name, price: Number(btn.dataset.price) };

  $('#orderSum').innerHTML =
    `<strong>${esc(current.name)}</strong> · 결제 금액 <b>${won(current.price)}</b>`;
  $('#listPanel').hidden = true;
  $('#orderPanel').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  await renderWidget(current.price);
});

$('#backBtn').addEventListener('click', () => {
  $('#orderPanel').hidden = true;
  $('#listPanel').hidden = false;
});

/* ------------------------------------------------------ 토스 결제위젯 렌더링 */
async function renderWidget(amount) {
  $('#orderMsg').innerHTML = '';
  if (!cfg.TOSS_CLIENT_KEY) {
    $('#orderMsg').innerHTML =
      `<div class="msg err">결제 설정(TOSS_CLIENT_KEY)이 없습니다. 관리자에게 문의하세요.</div>`;
    return;
  }
  try {
    const toss = await loadTossPayments(cfg.TOSS_CLIENT_KEY);
    widgets = toss.widgets({ customerKey: ANONYMOUS });
    await widgets.setAmount({ currency: 'KRW', value: amount });
    await Promise.all([
      widgets.renderPaymentMethods({ selector: '#payment-method', variantKey: 'DEFAULT' }),
      widgets.renderAgreement({ selector: '#agreement', variantKey: 'AGREEMENT' }),
    ]);
  } catch (err) {
    $('#orderMsg').innerHTML = `<div class="msg err">결제창을 불러오지 못했습니다: ${esc(String(err.message || err))}</div>`;
  }
}

/* ------------------------------------------------------------------ 결제하기 */
$('#payBtn').addEventListener('click', async () => {
  const email = $('#buyerEmail').value.trim();
  if (!email) return void ($('#orderMsg').innerHTML = `<div class="msg err">받는 이메일을 입력하세요.</div>`);
  if (!widgets) return;

  $('#payBtn').disabled = true;
  try {
    // 1) 서버가 상품 정가로 주문 생성 (금액 위조 방지)
    const r = await fetch('/api/create-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: current.id, email }),
    });
    const order = await r.json();
    if (!r.ok) throw new Error(order.error || '주문 생성 실패');

    // 2) 토스 결제창 호출
    await widgets.requestPayment({
      orderId: order.orderId,
      orderName: order.orderName,
      successUrl: location.origin + '/store-success',
      failUrl: location.origin + '/store-fail',
      customerEmail: email,
    });
    // requestPayment 는 성공 시 successUrl 로 리다이렉트되므로 이 아래는 실행되지 않는다.
  } catch (err) {
    $('#orderMsg').innerHTML = `<div class="msg err">${esc(String(err.message || err))}</div>`;
    $('#payBtn').disabled = false;
  }
});

initNav('/store');
loadProducts();
