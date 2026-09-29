/* 机房巡检：设备台账（阶段 3）
 *
 * 设计要点：
 *  - 口令字段只有「留空＝不修改」一种语义。服务端从不下发密文，浏览器里永远不存在
 *    可复制粘贴的凭据，页面被截屏或被人围观也不会泄密。
 *  - 写操作前先判角色；服务端还会再判一次，前端判断只是为了不让普通用户看到无意义的报错。
 *  - 单台自检按钮的价值在于即时反馈：改完凭据不用等下一轮几分钟后才知道通不通。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  const OS_ORDER = ['linux', 'windows', 'esxi', 'switch', 'bmc', 'database'];
  const AUTH_HINT = {
    password: 'SSH / 账号密码',
    key: 'SSH 私钥',
    wmi: 'WMI 远程',
    local: '本机（无需凭据）',
    bmc: '管理口 Redfish'
  };

  V.DevicesView = {
    template: `
    <div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="font-size:16px;font-weight:600">设备台账</div>
          <span v-if="source" class="dev-badge" :class="source.mode==='db' ? 'ok' : 'warn'">
            数据源：{{ source.mode==='db' ? '数据库台账' : '配置文件' }}
          </span>
          <span v-if="source && !source.keyAvailable" class="dev-badge err" :title="source.keyError">
            主密钥不可用，加密口令的设备无法巡检
          </span>
          <span v-if="source" class="dev-badge muted">
            启用 {{ source.enabled }} / 共 {{ source.devices }} 台
          </span>
          <!-- 过滤激活时显示筛选结果计数，避免与上面全局统计混淆 -->
          <span v-if="kw || fOs || fEnabled" class="dev-badge">
            筛选结果 {{ rows.length }} 台
          </span>
          <div style="flex:1"></div>
          <button v-if="isAdmin" class="btn btn-outline btn-sm" @click="openSettings">巡检参数</button>
          <button v-if="isAdmin" class="btn btn-primary btn-sm" @click="openNew">+ 新增设备</button>
        </div>
      </div>

      <div class="filter-bar">
        <input class="ipt" v-model="kw" placeholder="搜索名称 / 地址 / 备注" @input="load">
        <select class="ipt" v-model="fOs" @change="load">
          <option value="">全部类型</option>
          <option v-for="o in osOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <select class="ipt" v-model="fEnabled" @change="load">
          <option value="">全部状态</option>
          <option value="1">已启用</option>
          <option value="0">已停用</option>
        </select>
        <div style="flex:1"></div>
        <button class="btn btn-outline btn-sm" @click="load">刷新</button>
      </div>

      <div class="card">
        <div class="table-wrap">
          <table class="tbl dev-table">
            <thead>
              <tr>
                <th class="c-name">设备名称</th>
                <th class="c-type">类型</th>
                <th class="c-host">地址 / 端口</th>
                <th class="c-user">登录账号</th>
                <th class="c-pwd">口令</th>
                <th class="c-last">上次巡检</th>
                <th class="c-state">状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!rows.length">
                <td colspan="8" class="empty-row">暂无设备</td>
              </tr>
              <tr v-for="r in rows" :key="r.id">
                <td :title="r.name">
                  <div class="dev-name">{{ r.name }}</div>
                  <span class="dev-sub">{{ r.remark || r.location || '-' }}</span>
                </td>
                <td>{{ r.osLabel }}</td>
                <td><span class="dev-host">{{ r.host }}<span class="muted" v-if="r.port">:{{ r.port }}</span></span></td>
                <td>{{ r.auth_username || '-' }}</td>
              <td>
                <span v-if="r.has_password && r.password_encrypted" class="dev-badge ok">已加密保存</span>
                <span v-else-if="r.has_password" class="dev-badge warn">明文</span>
                <span v-else class="muted">未设置</span>
              </td>
              <td>
                <span v-if="r.last_status" :class="'dev-badge ' + statusClass(r.last_status)">
                  {{ statusText(r.last_status) }}
                </span>
                <span v-else class="muted">未巡检</span>
              </td>
              <td>
                <span :class="'dev-badge ' + (r.enabled ? 'ok' : 'muted')">{{ r.enabled ? '启用' : '停用' }}</span>
              </td>
              <td class="actions-cell">
                <button v-if="isAdmin" class="btn btn-sm btn-outline" @click="edit(r)">编辑</button>
                <button v-if="isAdmin" class="btn btn-sm btn-outline" @click="check(r)" :disabled="checking===r.id">
                  {{ checking===r.id ? '检测中' : '自检' }}
                </button>
                <button v-if="isAdmin" class="btn btn-sm btn-outline" @click="toggle(r)">
                  {{ r.enabled ? '停用' : '启用' }}
                </button>
                <button v-if="isAdmin" class="btn btn-sm btn-danger" @click="remove(r)">删除</button>
                <span v-if="!isAdmin" class="muted">只读</span>
              </td>
            </tr>
          </tbody>
          </table>
        </div>
      </div>

      <!-- 自检结果 -->
      <div class="modal-mask" v-if="checkResult" @click.self="checkResult=null">
        <div class="modal" style="width:520px">
          <div class="modal-head">连通性自检 <span class="x" @click="checkResult=null">✕</span></div>
          <div class="modal-body">
            <div style="margin-bottom:8px">
              <span :class="'dev-badge ' + (checkResult.ok ? 'ok' : 'err')">
                {{ checkResult.ok ? '连接正常' : '连接失败' }}
              </span>
              <span class="muted" style="margin-left:8px">
                {{ checkResult.name }}（{{ checkResult.host }}）· 耗时 {{ checkResult.durationMs }} ms
              </span>
            </div>
            <div v-if="checkResult.error" style="color:var(--danger);word-break:break-all;padding:8px;background:#fef2f2;border-radius:6px">
              {{ checkResult.error }}
            </div>
            <div v-else>
              <div v-if="checkResult.hostname">主机名：{{ checkResult.hostname }}</div>
              <div v-if="checkResult.cpu!=null">CPU：{{ checkResult.cpu }}%</div>
              <div v-if="checkResult.mem!=null">内存：{{ checkResult.mem }}%</div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="checkResult=null">关闭</button>
          </div>
        </div>
      </div>

      <!-- 编辑 / 新增 -->
      <div class="modal-mask" v-if="form" @click.self="closeForm">
        <div class="modal" style="width:720px;max-height:88vh;overflow:auto">
          <div class="modal-head">{{ form.id ? '编辑设备' : '新增设备' }} <span class="x" @click="closeForm">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item"><label>设备名称 *</label>
                <input class="ipt" v-model="form.name" placeholder="如 HIS数据库"></div>
              <div class="form-item"><label>设备类型 *</label>
                <select class="ipt" v-model="form.os">
                  <option v-for="o in osOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>主机地址 *</label>
                <input class="ipt" v-model="form.host" placeholder="IP 或域名"></div>
              <div class="form-item"><label>端口</label>
                <input class="ipt" type="number" v-model="form.port" :placeholder="defaultPort"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>认证方式</label>
                <select class="ipt" v-model="form.auth_type">
                  <option v-for="t in (meta.authTypes[form.os] || [])" :key="t" :value="t">
                    {{ authHint(t) }}
                  </option>
                </select></div>
              <div class="form-item" v-if="needPort"><label>位置 / 机柜</label>
                <input class="ipt" v-model="form.location" placeholder="选填"></div>
              <div class="form-item" v-if="form.os==='bmc'"><label>协议</label>
                <select class="ipt" v-model="form.protocol">
                  <option value="https">https</option><option value="http">http</option>
                </select></div>
            </div>

            <template v-if="form.auth_type!=='local'">
              <div class="form-row">
                <div class="form-item"><label>登录账号 *</label>
                  <input class="ipt" v-model="form.auth_username"></div>
                <div class="form-item"><label>登录口令</label>
                  <input class="ipt" type="password" v-model="form.auth_password"
                         :placeholder="form.has_password ? '已加密保存，留空则不修改' : '留空表示不设置'"
                         autocomplete="new-password"></div>
              </div>
              <div class="form-row" v-if="form.auth_type==='key'">
                <div class="form-item"><label>私钥文件路径</label>
                  <input class="ipt" v-model="form.auth_private_key_path" placeholder="如 C:\\\\keys\\\\id_rsa"></div>
                <div class="form-item"><label>私钥口令</label>
                  <input class="ipt" type="password" v-model="form.auth_passphrase"
                         placeholder="留空表示不修改" autocomplete="new-password"></div>
              </div>
            </template>

            <div class="form-row" v-if="form.os==='database'">
              <div class="form-item"><label>数据库类型 *</label>
                <select class="ipt" v-model="form.db_engine">
                  <option value="mssql">SQL Server</option><option value="oracle">Oracle</option>
                </select></div>
              <div class="form-item"><label>版本提示</label>
                <input class="ipt" v-model="form.db_version_hint" placeholder="默认 auto"></div>
            </div>

            <div class="form-sec">
              <div style="font-weight:600;margin-bottom:6px">服务检查
                <button class="btn btn-sm btn-outline" style="margin-left:8px" @click="form.services.push({type:'auto',name:''})">+ 添加</button>
              </div>
              <div v-for="(s,i) in form.services" :key="'s'+i" style="display:flex;gap:6px;margin-bottom:6px">
                <input class="ipt" style="width:150px" v-model="s.name" placeholder="服务名，如 sshd">
                <button class="btn btn-sm btn-danger" @click="form.services.splice(i,1)">删除</button>
              </div>
              <div v-if="!form.services.length" class="muted">未配置，仅采集 CPU / 内存 / 磁盘</div>
            </div>

            <div class="form-sec">
              <div style="font-weight:600;margin-bottom:6px">自定义命令
                <button class="btn btn-sm btn-outline" style="margin-left:8px" @click="form.custom_commands.push({name:'',command:''})">+ 添加</button>
              </div>
              <div v-for="(c,i) in form.custom_commands" :key="'c'+i" style="display:flex;gap:6px;margin-bottom:6px">
                <input class="ipt" style="width:150px" v-model="c.name" placeholder="显示名">
                <input class="ipt" style="flex:1" v-model="c.command" placeholder="命令，如 df -h /data">
                <button class="btn btn-sm btn-danger" @click="form.custom_commands.splice(i,1)">删除</button>
              </div>
            </div>

            <div class="form-row">
              <div class="form-item"><label>备注</label>
                <input class="ipt" v-model="form.remark" placeholder="用途、负责人等"></div>
              <div class="form-item"><label>是否纳入巡检</label>
                <select class="ipt" v-model="form.enabled">
                  <option :value="true">启用</option><option :value="false">停用</option>
                </select></div>
            </div>

            <div v-if="errs.length" style="background:#fef2f2;color:var(--danger);padding:8px;border-radius:6px">
              <div v-for="e in errs" :key="e">{{ e }}</div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="closeForm">取消</button>
            <button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- 巡检参数 -->
      <div class="modal-mask" v-if="stg" @click.self="stg=null">
        <div class="modal" style="width:520px">
          <div class="modal-head">巡检参数 <span class="x" @click="stg=null">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item"><label>并发采集数</label>
                <input class="ipt" type="number" min="1" max="32" v-model="stg.concurrency"></div>
              <div class="form-item"><label>单台超时（毫秒）</label>
                <input class="ipt" type="number" min="10000" step="1000" v-model="stg.timeout_ms"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>采集间隔（秒）</label>
                <input class="ipt" type="number" min="30" v-model="stg.interval_sec"></div>
              <div class="form-item"><label>SSH 默认端口</label>
                <input class="ipt" type="number" v-model="stg.ssh_port_default"></div>
            </div>
            <div class="form-item"><label>报告目录</label>
              <input class="ipt" v-model="stg.report_dir" placeholder="留空则用 data/reports"></div>
            <div class="form-sec">
              <div style="font-weight:600;margin-bottom:6px">告警阈值</div>
              <div class="form-row" v-for="t in thresholdKeys" :key="t.k">
                <div class="form-item"><label>{{ t.label }}（%）</label>
                  <input class="ipt" type="number" v-model="stg.thresholds[t.k]"></div>
              </div>
            </div>
            <div class="muted" style="font-size:12px">保存后即刻生效，无需重启服务。</div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="stg=null">取消</button>
            <button class="btn btn-primary" @click="saveSettings" :disabled="saving">保存</button>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        rows: [], meta: {}, source: null, kw: '', fOs: '', fEnabled: '',
        form: null, errs: [], saving: false, checking: null, checkResult: null,
        stg: null, timer: null,
        thresholdKeys: [
          { k: 'cpu_percent_warn', label: 'CPU 警告' },
          { k: 'cpu_percent_critical', label: 'CPU 严重' },
          { k: 'memory_percent_warn', label: '内存 警告' },
          { k: 'memory_percent_critical', label: '内存 严重' },
          { k: 'disk_percent_warn', label: '磁盘 警告' },
          { k: 'disk_percent_critical', label: '磁盘 严重' }
        ]
      };
    },

    computed: {
      isAdmin() {
        const u = window.HisUser && window.HisUser.user;
        return !!(u && u.role_id === 1);
      },
      osOptions() {
        const all = (this.meta && this.meta.osTypes) || [];
        const map = {};
        all.forEach((o) => { map[o.value] = o.label; });
        return OS_ORDER.filter((k) => map[k]).map((k) => ({ value: k, label: map[k] }));
      },
      needPort() { return this.form && this.form.os !== 'bmc'; },
      defaultPort() {
        const m = { linux: 22, windows: 22, switch: 22, bmc: 443, esxi: 443, database: 1433 };
        return '默认 ' + (m[this.form && this.form.os] || '');
      }
    },

    mounted() { this.load(); this.loadMeta(); this.loadSource(); },

    methods: {
      authHint(t) { return AUTH_HINT[t] || t; },

      statusClass(s) { return { normal: 'ok', warning: 'warn', critical: 'err', error: 'err' }[s] || 'muted'; },
      statusText(s) { return { normal: '正常', warning: '警告', critical: '严重', error: '失败' }[s] || s; },

      async load() {
        try {
          // 手工拼串而非 URLSearchParams：内网仍有老版本 360/IE 内核在用，
          // URLSearchParams 在那些内核里不存在，会让整个页面报错
          function q(base, params) {
            const parts = [];
            for (const k in params) if (params[k] !== '' && params[k] != null) {
              parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
            }
            return parts.length ? (base + '?' + parts.join('&')) : base;
          }
          const r = await api.get(q('/api/inspection/devices', { kw: this.kw, os: this.fOs, enabled: this.fEnabled }));
          this.rows = r.items;
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async loadMeta() {
        try { this.meta = await api.get('/api/inspection/devices/meta'); } catch (e) { /* 字典拿不到不影响使用 */ }
      },

      async loadSource() {
        try { this.source = await api.get('/api/inspection/source'); } catch (e) { /* 忽略 */ }
      },

      blankForm() {
        return {
          id: null, name: '', host: '', os: 'linux', port: null, protocol: 'https',
          enabled: true, location: '', auth_type: 'password', auth_username: '',
          auth_password: '', auth_private_key_path: '', auth_passphrase: '',
          db_engine: 'mssql', db_version_hint: '', remark: '', services: [], custom_commands: []
        };
      },

      openNew() { this.errs = []; this.form = this.blankForm(); },

      edit(r) {
        this.errs = [];
        const f = this.blankForm();
        for (const k of Object.keys(f)) if (r[k] !== undefined) f[k] = r[k];
        f.services = (r.services || []).map((s) => ({ type: s.type || 'auto', name: s.name || '' }));
        f.custom_commands = (r.custom_commands || []).map((c) => ({ name: c.name || '', command: c.command || '' }));
        // 口令永远不带入表单，浏览器里不存在凭据值
        f.auth_password = ''; f.auth_passphrase = '';
        f.has_password = !!r.has_password;
        this.form = f;
      },

      closeForm() { this.form = null; this.errs = []; },

      async save() {
        this.errs = [];
        const body = Object.assign({}, this.form);
        // 未修改过的凭据不提交，服务端据此保留原密文
        if (!body.auth_password) delete body.auth_password;
        if (!body.auth_passphrase) delete body.auth_passphrase;
        delete body.has_password;
        if (body.port === '' || body.port === null) delete body.port;
        this.saving = true;
        try {
          if (body.id) await api.put('/api/inspection/devices/' + body.id, body);
          else await api.post('/api/inspection/devices', body);
          this.$toast('已保存，下一轮巡检生效', 'ok');
          this.form = null;
          this.load(); this.loadSource();
        } catch (e) {
          this.errs = (e.errors && e.errors.length) ? e.errors : [e.message];
        } finally { this.saving = false; }
      },

      async toggle(r) {
        try {
          await api.post('/api/inspection/devices/' + r.id + '/toggle', { enabled: !r.enabled });
          this.$toast(r.enabled ? '已暂停巡检' : '已纳入巡检', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async remove(r) {
        if (!window.confirm('确认停用并删除设备「' + r.name + '」？\n删除后可在数据库 it_devices 表中恢复（软删除）。')) return;
        try {
          await api.del('/api/inspection/devices/' + r.id);
          this.$toast('已删除', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async check(r) {
        this.checking = r.id;
        try {
          this.checkResult = await api.post('/api/inspection/devices/' + r.id + '/check', {});
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally { this.checking = null; }
      },

      async openSettings() {
        try {
          const s = await api.get('/api/inspection/settings');
          this.stg = JSON.parse(JSON.stringify(s));
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async saveSettings() {
        this.saving = true;
        try {
          await api.put('/api/inspection/settings', this.stg);
          this.$toast('参数已生效', 'ok');
          this.stg = null;
          this.loadSource();
        } catch (e) {
          this.$toast((e.errors && e.errors[0]) || e.message, 'err');
        } finally { this.saving = false; }
      }
    }
  };
})();
