/* 테마 전환 — 기본값은 라이트, 선택은 localStorage 에 보존.
   <head> 에서 동기 로드해 첫 페인트 전에 속성을 적용한다(깜빡임 방지). */
(function () {
  var KEY = 'betgirl.theme';
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }

  // 저장된 선택이 없으면 라이트가 기본
  var current = saved() === 'dark' ? 'dark' : 'light';
  apply(current);

  function label(btn) {
    var dark = current === 'dark';
    btn.innerHTML = '<span class="tt-icon">' + (dark ? '☀️' : '🌙') + '</span>' +
                    '<span>' + (dark ? '라이트' : '다크') + '</span>';
    btn.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
    btn.setAttribute('title', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
    btn.setAttribute('aria-pressed', String(dark));
  }

  function mount() {
    var nav = document.querySelector('header.site nav');
    if (!nav || nav.querySelector('.theme-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    label(btn);
    btn.addEventListener('click', function () {
      current = current === 'dark' ? 'light' : 'dark';
      apply(current);
      try { localStorage.setItem(KEY, current); } catch (e) {}
      label(btn);
    });
    nav.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
