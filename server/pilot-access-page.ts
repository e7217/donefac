import { randomBytes } from 'node:crypto';

const htmlEntities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => htmlEntities[character]);
}

export function renderPilotAccessPage({ authenticated, error, returnFragment = '' }: {
  authenticated: boolean;
  error?: string;
  returnFragment?: string;
}): { html: string; nonce: string } {
  const nonce = randomBytes(18).toString('base64url');
  const content = authenticated ? `
    <p>이 브라우저에서 팀 워크스페이스에 접속 중입니다.</p>
    <a class="primary" href="/">워크스페이스로 돌아가기</a>
    <form action="/pilot-access/logout" method="post">
      <button class="secondary" type="submit">접속 종료</button>
    </form>` : `
    <form action="/pilot-access" method="post">
      <label for="access-code">팀 접속 키</label>
      <input id="access-code" name="accessCode" type="password" required autocomplete="current-password"${error ? ' aria-invalid="true" aria-describedby="access-error"' : ''}>
      <input id="return-fragment" name="returnFragment" type="hidden" value="${escapeHtml(returnFragment)}">
      ${error ? `<p class="error" id="access-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <button class="primary" type="submit">접속</button>
    </form>`;

  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>팀 접속 | Donefac</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: #f5f8f6;
      color: #263338;
      font: 15px/1.6 'Noto Sans KR', system-ui, sans-serif;
    }
    main {
      width: 100%;
      max-width: 400px;
      padding: clamp(22px, 6vw, 36px);
      background: #fff;
      border: 1px solid #dfe6e2;
      border-radius: 12px;
      box-shadow: 0 8px 32px #2633380b;
    }
    .brand { margin-bottom: 6px; color: #177c72; font-weight: 700; }
    h1 { margin: 0 0 24px; font-size: 25px; line-height: 1.3; }
    p { margin: 0 0 16px; }
    form { margin: 0; }
    label { display: block; margin-bottom: 6px; font-weight: 600; }
    input, button { font: inherit; }
    input[type=password] {
      display: block;
      width: 100%;
      min-height: 44px;
      padding: 9px 11px;
      border: 1px solid #a8b6b0;
      border-radius: 6px;
      color: inherit;
      font-size: 16px;
    }
    input[aria-invalid=true] { border-color: #bd4c4c; }
    .error { margin: 9px 0 0; color: #963232; overflow-wrap: anywhere; }
    .primary, .secondary {
      display: grid;
      place-items: center;
      width: 100%;
      min-height: 44px;
      padding: 9px 12px;
      border: 1px solid transparent;
      border-radius: 6px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
    }
    .primary { margin-top: 16px; background: #177c72; color: #fff; }
    .primary:hover { background: #10685f; }
    .secondary { margin-top: 10px; border-color: #dfe6e2; background: #fff; color: #263338; }
    .secondary:hover { background: #f5f8f6; }
    :focus-visible { outline: 2px solid #177c72; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <p class="brand">Donefac</p>
    <h1>팀 접속</h1>${content}
  </main>${authenticated ? '' : `
  <script nonce="${nonce}">
    const fragment = window.location.hash;
    if (fragment.startsWith('#/')) document.getElementById('return-fragment').value = fragment;
  </script>`}
</body>
</html>`;

  return { html, nonce };
}
