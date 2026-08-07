// betgirl — 공통 유틸 (Supabase 클라이언트, 포맷터, 해시 체인 검증)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.BETGIRL_CONFIG || {};

export const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const CURRENCY = cfg.CURRENCY || '원';

/* ------------------------------------------------------------------ 포맷 */
export const won = (n) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('ko-KR') + CURRENCY;

export const signedWon = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toLocaleString('ko-KR') + CURRENCY;
};

export const pct = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(1) + '%');

export const kst = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

/** http(s) URL만 통과. 저장된 링크가 javascript: 등으로 오염돼도 렌더되지 않게 한다. */
export const safeUrl = (u) => {
  try {
    const p = new URL(String(u));
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
  } catch {
    return null;
  }
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const STATUS_LABEL = {
  pending: '미확정', win: '적중', lose: '미적중', void: '무효', cancel: '취소',
};

/* --------------------------------------------------- 해시 체인 (DB 트리거와 동일 규칙) */
const ZERO = '0'.repeat(64);

const isoSec = (ts) => new Date(ts).toISOString().slice(0, 19) + 'Z';

export const canonicalBet = (b) =>
  [
    'bet', b.bettor, b.event_key, b.match_label, b.market, b.pick,
    String(b.stake), Number(b.odds).toFixed(2), isoSec(b.placed_at), b.ticket_no ?? '',
  ].join('|');

export const canonicalSettlement = (s) =>
  ['settle', String(s.bet_seq), s.result, String(s.payout), isoSec(s.settled_at)].join('|');

export const canonicalCredit = (c) =>
  ['credit', c.handle, String(c.amount), c.reason, isoSec(c.created_at)].join('|');

export const canonicalDraw = (d) =>
  [
    'draw', d.handle, d.item, String(d.item_cost), d.mode, String(d.cost),
    String(d.seed_seq), String(d.nonce), d.client_seed, d.roll,
    d.win ? 'W' : 'L', isoSec(d.created_at),
  ].join('|');

export const canonicalRedemption = (r) =>
  [
    'redeem', r.kind, r.handle, r.item, String(r.cost),
    r.request_seq == null ? '' : String(r.request_seq), isoSec(r.created_at),
  ].join('|');

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 원장 한 벌의 해시 체인을 브라우저에서 재계산해 위변조를 검증한다.
 * rows 는 seq 오름차순이어야 한다.
 */
async function verifyChain(rows, canonicalFn, kind) {
  const problems = [];
  const hashes = [];
  let prev = ZERO;

  for (const row of rows) {
    const rebuilt = canonicalFn(row);
    if (rebuilt !== row.canonical) {
      problems.push({ kind, seq: row.seq, reason: '표시된 값과 서명된 원문이 다릅니다' });
    }
    if (row.prev_hash !== prev) {
      problems.push({ kind, seq: row.seq, reason: '이전 행 연결이 끊어졌습니다' });
    }
    const expected = await sha256Hex(row.prev_hash + row.canonical);
    if (expected !== row.row_hash) {
      problems.push({ kind, seq: row.seq, reason: '해시가 일치하지 않습니다' });
    }
    prev = row.row_hash;
    hashes.push(row.row_hash);
  }
  return { count: rows.length, tip: prev === ZERO ? null : prev, hashes, problems };
}

/**
 * 외부 앵커 저장소(GitHub)의 최신 앵커와 현재 체인을 대조한다.
 * 앵커 시점의 행 개수 위치에서 해시가 일치하면, 그 시점 이후 원장이
 * "추가만" 되었음이 증명된다 (재구축·소급 수정 시 불일치).
 */
export async function checkAnchor(hashMap) {
  const url = (window.BETGIRL_CONFIG || {}).ANCHOR_RAW_URL;
  if (!url) return { state: 'unconfigured' };

  let text;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { state: 'unavailable' };
    text = (await res.text()).trim();
  } catch {
    return { state: 'unavailable' };
  }
  if (!text) return { state: 'unavailable' };

  let a;
  try {
    a = JSON.parse(text.split('\n').pop());
  } catch {
    return { state: 'unavailable' };
  }

  const at = (chain, hashes) =>
    chain.rows === 0 || (chain.rows <= hashes.length && hashes[chain.rows - 1] === chain.tip);

  // 앵커에 기록된 체인은 전부 대조한다 (앵커에 없는 체인만 생략 — 구버전 앵커 호환).
  // 앵커가 "이 체인에 N행이 있었다"고 주장하는데 브라우저가 그 체인을 읽지 못했다면,
  // 원장이 재구축·롤백됐을 수 있으므로 일치가 아니라 불일치로 처리한다.
  let ok = true;
  for (const key of ['bets', 'settlements', 'credits', 'redemptions', 'draws']) {
    if (!a[key]) continue;
    if (!hashMap[key]) {
      if (a[key].rows > 0) ok = false;
      continue;
    }
    ok = ok && at(a[key], hashMap[key]);
  }
  return { state: ok ? 'ok' : 'mismatch', at: a.at };
}

/** 베팅·정산·적립·교환 네 체인을 모두 검증한다. */
export async function verifyLedger() {
  const [bets, settles] = await Promise.all([
    selectAll('betgirl_bets', 'seq,bettor,event_key,match_label,market,pick,stake,odds,placed_at,ticket_no,prev_hash,canonical,row_hash'),
    selectAll('betgirl_settlements', 'seq,bet_seq,result,payout,settled_at,prev_hash,canonical,row_hash'),
  ]);

  // 적립·교환 체인은 011 마이그레이션 이후에만 존재한다. 컬럼/테이블 자체가 없을 때만
  // 건너뛰고, 행이 있는데 해시가 비어 있으면 "건너뛰기"가 아니라 위변조 의심으로 보고한다
  // (조용한 스킵은 검증을 무력화하는 뒷문이 된다).
  let credits = null;
  let redeems = null;
  let draws = null;
  try {
    credits = await selectAll('betgirl_credits', 'seq,handle,amount,reason,created_at,prev_hash,canonical,row_hash');
  } catch { credits = null; }
  try {
    redeems = await selectAll('betgirl_redemptions', 'seq,kind,handle,item,cost,request_seq,created_at,prev_hash,canonical,row_hash');
  } catch { redeems = null; }
  try {
    draws = await selectAll('betgirl_draws', 'seq,handle,item,item_cost,mode,cost,seed_seq,nonce,client_seed,roll,win,created_at,prev_hash,canonical,row_hash');
  } catch { draws = null; }

  const b = await verifyChain(bets, canonicalBet, '베팅');
  const s = await verifyChain(settles, canonicalSettlement, '정산');
  const c = credits ? await verifyChain(credits, canonicalCredit, '적립') : null;
  const r = redeems ? await verifyChain(redeems, canonicalRedemption, '교환') : null;
  const d = draws ? await verifyChain(draws, canonicalDraw, '추첨') : null;

  const problems = [
    ...b.problems, ...s.problems,
    ...(c ? c.problems : []), ...(r ? r.problems : []), ...(d ? d.problems : []),
  ];
  return {
    ok: problems.length === 0,
    bets: b, settlements: s, credits: c, redemptions: r, draws: d, problems,
  };
}

/* ------------------------------------------------------------------ 공통 내비 */
export async function initNav(activeHref) {
  document.querySelectorAll('header.site nav a').forEach((a) => {
    if (a.getAttribute('href') === activeHref) a.classList.add('on');
  });

  const out = document.querySelector('#logout');
  if (!out) return;

  const { data } = await sb.auth.getSession();
  out.hidden = !data.session;
  out.addEventListener('click', async (e) => {
    e.preventDefault();
    await sb.auth.signOut();
    location.reload();
  });
}

/** 현재 로그인 사용자의 세션·프로필·운영자 여부를 한 번에 가져온다. */
export async function currentUser() {
  const { data } = await sb.auth.getSession();
  const session = data.session;
  if (!session) return { session: null, profile: null, isOperator: false };

  const [{ data: profile }, { data: op }] = await Promise.all([
    sb.from('betgirl_profiles').select('handle').eq('user_id', session.user.id).maybeSingle(),
    sb.from('betgirl_operators').select('user_id').eq('user_id', session.user.id).maybeSingle(),
  ]);

  return { session, profile: profile ?? null, isOperator: !!op };
}

/* ------------------------------------------------- Supabase 전량 조회(1,000행 캡 회피) */
export async function selectAll(table, columns, { order = 'seq', ascending = true } = {}) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .order(order, { ascending })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}
