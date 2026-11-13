document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  const res = await apiPost('admin_login.php', { username, password });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (!res.success) {
    document.getElementById('loginError').textContent = res.error || 'Login failed';
    return;
  }
  window.location.href = 'admin.html';
});
document.getElementById('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});
