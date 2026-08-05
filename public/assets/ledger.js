// betgirl — 공개 원장 화면
import { sb, initNav, selectAll, verifyLedger, won, signedWon, pct, kst, esc, STATUS_LABEL } from './app.js';

const $ = (s) => document.querySelector(s);

let rows = [];

/* ------------------------------------------------------------------ 로드 */
async function load() {
  try {
    rows = await selectAll('betgirl_ledger', '*', { order: 'seq', ascending: false });
  } catch (e) {
    $('#ledgerNote').innerHTML =
      `<span style="color:var(--lose)">원장을 불러오지 못했습니다: ${esc(e.message)}</span>`;
    return;
  }

  renderSummary();
  await renderStats();
  fillBettorFilter();
  renderLedger();
}

/* ---------------------------------------------------------------- 요약 카드 */
function renderSummary() {
  const settled = rows.filter((r) => r.status !== 'pending');
  const decided = rows.filter((r) => r.status === 'win' || r.status === 'lose');
  const staked = rows.reduce((a, r) => a + Number(r.stake), 0);
  const returned = settled.reduce((a, r) => a + Number(r.payout || 0), 0);
  const settledStake = settled.reduce((a, r) => a + Number(r.stake), 0);
  const net = returned - settledStake;
  const wins = decided.filter((r) => r.status === 'win').length;
  const pending = rows.length - settled.length;

  const cards = [
    { label: '총 베팅', value: rows.length.toLocaleString('ko-KR') + '건', sub: `미확정 ${pending}건` },
    { label: '총 베팅액', value: won(staked) },
    { label: '총 회수액', value: won(returned), sub: '정산 완료분 기준' },
    { label: '순손익', value: signedWon(net), cls: net > 0 ? 'pos' : net < 0 ? 'neg' : '' },
    { label: '적중률', value: decided.length ? pct((wins / decided.length) * 100) : '—', sub: `${wins} / ${decided.length}` },
    {
      label: '수익률',
      value: settledStake ? pct((net / settledStake) * 100) : '—',
      cls: net > 0 ? 'pos' : net < 0 ? 'neg' : '',
    },
  ];

  $('#summary').innerHTML = cards
    .map(
      (c) => `<div class="stat">
        <div class="label">${esc(c.label)}</div>
        <div class="value ${c.cls || ''}">${esc(c.value)}</div>
        ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
      </div>`
    )
    .join('');
}

/* ------------------------------------------------------------- 참가자 성적 */
async function renderStats() {
  const { data, error } = await sb.from('betgirl_stats').select('*').order('net', { ascending: false });
  const tb = $('#statsTbl tbody');
  if (error || !data || !data.length) {
    tb.innerHTML = `<tr><td colspan="8" class="empty">${error ? esc(error.message) : '아직 기록이 없습니다.'}</td></tr>`;
    return;
  }
  tb.innerHTML = data
    .map((s) => {
      const net = Number(s.net);
      const cls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
      const color = net > 0 ? 'var(--win)' : net < 0 ? 'var(--lose)' : 'inherit';
      return `<tr>
        <td><strong>${esc(s.bettor)}</strong>${Number(s.pending) ? ` <span class="dim">미확정 ${s.pending}</span>` : ''}</td>
        <td class="num">${Number(s.bets).toLocaleString('ko-KR')}</td>
        <td class="num">${s.wins} / ${s.losses}</td>
        <td class="num">${pct(s.hit_rate)}</td>
        <td class="num">${won(s.staked)}</td>
        <td class="num">${won(s.returned)}</td>
        <td class="num" style="color:${color}">${signedWon(net)}</td>
        <td class="num" style="color:${color}">${pct(s.roi)}</td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ 필터 */
function fillBettorFilter() {
  const names = [...new Set(rows.map((r) => r.bettor))].sort();
  $('#fBettor').insertAdjacentHTML(
    'beforeend',
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
  );
}

function filtered() {
  const b = $('#fBettor').value;
  const st = $('#fStatus').value;
  const q = $('#fQuery').value.trim().toLowerCase();
  return rows.filter((r) => {
    if (b && r.bettor !== b) return false;
    if (st && r.status !== st) return false;
    if (q) {
      const hay = `${r.match_label} ${r.pick} ${r.event_key} ${r.league ?? ''} ${r.market}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ 원장 */
function renderLedger() {
  const list = filtered();
  const tb = $('#ledgerTbl tbody');

  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="10" class="empty">조건에 맞는 기록이 없습니다.</td></tr>`;
    $('#ledgerNote').textContent = `전체 ${rows.length}건 중 0건 표시`;
    return;
  }

  tb.innerHTML = list
    .map((r) => {
      const net = r.net === null ? null : Number(r.net);
      const color = net === null ? 'var(--muted)' : net > 0 ? 'var(--win)' : net < 0 ? 'var(--lose)' : 'inherit';
      const proof = r.proof_url
        ? `<a href="${esc(r.proof_url)}" target="_blank" rel="noopener noreferrer">구매</a>`
        : '<span class="dim">—</span>';
      const sproof = r.settle_proof_url
        ? ` · <a href="${esc(r.settle_proof_url)}" target="_blank" rel="noopener noreferrer">정산</a>`
        : '';
      return `<tr>
        <td class="dim">${r.seq}</td>
        <td>${esc(kst(r.placed_at))}<div class="dim">${esc(r.event_key)}</div></td>
        <td>${esc(r.bettor)}</td>
        <td>
          <strong>${esc(r.match_label)}</strong>
          <div class="dim">${esc(r.market)} · ${esc(r.pick)}${r.league ? ' · ' + esc(r.league) : ''}</div>
        </td>
        <td class="num">${won(r.stake)}</td>
        <td class="num">${Number(r.odds).toFixed(2)}</td>
        <td><span class="badge ${esc(r.status)}">${esc(STATUS_LABEL[r.status] ?? r.status)}</span></td>
        <td class="num">${r.status === 'pending' ? '<span class="dim">—</span>' : won(r.payout)}</td>
        <td class="num" style="color:${color}">${net === null ? '<span class="dim">—</span>' : signedWon(net)}</td>
        <td class="dim">${proof}${sproof}<div class="hash" title="${esc(r.row_hash)}">${esc(String(r.row_hash).slice(0, 10))}…</div></td>
      </tr>`;
    })
    .join('');

  $('#ledgerNote').textContent = `전체 ${rows.length}건 중 ${list.length}건 표시`;
}

/* ------------------------------------------------------------------ 검증 */
async function runVerify() {
  const out = $('#verifyOut');
  const btn = $('#verifyBtn');
  btn.disabled = true;
  out.textContent = '검증 중…';
  try {
    const r = await verifyLedger();
    if (r.ok) {
      out.innerHTML = `<span style="color:var(--win)">무결성 확인됨</span> —
        베팅 ${r.bets.count}건 · 정산 ${r.settlements.count}건의 SHA-256 체인을 이 브라우저에서 재계산했고 전부 일치했습니다.
        ${r.bets.tip ? `<div class="hash" style="margin-top:6px">베팅 체인 최종 해시 ${esc(r.bets.tip)}</div>` : ''}
        ${r.settlements.tip ? `<div class="hash">정산 체인 최종 해시 ${esc(r.settlements.tip)}</div>` : ''}`;
    } else {
      out.innerHTML =
        `<span style="color:var(--lose)">불일치 ${r.problems.length}건이 발견되었습니다.</span><ul>` +
        r.problems.map((p) => `<li>${esc(p.kind)} #${p.seq}: ${esc(p.reason)}</li>`).join('') +
        '</ul>';
    }
  } catch (e) {
    out.innerHTML = `<span style="color:var(--lose)">검증 실패: ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

$('#verifyBtn').addEventListener('click', runVerify);
['#fBettor', '#fStatus'].forEach((s) => $(s).addEventListener('change', renderLedger));
$('#fQuery').addEventListener('input', renderLedger);

initNav('/ledger');
load();
