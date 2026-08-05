# betgirl.site — 공개 베팅 장부

betman.co.kr 구매 내역과 정산을 **추가 전용(append-only) 원장**으로 공개하는 정적 사이트.
Vercel(호스팅) + Supabase(Postgres, Auth) 구성이며 빌드 단계가 없다.

```
public/
  index.html      경기 보드 — 공식 경기 목록·배당, 픽 등록 (betman 스타일)
  ledger.html     공개 원장 — 요약·참가자별 성적·베팅 목록·무결성 검증
  about.html      기록 규칙과 검증 방법
  admin.html      운영 콘솔 — 경기 게시 / 수동 기록 / 정산
  config.js       Supabase URL / anon 키
  assets/         styles.css, app.js(공통), board.js, ledger.js, admin.js
db/
  schema.sql              001 — 원장 테이블·해시 체인·RLS
  002_events_and_picks.sql  경기 보드·참가자 프로필·운영자·픽 등록 규칙
  003_seed_demo.sql         운영자 등록 + 예시 경기
  parity_check.sql          SQL↔JS 해시 규칙 일치 확인 (롤백됨)
vercel.json       정적 배포 설정 (outputDirectory=public, 보안 헤더)
```

마이그레이션은 **001 → 002 → 003 순서**로 실행한다.

## 설계 요약

| 원칙 | 구현 |
|------|------|
| 픽은 경기 시작 전에만 | `betgirl_fill_from_event()` 가 `now() >= start_at` 이면 INSERT 거부 |
| 배당 조작 불가 | 경기명·선택지·배당을 클라이언트가 아니라 서버가 `betgirl_events` 에서 채움 |
| 이름 도용 불가 | `bettor = betgirl_my_handle()` RLS + 핸들 변경 잠금 |
| 사후 조작 불가 | `betgirl_bets`, `betgirl_settlements` 에 UPDATE/DELETE 차단 트리거 |
| 결과 보고 베팅 못 고침 | 베팅 테이블에 결과 컬럼이 없음. 결과는 별도 정산 행으로만 추가 |
| 정산은 운영자만 | `betgirl_settlements` INSERT 는 `betgirl_is_operator()` 필요 |
| 누구나 검증 | 행마다 `SHA-256(직전 해시 + 정규화 원문)` 체인. 원장 페이지에서 브라우저가 직접 재계산 |
| 정정도 공개 | 오기입은 삭제가 아니라 `cancel` 정산 + 새 행 추가 |
| 키 노출 안전 | 프런트는 anon 키만 사용. 읽기 공개 / 쓰기는 `authenticated` 만 (RLS) |

## 세팅 순서

### 1. Supabase

1. [supabase.com](https://supabase.com) → New project (region: **Northeast Asia (Seoul)**)
2. SQL Editor → `db/schema.sql` 전체 붙여넣고 Run
3. Authentication → Users → **Add user** 로 운영자 계정 생성
   (Providers → Email → *Enable sign ups* 는 **끌 것**. 아무나 가입해 기록을 넣으면 안 된다)
4. Settings → API 에서 `Project URL` 과 `anon public` 키 복사 → `public/config.js` 에 입력

> `service_role` 키는 절대 `config.js` 나 프런트 코드에 넣지 않는다.

### 2. Vercel

```bash
cd ~/betgirl
vercel --prod
```

또는 GitHub 레포를 연결해 자동 배포. 프레임워크는 **Other**, 빌드 커맨드 없음.

### 3. 도메인 (가비아)

가비아 → My가비아 → 도메인 → 네임서버 설정에서 1·2차를 아래로 교체 (3·4차 비움):

```
ns1.vercel-dns.com
ns2.vercel-dns.com
```

Vercel 프로젝트 → Settings → Domains 에 `betgirl.site` 와 `www.betgirl.site` 를 추가하면
A/CNAME 레코드는 Vercel이 자동 생성한다. 전파는 보통 수십 분, 최대 48시간.

### 4. 첫 검증

`/admin.html` 에서 테스트 베팅 1건을 넣고 정산까지 마친 뒤,
`/` 의 **무결성 검증** 버튼이 초록색으로 뜨는지 확인한다.

이 검증은 SQL 트리거가 만든 정규화 문자열과 `assets/app.js` 의 `canonicalBet()` /
`canonicalSettlement()` 가 **완전히 같은 규칙**이어야 통과한다.
스키마의 정규화 필드를 바꾸면 JS도 함께 고쳐야 한다.

## 운영 규칙

- 베팅은 **구매 직후** 입력한다. 경기 시작 후 입력된 기록은 신뢰도가 없다.
- 구매번호와 캡처 URL을 함께 남긴다.
- 오기입은 지우지 말고 `cancel` 로 정산한 뒤 새 행을 추가한다.

## 법적 고지

본 사이트는 베팅을 접수·중개하지 않으며 금전을 수취하지 않는다.
대한민국에서 합법적으로 발행되는 체육진흥투표권(betman.co.kr) 구매 내역의 기록·공개 용도로만 운영한다.
만 19세 미만 구매 불가. 도박 문제 상담 1336.
