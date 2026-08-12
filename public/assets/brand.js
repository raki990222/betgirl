// betgirl 브랜드 자산 — 로고(인라인 SVG)와 회사 정보를 한 곳에서 관리.
// 로고: 타깃(🎯) 과녁을 모티프로 한 워드마크. --accent 를 상속해 라이트/다크 자동 대응.

export const LOGO_MARK = (size = 26) => `
<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"
     style="vertical-align:-5px">
  <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2" opacity="0.35"/>
  <circle cx="16" cy="16" r="9" stroke="currentColor" stroke-width="2" opacity="0.6"/>
  <circle cx="16" cy="16" r="3.5" fill="currentColor"/>
  <path d="M16 2 L16 7 M16 25 L16 30 M2 16 L7 16 M25 16 L30 16" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" opacity="0.5"/>
</svg>`;

/** 헤더 브랜드 영역을 표준화한다 (기존 정적 마크업을 대체). */
export function mountBrand(subtitle = '') {
  const el = document.querySelector('header.site .brand');
  if (!el) return;
  el.innerHTML =
    `<a href="/" style="display:inline-flex;align-items:center;gap:8px;color:inherit;text-decoration:none">
       <span style="color:var(--accent)">${LOGO_MARK(24)}</span>
       <span>bet<em>girl</em></span>
     </a>` + (subtitle ? `<span class="brand-sub">${subtitle}</span>` : '');
}

export const COMPANY = {
  name: '주식회사 시지온',
  ceo: '김범진',
  bizNo: '105-87-52653',
  mailOrder: '통신판매업신고',
  address: '서울특별시 을지로5길 19, 페럼타워 23층',
};

/** 회사 정보 푸터 블록 (법적 고지 + 사업자 정보). */
export function companyFooter() {
  const c = COMPANY;
  return `
    <div class="wrap">
      <div class="foot-legal">
        <strong>betgirl.site</strong> — 본 사이트는 베팅을 접수·중개하지 않으며 금전을 수취하지 않습니다.
        벳은 현금 가치가 없는 사이트 내부 포인트이며 충전·환전이 불가능합니다.
        만 19세 미만 이용 불가. 도박 문제 상담 국번없이 <strong>1336</strong>.
      </div>
      <div class="foot-corp">
        ${c.name} · 대표이사 ${c.ceo} · 사업자등록번호 ${c.bizNo} · ${c.mailOrder}<br>
        ${c.address}
      </div>
    </div>`;
}
