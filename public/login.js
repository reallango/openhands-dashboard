const form = document.getElementById('login');
const error = document.getElementById('error');
form.addEventListener('submit', async e => {
  e.preventDefault();
  error.textContent = '';
  const data = new FormData(form);
  try {
    const r = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: data.get('user'), password: data.get('password') }),
    });
    if (r.ok) { location.href = '/'; return; }
    error.textContent = (await r.json().catch(() => ({}))).error || `Sign-in failed (${r.status})`;
  } catch {
    error.textContent = 'The dashboard is not reachable.';
  }
});
