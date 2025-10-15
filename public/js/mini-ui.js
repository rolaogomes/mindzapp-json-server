const API_BASE = 'http://localhost:4321'; // ajusta se precisares

function show(text) {
  const el = document.getElementById('out');
  el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
}

async function apiPost(path, body) {
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'NETWORK_ERROR', message: String(e?.message || e) } };
  }

  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  const data = ct.includes('application/json') && text ? JSON.parse(text) : (text || null);

  return { ok: resp.ok, status: resp.status, statusText: resp.statusText, data };
}

async function register() {
  const email = document.getElementById('regEmail').value.trim();
  const username = document.getElementById('regUser').value.trim();
  const password = document.getElementById('regPass').value;

  const r = await apiPost('/accounts/register', { email, username, password });
  if (!r.ok) {
    const d = r.data || {};
    show(d.error ? `${d.error}: ${d.message || d.details || ''}`.trim() : `HTTP_${r.status} ${r.statusText}`);
    return;
  }
  show({ ok: true, info: 'Conta criada. Verifica o teu email para confirmar a conta.', resp: r.data });
}

async function login() {
  const email = document.getElementById('logEmail').value.trim();
  const password = document.getElementById('logPass').value;

  const r = await apiPost('/accounts/login', { email, password });
  if (!r.ok) {
    const d = r.data || {};
    show(d.error ? `${d.error}: ${d.message || d.details || ''}`.trim() : `HTTP_${r.status} ${r.statusText}`);
    return;
  }
  const { userId, deviceSecret, howToUseHeaders } = r.data || {};
  show({
    ok: true,
    userId,
    deviceSecret,
    headersToUse: howToUseHeaders || { 'x-user-id': userId, 'x-device-secret': deviceSecret },
    curlExample: `curl -H "x-user-id: ${userId}" -H "x-device-secret: ${deviceSecret}" ${API_BASE}/auth/me`
  });
}

async function resetPassword() {
  const email = document.getElementById('resEmail').value.trim();
  const r = await apiPost('/accounts/reset/initiate', { email });
  if (!r.ok) {
    const d = r.data || {};
    show(d.error ? `${d.error}: ${d.message || d.details || ''}`.trim() : `HTTP_${r.status} ${r.statusText}`);
    return;
  }
  show({ ok: true, info: 'Se existir conta, o link de reset foi enviado (em DEV aparece no terminal do servidor).' });
}

function bind() {
  document.getElementById('btnReg')?.addEventListener('click', register);
  document.getElementById('btnLogin')?.addEventListener('click', login);
  document.getElementById('btnReset')?.addEventListener('click', resetPassword);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bind);
} else {
  bind();
}
