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

/* ==================== 表单弹窗「防误关」工具 ====================
 *
 * 背景：全站弹窗原先统一写着 @click.self="xxx = null"，点到弹窗外面的灰色遮罩就关闭。
 * 这对「详情 / 预览 / 趋势图」这类只读弹窗是合适的，但用在要填一串字段的表单上就是数据丢失 ——
 * 用户填了一半的名称、网址、账号密码会因为一次误点全部消失；IP 管理的「批量登记」更严重，
 * 粘贴一整段地址清单，手一抖点到外面就全没了。
 *
 * 所以拆成两档：
 *   · 只读弹窗（详情 / 预览 / 趋势图）—— 保留「点遮罩关闭」；
 *   · 表单弹窗                         —— 删掉 @click.self，只能点 ✕ / 取消 / 关闭 主动退出，
 *                                        且相对「打开时」有改动的话先确认一次。
 *
 * 接入一个表单弹窗分三步：
 *   1) 模版：删掉 modal-mask 上的 @click.self；把 ✕ 与「取消 / 关闭」的 @click 改成 tryCloseXxx；
 *   2) 打开处（openXxx）：末尾补 this.xxxBase = HisUI.snap(this.xxx, XXX_KEYS);
 *   3) methods 里加：
 *        tryCloseXxx() {
 *          if (this.saving) return;                        // 正在提交就别关
 *          if (HisUI.dirty(this.xxx, this.xxxBase, XXX_KEYS) && !HisUI.confirmDiscard()) return;
 *          this.xxx = null;
 *        }
 *
 * ★ 放在 api.js 是因为它是所有视图脚本里最先加载的那个公共文件 —— 不新增文件，
 *   部署时就少一个出入点（static\** 是纯前端，改完 Ctrl+F5 即生效，不必重启服务）。
 */
const HisUI = {
  /** 把表单里参与比较的字段拼成一个可比较的串；keys 是白名单，派生数据（预览结果等）不要列进来 */
  snap(obj, keys) {
    if (!obj) return '';
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      // ★ undefined 必须与空串区分开：书签编辑态的 password=undefined 表示「不改密码」，
      //   而「清空密码」传的是 ''。两者若都拼成空串，就再也判不出用户到底动过没有。
      if (v === undefined) out.push('\u0000u');
      else if (v === null) out.push('\u0000n');
      else if (typeof v === 'object') out.push(JSON.stringify(v));
      else out.push(String(v));
    }
    return out.join('\u0001');
  },

  /** 相对「打开表单时」有没有改动 */
  dirty(obj, base, keys) {
    if (!obj) return false;
    return HisUI.snap(obj, keys) !== base;
  },

  /** 关掉就丢内容的确认框；用户点了确定才返回 true */
  confirmDiscard() {
    return confirm('这个窗口里还有没保存的内容，关掉就会丢失。\n\n确定要关闭吗？');
  },

  /** 按条件确认：给没有表单对象的弹窗用（如 Excel 导入已选文件但还没导） */
  confirmIf(cond) {
    return !cond || HisUI.confirmDiscard();
  },
};

window.HisUI = HisUI;