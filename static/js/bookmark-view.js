/* 网页书签管理
 *
 * 用户诉求：把「内部系统入口 + 对应账号密码」收进系统，且**密码可以按角色授权是否可见**。
 *
 * 前端这里的两个关键点：
 * 1) 【查看密码】按钮的显隐走 HisPerm.can('bookmarks.secret') —— 注意它与「管理」是**两档**，
 *    持 manage 不代表能看密码（后端同样如此）。只在前端藏起来不算安全边界，
 *    真正的拦截在 GET /bookmarks/:id/secret 上的 requirePerm。
 * 2) 复制走的是 execCommand 兜底：内网是 http://10.x.x.x，
 *    浏览器只在安全上下文（https / localhost）才提供 navigator.clipboard，
 *    直接用它会在内网机器上静默失败（按钮点了没反应）。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  /** 复制文本：优先 Clipboard API，内网 http 下回落到 execCommand */
  function copyText(text) {
    const t = String(text == null ? '' : text);
    if (!t) return Promise.resolve(false);
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(t).then(() => true).catch(() => fallback(t));
    }
    return Promise.resolve(fallback(t));
  }
  function fallback(t) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      // 必须留在文档流里才能选中（display:none / 负 z-index 之外的简化做法：放到视口外）
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  V.BookmarkView = {
    template: `
    <div>
      <div class="page-head">
        <div>
          <h2>网页书签</h2>
          <div class="muted">内部系统的入口与账号集中在这里。密码按角色授权是否可见，查看动作会记入操作日志。</div>
        </div>
        <div class="page-actions">
          <span class="dev-badge muted">共 {{ total }} 条</span>
          <button v-if="canManage" class="btn btn-primary" @click="openForm(null)">新增书签</button>
        </div>
      </div>

      <div class="filter-bar">
        <input class="ipt grow" v-model="kw" placeholder="搜索名称 / 网址 / 账号 / 备注" @keyup.enter="load">
        <select class="ipt" v-model="group" @change="load">
          <option value="">全部分组</option>
          <option v-for="g in groups" :key="g.name" :value="g.name">
            {{ g.name || '未分组' }}（{{ g.cnt }}）
          </option>
        </select>
        <button class="btn btn-outline" @click="load">查询</button>
        <button class="btn btn-outline" @click="reset">重置</button>
        <div class="grow"></div>
        <span v-if="!canSecret" class="dev-badge warn" title="当前角色没有「看密码」权限，可在【系统管理 → 角色权限】里开启">无「看密码」权限</span>
      </div>

      <div class="card card-flush">
        <div class="table-wrap">
          <table class="tbl bm-table">
            <thead>
              <tr>
                <th class="c-name">名称</th>
                <th class="c-url">网址</th>
                <th class="c-group">分组</th>
                <th class="c-user">账号</th>
                <th class="c-pwd">密码</th>
                <th class="c-note">备注</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading"><td colspan="7" class="empty-row">加载中…</td></tr>
              <tr v-else-if="!list.length">
                <td colspan="7" class="empty-row">
                  还没有书签。{{ canManage ? '点右上角「新增书签」录入第一条。' : '请联系管理员录入。' }}
                </td>
              </tr>
              <tr v-for="r in list" :key="r.id">
                <td>
                  <span class="cell-strong">{{ r.name }}</span>
                  <span class="cell-sub">{{ r.creator_name }} · {{ r.updated_at || r.created_at }}</span>
                </td>
                <td>
                  <!-- 展示用户自己写的那串（含没带协议的），点开才用补过协议的地址 -->
                  <span class="bm-url" :title="r.url" @click="open(r)">{{ r.url || '—' }}</span>
                </td>
                <td>
                  <span v-if="r.group_name" class="chip">{{ r.group_name }}</span>
                  <span v-else class="muted">未分组</span>
                </td>
                <td>
                  <span v-if="r.username" class="mono">{{ r.username }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td>
                  <div v-if="shown[r.id]" class="bm-pwd">
                    <span class="val">{{ shown[r.id].password || '（空）' }}</span>
                    <button class="btn btn-sm btn-outline" @click="copy(shown[r.id].password, '密码')">复制</button>
                    <button class="btn btn-sm btn-outline" @click="hide(r.id)">隐藏</button>
                  </div>
                  <div v-else-if="!r.has_password"><span class="muted">未保存</span></div>
                  <div v-else-if="canSecret" class="bm-pwd">
                    <span class="muted">●●●●●●</span>
                    <button class="btn btn-sm btn-outline" :disabled="busy === r.id" @click="reveal(r)">
                      {{ busy === r.id ? '读取中' : '查看密码' }}
                    </button>
                  </div>
                  <span v-else class="muted" title="需要「网页书签 · 看密码」权限">●●●●●● <i class="bm-lock">（无权限）</i></span>
                </td>
                <td><span class="cell-sub">{{ r.note || '—' }}</span></td>
                <td class="ops">
                  <button class="btn btn-sm btn-outline" @click="open(r)">打开</button>
                  <template v-if="canManage">
                    <button class="btn btn-sm btn-outline" @click="openForm(r)">编辑</button>
                    <button class="btn btn-sm btn-outline btn-danger" @click="del(r)">删除</button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint">
          密码经本机主密钥加密后存库（跨机器不可解密，与设备口令同一套机制）。
          列表接口不返回密码，点「查看密码」才单独取一次，并写一条操作日志。
        </div>
      </div>

      <div class="pager" v-if="total > pageSize">
        <button class="btn btn-sm btn-outline" :disabled="page<=1" @click="go(page-1)">上一页</button>
        <span class="muted">第 {{ page }} / {{ pageCount }} 页</span>
        <button class="btn btn-sm btn-outline" :disabled="page>=pageCount" @click="go(page+1)">下一页</button>
      </div>

      <!-- 新增 / 编辑 -->
      <div class="modal-mask" v-if="form" @click.self="form=null">
        <div class="modal" style="width:560px">
          <div class="modal-head">{{ form.id ? '编辑书签' : '新增书签' }}<span class="modal-close" @click="form=null">✕</span></div>
          <div class="modal-body">
            <div class="form-item">
              <label>名称 *</label>
              <input class="ipt" v-model="form.name" placeholder="如：HIS 住院系统">
            </div>
            <div class="form-item">
              <label>网址</label>
              <input class="ipt" v-model="form.url" placeholder="10.1.1.5:8080 或 https://his.local（不带协议时按 http 打开）">
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>分组</label>
                <input class="ipt" v-model="form.group_name" list="bm-groups" placeholder="如：业务系统">
                <datalist id="bm-groups">
                  <option v-for="g in groups" :key="g.name" :value="g.name"></option>
                </datalist>
              </div>
              <div class="form-item">
                <label>账号</label>
                <input class="ipt" v-model="form.username" placeholder="登录用户名">
              </div>
            </div>
            <div class="form-item">
              <label>{{ form.id ? '密码（留空表示不修改）' : '密码' }}</label>
              <input class="ipt" type="text" v-model="form.password" autocomplete="off"
                     :placeholder="form.id ? '不填则保留原密码；填 0 个字符无法清空，需点下方「清空密码」' : '可留空'">
              <button v-if="form.id && form.has_password" class="btn btn-sm btn-outline" style="margin-top:6px"
                      @click="clearPwd">清空密码</button>
            </div>
            <div class="form-item">
              <label>备注</label>
              <textarea rows="3" v-model="form.note" placeholder="仅内网可访问 / 归属科室 等"></textarea>
            </div>
            <div v-if="!canSecret" class="hint warn">
              当前角色没有「看密码」权限。这里填写的密码会正常加密保存，但你在列表里看不到它。
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="form=null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        list: [], groups: [], total: 0, page: 1, pageSize: 50,
        kw: '', group: '', loading: false, saving: false, busy: 0,
        shown: {},   // id → { username, password }；只在本次会话内保留，切页即清
        form: null,
      };
    },

    computed: {
      canManage() { return !!(window.HisPerm && window.HisPerm.can('bookmarks.manage')); },
      // ★ 独立于 manage：能改书签不等于能看别人的密码
      canSecret() { return !!(window.HisPerm && window.HisPerm.can('bookmarks.secret')); },
      pageCount() { return Math.max(1, Math.ceil(this.total / this.pageSize)); },
    },

    mounted() { this.load(); },

    methods: {
      async load() {
        this.loading = true;
        try {
          const q = '?keyword=' + encodeURIComponent(this.kw || '')
            + '&group=' + encodeURIComponent(this.group || '')
            + '&page=' + this.page + '&pageSize=' + this.pageSize;
          const d = await api.get('/bookmarks' + q);
          this.list = (d && d.list) || [];
          this.groups = (d && d.groups) || [];
          this.total = (d && d.total) || 0;
          // 列表重载后已展开的密码全部收回：避免「翻页后旧密码留在屏幕上」
          this.shown = {};
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loading = false;
        }
      },
      go(p) { this.page = Math.min(Math.max(1, p), this.pageCount); this.load(); },
      reset() { this.kw = ''; this.group = ''; this.page = 1; this.load(); },

      open(r) {
        if (!r.open_url) return this.$toast('这条书签没有填网址', 'err');
        window.open(r.open_url, '_blank', 'noopener');
      },

      async reveal(r) {
        this.busy = r.id;
        try {
          const d = await api.get('/bookmarks/' + r.id + '/secret');
          // 用 $set 语义：Vue 3 对新增键是响应式的，直接赋值即可
          this.shown[r.id] = { username: d.username, password: d.password };
          if (d.encrypted === false) {
            this.$toast('这条密码是历史明文（升级前录入的），编辑保存一次就会转为密文', '');
          }
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.busy = 0;
        }
      },
      hide(id) { delete this.shown[id]; },
      async copy(text, label) {
        const ok = await copyText(text);
        this.$toast(ok ? label + '已复制' : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
      },

      openForm(r) {
        this.form = r
          ? {
            id: r.id, name: r.name, url: r.url, group_name: r.group_name,
            username: r.username, note: r.note,
            // ★ 关键：password 留成 undefined，表示「本次不改密码」。
            //   若这里填 ''，提交时会被理解成「清空密码」—— 只改个备注就把密码弄丢了。
            password: undefined, has_password: r.has_password,
          }
          : { id: 0, name: '', url: '', group_name: '', username: '', note: '', password: '', has_password: 0 };
      },
      clearPwd() {
        // 显式清空要走「传空串」，与「不改动（undefined）」区分开
        this.form.password = '';
        this.form.has_password = 0;
        this.$toast('保存后将清空该密码', '');
      },

      async save() {
        const f = this.form;
        if (!f) return;
        if (!String(f.name || '').trim()) return this.$toast('请填写名称', 'err');
        const body = {
          name: f.name, url: f.url, group_name: f.group_name,
          username: f.username, note: f.note,
        };
        if (f.password !== undefined) body.password = f.password;
        this.saving = true;
        try {
          if (f.id) await api.put('/bookmarks/' + f.id, body);
          else await api.post('/bookmarks', body);
          this.$toast('已保存', 'ok');
          this.form = null;
          this.load();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },

      async del(r) {
        if (!confirm('确定删除书签「' + r.name + '」？此操作不可撤销。')) return;
        try {
          await api.del('/bookmarks/' + r.id);
          this.$toast('已删除', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
    },
  };
})();
