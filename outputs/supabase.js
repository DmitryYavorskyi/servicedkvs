/* Shared DKVS storage. The publishable key is intended for browser use; RLS is the security boundary. */
(() => {
  const SUPABASE_URL = 'https://yqnbdzkxmigmcpmjpnav.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_oBXCUTjeqkc5hnE_6RL2DQ_zBFdERhU';
  const authStorage = {
    async getItem(key) { return sessionStorage.getItem(key) || localStorage.getItem(key); },
    async setItem(key, value) {
      const remember = document.getElementById('rememberMe');
      if (!remember || remember.checked) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    },
    async removeItem(key) { localStorage.removeItem(key); sessionStorage.removeItem(key); }
  };
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const categories = { prisoners: 'prisoner', blacklist: 'blacklist', cars: 'vehicle', news: 'announcement' };
  const keys = Object.keys(categories);
  let currentAuthUser = null;
  let remoteBusy = false;
  let refreshTimer = null;
  let presenceTimer = null;
  let presenceSessionId = sessionStorage.getItem('dkvsPresenceId');
  if (!presenceSessionId) {
    presenceSessionId = 'tab-' + crypto.randomUUID();
    sessionStorage.setItem('dkvsPresenceId', presenceSessionId);
  }
  window.dkvsOnlineUserIds = new Set();
  let pendingTimer = null;
  let lastPresenceCleanupAt = 0;
  let localBackup = {};
  let lastRemoteIds = new Set();
  const originalSetItem = Storage.prototype.setItem;

  function cleanLocalState(value) {
    try {
      const parsed = JSON.parse(value);
      parsed.users = [];
      parsed.roles = [];
      parsed.user = null;
      return JSON.stringify(parsed);
    } catch { return value; }
  }
  Storage.prototype.setItem = function (key, value) {
    const safeValue = key === 'dkvs' ? cleanLocalState(value) : value;
    const result = originalSetItem.call(this, key, safeValue);
    if (key === 'dkvs' && currentAuthUser) queueRemoteSave();
    return result;
  };

  function usernameEmail(name, uniqueSeed = '') {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.trim().toLocaleLowerCase('uk-UA') + '|' + uniqueSeed))
      .then(buf => 'u' + Array.from(new Uint8Array(buf)).slice(0, 30).map(x => x.toString(16).padStart(2, '0')).join('') + '@dkvs-login.example.com');
  }
  function errorText(error) {
    const message = error && error.message ? error.message : String(error || 'невідома помилка');
    if (/confirm|email/i.test(message)) return 'Вимкніть підтвердження email у Supabase Auth → Providers → Email. Вхід у цьому сайті використовує ім’я замість email.';
    return 'Помилка Supabase: ' + message;
  }
  function rowPayload(item) {
    const payload = { ...item };
    delete payload._remoteId;
    return payload;
  }
  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function adoptRows(rows) {
    const arrays = { prisoners: [], blacklist: [], cars: [], news: [] };
    lastRemoteIds = new Set();
    (rows || []).forEach(row => {
      const collection = Object.keys(categories).find(k => categories[k] === row.category);
      if (!collection) return;
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      payload._remoteId = row.id;
      arrays[collection].push(payload);
      lastRemoteIds.add(row.id);
    });
    keys.forEach(k => { d[k] = arrays[k]; });
  }
  async function loadProfiles() {
    const { data, error } = await client.from('dkvs_profiles').select('user_id,login_name,display_name,player_id,role,active').order('display_name');
    if (error) throw error;
    d.users = (data || []).filter(x => x.active).map(x => ({ userId: x.user_id, loginName: x.login_name, name: x.display_name, playerId: x.player_id || '', role: x.role }));
    d.roles = d.users.map(x => ({ name: x.name, role: x.role }));
    const mine = (data || []).find(x => x.user_id === currentAuthUser.id && x.active);
    if (!mine) throw new Error('Обліковий запис вимкнений або профіль не створений. Зверніться до власника.');
    d.user = { userId: mine.user_id, loginName: mine.login_name, name: mine.display_name, playerId: mine.player_id || '', role: mine.role };
  }
  async function pullRecords() {
    const { data, error } = await client.from('dkvs_records').select('id,category,payload').order('created_at', { ascending: false });
    if (error) throw error;
    adoptRows(data || []);
  }
  async function sendPresenceHeartbeat() {
    if (!currentAuthUser || !d.user) return;
    const { error } = await client.from('dkvs_presence').upsert({
      user_id: currentAuthUser.id,
      session_id: presenceSessionId,
      display_name: d.user.name,
      last_seen: new Date().toISOString()
    }, { onConflict: 'user_id,session_id' });
    if (error) console.warn('DKVS presence heartbeat failed:', error.message);
  }
  async function refreshOnlinePresence() {
    if (!currentAuthUser) return;
    const cutoff = new Date(Date.now() - 45000).toISOString();
    const { data, error } = await client.from('dkvs_presence').select('user_id,last_seen').gte('last_seen', cutoff);
    if (error) return;
    if (Date.now() - lastPresenceCleanupAt > 60000) {
      lastPresenceCleanupAt = Date.now();
      client.from('dkvs_presence').delete().lt('last_seen', new Date(Date.now() - 5 * 60 * 1000).toISOString())
        .then(({ error: cleanupError }) => { if (cleanupError) console.warn('DKVS presence cleanup failed:', cleanupError.message); })
        .catch(() => {});
    }
    const online = new Set((data || []).map(row => row.user_id));
    const previous = window.dkvsOnlineUserIds;
    const changed = online.size !== previous.size || [...online].some(id => !previous.has(id));
    window.dkvsOnlineUserIds = online;
    if (typeof refreshOnline === 'function') refreshOnline();
    if (changed && typeof renderStaff === 'function') renderStaff();
  }
  async function removeOwnPresence() {
    if (!currentAuthUser) return;
    await client.from('dkvs_presence').delete()
      .eq('user_id', currentAuthUser.id).eq('session_id', presenceSessionId);
  }
  async function refreshSharedData(showErrors) {
    if (!currentAuthUser || remoteBusy) return;
    remoteBusy = true;
    try {
      await Promise.all([loadProfiles(), pullRecords()]);
      render();
    } catch (error) {
      if (showErrors) msg(errorText(error));
    } finally { remoteBusy = false; }
  }
  async function syncRecords() {
    if (!currentAuthUser) return;
    const { data: remoteRows, error: readError } = await client.from('dkvs_records').select('id,category,payload');
    if (readError) throw readError;
    const byId = new Map((remoteRows || []).map(row => [row.id, row]));
    const seen = new Set();
    for (const collection of keys) {
      const category = categories[collection];
      for (const item of (d[collection] || [])) {
        const payload = rowPayload(item);
        if (item._remoteId && byId.has(item._remoteId)) {
          seen.add(item._remoteId);
          const existing = byId.get(item._remoteId);
          if (stableStringify(existing.payload) !== stableStringify(payload)) {
            const { error } = await client.from('dkvs_records').update({ payload, updated_at: new Date().toISOString() }).eq('id', item._remoteId);
            if (error) throw error;
          }
        } else {
          const { data, error } = await client.from('dkvs_records').insert({ category, payload, created_by: currentAuthUser.id }).select('id').single();
          if (error) throw error;
          item._remoteId = data.id;
          seen.add(data.id);
        }
      }
    }
    for (const row of (remoteRows || [])) {
      if (!seen.has(row.id)) {
        const { error } = await client.from('dkvs_records').delete().eq('id', row.id);
        if (error) throw error;
      }
    }
    lastRemoteIds = new Set(seen);
  }
  function queueRemoteSave() {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(async () => {
      if (!currentAuthUser || remoteBusy) return;
      remoteBusy = true;
      try { await syncRecords(); }
      catch (error) { msg(errorText(error)); }
      finally { remoteBusy = false; }
    }, 450);
  }
  async function startSession(authUser, importLocal) {
    currentAuthUser = authUser;
    try {
      await loadProfiles();
      const { data: rows, error } = await client.from('dkvs_records').select('id,category,payload').order('created_at', { ascending: false });
      if (error) throw error;
      if ((!rows || rows.length === 0) && importLocal) {
        keys.forEach(k => { d[k] = Array.isArray(localBackup[k]) ? localBackup[k] : []; });
        if (!['Власник сайту','Лідер','Заступник'].includes(d.user.role)) d.news = [];
        lastRemoteIds = new Set();
        await syncRecords();
      } else adoptRows(rows || []);
      localStorage.setItem('dkvs', JSON.stringify(d));
      render();
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => refreshSharedData(false), 15000);
      if (presenceTimer) clearInterval(presenceTimer);
      await sendPresenceHeartbeat();
      await refreshOnlinePresence();
      presenceTimer = setInterval(() => {
        sendPresenceHeartbeat();
        refreshOnlinePresence();
      }, 15000);
    } catch (error) {
      await client.auth.signOut();
      currentAuthUser = null;
      d.user = null;
      render();
      msg(errorText(error));
    }
  }
  async function submitAuth() {
    const name = uname.value.trim();
    const pass = pw.value;
    const playerId = document.getElementById('playerId').value.trim();
    if (!name || !pass) return msg('Введіть ім’я користувача та пароль');
    try {
      if (reg) {
        if (!playerId) return msg('Вкажіть ID гравця');
        const { data: existing, error: lookupError } = await client.rpc('dkvs_lookup_login', { requested_login: name });
        if (lookupError) throw lookupError;
        if (existing) return msg('Акаунт із таким ім’ям уже зареєстрований. Увійдіть або зверніться до власника.');
        const email = await usernameEmail(name, crypto.getRandomValues(new Uint32Array(4)).join('-') + Date.now());
        const { data, error } = await client.auth.signUp({
          email, password: pass,
          options: { data: { login_name: name.toLocaleLowerCase('uk-UA'), display_name: name, player_id: playerId } }
        });
        if (error) throw error;
        if (!data.session) return msg('Акаунт створено. Вимкніть підтвердження email у Supabase Auth, тоді можна буде увійти за ім’ям і паролем.');
        hide('auth');
        await startSession(data.session.user, true);
      } else {
        const { data: email, error: lookupError } = await client.rpc('dkvs_lookup_login', { requested_login: name });
        if (lookupError) throw lookupError;
        if (!email) return msg('Активний акаунт із таким ім’ям не знайдено. Зареєструйтеся знову або зверніться до власника.');
        const { data, error } = await client.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        hide('auth');
        await startSession(data.user, false);
      }
    } catch (error) { msg(errorText(error)); }
  }
  submit.onclick = submitAuth;

  const oldToggle = toggle.onclick;
  toggle.onclick = event => {
    oldToggle(event);
    if (reg) document.querySelector('#auth .box>p').textContent = 'Ім’я та пароль для входу. Email вводити не потрібно.';
    else document.querySelector('#auth .box>p').textContent = 'Службовий обліковий запис';
  };

  const originalRender = render;
  render = function () {
    originalRender();
    const identityText = d.user ? `${E(d.user.name)} · ${E(d.user.role)}` : 'Гість · не авторизовано';
    identity.innerHTML = d.user ? `${identityText}<br><button class="btn" onclick="portalSignOut()">Вийти</button>` : identityText;
    login.textContent = d.user ? 'Мій профіль' : 'Увійти';
    login.style.display = d.user ? 'none' : '';
    const roleAccess = d.user && ['Власник сайту','Лідер'].includes(d.user.role);
    document.querySelector('.nav button[data-p="roles"]').style.display = roleAccess ? 'flex' : 'none';
    const owner = d.user && d.user.role === 'Власник сайту';
    Array.from(rsel.options).forEach(option => { option.hidden = !owner && option.value !== 'Заступник'; });
    if (!owner && d.user && d.user.role === 'Лідер') rsel.value = 'Заступник';
    newNews.style.display = d.user && ['Власник сайту','Лідер','Заступник'].includes(d.user.role) ? '' : 'none';
  };
  window.portalSignOut = async () => {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null;
    await removeOwnPresence();
    await client.auth.signOut();
    currentAuthUser = null;
    if (refreshTimer) clearInterval(refreshTimer);
    d.user = null;
    d.users = [];
    d.roles = [];
    window.dkvsOnlineUserIds = new Set();
    render();
  };
  window.addEventListener('focus', () => {
    sendPresenceHeartbeat();
    refreshOnlinePresence();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendPresenceHeartbeat();
      refreshOnlinePresence();
    }
  });

  window.assign = async function () {
    if (!d.user || !['Власник сайту','Лідер'].includes(d.user.role)) return msg('Недостатньо прав для призначення ролей');
    if (d.user.role === 'Лідер' && rsel.value !== 'Заступник') return msg('Лідер може призначити лише роль заступника');
    const target = d.users.find(x => x.name.toLocaleLowerCase('uk-UA') === rname.value.trim().toLocaleLowerCase('uk-UA') || x.loginName === rname.value.trim().toLocaleLowerCase('uk-UA') || String(x.playerId || '') === rname.value.trim());
    if (!target) return msg('Працівника не знайдено');
    const { error } = await client.rpc('dkvs_assign_role', { target_user: target.userId, new_role: rsel.value });
    if (error) return msg(errorText(error));
    await refreshSharedData(false);
    msg('Роль призначено');
  };
  window.saveUserEdit = async function () {
    if (!d.user || d.user.role !== 'Власник сайту') return msg('Недостатньо прав');
    const target = d.users[editUserIndex];
    if (!target) return;
    const name = document.getElementById('editName').value.trim();
    const playerId = document.getElementById('editPlayerId').value.trim();
    if (!name) return msg('Вкажіть ім’я та прізвище');
    const { error } = await client.from('dkvs_profiles').update({ display_name: name, player_id: playerId }).eq('user_id', target.userId);
    if (error) return msg(errorText(error));
    hide('um');
    await refreshSharedData(false);
    msg('Профіль оновлено. Ім’я для входу не змінюється.');
  };
  window.deleteUser = async function (index) {
    if (!d.user || d.user.role !== 'Власник сайту') return msg('Видаляти акаунти може лише власник');
    const target = d.users[index];
    if (!target) return;
    if (target.role === 'Власник сайту' && d.users.filter(x => x.role === 'Власник сайту').length <= 1) return msg('Не можна вимкнути останній акаунт власника');
    if (!confirm('Вимкнути акаунт ' + target.name + '?')) return;
    const { error } = await client.from('dkvs_profiles').update({ active: false }).eq('user_id', target.userId);
    if (error) return msg(errorText(error));
    await refreshSharedData(false);
    msg('Акаунт вимкнено');
  };

  window.putEvidenceVideo = async function (id, file) {
    const { error } = await client.storage.from('dkvs-evidence').upload(id, file, { contentType: file.type });
    if (error) throw error;
  };
  window.getEvidenceVideo = async function (id) {
    const { data, error } = await client.storage.from('dkvs-evidence').download(id);
    if (error) throw error;
    return data;
  };
  window.removeEvidenceVideo = async function (id) {
    const { error } = await client.storage.from('dkvs-evidence').remove([id]);
    if (error) throw error;
  };
  window.viewCarPassport = function (index) {
    const documentFile = d.cars[index] && d.cars[index].passport;
    if (!documentFile || !documentFile.data) return msg('Техпаспорт не прикріплено');
    if (documentFile.type === 'application/pdf' && documentFile.data.startsWith('data:application/pdf;base64,')) {
      try {
        const binary = atob(documentFile.data.split(',')[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const tab = window.open(url, '_blank', 'noopener');
        if (!tab) msg('Дозвольте спливаючі вікна, щоб відкрити PDF');
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      } catch { msg('Не вдалося відкрити PDF'); }
      return;
    }
    if (/^image\/(jpeg|png|webp)$/.test(documentFile.type || '') && /^data:image\/(jpeg|png|webp);base64,/.test(documentFile.data)) {
      showPhoto(documentFile.data, 'Техпаспорт · ' + (d.cars[index].plate || 'транспорт'));
      return;
    }
    msg('Формат техпаспорта не підтримується');
  };

  (async function init() {
    try { localBackup = JSON.parse(localStorage.getItem('dkvs') || '{}'); } catch { localBackup = {}; }
    d.user = null;
    d.users = [];
    d.roles = [];
    localStorage.setItem('dkvs', JSON.stringify(d));
    render();
    const { data, error } = await client.auth.getSession();
    if (error) { msg(errorText(error)); return; }
    if (data.session) await startSession(data.session.user, false);
  })();
})();
