-- betgirl 018 — 현금 상품 스토어 (기프티콘 등 현금 직접 판매) — SQL Editor 1회 실행
--
-- ⚠️ 이 스토어는 예측·벳(무료 포인트) 시스템과 완전히 분리된 일반 전자상거래다.
--    현금 결제(토스페이먼츠)로 기프티콘을 판매한다. 벳/예측과 얽히지 않는다.
--
-- 보안: 주문 금액은 서버(create-order 함수)가 상품 정가로 확정하고,
--       결제 승인(toss-confirm)은 서버가 시크릿 키로 토스에 확인한 뒤에만 paid 로 바꾼다.
--       주문 테이블은 공개 읽기가 없다(개인 구매정보). 쓰기는 service_role(서버)만.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- 상품(현금)
create table if not exists public.betgirl_products (
  id          bigint generated always as identity primary key,
  name        text    not null,
  price_krw   integer not null check (price_krw > 0),
  image_url   text,
  description text,
  stock       integer check (stock is null or stock >= 0),   -- null=무제한
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.betgirl_products enable row level security;
drop policy if exists betgirl_products_read on public.betgirl_products;
create policy betgirl_products_read on public.betgirl_products
  for select to anon, authenticated using (active);
grant select on public.betgirl_products to anon, authenticated;

-- ---------------------------------------------------------------- 주문
create table if not exists public.betgirl_orders (
  order_id    text primary key,                              -- 토스 orderId (서버 생성)
  product_id  bigint references public.betgirl_products(id),
  order_name  text    not null,
  amount_krw  integer not null check (amount_krw > 0),
  buyer_email text,
  status      text    not null default 'pending'
                check (status in ('pending','paid','failed','canceled')),
  payment_key text,
  method      text,
  created_at  timestamptz not null default now(),
  paid_at     timestamptz
);

alter table public.betgirl_orders enable row level security;
-- 공개 읽기/쓰기 정책 없음 → anon 은 접근 불가. 서버(service_role)만 처리.
grant select, insert, update on public.betgirl_orders to service_role;

-- ---------------------------------------------------------------- 샘플 상품
insert into public.betgirl_products (name, price_krw, description, stock)
select * from (values
  ('스타벅스 아메리카노 Tall',        4500, '모바일 교환권 · 발송까지 최대 24시간', null),
  ('GS25 모바일 상품권 5,000원',      5000, '편의점 모바일 상품권',                 null),
  ('배스킨라빈스 싱글레귤러',          3900, '아이스크림 싱글 교환권',               100),
  ('CU 모바일 상품권 10,000원',      10000, '편의점 모바일 상품권',                 null)
) v(name, price_krw, description, stock)
where not exists (select 1 from public.betgirl_products);

select id, name, price_krw from public.betgirl_products order by id;
