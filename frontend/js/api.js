/* 북적북적 API 클라이언트 */
const API = (() => {
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
    if (isForm) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + '/api' + path, { method, headers, body: payload, credentials: 'include' });
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

  const own = (ownerId) => (ownerId ? `ownerId=${ownerId}` : '');

  return {
    setToken,
    hasToken: () => !!token,
    getToken: () => token,
    base: BASE,
    // auth
    login: (username, password) => req('POST', '/auth/login', { username, password }),
    logout: () => req('POST', '/auth/logout'),
    me: () => req('GET', '/auth/me'),
    changePassword: (currentPassword, newPassword) => req('POST', '/auth/change-password', { currentPassword, newPassword }),
    // files & folders
    listFiles: (folder, ownerId) => req('GET', `/files?folder=${encodeURIComponent(folder)}${ownerId ? '&ownerId=' + ownerId : ''}`),
    tree: (ownerId) => req('GET', `/files/tree${ownerId ? '?ownerId=' + ownerId : ''}`),
    accounts: () => req('GET', '/files/accounts'),
    branches: () => req('GET', '/meta/branches'),
    activeNotices: () => req('GET', '/meta/notices/active'),
    allowedExtensions: () => req('GET', '/files/allowed-extensions'),
    usage: (ownerId) => req('GET', `/files/usage/summary${ownerId ? '?ownerId=' + ownerId : ''}`),
    upload: (formData, ownerId) => req('POST', `/files/upload${ownerId ? '?ownerId=' + ownerId : ''}`, formData, true),
    createFolder: (path, ownerId) => req('POST', '/files/folders', { path, ownerId }),
    deleteFolder: (path, ownerId) => req('DELETE', `/files/folders?path=${encodeURIComponent(path)}${ownerId ? '&ownerId=' + ownerId : ''}`),
    renameFolder: (oldPath, newPath, ownerId) => req('PATCH', '/files/folders', { oldPath, newPath, ownerId }),
    setFolderNote: (path, note, ownerId) => req('PATCH', '/files/folders/note', { path, note, ownerId }),
    deleteFile: (id) => req('DELETE', `/files/${id}`),
    renameFile: (id, name) => req('PATCH', `/files/${id}/rename`, { name }),
    setNote: (id, note) => req('PATCH', `/files/${id}/note`, { note }),
    share: (id, expiresInDays) => req('POST', `/files/${id}/share`, { expiresInDays: expiresInDays || 0 }),
    bulkDelete: (ids) => req('POST', '/files/bulk/delete', { ids }),
    bulkMove: (ids, folder) => req('POST', '/files/bulk/move', { ids, folder }),
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
    // trash
    trash: () => req('GET', '/admin/trash'),
    restoreFile: (id) => req('POST', `/admin/trash/file/${id}/restore`),
    restoreFolder: (id) => req('POST', `/admin/trash/folder/${id}/restore`),
    purgeFile: (id) => req('DELETE', `/admin/trash/file/${id}`),
    purgeFolder: (id) => req('DELETE', `/admin/trash/folder/${id}`),
    // 확장자
    getExtensions: () => req('GET', '/admin/settings/extensions'),
    setExtensions: (extensions) => req('PUT', '/admin/settings/extensions', { extensions }),
    // 영업점
    adminBranches: () => req('GET', '/admin/branches'),
    addBranch: (name) => req('POST', '/admin/branches', { name }),
    editBranch: (id, name) => req('PATCH', `/admin/branches/${id}`, { name }),
    deleteBranch: (id) => req('DELETE', `/admin/branches/${id}`),
    // 공지사항
    adminNotices: () => req('GET', '/admin/notices'),
    addNotice: (data) => req('POST', '/admin/notices', data),
    editNotice: (id, data) => req('PATCH', `/admin/notices/${id}`, data),
    deleteNotice: (id) => req('DELETE', `/admin/notices/${id}`),
  };
})();
