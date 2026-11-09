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

  /** 巡检参数表单「有没有改动」的比较字段（thresholds 是对象，snap 里走 JSON 比较） */
  const STG_KEYS = ['concurrency', 'timeout_ms', 'interval_sec', 'ssh_port_default', 'report_dir', 'thresholds'];

  const OS_ORDER = ['linux', 'windows', 'esxi', 'switch', 'bmc', 'database'];
  /* 表单下拉文案。比 connectLabelOf 长 —— 下拉里有空间说明「这条通道是什么」，
     台账那一列只有 8% 宽，只能用短名。两者的通道集合必须一致，加通道时一起加。 */
  const AUTH_HINT = {
    password: 'SSH / 账号密码',
    key: 'SSH 密钥',
    wmi: 'WMI 远程',
    exporter: 'exporter 指标端点',
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
                <th class="c-mon">监控方式</th>
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
                <td colspan="9" class="empty-row">暂无设备</td>
              </tr>
              <tr v-for="r in rows" :key="r.id">
                <td :title="r.name">
                  <div class="dev-name">{{ r.name }}</div>
                  <span class="dev-sub">{{ r.remark || r.location || '-' }}</span>
                </td>
                <td>{{ r.osLabel }}</td>
                <td class="c-mon">
                  <!-- 监控方式 = 采集通道。名字由后端 connect_label 给（lib/common.js 唯一来源），
                       前端不再按 auth_type 映射一份，否则台账和巡检详情会各叫一个名字。 -->
                  <span :class="'dev-badge ' + monClass(r)" :title="monTip(r)">{{ r.connect_label || '未设置' }}</span>
                </td>
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
                <!-- 通道对比只对 Windows 有意义：那边才有 SSH / WMI / exporter 多条通道 -->
                <button v-if="isAdmin && r.os==='windows'" class="btn btn-sm btn-outline"
                        @click="openCompare(r)">通道对比</button>
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
            <div v-if="checkResult.error" class="err-box">
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

      <!-- 通道对比：切换采集通道前的核对
           ★ 不写 @click.self：里面有临时凭据输入框，误触遮罩清掉要重填。
             退出走 ✕ / 关闭，填过凭据还没跑才确认。 -->
      <div class="modal-mask" v-if="cmp">
        <div class="modal" style="width:820px;max-height:88vh;overflow:auto">
          <div class="modal-head">通道对比 · {{ cmp.row.name }} <span class="x" @click="closeCmp">✕</span></div>
          <div class="modal-body">

            <!-- 配置态 -->
            <template v-if="!cmp.result">
              <div class="hint" style="margin:0 0 12px">
                同一台机器用两条通道各采一次，把数字并排核对。对比是只读的：不改台账、不改上一轮的巡检结果。
                确认一致后再切换认证方式；切换后先别急着关 sshd，观察几轮再退役。
              </div>
              <div class="cmp-cfg">
                <div class="cmp-side">
                  <div class="cmp-side-t">当前通道（台账里配的）</div>
                  <div class="cmp-side-v">{{ authHint(cmp.curType) }}</div>
                  <div class="cmp-side-s mono">{{ cmp.row.host }}<span v-if="cmp.row.port">:{{ cmp.row.port }}</span></div>
                </div>
                <div class="cmp-vs">VS</div>
                <div class="cmp-side">
                  <div class="cmp-side-t">对比通道</div>
                  <select class="ipt" v-model="cmp.otherType">
                    <option v-for="t in cmpChannels" :key="t" :value="t">{{ authHint(t) }}</option>
                  </select>
                  <div class="cmp-side-s mono" v-if="cmp.otherType==='exporter'">{{ cmp.row.host }}:{{ cmp.port || 9182 }}/metrics</div>
                  <div class="cmp-side-s mono" v-else>{{ cmp.row.host }}:{{ cmp.row.port || 22 }}</div>
                </div>
              </div>

              <div class="form-row" v-if="cmp.otherType==='exporter'">
                <div class="form-item"><label>exporter 端口</label>
                  <input class="ipt" type="number" v-model="cmp.port" placeholder="默认 9182"></div>
                <div class="form-item"><label>协议</label>
                  <select class="ipt" v-model="cmp.protocol">
                    <option value="http">http</option><option value="https">https</option>
                  </select></div>
              </div>

              <div class="form-row">
                <div class="form-item"><label>{{ cmp.otherType==='exporter' ? '账号（可选）' : '临时账号 *' }}</label>
                  <input class="ipt" v-model="cmp.username" autocomplete="off"
                         :placeholder="cmp.otherType==='exporter' ? '端点开了 Basic 认证才需要' : '只用于本次对比'"></div>
                <div class="form-item"><label>{{ cmp.otherType==='exporter' ? '口令（可选）' : '临时口令' }}</label>
                  <input class="ipt" type="password" v-model="cmp.password" autocomplete="new-password"
                         placeholder="不写入台账"></div>
              </div>
              <div class="form-row" v-if="cmp.otherType==='key'">
                <div class="form-item"><label>私钥文件路径 *</label>
                  <input class="ipt" v-model="cmp.private_key_path" placeholder="如 C:\\keys\\id_inspect"></div>
              </div>

              <div class="hint" style="margin:0">
                <template v-if="cmp.otherType!=='exporter'">
                  临时凭据只用于这一次对比：不写入台账、不进审计日志，采完即从页面清掉。
                  通常直接填台账里这台设备已经在用的那个账号就行，不必另外建。
                </template>
                <template v-else>
                  exporter 通道默认不需要账号。两侧并行采集：SSH 一次要几秒，
                  exporter 要隔 1 秒抓两次样，整体约 3~10 秒。
                </template>
              </div>
            </template>

            <!-- 结果态 -->
            <template v-else>
              <div class="cmp-sum">
                <span :class="'dev-badge ' + cmpVerdictClass(cmp.result.diff.verdict)">
                  {{ cmpVerdictText(cmp.result.diff.verdict) }}
                </span>
                <span class="muted">
                  一致 {{ cmp.result.diff.counts.same }} · 接近 {{ cmp.result.diff.counts.close }} ·
                  不一致 {{ cmp.result.diff.counts.diff }} · 不适用 {{ cmp.result.diff.counts.na }}
                </span>
                <div style="flex:1"></div>
                <span class="muted">总耗时 {{ cmp.result.durationMs }} ms</span>
                <button class="btn btn-sm btn-outline" @click="cmp.result=null">改通道</button>
              </div>

              <div class="cmp-cfg">
                <div class="cmp-side" :class="{ 'is-bad': !cmp.result.left.ok }">
                  <div class="cmp-side-t">{{ cmp.result.left.label }}（当前）</div>
                  <div class="cmp-side-v">{{ cmp.result.left.ok ? (cmp.result.left.hostname || '已连接') : '采集失败' }}</div>
                  <div class="cmp-side-s">{{ cmp.result.left.ok ? (cmp.result.left.ms + ' ms') : '' }}</div>
                  <div class="cmp-err" v-if="!cmp.result.left.ok">{{ cmp.result.left.error }}</div>
                </div>
                <div class="cmp-vs">VS</div>
                <div class="cmp-side" :class="{ 'is-bad': !cmp.result.right.ok }">
                  <div class="cmp-side-t">{{ cmp.result.right.label }}（对比）</div>
                  <div class="cmp-side-v">{{ cmp.result.right.ok ? (cmp.result.right.hostname || '已连接') : '采集失败' }}</div>
                  <div class="cmp-side-s">{{ cmp.result.right.ok ? (cmp.result.right.ms + ' ms') : '' }}</div>
                  <div class="cmp-err" v-if="!cmp.result.right.ok">{{ cmp.result.right.error }}</div>
                </div>
              </div>

              <div class="cmp-table-wrap">
                <table class="tbl cmp-table">
                  <thead>
                    <tr>
                      <th class="c-k">指标</th>
                      <th class="c-n">{{ cmp.result.left.label }}</th>
                      <th class="c-n">{{ cmp.result.right.label }}</th>
                      <th class="c-v">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in cmp.result.diff.rows" :key="row.key" :class="cmpRowClass(row)">
                      <td :title="row.note">
                        {{ row.label }}
                        <span class="cmp-note" v-if="row.note && (row.verdict==='diff' || row.verdict==='na')">{{ row.note }}</span>
                      </td>
                      <td class="c-n mono">{{ row.a }}</td>
                      <td class="c-n mono">{{ row.b }}</td>
                      <td class="c-v">
                        <span :class="'dev-badge ' + cmpVerdictClass(row.verdict)">{{ cmpVerdictText(row.verdict) }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="cmp-tips">
                <div v-for="(t,i) in cmp.result.diff.tips" :key="i">· {{ t }}</div>
              </div>
            </template>

            <div v-if="cmp.error" class="err-box" style="margin-top:10px">{{ cmp.error }}</div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="closeCmp">关闭</button>
            <button class="btn btn-primary" @click="runCompare" :disabled="cmp.running">
              {{ cmp.running ? '采集中…' : (cmp.result ? '再测一次' : '开始对比') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 编辑 / 新增
           ★ 不写 @click.self：设备表单字段最多（含服务检查、自定义命令两组可增删的行），
             点到遮罩就清空的话损失最大。退出走 ✕ / 取消，改过内容会先确认。 -->
      <div class="modal-mask" v-if="form">
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
                <select class="ipt" v-model="form.auth_type" @change="onAuthTypeChange(form.auth_type)">
                  <option v-for="t in (meta.authTypes[form.os] || [])" :key="t" :value="t">
                    {{ authHint(t) }}
                  </option>
                </select></div>
              <div class="form-item" v-if="needPort"><label>位置 / 机柜</label>
                <input class="ipt" v-model="form.location" placeholder="选填"></div>
              <div class="form-item" v-if="form.os==='bmc' || form.auth_type==='exporter'"><label>协议</label>
                <select class="ipt" v-model="form.protocol">
                  <option value="https">https</option><option value="http">http</option>
                </select></div>
            </div>

            <!-- exporter 通道的说明放这里：它不是「连上去执行命令」，而是一个只读 HTTP 端点，
                 能做什么不能做什么跟 SSH/WMI 差别很大，必须写清楚，否则用户配了服务检查却没生效会以为是 bug -->
            <div class="hint" v-if="form.auth_type==='exporter'" style="margin:0 0 10px">
              目标机需先安装 windows_exporter（默认监听 9182，只读 HTTP）。
              本通道不执行远程命令：服务检查只按「服务名」判定，进程 / 端口类检查项会被跳过，自定义命令不会执行。
              windows_exporter 0.30 及以上仅支持 Server 2016+，更老的系统（如 2008 R2）请用 WMI。
            </div>

            <template v-if="form.auth_type!=='local'">
              <div class="form-row">
                <div class="form-item"><label>{{ form.auth_type==='exporter' ? '账号（可选）' : '登录账号 *' }}</label>
                  <input class="ipt" v-model="form.auth_username"
                         :placeholder="form.auth_type==='exporter' ? '端点开了 Basic 认证才需要' : ''"></div>
                <div class="form-item"><label>{{ form.auth_type==='exporter' ? '口令（可选）' : '登录口令' }}</label>
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

            <div v-if="errs.length" class="err-box">
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
      <div class="modal-mask" v-if="stg">
        <div class="modal" style="width:520px">
          <div class="modal-head">巡检参数 <span class="x" @click="tryCloseStg">✕</span></div>
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
            <button class="btn btn-outline" @click="tryCloseStg">取消</button>
            <button class="btn btn-primary" @click="saveSettings" :disabled="saving">保存</button>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        rows: [], meta: {}, source: null, kw: '', fOs: '', fEnabled: '',
        form: null, formBase: '', errs: [], saving: false, checking: null, checkResult: null,
        cmp: null,
        stg: null, stgBase: '', timer: null,
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
      // 设备台账的写操作（新增/编辑/删除/启停用/测试连接/巡检参数）看「设备台账.管理」
      isAdmin() {
        return !!(window.HisPerm && window.HisPerm.can('devices.manage'));
      },
      osOptions() {
        const all = (this.meta && this.meta.osTypes) || [];
        const map = {};
        all.forEach((o) => { map[o.value] = o.label; });
        return OS_ORDER.filter((k) => map[k]).map((k) => ({ value: k, label: map[k] }));
      },
      needPort() { return this.form && this.form.os !== 'bmc'; },
      /** 可选的对比通道：排除当前通道（同一通道对比没有意义） */
      cmpChannels() {
        const cur = this.cmp ? this.cmp.curType : '';
        return ['exporter', 'password', 'key', 'wmi'].filter((t) => t !== cur);
      },
      defaultPort() {
        // exporter 走自己的 HTTP 端点，端口跟 SSH 的 22 完全无关，必须单独给默认值
        if (this.form && this.form.auth_type === 'exporter') return '默认 9182';
        const m = { linux: 22, windows: 22, switch: 22, bmc: 443, esxi: 443, database: 1433 };
        return '默认 ' + (m[this.form && this.form.os] || '');
      }
    },

    mounted() {
      // 从【IP 管理】点「查看台账」跳过来：浏览器 hash 路由带不了参数，
      // 那边把地址写进 sessionStorage，这里读一次就删（刷新不会又把筛选粘回去）。
      try {
        const k = sessionStorage.getItem('his_device_kw');
        if (k) { sessionStorage.removeItem('his_device_kw'); this.kw = k; }
      } catch (e) { /* 隐私模式忽略 */ }
      this.onOpenDevice = (ev) => {
        const k = String((ev && ev.detail) || '');
        if (k) { this.kw = k; this.load(); }
      };
      window.addEventListener('his:open-device', this.onOpenDevice);
      this.load(); this.loadMeta(); this.loadSource();
    },
    beforeUnmount() {
      if (this.onOpenDevice) window.removeEventListener('his:open-device', this.onOpenDevice);
    },

    methods: {
      authHint(t) { return AUTH_HINT[t] || t; },

      /**
       * 「监控方式」徽章的颜色。
       * 只给两种语义色，其余保持默认文字色 —— 这一列是信息不是状态，
       * 一片绿/黄会盖过右边真正需要注意的「状态」列。
       * warn 只留给「未设置」：那种设备其实一次都采不到，是真问题而不是显示问题。
       */
      monClass(r) {
        const lab = r && r.connect_label;
        if (!lab || lab === '未设置') return 'warn';
        if (r.auth_type === 'exporter') return 'info';
        return '';
      },

      /** 悬停补一句「这条路怎么走、有什么前提」，省得回头查文档 */
      monTip(r) {
        const lab = (r && r.connect_label) || '';
        const M = {
          'exporter': '只读 HTTP 指标端点（默认 9182 /metrics），不经过 SSH，不需要账号密码',
          'WMI': 'WMI / DCOM：TCP 135 + RPC 动态端口。补丁随 Windows Update 走，不用手工追版本',
          'SSH 密码': 'SSH 账号密码登录。Windows 上是 keyboard-interactive 通道，只关 PasswordAuthentication 关不掉它',
          'SSH 密钥': 'SSH 私钥认证，免密码。Windows 管理员的公钥在 administrators_authorized_keys',
          'SSH(设备)': '网络设备自带的 SSH 服务（设备侧只支持账号密码）',
          'Redfish': '管理口 Redfish（默认 443）：温度、风扇、电源、RAID 这类硬件告警只能从这一层取',
          'TDS连接': '数据库直连（TDS），不经过操作系统',
          'Oracle连接': '数据库直连（Oracle），不经过操作系统',
          'vSphere API': 'vSphere API（默认 443）',
          '本机': '巡检服务器本机，不走网络、不需要凭据',
          '未设置': '还没选采集通道，这台设备现在采不到任何数据'
        };
        return M[lab] || '采集通道：' + (lab || '未设置');
      },

      /**
       * 切认证方式时联动端口与协议。
       * 为什么必须做：SSH 的 22 和 exporter 的 9182 不是一回事，
       * 从「账号密码」改成「exporter」却留着 22，采集必然连不上，
       * 而错误信息只会说「拉取失败」，运维很难想到是端口没改。
       */
      onAuthTypeChange(v) {
        const f = this.form;
        if (!f) return;
        if (v === 'exporter') {
          // exporter 默认是明文 HTTP（msi 装完就是 http），选 https 反而连不上
          if (!f.protocol || f.protocol === 'https') f.protocol = 'http';
          if (!f.port || Number(f.port) === 22) f.port = 9182;
        } else if (Number(f.port) === 9182) {
          // 从 exporter 切回 SSH/WMI：清掉 9182，让占位符提示该类型自己的默认端口
          f.port = null;
        }
      },

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

      openNew() { this.errs = []; this.form = this.blankForm(); this.markFormBase(); },

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
        this.markFormBase();
      },

      /** 参与「有没有改动」比较的字段：表单自身除 id / has_password（派生）之外的全部 */
      formKeys() {
        const f = this.form || {};
        return Object.keys(f).filter((k) => k !== 'id' && k !== 'has_password');
      },
      markFormBase() { this.formBase = HisUI.snap(this.form, this.formKeys()); },

      /** 关闭设备表单：字段最多（含两组可增删的行），改到一半被清掉最亏 */
      closeForm() {
        if (this.saving) return;
        if (HisUI.dirty(this.form, this.formBase, this.formKeys()) && !HisUI.confirmDiscard()) return;
        this.form = null; this.errs = [];
      },

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

      /* ---------------- 通道对比 ---------------- */

      /**
       * 打开对比弹窗。默认「当前通道 vs exporter」——这是实际会用到的方向
       * （设备现在跑 SSH，想知道换 exporter 后数对不对）。
       * 反方向（当前已是 exporter，想用 SSH 反向核对）也支持：此时默认选 SSH 密码。
       */
      openCompare(r) {
        this.cmp = {
          row: r,
          curType: r.auth_type || '',
          otherType: r.auth_type === 'exporter' ? 'password' : 'exporter',
          port: 9182,
          protocol: 'http',
          username: '', password: '', private_key_path: '',
          running: false, error: '', result: null
        };
      },

      closeCmp() {
        const c = this.cmp;
        if (!c || c.running) return;
        // 只在「填了临时凭据、还没跑出结果」时拦一下：跑完再关没有损失
        const dirty = !c.result && !!(c.username || c.password || c.private_key_path);
        if (dirty && !window.confirm('关掉后临时填写的账号口令会被丢弃，确定关闭？')) return;
        this.cmp = null;
      },

      cmpVerdictClass(v) {
        return { same: 'ok', close: 'warn', diff: 'err', blocked: 'err', na: 'muted' }[v] || 'muted';
      },
      /** 行底色：只有「不一致 / 不适用」需要一眼看见，其余保持干净 */
      cmpRowClass(row) {
        const v = row && row.verdict;
        return v === 'diff' ? 'is-diff' : v === 'na' ? 'is-na' : '';
      },
      cmpVerdictText(v) {
        return { same: '一致', close: '接近', diff: '不一致', blocked: '无法对比', na: '不适用' }[v] || v;
      },

      async runCompare() {
        const c = this.cmp;
        if (!c || c.running) return;
        if (c.otherType !== 'exporter' && !String(c.username || '').trim()) {
          this.$toast('对比 ' + this.authHint(c.otherType) + ' 通道需要填写临时账号', 'err');
          return;
        }
        if (c.otherType === 'key' && !String(c.private_key_path || '').trim()) {
          this.$toast('SSH 私钥通道需要填写私钥文件路径', 'err');
          return;
        }
        c.running = true; c.error = '';
        try {
          const body = { channel: c.otherType, username: c.username, password: c.password };
          if (c.otherType === 'exporter') {
            body.port = Number(c.port) || 9182;
            body.protocol = c.protocol;
          }
          if (c.otherType === 'key') body.private_key_path = c.private_key_path;
          c.result = await api.post('/api/inspection/devices/' + c.row.id + '/compare', body);
          // 口令不在页面里多留一秒
          c.password = '';
        } catch (e) {
          c.error = e.message;
        } finally { c.running = false; }
      },

      async openSettings() {
        try {
          const s = await api.get('/api/inspection/settings');
          this.stg = JSON.parse(JSON.stringify(s));
          this.stgBase = HisUI.snap(this.stg, STG_KEYS);
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      /** 关闭巡检参数：改完没保存就点到外面，阈值会悄悄回到原样，先确认一次 */
      tryCloseStg() {
        if (this.saving) return;
        if (HisUI.dirty(this.stg, this.stgBase, STG_KEYS) && !HisUI.confirmDiscard()) return;
        this.stg = null;
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
