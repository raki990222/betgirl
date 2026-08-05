// betgirl.site 공개 설정
// anon 키는 공개되어도 되는 값이다(RLS로 보호). service_role 키는 절대 여기에 넣지 말 것.
window.BETGIRL_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
  SITE_NAME: 'betgirl',
  // 화면에 표시할 통화 기호
  CURRENCY: '원',
};
