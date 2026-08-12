// betgirl 브랜드 자산 — 로고(인라인 SVG)와 회사 정보를 한 곳에서 관리.
// 로고: 타깃(🎯) 과녁을 모티프로 한 워드마크. --accent 를 상속해 라이트/다크 자동 대응.

// 윙드 로델 엠블럼 (차량 엠블럼 스타일). 고정 그라데이션이라 라이트/다크 동일하게 보인다.
// id 충돌 방지를 위해 인스턴스마다 접미사를 붙인다.
export const LOGO_MARK = (size = 26, id = 'lg') => `
<svg width="${size * 2}" height="${size}" viewBox="0 0 64 44" fill="none" aria-hidden="true"
     style="vertical-align:-9px">
  <defs>
    <linearGradient id="wing-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff6aa6"/><stop offset="1" stop-color="#c81f5a"/>
    </linearGradient>
    <radialGradient id="core-${id}" cx="0.5" cy="0.36" r="0.75">
      <stop offset="0" stop-color="#2b3040"/><stop offset="1" stop-color="#0b0d13"/>
    </radialGradient>
    <linearGradient id="ring-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff8dbd"/><stop offset="0.5" stop-color="#e0316f"/>
      <stop offset="1" stop-color="#9c1244"/>
    </linearGradient>
  </defs>
  <g fill="url(#wing-${id})">
    <rect x="2"  y="15.4" width="14" height="3" rx="1.5"/>
    <rect x="1"  y="20.3" width="16" height="3" rx="1.5"/>
    <rect x="4"  y="25.2" width="12" height="3" rx="1.5"/>
    <rect x="48" y="15.4" width="14" height="3" rx="1.5"/>
    <rect x="47" y="20.3" width="16" height="3" rx="1.5"/>
    <rect x="48" y="25.2" width="12" height="3" rx="1.5"/>
  </g>
  <circle cx="32" cy="22" r="15" fill="url(#core-${id})" stroke="url(#ring-${id})" stroke-width="2.6"/>
  <circle cx="32" cy="22" r="9" fill="none" stroke="#ff8dbd" stroke-width="1.5" opacity="0.55"/>
  <circle cx="32" cy="22" r="4.1" fill="url(#ring-${id})"/>
  <path d="M23 15 a12 12 0 0 1 18 0" stroke="#fff" stroke-width="1.3" opacity="0.18"
        fill="none" stroke-linecap="round"/>
</svg>`;

/** 헤더 브랜드 영역을 표준화한다 (기존 정적 마크업을 대체). */
export function mountBrand(subtitle = '') {
  const el = document.querySelector('header.site .brand');
  if (!el) return;
  el.innerHTML =
    `<a href="/" style="display:inline-flex;align-items:center;gap:9px;color:inherit;text-decoration:none">
       ${LOGO_MARK(26, 'hdr')}
       <span>bet<em>girl</em></span>
     </a>` + (subtitle ? `<span class="brand-sub">${subtitle}</span>` : '');
}

export const COMPANY = {
  name: '주식회사 시지온',
  ceo: '김범진',
  bizNo: '105-87-52653',
  mailOrder: '통신판매업신고 제2021-서울중구-0970호',
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
