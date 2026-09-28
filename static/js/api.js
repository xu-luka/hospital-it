/* API 封装：统一带 JWT，401 自动踢回登录 */
const api = {
  base: '/api',

  get token() { return localStorage.getItem('his_token') || ''; },
  get user() {
    try { return JSON.parse(localStorage.getItem('his_user') || 'null'); }
    catch (e) { return null; }
  },
  setUser(u, t) {
    localStorage.setItem('his_user', JSON.stringify(u || null));
    if (t) localStorage.setItem('his_token', t);
    if (!t) localStorage.removeItem('his_token');
  },

  async request(method, url, body, isForm) {
    const headers = {};
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    let payload;
    if (isForm) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    let res;
    try {
      // 兼容两种写法：'auth/login' 或 '/api/auth/login'
      const full = url.startsWith('/api/') ? url : this.base + url;
      res = await fetch(full, { method, headers, body: payload });
    } catch (e) {
      throw new Error('网络请求失败，请确认服务已启动');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    if (res.status === 401 || (data && data.code === 401)) {
      this.setUser(null, null);
      if (location.hash !== '#/login') location.hash = '#/login';
      throw new Error((data && data.message) || '未登录或登录已过期');
    }
    if (data && data.code === 0 && data.message) {
      // 成功也可能带提示（如上传时"实际为旧版 .doc"的格式纠正说明），
      // 挂在返回对象上，调用方可自行决定是否展示
      if (data.data && typeof data.data === 'object') data.data.__msg = data.message;
    }
    if (!res.ok || !data || data.code !== 0) {
      // 把服务端的逐项校验结果一并带出来，否则前端只能显示笼统的「参数校验未通过」，
      // 用户看不出到底是哪一项填错了
      const err = new Error((data && data.message) || ('请求失败（' + res.status + '）'));
      if (data && Array.isArray(data.errors) && data.errors.length) err.errors = data.errors;
      if (data && data.code) err.code = data.code;
      throw err;
    }
    return data.data;
  },

  get(u) { return this.request('GET', u); },
  post(u, b) { return this.request('POST', u, b); },
  put(u, b) { return this.request('PUT', u, b); },
  del(u) { return this.request('DELETE', u); },
  upload(u, formData) { return this.request('POST', u, formData, true); },

  // 附件下载（带 token 走 blob，兼容 IE/360 兼容模式等老内核）
  async download(url, fileName) {
    const full = url.startsWith('/api/') ? url : this.base + url;
    const res = await fetch(full, { headers: { Authorization: 'Bearer ' + this.token } });
    if (!res.ok) {
      let msg = '下载失败（' + res.status + '）';
      try { const d = await res.json(); if (d && d.message) msg = d.message; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const name = fileName || 'download';

    // 老内核（IE / 360 兼容模式）：用 msSaveBlob 保存
    if (window.navigator && window.navigator.msSaveBlob) {
      window.navigator.msSaveBlob(blob, name);
      return;
    }

    // 标准浏览器：a[download] 触发下载
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  },

  // 图片预览（带 token 拉 blob，返回可渲染的 objectURL）
  async previewUrl(url) {
    const blob = await this.previewBlobRaw(url);
    if (!blob.type.startsWith('image/') && !blob.type.includes('pdf') && !blob.type.startsWith('video/')) {
      throw new Error('该附件不支持预览');
    }
    return URL.createObjectURL(blob);
  },

  // 附件预览 blob（供前端库渲染 Word/Excel）
  async previewBlob(url) {
    return this.previewBlobRaw(url);
  },

  async previewBlobRaw(url) {
    const full = url.startsWith('/api/') ? url : this.base + url;
    const res = await fetch(full, { headers: { Authorization: 'Bearer ' + this.token } });
    if (!res.ok) {
      let msg = '预览失败（' + res.status + '）';
      try { const d = await res.json(); if (d && d.message) msg = d.message; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return res.blob();
  },
};

// 供后续脚本（contract-views.js 等）通过 window.api 访问
window.api = api;