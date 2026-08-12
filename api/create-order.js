// betgirl — 주문 생성 (서버가 상품 정가로 금액을 확정한다. 클라이언트 금액 위조 방지)
// POST { productId, email } → { orderId, amount, orderName }

const SUPABASE_URL = 'https://scpijkzdxalswmnljafu.supabase.co';

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const productId = Number(body.productId);
    const email = (body.email || '').trim() || null;
    if (!productId) return res.status(400).json({ error: '상품이 지정되지 않았습니다.' });

    const rows = await sb(`betgirl_products?id=eq.${productId}&select=id,name,price_krw,active,stock`);
    const p = rows[0];
    if (!p || !p.active) return res.status(400).json({ error: '판매 중인 상품이 아닙니다.' });
    if (p.stock !== null && p.stock <= 0) return res.status(400).json({ error: '품절된 상품입니다.' });

    // 토스 orderId: 영문/숫자/-_ 6~64자
    const orderId = 'bg_' + Date.now().toString(36) + '_' +
      require('crypto').randomBytes(6).toString('hex');

    await sb('betgirl_orders', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        order_id: orderId,
        product_id: p.id,
        order_name: p.name,
        amount_krw: p.price_krw,      // ← 금액은 서버가 상품 정가로 확정
        buyer_email: email,
        status: 'pending',
      },
    });

    return res.status(200).json({ orderId, amount: p.price_krw, orderName: p.name });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
