// betgirl.site 공개 설정
// anon 키는 공개되어도 되는 값이다(RLS로 보호). service_role 키는 절대 여기에 넣지 말 것.
window.BETGIRL_CONFIG = {
  SUPABASE_URL: 'https://scpijkzdxalswmnljafu.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjcGlqa3pkeGFsc3dtbmxqYWZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MDg5NDksImV4cCI6MjEwMTQ4NDk0OX0.w9MAXZorH9-VunRq-Z6_VH7pWGUYLSYlNsvfmSWkYwE',
  SITE_NAME: 'betgirl',
  // 화면에 표시할 단위 — 사이트 포인트 '벳' (현금 아님, 1원=10벳 감각)
  CURRENCY: '벳',
  // 체인 앵커 저장소 (매일 tip 해시가 게시됨). 무결성 검증이 이 파일과 대조한다.
  ANCHOR_RAW_URL: 'https://raw.githubusercontent.com/raki990222/betgirl-anchor/main/anchors.jsonl',
};
