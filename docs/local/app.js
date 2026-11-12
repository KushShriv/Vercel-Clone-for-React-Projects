(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const apiBase = window.location.origin === 'https://kushshriv.github.io' ? 'http://127.0.0.1:4317' : '';
  const connectForm = byId('connect-form');
  const buildForm = byId('build-form');
  const tokenInput = byId('token');
  const repository = byId('repository');
  const revision = byId('revision');
  const confirmation = byId('confirm');
  const buildButton = byId('build-button');
  const cancelButton = byId('cancel');
  const deleteButton = byId('delete');
  const preview = byId('preview');
  let token = '';
  let currentId = null;
  let currentState = null;
  let pollTimer = null;
  const activeStates = new Set(['queued', 'cloning', 'building']);
  const clearPoll = () => { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; };
  const message = (id, value) => { byId(id).textContent = value || ''; };
  function setConnected(connected) {
    byId('connection-state').textContent = connected ? 'Connected' : 'Not connected';
    for (const element of [repository, revision, confirmation, buildButton]) element.disabled = !connected;
  }
  async function api(path, options = {}) {
    const response = await fetch(apiBase + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Request failed (${response.status}).`);
    return result;
  }
  function render(job) {
    currentId = job.id;
    currentState = job.state;
    byId('job-state').textContent = job.state;
    byId('job-id').hidden = false;
    byId('job-id').textContent = `Job ID: ${job.id}`;
    byId('job-description').textContent = job.error || (job.state === 'ready' ? 'The local preview is ready.' : `Repository: ${job.repository || ''}`);
    byId('commit').hidden = !job.commit;
    byId('commit').textContent = job.commit ? `Commit: ${job.commit}` : '';
    byId('logs').hidden = !job.logs;
    byId('logs').textContent = job.logs || '';
    cancelButton.hidden = !activeStates.has(job.state);
    deleteButton.hidden = activeStates.has(job.state);
    preview.hidden = true;
    if (job.state === 'ready' && typeof job.previewUrl === 'string') {
      try {
        const url = new URL(job.previewUrl);
        if (url.origin === 'http://127.0.0.1:4318' && url.pathname.startsWith(`/${job.id}/`)) {
          preview.href = url.href;
          preview.hidden = false;
        }
      } catch { /* Do not navigate to an invalid preview URL. */ }
    }
  }
  async function poll() {
    if (!currentId || !token) return;
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(currentId)}`);
      render(job);
      message('job-message', '');
      if (activeStates.has(job.state)) pollTimer = setTimeout(poll, 2000);
    } catch (error) { message('job-message', `Could not refresh the build: ${error.message}`); }
  }
  connectForm.addEventListener('submit', async event => {
    event.preventDefault();
    clearPoll();
    token = tokenInput.value.trim();
    setConnected(false);
    message('connect-message', 'Connecting…');
    try {
      await api('/api/health');
      tokenInput.value = '';
      setConnected(true);
      message('connect-message', 'Connected. You can start a build.');
      if (currentId && activeStates.has(currentState)) poll();
    } catch (error) {
      token = '';
      message('connect-message', `Connection failed: ${error.message}. Check the token and local service.`);
    }
  });
  buildForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!token || !confirmation.checked) return;
    buildButton.disabled = true;
    message('build-message', 'Starting build…');
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ repository: repository.value.trim(), revision: revision.value.trim() || 'HEAD', confirmed: true }) });
      clearPoll();
      render(job);
      confirmation.checked = false;
      message('build-message', '');
      if (activeStates.has(job.state)) pollTimer = setTimeout(poll, 1000);
    } catch (error) { message('build-message', error.message); }
    finally { buildButton.disabled = !token; }
  });
  cancelButton.addEventListener('click', async () => {
    cancelButton.disabled = true;
    try { await api(`/api/jobs/${encodeURIComponent(currentId)}/cancel`, { method: 'POST' }); clearPoll(); await poll(); }
    catch (error) { message('job-message', error.message); }
    finally { cancelButton.disabled = false; }
  });
  deleteButton.addEventListener('click', async () => {
    deleteButton.disabled = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
      clearPoll(); currentId = null; currentState = null;
      byId('job-state').textContent = 'No build yet';
      byId('job-description').textContent = 'Build status, commit and logs will appear here.';
      byId('job-id').hidden = true; byId('job-id').textContent = '';
      byId('commit').hidden = true; byId('logs').hidden = true; preview.hidden = true; deleteButton.hidden = true;
      message('job-message', 'Build deleted.');
    } catch (error) { message('job-message', error.message); }
    finally { deleteButton.disabled = false; }
  });
})();
