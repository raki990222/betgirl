-- betgirl 019 — 교환소(/shop) 상품 카탈로그 + 상품 이미지 (SQL Editor 1회 실행)
--
-- 대상은 벳(무료 포인트) 교환소인 betgirl_items 다. 현금 스토어(betgirl_products, 018)와는 별개.
-- 이미지는 외부 링크가 아니라 레포에 포함된 자체 제작 SVG(/items/*.svg) 를 가리킨다 —
-- 외부 요청 0, 저작권 안전, CDN 장애 무관.
--
-- 멱등: 같은 이름의 상품이 있으면 새로 넣지 않고, 이미지 경로만 카탈로그 값으로 맞춘다.
-- 가격·재고는 덮어쓰지 않는다 (운영 중 조정한 값을 재실행이 되돌리면 안 되므로).
-- 가격은 기준가 10벳 = 1원 (예: 5,000원 상품권 = 50,000벳).
--
-- 상표를 쓰지 않고 품목만 적는다 ("프랜차이즈 카페", "전국 편의점") — 조달처를 바꿔도 고지가 유지된다.

-- 초기 테스트 상품은 내린다 (삭제 대신 비활성 — 교환 원장에 이름이 남아 있으므로).
update public.betgirl_items
   set active = false
 where name = '테스트 상품 (아메리카노)' and active;

with cat(name, cost, stock, image_url, note) as (
  values
    ('편의점 금액권 1,000원',     10000,  50, '/items/gift-cvs-1000.svg',
     '전국 편의점에서 쓰는 모바일 금액권'),
    ('아이스크림 콘 교환권',       20000,  30, '/items/ice-cream.svg',
     '아이스크림 전문점 싱글 레귤러 · 모바일 교환권'),
    ('편의점 금액권 3,000원',     30000,  30, '/items/gift-cvs-3000.svg',
     '전국 편의점에서 쓰는 모바일 금액권'),
    ('카페 아메리카노 교환권',     45000,  30, '/items/americano.svg',
     '프랜차이즈 카페 아메리카노 Tall · 모바일 교환권'),
    ('편의점 금액권 5,000원',     50000,  30, '/items/gift-cvs-5000.svg',
     '전국 편의점에서 쓰는 모바일 금액권'),
    ('카페 카페라떼 교환권',       55000,  25, '/items/latte.svg',
     '프랜차이즈 카페 카페라떼 Tall · 모바일 교환권'),
    ('떡볶이 1인분 교환권',        60000,  20, '/items/tteokbokki.svg',
     '분식 프랜차이즈 떡볶이 1인분 · 모바일 교환권'),
    ('버거 세트 교환권',           85000,  20, '/items/burger.svg',
     '버거 프랜차이즈 세트(버거+사이드+음료) · 모바일 교환권'),
    ('도넛 6개 세트 교환권',       90000,  15, '/items/donut.svg',
     '도넛 전문점 6개 세트 · 모바일 교환권'),
    ('음악 스트리밍 1개월 이용권', 95000,  15, '/items/music.svg',
     '음악 스트리밍 서비스 1개월 이용권 코드'),
    ('문화상품권 10,000원',      100000,  15, '/items/gift-culture-10000.svg',
     '온라인 충전형 문화상품권 핀번호'),
    ('영상 스트리밍 1개월 이용권',120000,  10, '/items/ott.svg',
     '영상 스트리밍 서비스 1개월 이용권 코드'),
    ('영화 예매권 1매',          130000,  10, '/items/movie.svg',
     '전국 주요 극장 2D 일반 1인 예매권'),
    ('배달 금액권 15,000원',     150000,  10, '/items/delivery.svg',
     '배달 주문에 쓰는 모바일 금액권'),
    ('치킨 한 마리 교환권',      200000,   5, '/items/chicken.svg',
     '프랜차이즈 후라이드 한 마리 · 모바일 교환권'),
    ('피자 라지 1판 교환권',     250000,   3, '/items/pizza.svg',
     '프랜차이즈 피자 라지 1판 · 모바일 교환권'),
    ('편의점 금액권 30,000원',   300000,   3, '/items/gift-cvs-30000.svg',
     '전국 편의점에서 쓰는 모바일 금액권'),
    ('백화점 상품권 50,000원',   500000,   1, '/items/gift-dept-50000.svg',
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
