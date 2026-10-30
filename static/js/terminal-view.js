/* 终端资产台账
 *
 * 与【机房巡检 → 设备台账】的区别（页面文案里也写了，避免两个"设备"按钮让人分不清）：
 *   设备台账 = 能 WMI/SSH/SNMP 采集的服务器与网络设备，有巡检状态
 *   终端资产 = PC、打印机、自助机、叫号机 —— 装完就没人再登进去，但报障最多
 *
 * 三个刻意的交互决定：
 * 1) 每行有「报修」：把 device id 写进 sessionStorage 再跳新建工单页。
 *    不用 URL query 传参 —— 本项目是 hash 路由，`#/issue/new?device=3` 会让
 *    路由解析把整个 "new?device=3" 当成 id，得在路由层再拆一次，不如 sessionStorage 干净。
 *    新建页读一次就删，避免下次误带（详见 app.js 的 NewIssueView）。
 * 2) 详情弹窗是**只读**的，保留 @click.self（点外面就关，找信息时不用找关闭按钮）；
 *    新增/编辑是**表单**，不写 @click.self，关闭走 tryCloseForm（有改动才确认）。
 * 3) 保修状态不在这里算，用后端给的 warranty_state —— 前后端各算一遍必然口径不一致。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  /** 参与「有没有改动」比较的字段（样式 / 派生字段不列进来） */
  const FORM_KEYS = [
    'asset_no', 'name', 'kind', 'brand', 'model', 'sn', 'mac', 'ip', 'ip_extra',
    'department', 'location', 'owner', 'status', 'purchase_date', 'warranty_end',
    'vendor', 'note',
    'campus', 'area', 'floor', 'stat_category', 'nature', 'hostname',
    'os', 'cpu', 'disk', 'ram', 'monitor', 'consumable', 'produce_date',
  ];

  /** 台账登记字段（与 src/terminals.js 的 EXCEL_COLUMNS 一一对应，详情里按这个顺序显示） */
  const LEDGER_FIELDS = [
    ['campus', '院区'], ['area', '区域'], ['floor', '楼层'],
    ['stat_category', '统计类别'], ['nature', '设备性质'],
    ['hostname', '工作组/计算机名'], ['ip_extra', '外网地址'],
    ['produce_date', '生产日期'], ['os', '操作系统'], ['cpu', 'CPU'],
    ['disk', '硬盘'], ['ram', '内存'], ['monitor', '显示器尺寸'],
    ['consumable', '耗材型号'],
  ];

  /** 工单状态的样式类（工单页用的是 pending/processing/resolved/closed 四档） */
  const ISSUE_TAG = { pending: 'tag-pending', processing: 'tag-processing', resolved: 'tag-resolved', closed: 'tag-closed' };
  const ISSUE_TEXT = { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };

  V.TerminalView = {
    template: `
    <div>
      <div class="page-head">
        <div>
          <h2>终端资产</h2>
          <div class="muted">
            PC、打印机、自助机、叫号机这类「装完就不再登进去」的设备。报障时可直接挂到具体设备上，
            保修到期会提前提示。
          </div>
        </div>
        <div class="page-actions">
          <span class="dev-badge muted">共 {{ stats.total }} 台</span>
          <!-- 导入/导出：导入要 manage；导出本质是「查看」，有 view 就够用 -->
          <button v-if="canManage" class="btn btn-outline" @click="pickFile">导入</button>
          <button class="btn btn-outline" @click="exportXlsx">导出</button>
          <button v-if="canManage" class="btn btn-primary" @click="openForm(null)">新增设备</button>
          <input ref="fileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onFilePicked">
        </div>
      </div>

      <div class="stat-strip">
        <div class="stat-cell"><div class="k">在用</div><div class="v ok">{{ stats.in_use }}</div></div>
        <div class="stat-cell"><div class="k">维修中</div><div class="v warn">{{ stats.repairing }}</div></div>
        <div class="stat-cell"><div class="k">已过保</div><div class="v bad">{{ stats.expired }}</div></div>
        <div class="stat-cell"><div class="k">保修将到期</div><div class="v warn">{{ stats.soon }}</div></div>
        <div class="stat-cell"><div class="k">未登记保修</div><div class="v">{{ stats.no_warranty }}</div></div>
        <div class="stat-cell"><div class="k">已报废</div><div class="v">{{ stats.scrapped }}</div></div>
      </div>

      <div class="filter-bar">
        <input class="ipt grow" v-model="kw" @keyup.enter="search"
               placeholder="搜索资产号 / 名称 / SN / MAC / IP / 科室 / 位置 / 责任人">
        <select class="ipt" v-model="fDept" @change="search">
          <option value="">全部科室</option>
          <option v-for="d in deptOptions" :key="d" :value="d">{{ d }}</option>
        </select>
        <select class="ipt" v-model="fKind" @change="search">
          <option value="">全部类型</option>
          <option v-for="k in metaKinds" :key="k" :value="k">{{ k }}</option>
        </select>
        <select class="ipt" v-model="fStatus" @change="search">
          <option value="">全部状态</option>
          <option v-for="s in metaStatuses" :key="s" :value="s">{{ s }}</option>
        </select>
        <select class="ipt" v-model="fWarranty" @change="search">
          <option value="">全部保修</option>
          <option value="expired">已过保</option>
          <option value="soon">30 天内到期</option>
          <option value="none">未登记</option>
        </select>
        <button class="btn btn-outline" @click="search">查询</button>
        <button class="btn btn-outline" @click="reset">重置</button>
      </div>

      <div class="card card-flush">
        <div class="table-wrap">
          <table class="tbl term-table">
            <thead>
              <tr>
                <th class="c-dev">设备</th>
                <th>类型</th>
                <th class="c-dept">科室 / 位置</th>
                <th>责任人</th>
                <th>IP</th>
                <th class="c-warranty">保修</th>
                <th>报修</th>
                <th>状态</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading"><td colspan="9" class="empty-row">加载中…</td></tr>
              <tr v-else-if="!list.length">
                <td colspan="9" class="empty-row">
                  没有符合条件的设备。{{ canManage ? '点右上角「新增设备」录入第一台。' : '请联系管理员录入。' }}
                </td>
              </tr>
              <tr v-for="r in list" :key="r.id">
                <td>
                  <span class="cell-strong term-name" @click="openDetail(r)">{{ r.name }}</span>
                  <span class="cell-sub">
                    {{ r.asset_no || '无资产号' }}<template v-if="r.brand || r.model"> · {{ r.brand }} {{ r.model }}</template>
                  </span>
                </td>
                <td><span class="chip">{{ r.kind }}</span></td>
                <td>
                  <span class="cell-strong">{{ r.department || '未填科室' }}</span>
                  <span class="cell-sub">{{ r.location || '未填位置' }}</span>
                </td>
                <td>{{ r.owner || '—' }}</td>
                <td><span class="mono">{{ r.ip || '—' }}</span></td>
                <td>
                  <span class="tag" :class="warrantyTag(r)">{{ r.warranty_text }}</span>
                  <span class="cell-sub" v-if="r.warranty_end">{{ r.warranty_end }}</span>
                </td>
                <td>
                  <span v-if="r.issue_count" class="term-issues" @click="openDetail(r)"
                        :title="'这台设备的报修记录，最近一次 ' + (r.last_issue_at || '未知')">
                    {{ r.issue_count }} 次<template v-if="r.open_issue_count">（{{ r.open_issue_count }} 未结）</template>
                  </span>
                  <span v-else class="muted">—</span>
                </td>
                <td><span class="tag" :class="statusTag(r.status)">{{ r.status }}</span></td>
                <td class="ops">
                  <button v-if="canReport" class="btn btn-sm btn-outline" @click="reportFault(r)"
                          :disabled="r.status === '报废'" :title="r.status === '报废' ? '报废设备不再接受报修' : '带着这台设备去填工单'">报修</button>
                  <button class="btn btn-sm btn-outline" @click="openDetail(r)">详情</button>
                  <!-- 删除刻意不放列表：九列已经排满，再加一个按钮就会被裁掉半个（功能不可见等于没有），
                       而且删除是低频高危操作，放在详情里还能顺手把「有 N 张工单会解绑」说清楚 -->
                  <button v-if="canManage" class="btn btn-sm btn-outline" @click="openForm(r)">编辑</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint">
          默认按科室与位置排 —— 现场找人时是按「哪个科、哪一层」找的，不是按录入时间。
          点设备名看详情与这台机器的全部报修记录。
        </div>
      </div>

      <div class="pager" v-if="total > pageSize">
        <button class="btn btn-sm btn-outline" :disabled="page<=1" @click="go(page-1)">上一页</button>
        <span class="muted">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 台</span>
        <button class="btn btn-sm btn-outline" :disabled="page>=pageCount" @click="go(page+1)">下一页</button>
      </div>

      <!-- 详情（只读，点外面可以关） -->
      <div class="modal-mask" v-if="detail" @click.self="detail = null">
        <div class="modal" style="width:760px">
          <div class="modal-head">{{ detail.name }}<span class="modal-close" @click="detail = null">✕</span></div>
          <div class="modal-body">
            <div class="term-info">
              <div class="ti"><div class="k">资产号</div><div class="v">{{ detail.asset_no || '—' }}</div></div>
              <div class="ti"><div class="k">类型</div><div class="v">{{ detail.kind }}</div></div>
              <div class="ti"><div class="k">品牌 / 型号</div><div class="v">{{ (detail.brand || '—') + ' ' + (detail.model || '') }}</div></div>
              <div class="ti"><div class="k">序列号</div><div class="v mono">{{ detail.sn || '—' }}</div></div>
              <div class="ti"><div class="k">MAC</div><div class="v mono">{{ detail.mac || '—' }}</div></div>
              <div class="ti"><div class="k">IP</div><div class="v mono">{{ detail.ip || '—' }}</div></div>
              <div class="ti"><div class="k">科室</div><div class="v">{{ detail.department || '—' }}</div></div>
              <div class="ti"><div class="k">位置</div><div class="v">{{ detail.location || '—' }}</div></div>
              <div class="ti"><div class="k">责任人</div><div class="v">{{ detail.owner || '—' }}</div></div>
              <div class="ti"><div class="k">状态</div><div class="v"><span class="tag" :class="statusTag(detail.status)">{{ detail.status }}</span></div></div>
              <div class="ti"><div class="k">采购日期</div><div class="v">{{ detail.purchase_date || '—' }}</div></div>
              <div class="ti"><div class="k">保修至</div><div class="v">
                <span class="tag" :class="warrantyTag(detail)">{{ detail.warranty_text }}</span>
                <span class="muted" v-if="detail.warranty_end">（{{ detail.warranty_end }}）</span>
              </div></div>
              <div class="ti"><div class="k">供应商</div><div class="v">{{ detail.vendor || '—' }}</div></div>
              <div class="ti"><div class="k">登记人</div><div class="v">{{ detail.creator_name || '—' }}</div></div>
            </div>
            <!-- 台账登记信息：只在有内容时显示，手工录的设备不会平白多出一整块「—」 -->
            <div class="section-block" v-if="hasLedger(detail)">
              <div class="sec-title">台账登记信息
                <span class="muted" v-if="detail.src_sheet" style="font-weight:400;font-size:12px">
                  来自导入「{{ detail.src_sheet }}」表{{ detail.import_at ? '（' + detail.import_at.slice(0, 10) + '）' : '' }}
                </span>
              </div>
              <div class="term-info">
                <div class="ti" v-for="f in ledgerFields" :key="f[0]">
                  <div class="k">{{ f[1] }}</div>
                  <div class="v" :class="{ mono: f[0] === 'hostname' || f[0] === 'ip_extra' }">{{ detail[f[0]] || '—' }}</div>
                </div>
              </div>
            </div>
            <div class="section-block" v-if="detail.note">
              <div class="sec-title">备注</div>
              <div class="sep">{{ detail.note }}</div>
            </div>
            <div class="section-block">
              <div class="sec-title">历史工单（{{ detail.issues.length }} 张）</div>
              <div class="table-wrap" v-if="detail.issues.length">
                <table class="tbl">
                  <thead><tr><th>单号</th><th>标题</th><th>报障时间</th><th>处理人</th><th>状态</th></tr></thead>
                  <tbody>
                    <tr v-for="it in detail.issues" :key="it.id" class="row-link" @click="jumpIssue(it)">
                      <td class="mono">{{ it.no }}</td>
                      <td>{{ it.title }}</td>
                      <td>{{ it.report_time || '—' }}</td>
                      <td>{{ it.assignee_name || '未指派' }}</td>
                      <td><span class="tag" :class="issueTag(it.status)">{{ issueText(it.status) }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="file-empty" v-else>这台设备还没有报修记录</div>
            </div>
          </div>
          <div class="modal-foot">
            <button v-if="canManage" class="btn btn-outline btn-danger" @click="del(detail)">删除设备</button>
            <button v-if="canReport && detail.status !== '报废'" class="btn btn-primary" @click="reportFault(detail); detail = null">为这台设备报修</button>
            <button class="btn btn-outline" @click="detail = null">关闭</button>
          </div>
        </div>
      </div>

      <!-- 新增 / 编辑
           ★ 表单弹窗不写 @click.self：点到外面的遮罩层不该把填了一半的内容清掉。 -->
      <div class="modal-mask" v-if="form">
        <div class="modal" style="width:680px">
          <div class="modal-head">{{ form.id ? '编辑设备' : '新增设备' }}<span class="modal-close" @click="tryCloseForm">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item" :class="{ 'is-bad': badField === 'name' }">
                <label>设备名称 *</label>
                <input class="ipt" v-model="form.name" @input="badField = ''"
                       placeholder="写清位置，如「门诊3号诊室工作站」">
                <div class="field-err" v-if="badField === 'name'">必填：写清位置，以后报修时才认得出是哪台</div>
              </div>
              <div class="form-item"><label>资产号</label>
                <input class="ipt" v-model="form.asset_no" placeholder="贴机器上那张资产标签"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>类型</label>
                <select class="ipt" v-model="form.kind"><option v-for="k in metaKinds" :key="k" :value="k">{{ k }}</option></select>
              </div>
              <div class="form-item"><label>状态</label>
                <select class="ipt" v-model="form.status"><option v-for="s in metaStatuses" :key="s" :value="s">{{ s }}</option></select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>品牌</label><input class="ipt" v-model="form.brand" placeholder="如 联想"></div>
              <div class="form-item"><label>型号</label><input class="ipt" v-model="form.model" placeholder="如 M720t"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>序列号 SN</label><input class="ipt" v-model="form.sn"></div>
              <div class="form-item"><label>MAC 地址</label><input class="ipt" v-model="form.mac" placeholder="AA-BB-CC-11-22-33"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>IP 地址</label><input class="ipt" v-model="form.ip" placeholder="如 10.20.30.41"></div>
              <div class="form-item"><label>责任人</label><input class="ipt" v-model="form.owner" placeholder="使用这台机器的人"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>科室</label>
                <input class="ipt" v-model="form.department" list="term-dept-list" placeholder="如 门诊部">
                <datalist id="term-dept-list"><option v-for="d in deptOptions" :key="d" :value="d"></option></datalist>
              </div>
              <div class="form-item"><label>具体位置</label><input class="ipt" v-model="form.location" placeholder="如 门诊楼3层3诊室"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>采购日期</label><input class="ipt" type="date" v-model="form.purchase_date"></div>
              <div class="form-item"><label>保修至</label><input class="ipt" type="date" v-model="form.warranty_end"></div>
            </div>
            <div class="form-item"><label>供应商</label><input class="ipt" v-model="form.vendor" placeholder="报修时找谁"></div>
            <div class="form-item"><label>备注</label>
              <textarea class="ipt" v-model="form.note" style="min-height:70px" placeholder="如：键盘鼠标已换过一次；系统由信息科统一装机"></textarea>
            </div>

            <!-- 台账登记信息：与信息科那份《信息设备台账》Excel 的列一一对应，
                 「导入」写的就是这些字段。手填当然也可以，只是大部分情况靠导入。 -->
            <div class="sec-title" style="margin-top:8px">台账登记信息<span class="muted" style="font-weight:400;font-size:12px">（导入 Excel 时自动填，也可以手填）</span></div>
            <div class="form-row">
              <div class="form-item"><label>院区</label>
                <input class="ipt" v-model="form.campus" list="term-campus-list" placeholder="如 珠江街道">
                <datalist id="term-campus-list"><option v-for="v in metaCampuses" :key="v" :value="v"></option></datalist>
              </div>
              <div class="form-item"><label>区域</label>
                <input class="ipt" v-model="form.area" list="term-area-list" placeholder="如 门诊楼">
                <datalist id="term-area-list"><option v-for="v in metaAreas" :key="v" :value="v"></option></datalist>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>楼层</label>
                <input class="ipt" v-model="form.floor" list="term-floor-list" placeholder="如 三楼">
                <datalist id="term-floor-list"><option v-for="v in metaFloors" :key="v" :value="v"></option></datalist>
              </div>
              <div class="form-item"><label>统计类别</label>
                <input class="ipt" v-model="form.stat_category" list="term-stat-list" placeholder="如 台式计算机 / 黑白打印机">
                <datalist id="term-stat-list"><option v-for="v in metaStatCats" :key="v" :value="v"></option></datalist>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>设备性质</label>
                <input class="ipt" v-model="form.nature" list="term-nature-list" placeholder="如 政府采购设备 / 租赁设备">
                <datalist id="term-nature-list"><option v-for="v in metaNatures" :key="v" :value="v"></option></datalist>
              </div>
              <div class="form-item"><label>工作组 / 计算机名</label><input class="ipt" v-model="form.hostname" placeholder="如 DESKTOP-3TQGIDB"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>外网地址</label><input class="ipt" v-model="form.ip_extra" placeholder="如 10.10.10.248"></div>
              <div class="form-item"><label>生产日期</label><input class="ipt" type="date" v-model="form.produce_date"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>操作系统</label><input class="ipt" v-model="form.os" placeholder="如 Windows 10"></div>
              <div class="form-item"><label>CPU</label><input class="ipt" v-model="form.cpu" placeholder="如 Intel Core i5-7500"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>硬盘</label><input class="ipt" v-model="form.disk" placeholder="如 256G+1T"></div>
              <div class="form-item"><label>内存</label><input class="ipt" v-model="form.ram" placeholder="如 DDR4 - 8G"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>显示器尺寸</label><input class="ipt" v-model="form.monitor" placeholder="如 Lenovo-LCD 20'"></div>
              <div class="form-item"><label>耗材型号</label><input class="ipt" v-model="form.consumable" placeholder="打印机的硒鼓/墨盒，如 T7741"></div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="tryCloseForm">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- 导入：先 dryRun 预览，确认后才写库。
           这是表单类弹窗之外的「只读预览」，点外面关掉不会有损失，所以保留 @click.self。 -->
      <div class="modal-mask" v-if="imp && imp.preview" @click.self="closeImp">
        <div class="modal" style="width:860px">
          <div class="modal-head">导入终端资产 · 预览<span class="modal-close" @click="closeImp">✕</span></div>
          <div class="modal-body">
            <div class="imp-file muted">
              文件：{{ imp.filename }}
              <span v-if="imp.sheets_scanned && imp.sheets_scanned.length">
                ｜ {{ imp.sheets_scanned.map(function(s){ return s.sheet + (s.skipped ? '（跳过）' : ' ' + s.rows + ' 行'); }).join('、') }}
              </span>
            </div>

            <div class="imp-sum">
              <div class="imp-cell"><div class="k">读到</div><div class="v">{{ imp.preview.total }}</div></div>
              <div class="imp-cell"><div class="k">新增</div><div class="v ok">{{ imp.preview.created }}</div></div>
              <div class="imp-cell"><div class="k">合并到已有</div><div class="v warn">{{ imp.preview.updated }}</div></div>
              <div class="imp-cell"><div class="k">无变化</div><div class="v">{{ imp.preview.unchanged }}</div></div>
              <div class="imp-cell"><div class="k">信息不足</div><div class="v">{{ imp.preview.thinTotal }}</div></div>
              <div class="imp-cell"><div class="k">失败</div><div class="v bad">{{ imp.preview.failedTotal }}</div></div>
            </div>

            <div class="imp-note">
              还没有写库。<b>「合并到已有」</b>指同一台设备在文件里出现了多行，或库里已有（按 MAC → SN → 资产编码 → 科室+位置 认的），
              会并成一条；空白单元格不会覆盖系统里已有的内容。
            </div>

            <div class="section-block" v-if="imp.preview.samples && imp.preview.samples.length">
              <div class="sec-title">前 20 条会怎么处理</div>
              <div class="table-wrap">
                <table class="tbl imp-tbl">
                  <thead><tr><th>表</th><th>行</th><th>动作</th><th>设备名称</th><th>受影响的字段</th></tr></thead>
                  <tbody>
                    <tr v-for="(s, i) in imp.preview.samples.slice(0, 20)" :key="i">
                      <td class="muted">{{ s.sheet }}</td>
                      <td class="mono">{{ s.row }}</td>
                      <td><span class="tag" :class="s.action === '新增' ? 'tag-resolved' : (s.action === '更新' ? 'tag-processing' : 'tag-pending')">{{ s.action === '更新' ? '合并' : s.action }}</span></td>
                      <td>{{ s.name }}</td>
                      <td class="muted">{{ (s.changed || []).join('、') || '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="section-block" v-if="imp.preview.thinTotal">
              <div class="sec-title">信息不足的 {{ imp.preview.thinTotal }} 行（不会导入）</div>
              <div class="muted" style="font-size:12px;line-height:1.7">
                {{ imp.preview.thin.slice(0, 12).map(function(t){ return t.sheet + ' 第' + t.row + '行（' + t.hint + '）'; }).join('；') }}
                <span v-if="imp.preview.thinTotal > 12">…等 {{ imp.preview.thinTotal }} 行</span>
              </div>
              <div class="imp-note" style="margin-top:8px">
                这些行只写了科室或区域，没有位置、也没有设备类型/型号，认不出是哪台。
                在 Excel 里补上「位置」或「统计类别」再导一次即可。
              </div>
            </div>

            <div class="section-block" v-if="imp.preview.failedTotal">
              <div class="sec-title">失败的 {{ imp.preview.failedTotal }} 行</div>
              <div class="muted" style="font-size:12px;line-height:1.7">
                {{ imp.preview.failed.slice(0, 12).map(function(f){ return f.sheet + ' 第' + f.row + '行：' + f.reason; }).join('；') }}
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <select class="ipt" v-model="imp.mode" @change="repreview" style="width:190px;margin-right:auto">
              <option value="update">已有设备：合并更新</option>
              <option value="skip">已有设备：跳过不动</option>
            </select>
            <button class="btn btn-outline" @click="closeImp">取消</button>
            <button class="btn btn-primary" :disabled="impBusy || (!imp.preview.created && !imp.preview.updated)" @click="applyImp">
              {{ impBusy ? '导入中…' : ('确认导入（新增 ' + imp.preview.created + '）') }}
            </button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        list: [], total: 0, page: 1, pageSize: 50,
        kw: '', fDept: '', fKind: '', fStatus: '', fWarranty: '',
        stats: { total: 0, in_use: 0, repairing: 0, scrapped: 0, expired: 0, soon: 0, no_warranty: 0 },
        metaKinds: [], metaStatuses: [], deptOptions: [],
        metaCampuses: [], metaAreas: [], metaFloors: [], metaStatCats: [], metaNatures: [],
        loading: false, detail: null, form: null, formBase: '', saving: false,
        ledgerFields: LEDGER_FIELDS,
        // 导入：file 选好后先跑一次 dryRun 预览，用户确认了才真写库
        imp: null, impBusy: false,
        // 必填项没填时把字段本身标红并滚到眼前。
        // 只靠右上角 toast 是不够的：名称在弹窗最上方，用户填完底下的字段再点保存，
        // 视线在右下角的按钮上，顶部一闪而过的提示经常被当成「按钮坏了」。
        badField: '',
      };
    },
    computed: {
      canManage() { return !!(window.HisPerm && window.HisPerm.can('terminals.manage')); },
      canReport() { return !!(window.HisPerm && window.HisPerm.can('issues.create')); },
      pageCount() { return Math.max(1, Math.ceil(this.total / this.pageSize)); },
    },
    mounted() {
      // 从工单详情点设备名跳过来时带着关键词，直接筛出那一台（hash 路由传不了参）
      try {
        const k = sessionStorage.getItem('his_terminal_kw');
        if (k) { sessionStorage.removeItem('his_terminal_kw'); this.kw = k; }
      } catch (e) { /* 隐私模式忽略 */ }
      this.loadMeta();
      this.load();
    },
    methods: {
      async loadMeta() {
        try {
          const m = await this.$api.get('/terminals/meta');
          this.metaKinds = m.kinds || [];
          this.metaStatuses = m.statuses || [];
          this.deptOptions = m.departments || [];
          this.metaCampuses = m.campuses || [];
          this.metaAreas = m.areas || [];
          this.metaFloors = m.floors || [];
          this.metaStatCats = m.stat_categories || [];
          this.metaNatures = m.natures || [];
        } catch (e) {
          // 元数据拿不到就用兜底清单，页面还能用（否则下拉全空，连新增都做不了）
          this.metaKinds = ['PC', '笔记本', '打印机', '一体机', '自助机', '叫号机', '显示屏', '扫码枪', '投影', '网络设备', '其他'];
          this.metaStatuses = ['在用', '备用', '维修中', '借出', '报废'];
        }
      },
      async load() {
        this.loading = true;
        try {
          const q = [];
          if (this.kw.trim()) q.push('keyword=' + encodeURIComponent(this.kw.trim()));
          if (this.fDept) q.push('department=' + encodeURIComponent(this.fDept));
          if (this.fKind) q.push('kind=' + encodeURIComponent(this.fKind));
          if (this.fStatus) q.push('status=' + encodeURIComponent(this.fStatus));
          if (this.fWarranty) q.push('warranty=' + this.fWarranty);
          q.push('page=' + this.page, 'pageSize=' + this.pageSize);
          const d = await this.$api.get('/terminals?' + q.join('&'));
          this.list = d.list || [];
          this.total = d.total || 0;
          this.stats = d.stats || this.stats;
          // 科室下拉跟着台账实际内容走（新登记一个科室后立刻能筛）
          if (d.departments && d.departments.length) this.deptOptions = d.departments.map((x) => x.name);
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loading = false;
        }
      },
      search() { this.page = 1; this.load(); },
      reset() {
        this.kw = ''; this.fDept = ''; this.fKind = ''; this.fStatus = ''; this.fWarranty = '';
        this.page = 1; this.load();
      },
      go(p) { this.page = p; this.load(); },

      warrantyTag(r) {
        const m = { expired: 'tag-over', soon: 'tag-warn', ok: 'tag-ok', none: 'tag-draft' };
        return m[(r && r.warranty_state) || 'none'] || 'tag-draft';
      },
      statusTag(s) {
        const m = { 在用: 'tag-ok', 备用: 'tag-draft', 维修中: 'tag-warn', 借出: 'tag-processing', 报废: 'tag-closed' };
        return m[s] || 'tag-draft';
      },
      issueTag(s) { return ISSUE_TAG[s] || 'tag-draft'; },
      issueText(s) { return ISSUE_TEXT[s] || s; },

      async openDetail(r) {
        try {
          this.detail = await this.$api.get('/terminals/' + r.id);
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      jumpIssue(it) { location.hash = '#/issue/' + it.id; },

      /** 带着设备去报修：sessionStorage 传 id，新建页读一次就删 */
      reportFault(r) {
        if (!this.canReport) return this.$toast('当前角色不能提交工单', 'err');
        if (r.status === '报废') return this.$toast('报废设备不再接受报修', 'err');
        try { sessionStorage.setItem('his_issue_device', String(r.id)); } catch (e) { /* 隐私模式忽略 */ }
        location.hash = '#/issue/new';
      },

      /* ---------- 导入 / 导出 ---------- */

      /** 台账登记信息那块要不要显示：手工录的设备全是空，就不必平白多一块「—」 */
      hasLedger(t) {
        return !!t && LEDGER_FIELDS.some((f) => !!(t[f[0]] || '').trim());
      },

      pickFile() {
        if (!this.canManage) return this.$toast('没有导入权限', 'err');
        if (this.$refs.fileInput) this.$refs.fileInput.click();
      },

      onFilePicked(e) {
        const f = e.target.files && e.target.files[0];
        // ★ 立刻清空 value：否则选完一次后，再选同一个文件不会触发 change，用户会以为按钮坏了
        e.target.value = '';
        if (!f) return;
        if (!/\.(xlsx|xls)$/i.test(f.name)) return this.$toast('请选择 Excel 文件（.xlsx）', 'err');
        this.imp = { filename: f.name, file: f, mode: 'update', preview: null, sheets_scanned: [] };
        this.previewImp();
      },

      async previewImp() {
        const imp = this.imp;
        if (!imp || !imp.file) return;
        this.impBusy = true;
        try {
          const fd = new FormData();
          fd.append('file', imp.file, imp.filename);
          const d = await this.$api.upload('/terminals/import?dryRun=1&mode=' + imp.mode, fd);
          imp.preview = d;
          imp.sheets_scanned = d.sheets_scanned || [];
        } catch (e) {
          this.imp = null;
          this.$toast(e.message, 'err');
        } finally {
          this.impBusy = false;
        }
      },

      /** 改「已有设备怎么处理」后重算预览 —— 否则用户看到的还是切换前的数字 */
      repreview() { this.previewImp(); },

      async applyImp() {
        const imp = this.imp;
        if (!imp || this.impBusy) return;
        this.impBusy = true;
        try {
          const fd = new FormData();
          fd.append('file', imp.file, imp.filename);
          const d = await this.$api.upload('/terminals/import?mode=' + imp.mode, fd);
          this.imp = null;
          this.$toast('导入完成：新增 ' + d.created + '，合并 ' + d.updated
            + '，无变化 ' + d.unchanged + '，信息不足 ' + (d.thinTotal || 0), 'ok');
          this.loadMeta();
          this.page = 1;
          this.load();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.impBusy = false;
        }
      },

      closeImp() {
        if (this.impBusy) return;
        this.imp = null;
      },

      /** 导出：带上当前筛选条件，所见即所得；不筛选就是全量 */
      exportXlsx() {
        const q = [];
        if (this.kw.trim()) q.push('keyword=' + encodeURIComponent(this.kw.trim()));
        if (this.fDept) q.push('department=' + encodeURIComponent(this.fDept));
        if (this.fKind) q.push('kind=' + encodeURIComponent(this.fKind));
        if (this.fStatus) q.push('status=' + encodeURIComponent(this.fStatus));
        if (this.fWarranty) q.push('warranty=' + this.fWarranty);
        const qs = q.length ? ('?' + q.join('&')) : '';
        const stamp = (window.HisUtils && window.HisUtils.todayStr) ? window.HisUtils.todayStr().replace(/-/g, '') : '';
        this.$toast(q.length ? '正在导出当前筛选结果…' : '正在导出全部设备…', '');
        this.$api.download('/terminals/export' + qs, '终端资产台账_' + stamp + '.xlsx')
          .catch((e) => this.$toast(e.message, 'err'));
      },

      openForm(r) {
        this.badField = '';
        // 用 FORM_KEYS 铺底，新增一列就不必再改这里两遍
        const blank = { id: 0, kind: 'PC', status: '在用', department: (this.fDept || '') };
        FORM_KEYS.forEach((k) => { if (blank[k] === undefined) blank[k] = ''; });
        if (!r) {
          this.form = blank;
        } else {
          const one = { id: r.id };
          FORM_KEYS.forEach((k) => { one[k] = r[k] == null ? '' : r[k]; });
          this.form = one;
        }
        this.formBase = window.HisUI.snap(this.form, FORM_KEYS);
      },
      tryCloseForm() {
        if (this.saving) return;
        if (window.HisUI.dirty(this.form, this.formBase, FORM_KEYS) && !window.HisUI.confirmDiscard()) return;
        this.form = null;
      },
      async save() {
        const name = (this.form.name || '').trim();
        if (!name) {
          this.badField = 'name';
          this.$toast('请填写设备名称', 'err');
          // 字段在弹窗最上方，用户很可能已经滚到底部按的保存 —— 滚回去 + 聚焦
          this.$nextTick(() => {
            const el = document.querySelector('.modal .form-item.is-bad .ipt');
            if (!el) return;
            if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
            try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
          });
          return;
        }
        this.badField = '';
        this.saving = true;
        try {
          const body = {};
          FORM_KEYS.forEach((k) => { body[k] = this.form[k]; });
          if (this.form.id) await this.$api.put('/terminals/' + this.form.id, body);
          else await this.$api.post('/terminals', body);
          this.$toast('已保存', 'ok');
          this.form = null;
          this.loadMeta();
          this.load();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
      async del(r) {
        const n = r.issue_count || 0;
        const msg = '删除设备「' + r.name + '」？'
          + (n ? '\n\n这台设备有 ' + n + ' 张历史工单，删除后工单会保留但不再关联到设备。' : '');
        if (!confirm(msg)) return;
        try {
          const d = await this.$api.del('/terminals/' + r.id);
          this.$toast(d && d.detached_issues ? '已删除，解绑 ' + d.detached_issues + ' 张工单' : '已删除', 'ok');
          this.detail = null;   // 从详情里删的时候必须关弹窗，否则它还挂着一台已经不存在的设备
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
    },
  };
})();
