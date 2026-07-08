/* 북적북적 API 클라이언트 */
const API = (() => {
  // 배포 시 window.BOOKJEOK_API 로 백엔드 주소 주입 (CF Pages → 오라클 백엔드)
  const BASE = (window.BOOKJEOK_API || '').replace(/\/$/, '') || '';

  let token = localStorage.getItem('bj_token') || null;

  function setToken(t) {
    token = t;
    if (t) localStorage.setItem('bj_token', t);
    else localStorage.removeItem('bj_token');
  }

  async function req(method, path, body, isForm = false) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    let payload;
    if (isForm) {
      payload = body; // FormData
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + '/api' + path, {
      method,
      headers,
      body: payload,
      credentials: 'include',
    });
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      if (!res.ok) throw new Error('요청 실패 (' + res.status + ')');
      return res;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '요청 실패');
    return data;
  }

  return {
    setToken,
    hasToken: () => !!token,
    base: BASE,
    // auth
    login: (username, password) => req('POST', '/auth/login', { username, password }),
    logout: () => req('POST', '/auth/logout'),
    me: () => req('GET', '/auth/me'),
    changePassword: (currentPassword, newPassword) => req('POST', '/auth/change-password', { currentPassword, newPassword }),
    // files
    listFiles: (folder, ownerId) => req('GET', `/files?folder=${encodeURIComponent(folder)}${ownerId ? '&ownerId=' + ownerId : ''}`),
    usage: (ownerId) => req('GET', `/files/usage/summary${ownerId ? '?ownerId=' + ownerId : ''}`),
    upload: (formData) => req('POST', '/files/upload', formData, true),
    deleteFile: (id) => req('DELETE', `/files/${id}`),
    downloadUrl: (id) => `${BASE}/api/files/${id}/download`,
    // admin
    adminUsers: () => req('GET', '/admin/users'),
    createUser: (data) => req('POST', '/admin/users', data),
    viewPassword: (id) => req('GET', `/admin/users/${id}/password`),
    resetPassword: (id, password) => req('PATCH', `/admin/users/${id}/password`, { password }),
    updateUser: (id, data) => req('PATCH', `/admin/users/${id}`, data),
    deleteUser: (id) => req('DELETE', `/admin/users/${id}`),
    dbStatus: () => req('GET', '/admin/db-status'),
    audit: (limit = 50) => req('GET', `/admin/audit?limit=${limit}`),
  };
})();
