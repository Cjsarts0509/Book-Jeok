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
    if (!res.ok) { const e = new Error(data.error || '요청 실패'); e.data = data; e.status = res.status; throw e; }
    return data;
  }

  const own = (ownerId) => (ownerId ? `ownerId=${ownerId}` : '');

  return {
    setToken,
    hasToken: () => !!token,
    getToken: () => token,
    base: BASE,
    // auth
    login: (username, password, token) => req('POST', '/auth/login', { username, password, token }),
    setup2fa: () => req('POST', '/auth/2fa/setup'),
    enable2fa: (token) => req('POST', '/auth/2fa/enable', { token }),
    disable2fa: (password) => req('POST', '/auth/2fa/disable', { password }),
    logout: () => req('POST', '/auth/logout'),
    me: () => req('GET', '/auth/me'),
    changePassword: (currentPassword, newPassword) => req('POST', '/auth/change-password', { currentPassword, newPassword }),
    updateSettings: (data) => req('PATCH', '/auth/settings', data),
    notifications: (limit = 20) => req('GET', `/files/notifications?limit=${limit}`),
    markNotificationsRead: (ids) => req('POST', '/files/notifications/read', ids ? { ids } : {}),
    // files & folders
    listFiles: (folder, ownerId) => req('GET', `/files?folder=${encodeURIComponent(folder)}${ownerId ? '&ownerId=' + ownerId : ''}`),
    tree: (ownerId) => req('GET', `/files/tree${ownerId ? '?ownerId=' + ownerId : ''}`),
    accounts: () => req('GET', '/files/accounts'),
    branches: () => req('GET', '/meta/branches'),
    activeNotices: () => req('GET', '/meta/notices/active'),
    serverStatus: () => req('GET', '/meta/server-status'),
    allowedExtensions: () => req('GET', '/files/allowed-extensions'),
    usage: (ownerId) => req('GET', `/files/usage/summary${ownerId ? '?ownerId=' + ownerId : ''}`),
    upload: (formData, ownerId) => req('POST', `/files/upload${ownerId ? '?ownerId=' + ownerId : ''}`, formData, true),
    rev: (ownerId) => req('GET', `/files/rev${ownerId ? '?ownerId=' + ownerId : ''}`),
    uploadInit: (data, ownerId) => req('POST', `/files/upload/init${ownerId ? '?ownerId=' + ownerId : ''}`, data),
    uploadChunk: (formData) => req('POST', '/files/upload/chunk', formData, true),
    uploadComplete: (data, ownerId) => req('POST', `/files/upload/complete${ownerId ? '?ownerId=' + ownerId : ''}`, data),
    createFolder: (path, ownerId, icon, color) => req('POST', '/files/folders', { path, ownerId, icon, color }),
    deleteFolder: (path, ownerId) => req('DELETE', `/files/folders?path=${encodeURIComponent(path)}${ownerId ? '&ownerId=' + ownerId : ''}`),
    renameFolder: (oldPath, newPath, ownerId) => req('PATCH', '/files/folders', { oldPath, newPath, ownerId }),
    setFolderNote: (path, note, ownerId) => req('PATCH', '/files/folders/note', { path, note, ownerId }),
    setFolderStyle: (path, icon, color, ownerId, cover) => req('PATCH', '/files/folders/style', { path, icon, color, ownerId, ...(cover !== undefined ? { cover } : {}) }),
    deleteFile: (id) => req('DELETE', `/files/${id}`),
    renameFile: (id, name) => req('PATCH', `/files/${id}/rename`, { name }),
    setNote: (id, note) => req('PATCH', `/files/${id}/note`, { note }),
    share: (id, opts) => req('POST', `/files/${id}/share`, opts || {}),
    bulkDelete: (ids) => req('POST', '/files/bulk/delete', { ids }),
    bulkMove: (ids, folder) => req('POST', '/files/bulk/move', { ids, folder }),
    bulkCopy: (ids, folder) => req('POST', '/files/bulk/copy', { ids, folder }),
    bulkZip: (ids, folders, folder, name, ownerId) => req('POST', '/files/bulk/zip', { ids, folders, folder, name, ownerId }),
    bundleShare: (bundleId, opts) => req('POST', `/files/bundle/${bundleId}/share`, opts || {}),
    bundleDownloadUrl: (bundleId) => `${BASE}/api/files/bundle/${bundleId}/download`,
    search: (q, ownerId) => req('GET', `/files/search?q=${encodeURIComponent(q)}${ownerId ? '&ownerId=' + ownerId : ''}`),
    // 고급 검색: params = { q, exts, dateFrom, dateTo, minSize, maxSize, tagId, favOnly, sort }
    searchAdvanced: (params, ownerId) => {
      const qs = new URLSearchParams();
      Object.entries(params || {}).forEach(([k, v]) => { if (v !== '' && v !== undefined && v !== null && v !== false) qs.set(k, v === true ? '1' : v); });
      if (ownerId) qs.set('ownerId', ownerId);
      return req('GET', `/files/search?${qs.toString()}`);
    },
    usageReport: (ownerId) => req('GET', `/files/usage/report${ownerId ? '?ownerId=' + ownerId : ''}`),
    selfTrash: (ownerId) => req('GET', '/files/trash' + (ownerId ? `?ownerId=${ownerId}` : '')),
    restoreSelfFile: (id, ownerId) => req('POST', `/files/trash/file/${id}/restore` + (ownerId ? `?ownerId=${ownerId}` : '')),
    restoreSelfFolder: (id, ownerId) => req('POST', `/files/trash/folder/${id}/restore` + (ownerId ? `?ownerId=${ownerId}` : '')),
    purgeSelfFile: (id, ownerId) => req('DELETE', `/files/trash/file/${id}` + (ownerId ? `?ownerId=${ownerId}` : '')),
    purgeSelfFolder: (id, ownerId) => req('DELETE', `/files/trash/folder/${id}` + (ownerId ? `?ownerId=${ownerId}` : '')),
    emptySelfTrash: (ownerId) => req('POST', '/files/trash/empty' + (ownerId ? `?ownerId=${ownerId}` : '')),
    // 즐겨찾기 / 태그 / QR
    toggleFav: (data) => req('POST', '/files/favorites/toggle', data),
    tags: (ownerId) => req('GET', `/files/tags${ownerId ? '?ownerId=' + ownerId : ''}`),
    createTag: (data) => req('POST', '/files/tags', data),
    updateTag: (id, data) => req('PATCH', `/files/tags/${id}`, data),
    deleteTag: (id, ownerId) => req('DELETE', `/files/tags/${id}${ownerId ? '?ownerId=' + ownerId : ''}`),
    setFileTags: (id, tagIds) => req('PUT', `/files/${id}/tags`, { tagIds }),
    qr: (text) => req('GET', `/files/qr?text=${encodeURIComponent(text)}`),
    createUploadRequest: (data) => req('POST', '/files/upload-requests', data),
    uploadRequests: (ownerId) => req('GET', `/files/upload-requests${ownerId ? '?ownerId=' + ownerId : ''}`),
    deleteUploadRequest: (id, ownerId) => req('DELETE', `/files/upload-requests/${id}${ownerId ? '?ownerId=' + ownerId : ''}`),
    myShares: () => req('GET', '/files/shares'),
    deleteShare: (id) => req('DELETE', `/files/shares/${id}`),
    createFolderShare: (data) => req('POST', '/files/folder-shares', data),
    folderShares: (ownerId) => req('GET', `/files/folder-shares${ownerId ? '?ownerId=' + ownerId : ''}`),
    deleteFolderShare: (id, ownerId) => req('DELETE', `/files/folder-shares/${id}${ownerId ? '?ownerId=' + ownerId : ''}`),
    downloadUrl: (id) => `${BASE}/api/files/${id}/download`,
    pdfUrl: (id) => `${BASE}/api/files/${id}/pdf`,
    // admin
    adminUsers: () => req('GET', '/admin/users'),
    createUser: (data) => req('POST', '/admin/users', data),
    viewPassword: (id) => req('GET', `/admin/users/${id}/password`),
    resetPassword: (id, password) => req('PATCH', `/admin/users/${id}/password`, { password }),
    updateUser: (id, data) => req('PATCH', `/admin/users/${id}`, data),
    deleteUser: (id) => req('DELETE', `/admin/users/${id}`),
    dashboard: () => req('GET', '/admin/dashboard'),
    adminShares: () => req('GET', '/admin/shares'),
    deleteAdminShare: (kind, id) => req('DELETE', `/admin/shares/${kind}/${id}`),
    usageTree: () => req('GET', '/admin/usage/tree'),
    reportPreview: () => req('GET', '/admin/report/preview'),
    reportSend: () => req('POST', '/admin/report/send'),
    dbStatus: () => req('GET', '/admin/db-status'),
    audit: (limit = 50) => req('GET', `/admin/audit?limit=${limit}`),
    // trash
    trash: () => req('GET', '/admin/trash'),
    restoreFile: (id) => req('POST', `/admin/trash/file/${id}/restore`),
    restoreFolder: (id) => req('POST', `/admin/trash/folder/${id}/restore`),
    purgeFile: (id) => req('DELETE', `/admin/trash/file/${id}`),
    purgeFolder: (id) => req('DELETE', `/admin/trash/folder/${id}`),
    // 디스크
    diskInfo: () => req('GET', '/admin/disk-info'),
    // 확장자
    getExtensions: () => req('GET', '/admin/settings/extensions'),
    setExtensions: (extensions) => req('PUT', '/admin/settings/extensions', { extensions }),
    // 일반 설정 (휴지통 보관일수 / 공유 QR)
    getGeneralSettings: () => req('GET', '/admin/settings/general'),
    setGeneralSettings: (data) => req('PUT', '/admin/settings/general', data),
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
