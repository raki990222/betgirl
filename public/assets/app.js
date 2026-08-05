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
  }
  return { count: rows.length, tip: prev === ZERO ? null : prev, problems };
}

/** 베팅·정산 두 체인을 모두 검증한다. */
export async function verifyLedger() {
  const [bets, settles] = await Promise.all([
    selectAll('betgirl_bets', 'seq,bettor,event_key,match_label,market,pick,stake,odds,placed_at,ticket_no,prev_hash,canonical,row_hash'),
    selectAll('betgirl_settlements', 'seq,bet_seq,result,payout,settled_at,prev_hash,canonical,row_hash'),
  ]);

  const b = await verifyChain(bets, canonicalBet, '베팅');
  const s = await verifyChain(settles, canonicalSettlement, '정산');

  return {
    ok: b.problems.length === 0 && s.problems.length === 0,
    bets: b,
    settlements: s,
    problems: [...b.problems, ...s.problems],
  };
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
