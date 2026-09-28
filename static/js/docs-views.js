/* 技术文档库视图（挂载到 window.HisViews.DocsView）
 * 功能：可自定义文档类型（CRUD）、上传 Word/PDF、在线预览、下载、删除、按类型/关键词检索。 */
(function () {
  const api = window.api;
  const fmtDate = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '');
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };
  const ALLOWED = '.docx,.doc,.pdf';

  const V = {};
  V.DocsView = {
    template: `
    <div>
      <div class="page-title">技术文档库</div>
      <div class="page-sub">信息科技术文档集中管理 · 支持 Word(.docx/.doc) / PDF 在线预览 · 类型可自定义</div>

      <!-- 工具条 -->
      <div class="filter-bar">
        <input class="grow" v-model="f.kw" placeholder="搜索标题 / 文件名 / 标签 / 备注" @keyup.enter="goPage(1)">
        <button class="btn btn-primary" @click="goPage(1)">查 询</button>
        <button class="btn btn-outline" @click="openCats">管理类型</button>
        <button class="btn btn-primary" @click="openUpload">＋ 上传文档</button>
      </div>

      <!-- 类型筛选 -->
      <div class="cat-bar">
        <button class="cat-btn" :class="{active: f.category_id===''}" @click="setCat('')">全部 <span class="cat-cnt">{{ total }}</span></button>
        <button class="cat-btn" v-for="c in categories" :key="c.id" :class="{active: String(f.category_id)===String(c.id)}" @click="setCat(c.id)">
          {{ c.name }} <span class="cat-cnt">{{ c.doc_count }}</span>
        </button>
        <button class="cat-btn" :class="{active: f.category_id==='none'}" @click="setCat('none')">未分类 <span class="cat-cnt">{{ uncategorized }}</span></button>
      </div>

      <!-- 文档网格 -->
      <div class="doc-grid" v-if="list.length">
        <div class="doc-card" v-for="d in list" :key="d.id">
          <div class="doc-ico" :class="d.ext">{{ d.ext==='pdf' ? '📄' : '📝' }}</div>
          <div class="doc-main">
            <div class="doc-title" :title="d.title" @click="preview(d)">{{ d.title }}</div>
            <div class="doc-meta">
              <span class="doc-tag" v-if="d.category_name">{{ d.category_name }}</span>
              <span class="doc-tag ghost" v-else>未分类</span>
              <span class="doc-ext">{{ (d.ext||'').toUpperCase() }}</span>
              <span v-if="d.tags" class="doc-tags" :title="d.tags">#{{ d.tags }}</span>
            </div>
            <div class="doc-sub">{{ d.uploader_name }} · {{ fmtDate(d.created_at) }} · {{ fmtSize(d.size) }}</div>
          </div>
          <div class="doc-acts">
            <button class="btn btn-primary btn-sm" @click="preview(d)">预览</button>
            <button class="btn btn-outline btn-sm" @click="download(d)">下载</button>
            <button class="btn btn-ghost btn-sm" @click="openPage(d)" title="在新标签页打开独立预览页">新页</button>
            <button class="btn btn-danger btn-sm" @click="removeDoc(d)">删除</button>
          </div>
        </div>
      </div>
      <div class="file-empty" v-else style="padding:48px 0">暂无文档，点击右上角「上传文档」开始建立技术资料库</div>

      <!-- 分页 -->
      <div class="pager" v-if="total > pageSize">
        <span class="btn-info">第 {{ page }} / {{ pageCount }} 页，共 {{ total }} 篇</span>
        <button :disabled="page<=1" @click="goPage(page-1)">上一页</button>
        <button v-for="p in pages" :key="p" :class="{active:p===page}" @click="goPage(p)">{{ p }}</button>
        <button :disabled="page>=pageCount" @click="goPage(page+1)">下一页</button>
      </div>

      <!-- 上传弹窗 -->
      <div class="modal-mask" v-if="uploadOpen" @click.self="uploadOpen=false">
        <div class="modal" style="width:560px">
          <div class="modal-head">上传技术文档 <span class="x" @click="uploadOpen=false">✕</span></div>
          <div class="modal-body">
            <div class="form-item"><label>选择文件 *（Word .docx / .doc、PDF）</label>
              <input type="file" :accept="allowed" @change="onFile" style="font-size:13px">
              <div v-if="pendFile" class="up-hint">已选：{{ pendFile.name }}（{{ fmtSize(pendFile.size) }}）</div>
            </div>
            <div class="form-item"><label>文档标题</label>
              <input v-model="form.title" placeholder="留空则使用文件名">
            </div>
            <div class="form-row">
              <div class="form-item"><label>文档类型</label>
                <select v-model="form.category_id" @change="onCatChange">
                  <option value="">未分类</option>
                  <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
                  <option value="__add__">+ 新增类型…</option>
                </select>
              </div>
              <div class="form-item"><label>标签（逗号分隔）</label>
                <input v-model="form.tags" placeholder="如：HIS,网络,2024">
              </div>
            </div>
            <div class="form-item"><label>备注</label>
              <textarea v-model="form.remark" placeholder="可选，记录文档用途/版本等信息" style="min-height:64px"></textarea>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="uploadOpen=false">取消</button>
            <button class="btn btn-primary" :disabled="!pendFile || saving" @click="submitUpload">{{ saving ? '上传中…' : '上传' }}</button>
          </div>
        </div>
      </div>

      <!-- 类型管理弹窗 -->
      <div class="modal-mask" v-if="catsOpen" @click.self="catsOpen=false">
        <div class="modal" style="width:480px">
          <div class="modal-head">文档类型管理 <span class="x" @click="catsOpen=false">✕</span></div>
          <div class="modal-body">
            <div class="cat-mgr-add">
              <input v-model="newCat" placeholder="输入新类型名称（如：应急预案）" @keyup.enter="addCat" style="flex:1">
              <button class="btn btn-primary btn-sm" :disabled="!newCat.trim()" @click="addCat">添加</button>
            </div>
            <div class="cat-mgr-list">
              <div class="cat-mgr-row" v-for="c in categories" :key="c.id">
                <template v-if="editingId!==c.id">
                  <span class="cm-name">{{ c.name }} <span class="muted">（{{ c.doc_count }} 篇）</span></span>
                  <span class="cm-acts">
                    <button class="btn btn-outline btn-sm" @click="startEdit(c)">重命名</button>
                    <button class="btn btn-danger btn-sm" @click="delCat(c)">删除</button>
                  </span>
                </template>
                <template v-else>
                  <input v-model="editName" class="cm-edit" @keyup.enter="saveEdit(c)" @keyup.esc="editingId=0">
                  <span class="cm-acts">
                    <button class="btn btn-primary btn-sm" @click="saveEdit(c)">保存</button>
                    <button class="btn btn-ghost btn-sm" @click="editingId=0">取消</button>
                  </span>
                </template>
              </div>
              <div v-if="!categories.length" class="file-empty">暂无自定义类型</div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="catsOpen=false">关闭</button>
          </div>
        </div>
      </div>

      <!-- 在线预览（全屏） -->
      <div class="modal-mask" v-if="viewer.open" @click.self="closeViewer">
        <div class="doc-viewer">
          <div class="docv-head">
            <div class="docv-name" :title="viewer.doc && viewer.doc.title">{{ viewer.doc && viewer.doc.title }}</div>
            <div class="docv-tools">
              <button class="lb-btn" @click="openPage(viewer.doc)" title="在新标签页打开">⧉ 独立页面</button>
              <button class="lb-btn" @click="download(viewer.doc)" title="下载">⭳ 下载</button>
              <button class="lb-btn lb-close" @click="closeViewer" title="关闭">✕ 关闭</button>
            </div>
          </div>
          <div class="docv-body loading" v-if="viewer.loading">文档加载中…</div>
          <div class="docv-body" v-else>
            <div v-if="viewer.error" class="lb-unsupported">{{ viewer.error }}</div>
            <iframe v-else-if="viewer.kind==='pdf'" :src="viewer.url" class="docv-iframe"></iframe>
            <div v-else-if="viewer.kind==='docx'" class="docv-docx"><div ref="docxBox" class="docv-docx-box"></div></div>
            <div v-else-if="viewer.kind==='doc'" class="docv-text">
              <div class="doct-tip">📄 {{ viewer.notice || '文本模式预览' }}</div>
              <div class="doct-body" v-html="viewer.textHtml"></div>
            </div>
            <div v-else class="lb-unsupported">该类型暂不支持预览</div>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        allowed: ALLOWED,
        categories: [],
        uncategorized: 0,
        total: 0,
        list: [],
        page: 1,
        pageSize: 12,
        f: { kw: '', category_id: '' },
        // 上传
        uploadOpen: false,
        pendFile: null,
        saving: false,
        form: { title: '', category_id: '', tags: '', remark: '' },
        // 类型管理
        catsOpen: false,
        newCat: '',
        editingId: 0,
        editName: '',
        // 预览（textHtml/notice 用于旧版 .doc 的文本模式）
        viewer: { open: false, doc: null, kind: '', url: '', loading: false, error: '', textHtml: '', notice: '' },
      };
    },

    computed: {
      pageCount() { return Math.max(1, Math.ceil(this.total / this.pageSize)); },
      pages() {
        const pc = this.pageCount, p = this.page, arr = [];
        for (let i = Math.max(1, p - 2); i <= Math.min(pc, p + 2); i++) arr.push(i);
        return arr;
      },
    },

    methods: {
      fmtDate, fmtSize,
      async loadCats() {
        try {
          const d = await api.get('/docs/categories');
          this.categories = d.categories || [];
          this.uncategorized = d.uncategorized || 0;
          this.total = d.total || 0;
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async loadDocs() {
        try {
          const q = new URLSearchParams({ page: this.page, pageSize: this.pageSize });
          if (this.f.kw) q.set('keyword', this.f.kw);
          if (this.f.category_id) q.set('category_id', this.f.category_id);
          const d = await api.get('/docs?' + q.toString());
          this.list = d.list || [];
          this.total = d.total || 0;
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      goPage(p) {
        if (p < 1 || p > this.pageCount) return;
        this.page = p; this.loadDocs();
      },
      setCat(c) { this.f.category_id = (c === '' || c === 'none') ? c : String(c); this.page = 1; this.loadDocs(); },

      // ---- 上传 ----
      openUpload() {
        this.form = { title: '', category_id: '', tags: '', remark: '' };
        this.pendFile = null; this.saving = false;
        this.uploadOpen = true;
      },
      onFile(ev) { this.pendFile = ev.target.files[0] || null; if (this.pendFile && !this.form.title) this.form.title = this.pendFile.name.replace(/\.[^.]+$/, ''); ev.target.value = ''; },
      onCatChange() {
        if (this.form.category_id === '__add__') {
          const name = prompt('请输入新类型名称（不超过30字）：');
          const v = name ? name.trim().slice(0, 30) : '';
          if (v) {
            api.post('/docs/categories', { name: v }).then((r) => {
              this.loadCats();
              this.form.category_id = String(r.id);
              this.$toast('已新增类型', 'ok');
            }).catch((e) => { this.$toast(e.message, 'err'); this.form.category_id = ''; });
          } else this.form.category_id = '';
        }
      },
      async submitUpload() {
        if (!this.pendFile) return this.$toast('请先选择文件', 'err');
        this.saving = true;
        try {
          const fd = new FormData();
          fd.append('file', this.pendFile);
          fd.append('title', this.form.title);
          if (this.form.category_id) fd.append('category_id', this.form.category_id);
          fd.append('tags', this.form.tags);
          fd.append('remark', this.form.remark);
          const r = await api.upload('/docs', fd);
          // 服务端可能纠正了格式（如 .docx 实为旧版 .doc）或提示文本模式预览
          this.$toast(r && r.__msg ? ('上传成功：' + r.__msg) : '上传成功', 'ok');
          this.uploadOpen = false;
          this.loadCats(); this.page = 1; this.loadDocs();
        } catch (e) { this.$toast(e.message, 'err'); }
        finally { this.saving = false; }
      },

      // ---- 类型管理 ----
      openCats() { this.newCat = ''; this.editingId = 0; this.catsOpen = true; },
      async addCat() {
        const name = this.newCat.trim().slice(0, 30);
        if (!name) return;
        try {
          await api.post('/docs/categories', { name });
          this.newCat = '';
          this.loadCats();
          this.$toast('已添加', 'ok');
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      startEdit(c) { this.editingId = c.id; this.editName = c.name; },
      async saveEdit(c) {
        const name = this.editName.trim().slice(0, 30);
        if (!name) return;
        try {
          await api.put('/docs/categories/' + c.id, { name });
          this.editingId = 0; this.loadCats(); this.loadDocs();
          this.$toast('已重命名', 'ok');
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async delCat(c) {
        if (!confirm('确认删除类型「' + c.name + '」？\n（该类型下仍有 ' + c.doc_count + ' 篇文档时不可删除，请先移走）')) return;
        try {
          await api.del('/docs/categories/' + c.id);
          this.loadCats(); this.loadDocs();
          this.$toast('已删除', 'ok');
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      // ---- 预览 / 下载 / 删除 ----
      async fetchPreviewBlob(id) {
        const r = await fetch('/api/docs/' + id + '/preview', { headers: { Authorization: 'Bearer ' + api.token } });
        if (!r.ok) {
          let m = '预览失败（' + r.status + '）';
          try { const j = await r.json(); if (j && j.message) m = j.message; } catch (e) {}
          throw new Error(m);
        }
        return r.blob();
      },
      async preview(doc) {
        this.viewer = { open: true, doc, kind: doc.preview_kind, url: '', loading: true, error: '', textHtml: '', notice: '' };
        try {
          if (doc.preview_kind === 'doc') {
            // 旧版 .doc：服务端提取正文，文本模式渲染（内容可读，排版不保留）
            const t = await api.get('/docs/' + doc.id + '/text');
            this.viewer.textHtml = t.html || '<p>（未能提取到文字内容）</p>';
            this.viewer.notice = t.notice || '';
          } else if (doc.preview_kind === 'pdf') {
            const blob = await this.fetchPreviewBlob(doc.id);
            this.viewer.url = URL.createObjectURL(blob);
          } else if (doc.preview_kind === 'docx') {
            const blob = await this.fetchPreviewBlob(doc.id);
            // 关键：先关 loading 让 ref="docxBox" 容器挂载，再渲染。
            // 否则容器还在 v-if 之外，$refs.docxBox 为 undefined，renderAsync 永远不执行，
            // 表现就是「弹窗打开但整页空白」。PDF 无此问题（iframe 只绑 URL 不取 ref）。
            this.viewer.loading = false;
            await this.$nextTick();
            const box = this.$refs.docxBox;
            if (!box) throw new Error('渲染容器未就绪');
            box.innerHTML = '';
            if (!window.docx) throw new Error('预览组件未加载，请刷新页面重试');
            await window.docx.renderAsync(blob, box, null, { inWrapper: true, ignoreWidth: false });
            if (!box.childElementCount) {
              throw new Error('文档渲染为空：可能是不兼容的 Word 格式（如 .doc 直接改名为 .docx），请下载后用 Word/WPS 打开');
            }
          } else {
            throw new Error('该类型暂不支持预览');
          }
        } catch (e) {
          this.viewer.error = e.message;
          this.$toast(e.message, 'err');
        }
        finally { this.viewer.loading = false; }
      },
      closeViewer() {
        if (this.viewer.url) { URL.revokeObjectURL(this.viewer.url); }
        this.viewer = { open: false, doc: null, kind: '', url: '', loading: false, error: '', textHtml: '', notice: '' };
      },
      download(doc) {
        if (!doc) return;
        api.download('/docs/' + doc.id + '/download', doc.original_name).catch((e) => this.$toast(e.message, 'err'));
      },
      // 新标签页打开独立预览页（#/doc/:id，可分享的直达链接）
      openPage(doc) {
        if (!doc) return;
        window.open('#/doc/' + doc.id, '_blank');
      },
      async removeDoc(doc) {
        if (!confirm('确认删除文档「' + doc.title + '」？此操作不可恢复')) return;
        try {
          await api.del('/docs/' + doc.id);
          this.$toast('已删除', 'ok');
          this.loadCats(); this.loadDocs();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
    },

    mounted() { this.loadCats(); this.loadDocs(); },
  };

  /* 独立预览页 #/doc/:id —— 可直接分享链接，在新标签打开后无需再进列表 */
  V.DocPageView = {
    template: `
    <div class="doc-page">
      <div class="docp-head">
        <button class="btn btn-outline btn-sm" @click="back">← 返回文档库</button>
        <div class="docp-title" :title="doc && doc.title">{{ doc && doc.title }}</div>
        <div class="docp-acts">
          <span class="muted" v-if="doc">{{ doc.category_name || '未分类' }} · {{ fmtSize(doc.size) }} · {{ doc.uploader_name }} · {{ fmtDate(doc.created_at) }}</span>
          <button class="btn btn-outline btn-sm" @click="download">下载</button>
        </div>
      </div>
      <div class="docp-body">
        <div v-if="loading" class="docp-loading">文档加载中…</div>
        <div v-else-if="errMsg" class="docp-err">{{ errMsg }}</div>
        <iframe v-else-if="kind==='pdf'" :src="url" class="docp-iframe"></iframe>
        <div v-else-if="kind==='docx'" class="docp-docx"><div ref="docxBox" class="docp-docx-box"></div></div>
        <div v-else-if="kind==='doc'" class="docp-text">
          <div class="doct-tip">📄 {{ notice || '文本模式预览' }}</div>
          <div class="doct-body" v-html="textHtml"></div>
        </div>
        <div v-else class="docp-err">该类型暂不支持预览</div>
      </div>
    </div>`,
    data() {
      return { doc: null, kind: '', url: '', loading: true, errMsg: '', textHtml: '', notice: '' };
    },
    methods: {
      fmtDate, fmtSize,
      back() { location.hash = '#/docs'; },
      async load() {
        const id = this.$route && this.$route.id;
        if (!id) { this.loading = false; this.errMsg = '缺少文档 ID'; return; }
        try {
          const d = await api.get('/docs/' + id);
          this.doc = d;
          this.kind = d.preview_kind;
          if (d.preview_kind === 'doc') {
            const t = await api.get('/docs/' + id + '/text');
            this.textHtml = t.html || '<p>（未能提取到文字内容）</p>';
            this.notice = t.notice || '';
          } else if (d.preview_kind === 'pdf') this.url = URL.createObjectURL(await this.blob());
          else if (d.preview_kind === 'docx') {
            const blob = await this.blob();
            // 先关 loading 让 ref 容器挂载再渲染（同弹窗预览的坑）
            this.loading = false;
            await this.$nextTick();
            const box = this.$refs.docxBox;
            if (!box) throw new Error('渲染容器未就绪');
            box.innerHTML = '';
            if (!window.docx) throw new Error('预览组件未加载，请刷新页面重试');
            await window.docx.renderAsync(blob, box, null, { inWrapper: true, ignoreWidth: false });
            if (!box.childElementCount) {
              throw new Error('文档渲染为空：可能是不兼容的 Word 格式（如 .doc 直接改名为 .docx），请下载后用 Word/WPS 打开');
            }
          }
        } catch (e) { this.errMsg = e.message; this.$toast(e.message, 'err'); }
        finally { this.loading = false; }
      },
      async blob() {
        const r = await fetch('/api/docs/' + this.docId + '/preview', { headers: { Authorization: 'Bearer ' + api.token } });
        if (!r.ok) {
          let m = '预览失败（' + r.status + '）';
          try { const j = await r.json(); if (j && j.message) m = j.message; } catch (e) {}
          throw new Error(m);
        }
        return r.blob();
      },
      download() {
        if (this.doc) api.download('/docs/' + this.doc.id + '/download', this.doc.original_name).catch((e) => this.$toast(e.message, 'err'));
      },
    },
    computed: {
      docId() { return this.$route && this.$route.id; },
    },
    beforeUnmount() { if (this.url) URL.revokeObjectURL(this.url); },
    mounted() { this.load(); },
  };

  window.HisViews = window.HisViews || {};
  window.HisViews.DocsView = V.DocsView;
  window.HisViews.DocPageView = V.DocPageView;
})();
