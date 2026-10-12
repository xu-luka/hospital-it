/* 角色权限配置页（PermView） + 无权限提示页（NoPermView）
 *
 * 页面结构：左侧角色列表，右侧按分组展开的权限矩阵（模块 × 动作）。
 * 权限编码与分组完全来自后端 /api/roles/meta，前端不写死任何模块清单 ——
 * 以后后端加模块，这里自动多出一行。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});
  const can = function (c) { return window.HisPerm && window.HisPerm.can(c); };

  // 动作隐含关系（与后端一致）：勾「管理」自动带上「提交 / 查看」，
  // 取消「查看」自动取消「提交 / 管理」。这样界面显示的就是实际生效的语义，
  // 不会出现"没勾查看却能看到"的迷惑状态。
  const WITH = { manage: ['view', 'create', 'manage'], create: ['view', 'create'], view: ['view'] };

  V.PermView = {
    data() {
      return {
        roles: [], modules: [], groups: [],
        cur: null, sel: [],
        saving: false, loading: true,
        form: null, showForm: false,
      };
    },
    computed: {
      roleName() { return this.cur ? this.cur.name : ''; },
    },
    mounted() {
      if (!can('roles.manage')) { this.loading = false; return; }
      this.load();
    },
    methods: {
      async load(keepId) {
        this.loading = true;
        try {
          const [roles, meta] = await Promise.all([
            api.get('/api/roles'),
            api.get('/api/roles/meta'),
          ]);
          this.roles = Array.isArray(roles) ? roles : [];
          this.modules = meta.modules || [];
          this.groups = this.buildGroups(this.modules);
          const want = keepId || (this.cur && this.cur.id);
          const target = this.roles.find((r) => r.id === want) || this.roles[0] || null;
          if (target) this.select(target);
          else { this.cur = null; this.sel = []; }
        } catch (e) {
          this.$toast(e.message || '加载失败', 'err');
        } finally {
          this.loading = false;
        }
      },
      buildGroups(mods) {
        const order = [];
        const map = {};
        mods.forEach((m) => {
          const g = m.group || '其他';
          if (!map[g]) { map[g] = { title: g, modules: [] }; order.push(map[g]); }
          map[g].modules.push(m);
        });
        return order;
      },
      select(r) {
        this.cur = r;
        this.sel = (r.perms || []).slice();
      },
      has(code) {
        if (this.cur && this.cur.locked) return true;
        return this.sel.indexOf(code) >= 0;
      },
      toggle(code) {
        if (this.cur && this.cur.locked) return;
        const i = code.lastIndexOf('.');
        const mod = code.slice(0, i);
        const act = code.slice(i + 1);
        const mine = WITH[act] || [act];
        const codes = mine.map((a) => mod + '.' + a);
        if (this.sel.indexOf(code) >= 0) {
          // 取消：本身 + 所有「依赖它」的更弱动作一起取消
          this.sel = this.sel.filter((c) => codes.indexOf(c) < 0);
        } else {
          codes.forEach((c) => { if (this.sel.indexOf(c) < 0) this.sel.push(c); });
        }
      },
      selectAll() {
        if (this.cur && this.cur.locked) return;
        this.sel = this.modules.reduce((acc, m) => acc.concat(m.acts.map((a) => a.code)), []);
      },
      clearAll() {
        if (this.cur && this.cur.locked) return;
        this.sel = [];
      },
      async save() {
        if (!this.cur) return;
        this.saving = true;
        try {
          const r = await api.put('/api/roles/' + this.cur.id + '/perms', { perms: this.sel });
          this.$toast(r && r.__msg ? r.__msg : '权限已保存', 'ok');
          await this.load(this.cur.id);
        } catch (e) {
          this.$toast(e.message || '保存失败', 'err');
        } finally {
          this.saving = false;
        }
      },
      openNewRole() {
        this.form = { isAdd: true, id: null, name: '', code: '' };
        this.showForm = true;
      },
      openRename() {
        if (!this.cur) return;
        this.form = { isAdd: false, id: this.cur.id, name: this.cur.name, code: this.cur.code };
        this.showForm = true;
      },
      async saveRole() {
        const f = this.form;
        if (!f || !f.name || f.name.trim().length < 2) return this.$toast('角色名称至少 2 个字', 'err');
        try {
          if (f.isAdd) {
            const r = await api.post('/api/roles', { name: f.name.trim(), code: (f.code || '').trim() });
            this.showForm = false;
            this.$toast('角色已创建，请在右侧勾选它的权限', 'ok');
            await this.load(r && r.id);
          } else {
            await api.put('/api/roles/' + f.id, { name: f.name.trim() });
            this.showForm = false;
            this.$toast('已保存', 'ok');
            await this.load(f.id);
          }
        } catch (e) {
          this.$toast(e.message || '保存失败', 'err');
        }
      },
      async removeRole() {
        if (!this.cur) return;
        if (this.cur.builtin) return this.$toast('内置角色不能删除，可以改名', 'err');
        if (!confirm('确定删除角色「' + this.cur.name + '」？该角色的权限配置会一并清除，此操作不可撤销。')) return;
        try {
          await api.del('/api/roles/' + this.cur.id);
          this.$toast('角色已删除', 'ok');
          this.cur = null;
          await this.load();
        } catch (e) {
          this.$toast(e.message || '删除失败', 'err');
        }
      },
    },
    template: `
    <div class="page">
      <div class="page-head">
        <h2>角色权限</h2>
        <div class="page-actions">
          <button class="btn btn-primary btn-sm" @click="openNewRole">+ 新增角色</button>
        </div>
      </div>

      <div v-if="loading" class="muted" style="padding:20px">正在加载…</div>

      <div v-else-if="!roles.length" class="perm-note">没有可管理的角色（或当前账号没有「角色权限」的管理权限）。</div>

      <div v-else class="perm-wrap">
        <aside class="perm-roles">
          <div v-for="r in roles" :key="r.id" class="perm-role"
               :class="{active: cur && cur.id===r.id}" @click="select(r)">
            <div class="perm-role-name">
              {{ r.name }}
              <span v-if="r.builtin" class="tag">内置</span>
            </div>
            <div class="perm-role-sub">
              {{ r.code }} · {{ r.userCount }} 人 ·
              {{ r.locked ? '全部权限' : (r.permCount + ' 项权限') }}
            </div>
          </div>
        </aside>

        <section class="perm-main" v-if="cur">
          <div class="perm-head">
            <div class="perm-title">{{ cur.name }}</div>
            <div class="perm-ops">
              <button class="btn btn-sm btn-outline" @click="openRename">改名</button>
              <button class="btn btn-sm btn-danger" @click="removeRole" :disabled="cur.builtin">删除</button>
              <button class="btn btn-sm btn-outline" @click="selectAll" :disabled="cur.locked">全选</button>
              <button class="btn btn-sm btn-outline" @click="clearAll" :disabled="cur.locked">清空</button>
              <button class="btn btn-sm btn-primary" @click="save" :disabled="saving || cur.locked">
                {{ saving ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>

          <div v-if="cur.locked" class="perm-note">
            内置管理员角色固定拥有全部权限，不可修改 —— 这样任何误操作都不会让系统没人能管。
          </div>
          <div v-else-if="!sel.length" class="perm-note">
            该角色目前没有任何权限：属于它的用户登录后只能看到工作台以外的空白菜单与「修改密码」。
          </div>

          <div v-for="g in groups" :key="g.title" class="perm-group">
            <div class="perm-group-title">{{ g.title }}</div>
            <div class="perm-row" v-for="m in g.modules" :key="m.code">
              <div class="perm-mod">
                <span class="perm-mod-name">{{ m.name }}</span>
                <span class="perm-code">{{ m.code }}</span>
              </div>
              <div class="perm-acts">
                <label v-for="a in m.acts" :key="a.code" class="ck perm-ck">
                  <input type="checkbox" :checked="has(a.code)" :disabled="cur.locked" @change="toggle(a.code)">
                  <span>{{ a.label }}</span>
                </label>
              </div>
            </div>
          </div>

          <div class="perm-tip">
            说明：勾「管理（处理）」会自动带上「查看 / 提交」，取消「查看」会一并取消它们 ——
            所以界面上看到的就是实际生效的结果。菜单与按钮按这里的配置显示，
            后端接口也会独立校验一次。
          </div>
        </section>
      </div>

      <div class="modal-mask" v-if="showForm">
        <div class="modal" style="width:420px">
          <div class="modal-head">
            {{ form && form.isAdd ? '新增角色' : '角色改名' }}
            <span class="x" @click="showForm=false">✕</span>
          </div>
          <div class="modal-body">
            <div class="form-item">
              <label>角色名称</label>
              <input v-model="form.name" placeholder="如：值班工程师 / 只读审计员">
            </div>
            <div class="form-item" v-if="form && form.isAdd">
              <label>角色标识（可留空自动生成）</label>
              <input v-model="form.code" placeholder="英文小写字母开头，如 auditor">
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="showForm=false">取消</button>
            <button class="btn btn-primary" @click="saveRole">保存</button>
          </div>
        </div>
      </div>
    </div>`,
  };

  // 无权限提示页：菜单已经在无权限时不显示入口，这里是「直接改地址栏 / 收藏夹旧链接」的兜底。
  // 明确告知原因，比静默跳到别的页面友好得多（改造前就是静默跳转）。
  V.NoPermView = {
    computed: {
      roleName() {
        const u = (window.HisUser && window.HisUser.user) || null;
        return u ? (u.role_name || u.roleName || '当前角色') : '当前角色';
      },
    },
    methods: {
      goHome() { location.hash = '#/dashboard'; },
    },
    template: `
    <div class="page">
      <div class="perm-denied">
        <div class="perm-denied-icon">🔒</div>
        <div class="perm-denied-title">没有权限访问该页面</div>
        <div class="perm-denied-sub">
          角色「{{ roleName }}」未被分配该模块的查看权限。<br>
          请联系管理员在【系统管理 → 角色权限】里勾选对应模块，保存后刷新页面即可生效（无需重新登录）。
        </div>
        <button class="btn btn-primary" @click="goHome">返回工作台</button>
      </div>
    </div>`,
  };
})();
