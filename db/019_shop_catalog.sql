-- betgirl 019 — 교환소(/shop) 상품 카탈로그 + 상품 이미지 (SQL Editor 1회 실행)
--
-- 대상은 벳(무료 포인트) 교환소인 betgirl_items 다. 현금 스토어(betgirl_products, 018)와는 별개.
-- 이미지는 외부 링크가 아니라 레포에 포함된 자체 제작 SVG(/items/*.svg) 를 가리킨다 —
-- 외부 요청 0, 저작권 안전, CDN 장애 무관.
--
-- 멱등: 같은 이름의 상품이 있으면 새로 넣지 않고, 이미지 경로만 카탈로그 값으로 맞춘다.
-- 가격은 기준가 10벳 = 1원 (예: 5,000원 상품권 = 50,000벳).

-- 초기 테스트 상품은 내린다 (삭제 대신 비활성 — 교환 원장에 이름이 남아 있으므로).
update public.betgirl_items
   set active = false
 where name = '테스트 상품 (아메리카노)' and active;

with cat(name, cost, stock, image_url, note) as (
  values
    ('아이스크림 콘 교환권',     20000,  30, '/items/ice-cream.svg',
     '아이스크림 전문점 싱글 레귤러 · 모바일 교환권'),
    ('편의점 금액권 3,000원',    30000,  30, '/items/gift-cvs-3000.svg',
     '전국 편의점에서 쓰는 모바일 금액권'),
    ('카페 아메리카노 교환권',   45000,  30, '/items/americano.svg',
     '프랜차이즈 카페 아메리카노 Tall · 모바일 교환권'),
    ('편의점 금액권 5,000원',    50000,  30, '/items/gift-cvs-5000.svg',
     '전국 편의점에서 쓰는 모바일 금액권'),
    ('도넛 6개 세트 교환권',     90000,  15, '/items/donut.svg',
     '도넛 전문점 6개 세트 · 모바일 교환권'),
    ('문화상품권 10,000원',     100000,  15, '/items/gift-culture-10000.svg',
     '온라인 충전형 문화상품권 핀번호'),
    ('영화 예매권 1매',         130000,  10, '/items/movie.svg',
     '전국 주요 극장 2D 일반 1인 예매권'),
    ('치킨 한 마리 교환권',     200000,   5, '/items/chicken.svg',
     '프랜차이즈 후라이드 한 마리 · 모바일 교환권'),
    ('피자 라지 1판 교환권',    250000,   3, '/items/pizza.svg',
     '프랜차이즈 피자 라지 1판 · 모바일 교환권'),
    ('백화점 상품권 50,000원',  500000,   1, '/items/gift-dept-50000.svg',
     '한정 수량 · 발송 방법은 지급 시 개별 안내')
),
ins as (
  insert into public.betgirl_items (name, cost, stock, image_url, note)
  select c.name, c.cost, c.stock, c.image_url, c.note
    from cat c
   where not exists (select 1 from public.betgirl_items i where i.name = c.name)
  returning id
)
update public.betgirl_items i
   set image_url = c.image_url
  from cat c
 where i.name = c.name
   and i.image_url is distinct from c.image_url;

select id, name, cost, stock, image_url, active
  from public.betgirl_items
 order by active desc, cost;
