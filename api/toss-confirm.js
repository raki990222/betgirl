// betgirl — 토스페이먼츠 결제 승인 (서버가 시크릿 키로 최종 확인)
// POST { paymentKey, orderId, amount } → 승인 성공 시 주문을 paid 로 확정
//
// 핵심 방어: 클라이언트가 보낸 amount 를 믿지 않고, 주문 테이블의 서버 확정 금액과
//           일치하는지 확인한 뒤에만 토스 승인을 호출한다.

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
    const { paymentKey, orderId } = body;
    const amount = Number(body.amount);
    if (!paymentKey || !orderId || !amount) return res.status(400).json({ error: '필수 값 누락' });

    const rows = await sb(`betgirl_orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`);
    const order = rows[0];
    if (!order) return res.status(400).json({ error: '존재하지 않는 주문입니다.' });
    if (order.status === 'paid') return res.status(200).json({ ok: true, already: true });
    if (order.amount_krw !== amount) {
      return res.status(400).json({ error: '결제 금액이 주문 금액과 일치하지 않습니다.' });
    }

    // 토스 승인
    const secret = process.env.TOSS_SECRET_KEY;
    const auth = Buffer.from(`${secret}:`).toString('base64');
    const tRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });
    const t = await tRes.json();

    if (!tRes.ok) {
      await sb(`betgirl_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { status: 'failed' },
      });
      return res.status(400).json({ error: t.message || '결제 승인 실패', code: t.code });
    }

    await sb(`betgirl_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { status: 'paid', payment_key: paymentKey, method: t.method || null, paid_at: new Date().toISOString() },
    });

    return res.status(200).json({ ok: true, orderName: order.order_name, amount, method: t.method });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
