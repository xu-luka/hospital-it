/* IP 管理（网段 + 已用 IP 登记）
 *
 * 用户诉求：自己登记院内已使用的 IP，先设网段，再按网段登记。
 *
 * 页面刻意分成两页签：
 *   ·「网段」看的是**容量**（这个段有多少地址、还剩几个、跟哪个段重叠）；
 *   ·「IP 登记」看的是**明细**（哪个地址给了谁）。
 * 混在一张表里会出现「一行是网段、一行是 IP」这种扫视灾难。
 *
 * 校验一律以后端为准（归属判断、判重都在服务端做一遍），前端这里只做
 * 明显的即时提示（比如批量登记先 dry_run 预览），避免「前端说没问题、提交后被拒」。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  const STATUS_BADGE = { used: 'ok', reserved: 'warn', free: 'muted', conflict: 'err' };

  /* 各表单「有没有改动」的比较字段（白名单：id 与导出的预览结果都不算改动） */
  const SEG_KEYS = ['name', 'cidr', 'gateway', 'vlan', 'location', 'note'];
  const IP_KEYS = ['segment_id', 'ip', 'status', 'hostname', 'owner', 'device_type', 'mac', 'note'];
  // ★ 批量登记只认 text 与几个下拉：preview / result 是点了「预览」之后由接口回的派生数据，
  //   若把它们算进改动里，光是预览一下再关窗口也会被拦下来问一次。
  const BULK_KEYS = ['segment_id', 'status', 'owner', 'device_type', 'text'];

  V.IpamView = {
    template: `
    <div>
      <div class="page-head">
        <div>
          <h2>IP 管理</h2>
          <div class="muted">先建立网段，再按网段登记已使用的地址；系统负责判断归属、判重与统计剩余可用地址。</div>
        </div>
        <div class="page-actions">
          <button v-if="canManage" class="btn btn-outline" @click="openBulk">批量登记</button>
          <button v-if="canManage" class="btn btn-outline" @click="openSegForm(null)">新增网段</button>
          <button v-if="canManage" class="btn btn-primary" :disabled="!segs.length" @click="openIpForm(null)">登记 IP</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card">
          <div class="bar bar-blue"></div>
          <div class="num">{{ summary.segments || 0 }}</div>
          <div class="lbl">已建网段</div>
        </div>
        <div class="stat-card">
          <div class="bar bar-gray"></div>
          <div class="num">{{ summary.host_count || 0 }}</div>
          <div class="lbl">地址容量（各段合计）</div>
        </div>
        <div class="stat-card">
          <div class="bar bar-blue"></div>
          <div class="num">{{ summary.registered || 0 }}</div>
          <div class="lbl">已登记</div>
          <!-- 终端资产那部分不落库、不算「登记」，但确实占了地址 —— 单独标出来，
               否则用户会觉得「已登记 0 条，怎么剩余地址少了这么多」 -->
          <div class="cell-sub" v-if="summary.terminal_only">+ 终端资产 {{ summary.terminal_only }}</div>
        </div>
        <div class="stat-card">
          <div class="bar bar-green"></div>
          <div class="num">{{ summary.used || 0 }}</div>
          <div class="lbl">标记为已使用</div>
        </div>
        <div class="stat-card" :class="{ warn: (summary.conflict || 0) > 0 }">
          <div class="bar bar-red"></div>
          <div class="num">{{ summary.conflict || 0 }}</div>
          <div class="lbl">冲突待处理</div>
        </div>
      </div>

      <div class="filter-bar">
        <div class="seg">
          <button class="seg-btn" :class="{ on: tab === 'seg' }" @click="tab = 'seg'">网段（{{ segs.length }}）</button>
          <button class="seg-btn" :class="{ on: tab === 'ip' }" @click="tab = 'ip'; loadIps()">IP 登记（{{ ipTotal }}）</button>
          <button class="seg-btn" :class="{ on: tab === 'map' }" @click="tab = 'map'; loadMap()">地址分布图</button>
        </div>
        <div class="grow"></div>
        <button class="btn btn-outline" @click="refreshAll">刷新</button>
      </div>

      <!-- ============ 网段 ============ -->
      <div class="card card-flush" v-if="tab === 'seg'">
        <div class="table-wrap">
          <table class="tbl ip-table">
            <thead>
              <tr>
                <th class="c-name">网段名称</th>
                <th class="c-cidr">CIDR</th>
                <th class="c-gw">网关</th>
                <th class="c-vlan">VLAN</th>
                <th class="c-loc">位置</th>
                <th class="c-cap">地址容量</th>
                <th class="c-use">使用情况</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loadingSeg"><td colspan="8" class="empty-row">加载中…</td></tr>
              <tr v-else-if="!segs.length">
                <td colspan="8" class="empty-row">
                  还没有网段。{{ canManage ? '点右上角「新增网段」先建一个（如 192.168.10.0/24）。' : '请联系管理员建立网段。' }}
                </td>
              </tr>
              <tr v-for="s in segs" :key="s.id">
                <td>
                  <span class="cell-strong">{{ s.name }}</span>
                  <span class="cell-sub" v-if="s.note">{{ s.note }}</span>
                  <span class="cell-sub warn-text" v-if="s.overlaps && s.overlaps.length">
                    与「{{ s.overlaps.join('、') }}」范围重叠
                  </span>
                </td>
                <td>
                  <span class="mono cell-strong">{{ s.cidr }}</span>
                  <span class="cell-sub mono">{{ s.first_host }} ~ {{ s.last_host }}</span>
                </td>
                <td><span class="mono" v-if="s.gateway">{{ s.gateway }}</span><span v-else class="muted">—</span></td>
                <td><span v-if="s.vlan" class="chip">{{ s.vlan }}</span><span v-else class="muted">—</span></td>
                <td><span class="cell-sub">{{ s.location || '—' }}</span></td>
                <td class="num">
                  {{ s.host_count }}
                  <span class="cell-sub">可用地址</span>
                </td>
                <td>
                  <div class="ip-usage">
                    <div class="ip-track"><div :class="usageClass(s)" :style="usageStyle(s)"></div></div>
                    <span class="ip-pct">{{ pct(s) }}%</span>
                  </div>
                  <span class="cell-sub">
                    已登记 {{ s.registered }} · 剩余 {{ s.free_count }}
                    <template v-if="s.conflict"> · <b class="err-text">冲突 {{ s.conflict }}</b></template>
                  </span>
                  <span class="cell-sub" v-if="s.terminal_only">
                    其中 {{ s.terminal_only }} 个已被终端资产占用（未登记）
                  </span>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-outline" @click="openFree(s)">空闲地址</button>
                  <template v-if="canManage">
                    <button class="btn btn-sm btn-outline" @click="openSegForm(s)">编辑</button>
                    <button class="btn btn-sm btn-outline btn-danger" @click="delSeg(s)">删除</button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint">
          使用率 = 标记为「已使用」的条数 ÷ 该网段可用地址数（/31 与 /32 不扣网络/广播地址）。
          「范围重叠」只作提示不拦：全院 /16 与科室 /24 并存时，同一个地址在两层都登记是合理的。
        </div>
      </div>

      <!-- ============ IP 登记 ============ -->
      <div v-show="tab === 'ip'">
        <div class="filter-bar">
          <select class="ipt" v-model="fSeg" @change="page = 1; loadIps()">
            <option :value="0">全部网段</option>
            <option v-for="s in segs" :key="s.id" :value="s.id">{{ s.name }}（{{ s.cidr }}）</option>
          </select>
          <select class="ipt" v-model="fStatus" @change="page = 1; loadIps()">
            <option value="">全部状态</option>
            <option v-for="st in statuses" :key="st.code" :value="st.code">{{ st.label }}</option>
          </select>
          <select class="ipt" v-model="fSource" @change="page = 1; loadIps()">
            <option value="">全部来源</option>
            <option value="manual">手工登记</option>
            <option value="terminal">终端资产</option>
          </select>
          <input class="ipt grow" v-model="kw" placeholder="搜索 IP / 主机名 / 使用人 / MAC / 备注" @keyup.enter="page = 1; loadIps()">
          <button class="btn btn-outline" @click="page = 1; loadIps()">查询</button>
          <button class="btn btn-outline" @click="resetIp">重置</button>
        </div>

        <div class="card card-flush">
          <div class="table-wrap">
            <table class="tbl ip-table">
              <thead>
                <tr>
                  <th class="c-ip">IP 地址</th>
                  <th class="c-st">状态</th>
                  <th class="c-host">主机名 / 用途</th>
                  <th class="c-owner">使用人 / 科室</th>
                  <th class="c-type">设备类型</th>
                  <th class="c-mac">MAC</th>
                  <th class="c-note">备注</th>
                  <th class="c-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loadingIp"><td colspan="8" class="empty-row">加载中…</td></tr>
                <tr v-else-if="!ips.length">
                  <td colspan="8" class="empty-row">
                    没有匹配的登记。{{ canManage && segs.length ? '可点右上角「登记 IP」或「批量登记」。' : '' }}
                  </td>
                </tr>
                <tr v-for="r in ips" :key="r.id">
                  <td>
                    <span class="mono cell-strong">{{ r.ip }}</span>
                    <!-- 来源标签贴在 IP 同一行：放第二行会把「网段名」挤到第三行，
                         130px 的列宽装不下，看着像排版坏了 -->
                    <span v-if="r.source === 'terminal'" class="chip chip-term">终端</span>
                    <span class="cell-sub">{{ segmentLabel(r.segment_id) }}</span>
                  </td>
                  <td><span class="dev-badge" :class="badgeOf(r.status)">{{ r.status_label }}</span></td>
                  <td>
                    <span class="cell-strong">{{ r.hostname || '—' }}</span>
                    <span class="cell-sub" v-if="r.hostname && r.device && r.device.name && r.hostname !== r.device.name">
                      {{ r.device.name }}
                    </span>
                  </td>
                  <!-- 终端行的「使用人」取自台账的科室（Excel 21 列里没有责任人这一项），
                       比显示一个「—」有用得多 -->
                  <td><span class="cell-sub">{{ r.owner || (r.device && r.device.department) || '—' }}</span></td>
                  <!-- 类型优先显示台账的「统计类别」（台式计算机 / 黑白打印机），比大类的「PC」具体 -->
                  <td><span class="cell-sub">{{ (r.device && r.device.stat_category) || r.device_type || '—' }}</span></td>
                  <td><span class="mono">{{ r.mac || '—' }}</span></td>
                  <td><span class="cell-sub">{{ r.note || '—' }}</span></td>
                  <td class="ops">
                    <!-- 终端资产那条：只在终端资产里维护，这里不给编辑/删除，
                         否则会出现「这边删了、那边还在」的两份数据 -->
                    <template v-if="r.source === 'terminal'">
                      <button class="btn btn-sm btn-outline" @click="openTerminal(r)">查看设备</button>
                    </template>
                    <template v-else-if="canManage">
                      <button class="btn btn-sm btn-outline" @click="openIpForm(r)">编辑</button>
                      <button class="btn btn-sm btn-outline btn-danger" @click="delIp(r)">删除</button>
                    </template>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
              <tfoot v-if="ips.length">
                <tr>
                  <td colspan="2">本页 {{ ips.length }} 条</td>
                  <td colspan="6">
                    全部 {{ ipTotal }} 条
                    <span v-if="ipTermTotal" class="muted">
                      （手工登记 {{ ipManualTotal }} · 终端资产 {{ ipTermTotal }}）
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="hint">
            登记时会校验：地址格式 → 是否属于所选网段 → 同一网段内是否已登记。
            同一地址若同时落在另一个网段内，会给出提示但不拦截。
          </div>
          <div class="hint" v-if="ipTermTotal">
            标了「终端」的这些行来自【终端资产】台账，是<b>自动同步</b>过来的，不会写进本页的登记表 ——
            设备改了 IP 或删除了，这里立刻跟着变。也因此不需要再手工登记一遍（会被拒绝并提示是哪台设备）。
            要让某个地址释放出来，请到终端资产把那台设备的「内网地址」清掉，或者直接删掉那台设备。
          </div>
          <div class="hint" v-if="mergeNote">{{ mergeNote }}</div>
        </div>

        <div class="pager" v-if="ipTotal > pageSize">
          <span class="muted">第 {{ page }} / {{ pageCount }} 页</span>
          <button class="btn btn-sm btn-outline" :disabled="page <= 1" @click="goto(page - 1)">上一页</button>
          <button class="btn btn-sm btn-outline" :disabled="page >= pageCount" @click="goto(page + 1)">下一页</button>
        </div>
      </div>

      <!-- ============ 地址分布图 ============ -->
      <!-- 表格回答「这个地址给了谁」，图回答「这一段还剩多少、哪里快满」。
           两块信息互补，所以是第三个页签而不是塞进上面两张表。 -->
      <div v-show="tab === 'map'">
        <div class="card">
          <div class="card-title">
            <span>各网段使用率</span>
            <span class="muted">按「已使用」条数 ÷ 该网段可用地址数</span>
          </div>
          <div v-if="!segs.length" class="muted">还没有网段，先到「网段」页签建一个。</div>
          <div v-else class="ipmap-bars">
            <div v-for="s in segs" :key="s.id" class="ipmap-bar-row" @click="jumpSeg(s)">
              <span class="ipmap-bar-name" :title="s.name + '（' + s.cidr + '）'">{{ s.name }}</span>
              <span class="ipmap-bar-track"><i :class="usageClass(s)" :style="usageStyle(s)"></i></span>
              <span class="ipmap-bar-pct" :class="{ hot: pct(s) >= 90 }">{{ pct(s) }}%</span>
              <span class="ipmap-bar-num mono">{{ s.used }} / {{ s.host_count }}</span>
            </div>
          </div>
          <div class="ipmap-legend">
            <span class="ipmap-key"><i class="k-free"></i>空闲（未登记）</span>
            <span class="ipmap-key"><i class="k-used"></i>已使用</span>
            <span class="ipmap-key"><i class="k-reserved"></i>保留</span>
            <span class="ipmap-key"><i class="k-conflict"></i>冲突</span>
            <span class="ipmap-key"><i class="k-net"></i>网络 / 广播地址</span>
          </div>
          <div class="hint">「已使用」里包含【终端资产】里登记了 IP 的设备 —— 那些地址没写进本页的登记表，但确实被占着，悬停能看到是哪台机器。</div>
        </div>

        <div v-if="loadingMap" class="card muted">正在生成地址分布…</div>
        <div v-else-if="!maps.length" class="card muted">还没有网段，建好网段后这里会按网段逐张画出地址占用情况。</div>

        <div v-for="m in maps" :key="m.id" class="card">
          <div class="card-title">
            <span>
              {{ m.name }}
              <span class="mono muted">{{ m.cidr }}</span>
            </span>
            <span class="muted">
              {{ m.mode === 'ip' ? '逐地址' : (m.mode === 'block' ? '按 /24 聚合' : '仅统计') }} ·
              可用 {{ m.host_count }} · 已登记 {{ m.registered }} · 剩余 {{ m.free_count }}
              <template v-if="m.terminal_only"> · 终端 {{ m.terminal_only }}</template>
              <template v-if="m.conflict"> · <b class="err-text">冲突 {{ m.conflict }}</b></template>
            </span>
          </div>

          <div v-if="m.mode === 'none'" class="hint">{{ m.note }}</div>

          <template v-else>
            <div class="ipmap-grid" :class="{ dense: m.cells.length > 1024 }" :style="gridStyle(m)">
              <span v-for="c in m.cells" :key="c.ip"
                    class="ipmap-cell" :class="[cellClass(c), { reg: c.reg }]"
                    :title="c.tip" @click="onCell(m, c)">{{ c.label }}</span>
            </div>
            <div class="hint">
              <template v-if="m.mode === 'ip'">
                每格一个地址，格内数字是该 IPv4 的最后一段（.0 / .16 / .32 正好是每行开头）。
                有底色的格子表示已被占用（含终端资产占的），点一下可跳到「IP 登记」查它的归属。
              </template>
              <template v-else>
                每格一个 /24，格内数字是该 /24 里已占用的个数（含终端资产，格子太小时不显示数字）。
                鼠标停上去能看到具体是哪一段。
              </template>
              <template v-if="m.truncated"> · 该网段登记条数超过单次读取上限，图中没有画全。</template>
            </div>
          </template>
        </div>
      </div>

      <!-- ============ 网段表单 ============
           ★ 表单弹窗一律不写 @click.self（点遮罩不关闭），退出走 ✕ / 取消 + 未保存确认 -->
      <div class="modal-mask" v-if="segForm">
        <div class="modal" style="width:560px">
          <div class="modal-head">{{ segForm.id ? '编辑网段' : '新增网段' }}<span class="modal-close" @click="tryCloseSeg">✕</span></div>
          <div class="modal-body">
            <div class="form-item">
              <label>网段名称 *</label>
              <input v-model="segForm.name" placeholder="如：门诊内网 / 住院楼无线">
            </div>
            <div class="form-item">
              <label>CIDR *</label>
              <input class="mono" v-model="segForm.cidr" placeholder="192.168.10.0/24">
              <div class="muted" v-if="segForm.id">缩小掩码会把已登记的地址甩出网段，这种情况会被拒绝并列出是哪几条。</div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>网关</label>
                <input class="mono" v-model="segForm.gateway" placeholder="192.168.10.1">
              </div>
              <div class="form-item">
                <label>VLAN</label>
                <input v-model="segForm.vlan" placeholder="如 10">
              </div>
            </div>
            <div class="form-item">
              <label>位置 / 归属</label>
              <input v-model="segForm.location" placeholder="如：门诊楼 3F 弱电间">
            </div>
            <div class="form-item">
              <label>备注</label>
              <textarea rows="2" v-model="segForm.note"></textarea>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="tryCloseSeg">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveSeg">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- ============ IP 表单 ============ -->
      <div class="modal-mask" v-if="ipForm">
        <div class="modal" style="width:600px">
          <div class="modal-head">{{ ipForm.id ? '编辑登记' : '登记 IP' }}<span class="modal-close" @click="tryCloseIp">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item">
                <label>所属网段 *</label>
                <select v-model="ipForm.segment_id">
                  <option v-for="s in segs" :key="s.id" :value="s.id">{{ s.name }}（{{ s.cidr }}）</option>
                </select>
              </div>
              <div class="form-item">
                <label>IP 地址 *</label>
                <input class="mono" v-model="ipForm.ip" placeholder="192.168.10.20">
              </div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>状态</label>
                <select v-model="ipForm.status">
                  <option v-for="st in statuses" :key="st.code" :value="st.code">{{ st.label }}</option>
                </select>
              </div>
              <div class="form-item">
                <label>设备类型</label>
                <input v-model="ipForm.device_type" placeholder="如：打印机 / 摄像头 / PC">
              </div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>主机名 / 用途</label>
                <input v-model="ipForm.hostname" placeholder="如：门诊自助机 3 号">
              </div>
              <div class="form-item">
                <label>使用人 / 科室</label>
                <input v-model="ipForm.owner" placeholder="如：门诊办 张工">
              </div>
            </div>
            <div class="form-item">
              <label>MAC 地址</label>
              <input class="mono" v-model="ipForm.mac" placeholder="00-1A-2B-3C-4D-5E（可留空）">
            </div>
            <div class="form-item">
              <label>备注</label>
              <textarea rows="2" v-model="ipForm.note"></textarea>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="tryCloseIp">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveIp">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- ============ 批量登记 ============ -->
      <div class="modal-mask" v-if="bulkForm">
        <div class="modal" style="width:680px">
          <div class="modal-head">批量登记 IP<span class="modal-close" @click="tryCloseBulk">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item">
                <label>所属网段 *</label>
                <select v-model="bulkForm.segment_id">
                  <option v-for="s in segs" :key="s.id" :value="s.id">{{ s.name }}（{{ s.cidr }}）</option>
                </select>
              </div>
              <div class="form-item">
                <label>统一状态</label>
                <select v-model="bulkForm.status">
                  <option v-for="st in statuses" :key="st.code" :value="st.code">{{ st.label }}</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>统一使用人 / 科室</label>
                <input v-model="bulkForm.owner" placeholder="可留空，逐条在备注里写">
              </div>
              <div class="form-item">
                <label>统一设备类型</label>
                <input v-model="bulkForm.device_type">
              </div>
            </div>
            <div class="form-item">
              <label>地址清单（每行一条）</label>
              <textarea rows="7" v-model="bulkForm.text"
                placeholder="192.168.10.20 门诊自助机3号&#10;192.168.10.21-192.168.10.30 诊室 PC&#10;192.168.10.128/28 摄像头段&#10;支持逗号/顿号分隔；# 开头的行是注释"></textarea>
            </div>

            <div v-if="bulkForm.preview" class="bulk-preview">
              <div class="bulk-line">
                解析出 <b>{{ bulkForm.preview.total }}</b> 个地址，其中
                <b class="ok-text">{{ bulkForm.preview.valid }}</b> 个属于本网段
                <template v-if="bulkForm.preview.outside.length">
                  ，<b class="err-text">{{ bulkForm.preview.outside.length }}</b> 个不在本网段
                </template>
                <template v-if="bulkForm.preview.invalid.length">
                  ，<b class="err-text">{{ bulkForm.preview.invalid.length }}</b> 行无法识别
                </template>
              </div>
              <div class="bulk-chips">
                <span v-for="x in bulkForm.preview.sample" :key="x.ip"
                      :class="{ outside: !x.in_segment }">{{ x.ip }}</span>
                <span v-if="bulkForm.preview.total > bulkForm.preview.sample.length" class="muted">
                  …（仅显示前 {{ bulkForm.preview.sample.length }} 个）
                </span>
              </div>
              <div class="hint" v-if="bulkForm.preview.invalid.length">
                无法识别的行：{{ bulkForm.preview.invalid.slice(0, 5).map(i => i.text + '（' + i.reason + '）').join('；') }}
              </div>
            </div>
            <div v-else-if="bulkForm.result" class="bulk-preview">
              <div class="bulk-line">
                新增 <b class="ok-text">{{ bulkForm.result.added }}</b> 条，
                失败 <b class="err-text">{{ bulkForm.result.failed.length }}</b> 条
              </div>
              <div class="hint" v-if="bulkForm.result.failed.length">
                失败明细：{{ bulkForm.result.failed.slice(0, 8).map(f => f.ip + '（' + f.error + '）').join('；') }}
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="tryCloseBulk">关闭</button>
            <button class="btn btn-outline" :disabled="saving" @click="doBulk(true)">预览</button>
            <button class="btn btn-primary" :disabled="saving || !bulkForm.text.trim()" @click="doBulk(false)">
              {{ saving ? '处理中' : '确认登记' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ============ 空闲地址 ============ -->
      <div class="modal-mask" v-if="freeView" @click.self="freeView = null">
        <div class="modal" style="width:640px">
          <div class="modal-head">空闲地址 · {{ freeView.name }}<span class="modal-close" @click="freeView = null">✕</span></div>
          <div class="modal-body">
            <div class="bulk-line">
              {{ freeView.cidr }} · 可用 {{ freeView.host_count }} · 已登记 {{ freeView.registered }} ·
              剩余 <b class="ok-text">{{ freeView.free_count }}</b>
            </div>
            <div class="bulk-chips" v-if="freeView.ips.length">
              <span v-for="ip in freeView.ips" :key="ip">{{ ip }}</span>
            </div>
            <div v-else class="muted">该网段已没有未登记的地址。</div>
            <div class="hint" v-if="freeView.truncated">列表只显示前 {{ freeView.ips.length }} 个（按地址顺序）。</div>
            <div class="hint" v-if="freeView.terminal">
              已扣除 {{ freeView.terminal }} 个被【终端资产】占用的地址
              （其中 {{ freeView.terminal_only }} 个没有手工登记过）—— 这些地址分配出去会撞 IP。
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="freeView = null">关闭</button>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        tab: 'seg',
        segs: [], summary: {}, statuses: [],
        ips: [], ipTotal: 0, page: 1, pageSize: 100,
        fSeg: 0, fStatus: '', kw: '',
        // 来源：'' = 全部（手工登记 + 终端资产）；'manual' / 'terminal'
        fSource: '',
        ipManualTotal: 0, ipTermTotal: 0, mergeNote: '',
        // 地址分布图：每个网段一份，由后端算好格子
        maps: [],
        loadingSeg: false, loadingIp: false, loadingMap: false, saving: false,
        segForm: null, ipForm: null, bulkForm: null, freeView: null,
        // 打开表单那一刻的快照，用来判断用户后来有没有改过东西（空着关闭不弹确认）
        segBase: '', ipBase: '', bulkBase: '',
      };
    },

    computed: {
      canManage() { return !!(window.HisPerm && window.HisPerm.can('ipam.manage')); },
      pageCount() { return Math.max(1, Math.ceil(this.ipTotal / this.pageSize)); },
    },

    mounted() { this.refreshAll(); },

    methods: {
      refreshAll() {
        this.loadSegments();
        if (this.tab === 'ip') this.loadIps();
        if (this.tab === 'map') this.loadMap();
      },

      async loadSegments() {
        this.loadingSeg = true;
        try {
          const d = await api.get('/ipam/segments');
          this.segs = (d && d.list) || [];
          this.summary = (d && d.summary) || {};
          this.statuses = (d && d.statuses) || [];
          if (!this.segForm && !this.ipForm && !this.bulkForm) {
            this.loadIps();
            // 图是按网段逐张画的，得等 segs 到位之后再拉（否则会拉到上一次的网段列表）
            if (this.tab === 'map') this.loadMap();
          }
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loadingSeg = false;
        }
      },

      async loadIps() {
        this.loadingIp = true;
        try {
          const q = '?segment_id=' + (this.fSeg || 0)
            + '&status=' + encodeURIComponent(this.fStatus || '')
            + '&source=' + encodeURIComponent(this.fSource || '')
            + '&keyword=' + encodeURIComponent(this.kw || '')
            + '&page=' + this.page + '&pageSize=' + this.pageSize;
          const d = await api.get('/ipam/ips' + q);
          this.ips = (d && d.list) || [];
          this.ipTotal = (d && d.total) || 0;
          this.ipManualTotal = (d && d.manual_total) || 0;
          this.ipTermTotal = (d && d.terminal_total) || 0;
          this.mergeNote = (d && d.merge_note) || '';
          if (d && d.statuses && d.statuses.length) this.statuses = d.statuses;
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loadingIp = false;
        }
      },
      goto(p) { this.page = Math.min(Math.max(1, p), this.pageCount); this.loadIps(); },
      resetIp() {
        this.fSeg = 0; this.fStatus = ''; this.kw = ''; this.fSource = '';
        this.page = 1; this.loadIps();
      },

      /**
       * 跳到【终端资产】并打开这台设备的详情。
       * hash 路由带不了参数（`#/terminals?id=3` 会被当成视图名的一部分），
       * 所以用 sessionStorage 带一次性值，那边 mounted 读一次就删。
       */
      openTerminal(r) {
        const id = (r && (r.terminal_id || (r.device && r.device.id))) || 0;
        if (!id) return;
        try { sessionStorage.setItem('his_terminal_open', String(id)); } catch (e) { /* 隐私模式忽略 */ }
        if (window.location.hash === '#/terminals') {
          // 已经在终端资产页时改 hash 不会触发重新挂载，直接派发一次事件让那边自己刷新
          window.dispatchEvent(new CustomEvent('his:open-terminal', { detail: Number(id) }));
        } else {
          window.location.hash = '#/terminals';
        }
      },

      /* ---------- 展示辅助 ---------- */
      /**
       * 使用率 = 真被占了多少地址 / 可用地址数。
       * ★ 必须把终端资产占的算进去：否则会出现「进度条 0%、剩余 254，点开空闲地址
       *   却少了一大截」的自相矛盾 —— 用户会以为空闲地址算错了。
       */
      pct(s) {
        if (!s || !s.host_count) return '0.0';
        const occupied = (s.used || 0) + (s.terminal_only || 0);
        return Math.round(occupied / s.host_count * 1000) / 10;
      },
      usageStyle(s) {
        const p = Number(this.pct(s));
        return { width: Math.min(100, Math.max(p > 0 ? 1.5 : 0, p)) + '%' };
      },
      // 使用率超 70% 转警示、超 90% 转危险：颜色只是加强，旁边永远有具体数字
      usageClass(s) {
        const p = Number(this.pct(s));
        if (p >= 90) return 'ip-fill high';
        if (p >= 70) return 'ip-fill mid';
        return 'ip-fill';
      },
      badgeOf(status) { return STATUS_BADGE[status] || 'muted'; },
      segmentLabel(id) {
        if (!id) return '不在已登记网段';
        const s = this.segs.filter((x) => x.id === id)[0];
        return s ? s.name + '（' + s.cidr + '）' : '网段 #' + id;
      },

      /* ---------- 地址分布图 ---------- */
      /**
       * 每个网段一张图，并发拉取。
       * ★ 单个网段失败不能把整页带走：某个网段 CIDR 存坏了、或者权限被临时收紧，
       *   都应该只少一张图，而不是整页空白 —— 所以这里逐个 catch 成 null 再过滤，
       *   不用 Promise.all 的「一个 reject 全盘皆输」。
       */
      async loadMap() {
        if (!this.segs.length) { this.maps = []; return; }
        this.loadingMap = true;
        try {
          const res = await Promise.all(this.segs.map((s) =>
            api.get('/ipam/segments/' + s.id + '/map').catch(() => null)));
          this.maps = res.filter((m) => m && m.ok);
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loadingMap = false;
        }
      },

      /** 列数由后端给（16 列，或小于 16 个地址的小网段按地址数缩减） */
      gridStyle(m) {
        return { gridTemplateColumns: 'repeat(' + (m.cols || 16) + ', minmax(0, 1fr))' };
      },

      /**
       * 状态 → 格子配色类。写成方法而不是在模板里拼 `'st-' + c.state`：
       * 一是类名普查脚本会把模板里的半截字面量当成一个类名报未定义，
       * 二是以后加状态（比如「已回收」）只需要改这里一处。
       */
      cellClass(c) {
        return 'st-' + (c && c.state ? c.state : 'free');
      },

      /** 点格子 → 跳到「IP 登记」并筛出相关记录；空闲/网络/广播格子没什么可跳的 */
      onCell(m, c) {
        if (!c.reg) return;
        this.tab = 'ip';
        this.fSeg = m.id;
        this.fStatus = '';
        this.page = 1;
        // 聚合成 /24 的时候格子的 key 是个网段，直接用「前三段.」做模糊匹配更准
        this.kw = m.mode === 'block'
          ? c.ip.split('/')[0].split('.').slice(0, 3).join('.') + '.'
          : c.ip;
        this.loadIps();
      },

      jumpSeg(s) {
        this.tab = 'ip';
        this.fSeg = s.id;
        this.fStatus = '';
        this.kw = '';
        this.page = 1;
        this.loadIps();
      },

      /* ---------- 网段 ---------- */
      openSegForm(s) {
        this.segForm = s
          ? { id: s.id, name: s.name, cidr: s.cidr, gateway: s.gateway, vlan: s.vlan, location: s.location, note: s.note }
          : { id: 0, name: '', cidr: '', gateway: '', vlan: '', location: '', note: '' };
        this.segBase = HisUI.snap(this.segForm, SEG_KEYS);
      },
      /** 关闭网段表单：保存中不关；填过内容先确认（新增网段要填名称和 CIDR，误点一次就得重来） */
      tryCloseSeg() {
        if (this.saving) return;
        if (HisUI.dirty(this.segForm, this.segBase, SEG_KEYS) && !HisUI.confirmDiscard()) return;
        this.segForm = null;
      },
      async saveSeg() {
        const f = this.segForm;
        if (!f) return;
        if (!String(f.name || '').trim()) return this.$toast('请填写网段名称', 'err');
        if (!String(f.cidr || '').trim()) return this.$toast('请填写 CIDR，如 192.168.10.0/24', 'err');
        this.saving = true;
        try {
          const body = { name: f.name, cidr: f.cidr, gateway: f.gateway, vlan: f.vlan, location: f.location, note: f.note };
          if (f.id) await api.put('/ipam/segments/' + f.id, body);
          else await api.post('/ipam/segments', body);
          this.$toast('已保存', 'ok');
          this.segForm = null;
          this.loadSegments();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
      async delSeg(s) {
        if (!confirm('确定删除网段「' + s.name + '」（' + s.cidr + '）？\n网段下还有 IP 登记时无法删除。')) return;
        try {
          await api.del('/ipam/segments/' + s.id);
          this.$toast('已删除', 'ok');
          this.loadSegments();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async openFree(s) {
        try {
          const d = await api.get('/ipam/segments/' + s.id + '/free?limit=200');
          this.freeView = Object.assign({ name: s.name }, d);
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      /* ---------- IP 登记 ---------- */
      openIpForm(r) {
        if (r) {
          this.ipForm = {
            id: r.id, segment_id: r.segment_id, ip: r.ip, status: r.status,
            hostname: r.hostname, owner: r.owner, device_type: r.device_type,
            mac: r.mac, note: r.note,
          };
        } else {
          this.ipForm = {
            id: 0, segment_id: (this.fSeg || (this.segs[0] && this.segs[0].id) || 0),
            ip: '', status: 'used', hostname: '', owner: '', device_type: '', mac: '', note: '',
          };
        }
        this.ipBase = HisUI.snap(this.ipForm, IP_KEYS);
      },
      /** 关闭 IP 表单：同上，登记一条 IP 要填好几个字段，别被一次误点清掉 */
      tryCloseIp() {
        if (this.saving) return;
        if (HisUI.dirty(this.ipForm, this.ipBase, IP_KEYS) && !HisUI.confirmDiscard()) return;
        this.ipForm = null;
      },
      async saveIp() {
        const f = this.ipForm;
        if (!f) return;
        if (!f.segment_id) return this.$toast('请选择网段', 'err');
        if (!String(f.ip || '').trim()) return this.$toast('请填写 IP 地址', 'err');
        this.saving = true;
        try {
          const body = {
            segment_id: f.segment_id, ip: f.ip, status: f.status, hostname: f.hostname,
            owner: f.owner, device_type: f.device_type, mac: f.mac, note: f.note,
          };
          let r;
          if (f.id) r = await api.put('/ipam/ips/' + f.id, body);
          else r = await api.post('/ipam/ips', body);
          verifyMsg(this, r);
          this.$toast('已保存', 'ok');
          this.ipForm = null;
          this.loadSegments();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
      async delIp(r) {
        if (!confirm('确定删除 ' + r.ip + ' 的登记？')) return;
        try {
          await api.del('/ipam/ips/' + r.id);
          this.$toast('已删除', 'ok');
          this.loadSegments();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      /* ---------- 批量 ---------- */
      openBulk() {
        this.bulkForm = {
          segment_id: (this.fSeg || (this.segs[0] && this.segs[0].id) || 0),
          status: 'used', owner: '', device_type: '', text: '', preview: null, result: null,
        };
        this.bulkBase = HisUI.snap(this.bulkForm, BULK_KEYS);
      },
      /** 关闭批量登记：这里最容易出事 —— 粘贴一整段地址清单后手一抖点到外面就全没了 */
      tryCloseBulk() {
        if (this.saving) return;
        if (HisUI.dirty(this.bulkForm, this.bulkBase, BULK_KEYS) && !HisUI.confirmDiscard()) return;
        this.bulkForm = null;
      },
      async doBulk(dry) {
        const f = this.bulkForm;
        if (!f) return;
        if (!f.segment_id) return this.$toast('请选择网段', 'err');
        if (!String(f.text || '').trim()) return this.$toast('请粘贴地址清单', 'err');
        this.saving = true;
        try {
          const body = {
            segment_id: f.segment_id, text: f.text, status: f.status,
            owner: f.owner, device_type: f.device_type, dry_run: dry ? 1 : 0,
          };
          const d = await api.post('/ipam/ips/bulk', body);
          if (dry) {
            f.preview = d;
          } else {
            f.preview = null;
            f.result = d;
            // 已经落库了，之后点「关闭」不该再被当成「有未保存内容」拦一次
            this.bulkBase = HisUI.snap(f, BULK_KEYS);
            this.$toast('新增 ' + d.added + ' 条，失败 ' + d.failed.length + ' 条',
              d.failed.length ? '' : 'ok');
            this.loadSegments();
          }
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
    },
  };

  /** 接口可能带一句 warn（地址同时落在别的网段里），单独提示一下，别混进「已保存」 */
  function verifyMsg(vm, r) {
    const msg = (r && r.__msg) || '';
    if (msg) vm.$toast(msg, '');
  }
})();
