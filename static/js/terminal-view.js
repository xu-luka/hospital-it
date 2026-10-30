/* 终端资产台账
 *
 * 与【机房巡检 → 设备台账】的区别（页面文案里也写了，避免两个"设备"按钮让人分不清）：
 *   设备台账 = 能 WMI/SSH/SNMP 采集的服务器与网络设备，有巡检状态
 *   终端资产 = PC、打印机、自助机、叫号机 —— 装完就没人再登进去，但报障最多
 *
 * ★ 2026-10-30 表结构重建：字段严格照信息科那份《信息设备台账》Excel 的 21 列，
 *   系统不再自造「设备名称 / 类型 / 状态 / 责任人 / 保修至 / 采购日期 / 品牌 / 供应商 / 备注」。
 *   连带影响（都是有意的）：
 *   · 列表第一列显示「工作组/计算机名」，没有就显示「统计类别 + 型号」，再空显示资产编码
 *     —— 名字是展示出来的，不是存下来的（见 src/terminals.js 的 displayName）；
 *   · 保修相关的统计卡、列、筛选全部去掉（Excel 里没有保修这一项，留着只能靠人瞎填）；
 *   · 没有「状态/报废」：不用了的设备直接从台账删掉，IP 管理那边的地址自然释放。
 *
 * 三个刻意的交互决定：
 * 1) 每行有「报修」：把 device id 写进 sessionStorage 再跳新建工单页。
 *    不用 URL query 传参 —— 本项目是 hash 路由，`#/issue/new?device=3` 会让
 *    路由解析把整个 "new?device=3" 当成 id，得在路由层再拆一次，不如 sessionStorage 干净。
 *    新建页读一次就删，避免下次误带（详见 app.js 的 NewIssueView）。
 * 2) 详情弹窗是**只读**的，保留 @click.self（点外面就关，找信息时不用找关闭按钮）；
 *    新增/编辑是**表单**，不写 @click.self，关闭走 tryCloseForm（有改动才确认）。
 * 3) 必填校验不靠右上角 toast：弹窗顶部给一条红条 + 滚回顶部（见 badField）。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  /** 参与「有没有改动」比较的字段（21 个台账列，派生字段不列进来） */
  const FORM_KEYS = [
    'campus', 'asset_no', 'area', 'floor', 'department', 'location',
    'stat_category', 'nature', 'hostname', 'ip', 'ip_extra', 'mac', 'sn',
    'produce_date', 'model', 'os', 'cpu', 'disk', 'ram', 'monitor', 'consumable',
  ];

  /** 详情弹窗的分组。顺序照 Excel：位置 → 设备 → 网络 → 硬件 → 耗材 */
  const DETAIL_GROUPS = [
    {
      title: '位置与归属',
      items: [['campus', '院区'], ['area', '区域'], ['floor', '楼层'],
        ['department', '科室'], ['location', '位置']],
    },
    {
      title: '设备信息',
      items: [['asset_no', '资产编码'], ['stat_category', '统计类别'], ['nature', '设备性质'],
        ['model', '型号'], ['sn', 'SN码'], ['produce_date', '生产日期']],
    },
    {
      title: '网络',
      items: [['hostname', '工作组 / 计算机名'], ['ip', '内网地址'],
        ['ip_extra', '外网地址'], ['mac', 'MAC']],
    },
    {
      title: '硬件配置',
      items: [['os', '操作系统'], ['cpu', 'CPU'], ['disk', '硬盘'],
        ['ram', '内存'], ['monitor', '显示器尺寸']],
    },
    { title: '耗材', items: [['consumable', '耗材型号']] },
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
            字段与《信息设备台账》Excel 一一对应（21 列）。报障时可直接挂到具体设备上。
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
        <div class="stat-cell"><div class="k">台账设备</div><div class="v ok">{{ stats.total }}</div></div>
        <div class="stat-cell"><div class="k">覆盖科室</div><div class="v">{{ stats.depts }}</div></div>
        <div class="stat-cell"><div class="k">已登记内网地址</div><div class="v">{{ stats.with_ip }}</div></div>
        <div class="stat-cell"><div class="k">缺资产编码</div><div class="v warn">{{ stats.no_asset }}</div></div>
      </div>

      <div class="filter-bar">
        <input class="ipt grow" v-model="kw" @keyup.enter="search"
               placeholder="搜索任意列：资产编码 / 计算机名 / SN / MAC / IP / 型号 / 科室 / 位置">
        <select class="ipt" v-model="fDept" @change="search">
          <option value="">全部科室</option>
          <option v-for="d in deptOptions" :key="d" :value="d">{{ d }}</option>
        </select>
        <select class="ipt" v-model="fStat" @change="search">
          <option value="">全部统计类别</option>
          <option v-for="s in statOptions" :key="s" :value="s">{{ s }}</option>
        </select>
        <select class="ipt" v-model="fNature" @change="search">
          <option value="">全部设备性质</option>
          <option v-for="s in natureOptions" :key="s" :value="s">{{ s }}</option>
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
                <th class="c-cat">统计类别</th>
                <th class="c-dept">科室 / 位置</th>
                <th class="c-ip">内网地址</th>
                <th class="c-wan">外网地址</th>
                <th class="c-spec">配置 / 耗材</th>
                <th class="c-issue">报修</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading"><td colspan="8" class="empty-row">加载中…</td></tr>
              <tr v-else-if="!list.length">
                <td colspan="8" class="empty-row">
                  没有符合条件的设备。{{ canManage ? '点右上角「新增设备」录入，或「导入」Excel 台账。' : '请联系管理员录入。' }}
                </td>
              </tr>
              <tr v-for="r in list" :key="r.id">
                <td>
                  <span class="cell-strong term-name" @click="openDetail(r)" :title="r.name">{{ r.name }}</span>
                  <!-- 副行只放「资产编码」，型号放 title：两者拼在一起会一路省略号，
                       而资产编码是现场核对时真正要念出来的那个 -->
                  <span class="cell-sub" :title="[r.asset_no, r.model].filter(Boolean).join(' · ')">
                    {{ r.asset_no || r.model || '无资产编码' }}
                  </span>
                </td>
                <td>
                  <span class="chip">{{ r.stat_category || r.kind }}</span>
                  <span class="cell-sub" v-if="r.nature">{{ r.nature }}</span>
                </td>
                <td>
                  <span class="cell-strong">{{ r.department || '未填科室' }}</span>
                  <!-- 副行只放「楼层 + 位置」：院区/区域大多数行是同一个值，带上只是挤掉位置本身；
                       完整路径放 title（院区 / 区域 / 楼层 / 位置），详情弹窗里也是全的 -->
                  <span class="cell-sub" :title="[r.campus, r.area, r.floor, r.location].filter(Boolean).join(' / ')">
                    {{ [r.floor, r.location].filter(Boolean).join(' ') || '未填位置' }}
                  </span>
                </td>
                <td class="c-ip">
                  <!-- 内网地址只放内网：外网地址是另一列，别再往下堆第二行 ——
                       两行挤在同一列时，用户核对「这台到底有没有外网」只能靠悬停猜 -->
                  <span class="mono" :title="r.ip ? '内网地址 ' + r.ip : '未登记内网地址'">{{ r.ip || '—' }}</span>
                  <span class="cell-sub mono" v-if="r.mac" :title="'MAC ' + r.mac">{{ r.mac }}</span>
                </td>
                <td class="c-wan">
                  <!-- 独立一列：Excel 里「外网地址」本来就是一列，导入后必须能单独核对到。
                       没有外网就给「—」，不再借用内网那一列 -->
                  <span v-if="r.ip_extra" class="mono is-wan" :title="'外网地址 ' + r.ip_extra">{{ r.ip_extra }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td>
                  <span class="cell-strong spec-text" :title="specTitle(r)">{{ specMain(r) }}</span>
                  <span class="cell-sub spec-text" v-if="specSub(r)">{{ specSub(r) }}</span>
                </td>
                <td>
                  <span v-if="r.issue_count" class="cell-strong term-issues" @click="openDetail(r)"
                        :title="'这台设备的报修记录，最近一次 ' + (r.last_issue_at || '未知')">
                    {{ r.issue_count }} 次
                  </span>
                  <span v-else class="muted">—</span>
                  <span v-if="r.open_issue_count" class="cell-sub term-open"
                        :title="'还没处理完的工单 ' + r.open_issue_count + ' 张'">{{ r.open_issue_count }} 未结</span>
                </td>
                <td class="ops">
                  <!-- 四个按钮是上限：再加就得到「点不到」的程度。
                       删除放在最后并统一用 btn-danger，跟详情弹窗里的那个是同一个动作、
                       同一套确认文案（会说清有几张工单会被解绑）。 -->
                  <button v-if="canReport" class="btn btn-sm btn-outline" @click="reportFault(r)"
                          title="带着这台设备去填工单">报修</button>
                  <button class="btn btn-sm btn-outline" @click="openDetail(r)">详情</button>
                  <button v-if="canManage" class="btn btn-sm btn-outline" @click="openForm(r)">编辑</button>
                  <button v-if="canManage" class="btn btn-sm btn-outline btn-danger" @click="del(r)"
                          :title="'删除这台设备（历史工单会保留，只解绑）'">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint">
          默认按科室与位置排 —— 现场找人时是按「哪个科、哪一层」找的，不是按录入时间。
          点设备名看详情与这台机器的全部报修记录。<b>删除设备不会删工单</b>：
          历史工单会保留，只是不再关联到这台机器（排查依据要活得比设备久）。
          不用了的机器从台账删掉即可，它在【IP 管理】里占的地址会同时释放。
        </div>
      </div>

      <div class="pager" v-if="total > pageSize">
        <button class="btn btn-sm btn-outline" :disabled="page<=1" @click="go(page-1)">上一页</button>
        <span class="muted">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 台</span>
        <button class="btn btn-sm btn-outline" :disabled="page>=pageCount" @click="go(page+1)">下一页</button>
      </div>

      <!-- 详情（只读，点外面可以关） -->
      <div class="modal-mask" v-if="detail" @click.self="detail = null">
        <div class="modal" style="width:820px">
          <div class="modal-head">{{ detail.name }}<span class="modal-close" @click="detail = null">✕</span></div>
          <div class="modal-body">
            <div class="section-block" v-for="g in detailGroups(detail)" :key="g.title">
              <div class="sec-title">{{ g.title }}</div>
              <div class="term-info">
                <div class="ti" v-for="f in g.items" :key="f[0]">
                  <div class="k">{{ f[1] }}</div>
                  <div class="v" :class="{ mono: f[0] === 'hostname' || f[0] === 'ip' || f[0] === 'ip_extra' || f[0] === 'mac' || f[0] === 'sn' }">{{ g.vals[f[0]] || '—' }}</div>
                </div>
              </div>
            </div>

            <div class="section-block">
              <div class="sec-title">登记信息</div>
              <div class="term-info">
                <div class="ti"><div class="k">登记人</div><div class="v">{{ detail.creator_name || '—' }}</div></div>
                <div class="ti"><div class="k">登记时间</div><div class="v">{{ detail.created_at || '—' }}</div></div>
                <div class="ti"><div class="k">最后修改</div><div class="v">{{ detail.updated_at || '—' }}</div></div>
                <div class="ti" v-if="detail.src_sheet"><div class="k">来源</div>
                  <div class="v">导入「{{ detail.src_sheet }}」表{{ detail.import_at ? '（' + detail.import_at.slice(0, 10) + '）' : '' }}</div>
                </div>
              </div>
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
            <button v-if="canReport" class="btn btn-primary" @click="reportFault(detail); detail = null">为这台设备报修</button>
            <button class="btn btn-outline" @click="detail = null">关闭</button>
          </div>
        </div>
      </div>

      <!-- 新增 / 编辑
           ★ 表单弹窗不写 @click.self：点到外面的遮罩层不该把填了一半的内容清掉。 -->
      <div class="modal-mask" v-if="form">
        <div class="modal" style="width:720px">
          <div class="modal-head">{{ form.id ? '编辑设备' : '新增设备' }}<span class="modal-close" @click="tryCloseForm">✕</span></div>
          <div class="modal-body">
            <!-- 认设备的必填项：Excel 里没有「设备名称」，能不能认出这台机器全靠这几个键字段。
                 弹窗顶部给红条 + 自动滚回顶部，而不是只在右上角闪一句 toast。 -->
            <div class="form-alert" v-if="badField === 'key'">
              认不出这是哪台设备：请至少填写
              <b>资产编码 / 工作组·计算机名 / MAC / SN码</b> 之一，或者把 <b>科室 + 位置</b> 都填上。
              内网地址不能单独作为标识（换机会沿用旧 IP）。
            </div>

            <div class="form-item"><label>资产编码</label>
              <input class="ipt" v-model="form.asset_no" @input="badField = ''" placeholder="贴机器上那张资产标签；原台账里写「-」的留空即可">
            </div>
            <div class="form-row">
              <div class="form-item"><label>院区</label>
                <input class="ipt" v-model="form.campus" list="term-campus-list" placeholder="如 珠江街道">
                <datalist id="term-campus-list"><option v-for="v in metaCampuses" :key="v" :value="v"></option></datalist>
              </div>
              <div class="form-item"><label>区域</label>
                <input class="ipt" v-model="form.area" list="term-area-list" placeholder="如 院本部 / 住院部">
                <datalist id="term-area-list"><option v-for="v in metaAreas" :key="v" :value="v"></option></datalist>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>楼层</label>
                <input class="ipt" v-model="form.floor" list="term-floor-list" placeholder="如 3F">
                <datalist id="term-floor-list"><option v-for="v in metaFloors" :key="v" :value="v"></option></datalist>
              </div>
              <div class="form-item"><label>科室</label>
                <input class="ipt" v-model="form.department" @input="badField = ''" list="term-dept-list" placeholder="如 门诊部">
                <datalist id="term-dept-list"><option v-for="d in deptOptions" :key="d" :value="d"></option></datalist>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>位置</label>
                <input class="ipt" v-model="form.location" @input="badField = ''" placeholder="如 门诊楼3层3诊室"></div>
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
              <div class="form-item"><label>工作组 / 计算机名</label>
                <input class="ipt" v-model="form.hostname" @input="badField = ''" placeholder="如 PC-20180817RHBE"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>内网地址</label><input class="ipt" v-model="form.ip" placeholder="如 200.100.60.34"></div>
              <div class="form-item"><label>外网地址</label><input class="ipt" v-model="form.ip_extra" placeholder="如 10.10.10.248"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>MAC</label><input class="ipt" v-model="form.mac" @input="badField = ''" placeholder="AA-BB-CC-11-22-33"></div>
              <div class="form-item"><label>SN码</label><input class="ipt" v-model="form.sn" @input="badField = ''" placeholder="如 M706TL9J"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>生产日期</label><input class="ipt" type="date" v-model="form.produce_date"></div>
              <div class="form-item"><label>型号</label><input class="ipt" v-model="form.model" placeholder="如 启天M410-N000"></div>
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
              还没有写库。<b>「合并到已有」</b>指同一台设备在文件里出现了多行，或库里已有（按 MAC → SN码 → 资产编码 → 工作组计算机名 认的），
              会并成一条；空白单元格不会覆盖系统里已有的内容。
            </div>

            <!-- 认不出的列必须当场说：不然用户以为「外网地址我填了」，其实整列都没进来 -->
            <div class="imp-note imp-bad" v-if="imp.ignored && imp.ignored.length" style="margin-top:10px">
              这几列没认出来，里面的内容不会导入：<b>{{ imp.ignored.map(function(i){ return i.header; }).join('、') }}</b>
              <template v-if="imp.preview.ignoredTotal > imp.ignored.length">…等 {{ imp.preview.ignoredTotal }} 列</template>。
              台账只认 21 列（不确定列名就先点「导出」拿一份标准表头的表对照）；
              「外网地址（IP）」「内网地址(管理口)」这类带括号后缀的写法能认，改名成别的就认不出了。
            </div>

            <div class="section-block" v-if="imp.preview.samples && imp.preview.samples.length">
              <div class="sec-title">前 20 条会怎么处理</div>
              <div class="table-wrap">
                <table class="tbl imp-tbl">
                  <thead><tr><th>表</th><th>行</th><th>动作</th><th>设备</th><th>受影响的字段</th></tr></thead>
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
                这些行只写了科室或区域，没有位置、也没有资产编码/MAC/计算机名，认不出是哪台。
                在 Excel 里补上「资产编码」或「工作组/计算机名」再导一次即可。
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
        kw: '', fDept: '', fStat: '', fNature: '',
        stats: { total: 0, with_ip: 0, no_asset: 0, depts: 0 },
        deptOptions: [], statOptions: [], natureOptions: [],
        metaCampuses: [], metaAreas: [], metaFloors: [], metaStatCats: [], metaNatures: [],
        loading: false, detail: null, form: null, formBase: '', saving: false,
        // 导入：file 选好后先跑一次 dryRun 预览，用户确认了才真写库
        imp: null, impBusy: false,
        // 认设备失败时给弹窗顶部红条（'key'），并滚回顶部
        badField: '',
        // 从【IP 管理】点「查看设备」跳过来时先记下 id，列表加载完再开详情
        pendingOpen: 0,
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
      // 从【IP 管理】点「查看设备」跳过来：带的是设备 id，进来直接开到详情弹窗
      try {
        const open = Number(sessionStorage.getItem('his_terminal_open') || 0);
        if (open) {
          sessionStorage.removeItem('his_terminal_open');
          this.pendingOpen = open;
        }
      } catch (e) { /* 隐私模式忽略 */ }
      this.onOpenTerminal = (ev) => {
        const id = Number((ev && ev.detail) || 0);
        if (id) this.openDetail({ id });
      };
      window.addEventListener('his:open-terminal', this.onOpenTerminal);
      this.load();
    },
    beforeUnmount() {
      if (this.onOpenTerminal) window.removeEventListener('his:open-terminal', this.onOpenTerminal);
    },
    methods: {
      async loadMeta() {
        try {
          const m = await this.$api.get('/terminals/meta');
          this.deptOptions = m.departments || [];
          this.metaCampuses = m.campuses || [];
          this.metaAreas = m.areas || [];
          this.metaFloors = m.floors || [];
          this.metaStatCats = m.stat_categories || [];
          this.metaNatures = m.natures || [];
          this.statOptions = this.metaStatCats;
          this.natureOptions = this.metaNatures;
        } catch (e) {
          // 元数据拿不到不影响用：这些字段都是自由输入 + datalist 提示，不是必须的下拉
          this.statOptions = [];
          this.natureOptions = [];
        }
      },
      async load() {
        this.loading = true;
        try {
          const q = [];
          if (this.kw.trim()) q.push('keyword=' + encodeURIComponent(this.kw.trim()));
          if (this.fDept) q.push('department=' + encodeURIComponent(this.fDept));
          if (this.fStat) q.push('stat_category=' + encodeURIComponent(this.fStat));
          if (this.fNature) q.push('nature=' + encodeURIComponent(this.fNature));
          q.push('page=' + this.page, 'pageSize=' + this.pageSize);
          const d = await this.$api.get('/terminals?' + q.join('&'));
          this.list = d.list || [];
          this.total = d.total || 0;
          this.stats = d.stats || this.stats;
          // 下拉跟着台账实际内容走（新登记一个科室后立刻能筛）
          if (d.departments && d.departments.length) this.deptOptions = d.departments.map((x) => x.name);
          if (d.stat_categories && d.stat_categories.length) this.statOptions = d.stat_categories.map((x) => x.name);
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loading = false;
        }
        // 从 IP 管理跳过来时要求「进来就看到那台设备」：等列表刷完再开详情，
        // 否则详情先弹出来、背后列表还是空的，关掉之后像什么都没发生。
        if (this.pendingOpen) {
          const id0 = this.pendingOpen;
          this.pendingOpen = 0;
          this.openDetail({ id: id0 });
        }
      },
      search() { this.page = 1; this.load(); },
      reset() {
        this.kw = ''; this.fDept = ''; this.fStat = ''; this.fNature = '';
        this.page = 1; this.load();
      },
      go(p) { this.page = p; this.load(); },

      /**
       * 列表第 5 列拆两行：主行「操作系统」或「耗材型号」，副行 CPU + 内存。
       * 拆开的原因写在 style.css 的 .spec-text 注释里：合成一行 197px，
       * 这列只有 168px，CPU 会永远显示成省略号。
       */
      specMain(r) {
        if (!r) return '—';
        if (r.os) return r.os;
        if (r.consumable) return '耗材 ' + r.consumable;
        if (r.cpu) return r.cpu;
        return '—';
      },
      specSub(r) {
        if (!r) return '';
        const parts = [];
        if (r.cpu && r.os) parts.push(r.cpu);   // 没 OS 时 cpu 已经在主行，别重复
        if (r.ram) parts.push(r.ram);
        return parts.join(' · ');
      },
      /** 悬停看全：主副两行都没显示出来的（硬盘、显示器）也一并给出来 */
      specTitle(r) {
        if (!r) return '';
        const all = [r.os, r.cpu, r.ram, r.disk, r.monitor, r.consumable ? '耗材 ' + r.consumable : ''];
        return all.filter(Boolean).join(' · ');
      },

      /** 详情按组显示，全空的一组直接不显示（手工录的空设备不会变成一整屏「—」） */
      detailGroups(t) {
        if (!t) return [];
        const out = [];
        DETAIL_GROUPS.forEach((g) => {
          const vals = {};
          let any = false;
          g.items.forEach((f) => {
            const v = String(t[f[0]] == null ? '' : t[f[0]]);
            vals[f[0]] = v;
            if (v) any = true;
          });
          if (any) out.push({ title: g.title, items: g.items, vals });
        });
        // 一条都没填的极端情况下也至少给前两组，否则弹窗里只剩「历史工单」
        if (!out.length) {
          return DETAIL_GROUPS.slice(0, 3).map((g) => {
            const vals = {};
            g.items.forEach((f) => { vals[f[0]] = ''; });
            return { title: g.title, items: g.items, vals };
          });
        }
        return out;
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
        try { sessionStorage.setItem('his_issue_device', String(r.id)); } catch (e) { /* 隐私模式忽略 */ }
        location.hash = '#/issue/new';
      },

      /* ---------- 导入 / 导出 ---------- */

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
        this.imp = { filename: f.name, file: f, mode: 'update', preview: null, sheets_scanned: [], ignored: [] };
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
          imp.ignored = d.ignored_headers || [];
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
        if (this.fStat) q.push('stat_category=' + encodeURIComponent(this.fStat));
        if (this.fNature) q.push('nature=' + encodeURIComponent(this.fNature));
        const qs = q.length ? ('?' + q.join('&')) : '';
        const stamp = (window.HisUtils && window.HisUtils.todayStr) ? window.HisUtils.todayStr().replace(/-/g, '') : '';
        this.$toast(q.length ? '正在导出当前筛选结果…' : '正在导出全部设备…', '');
        this.$api.download('/terminals/export' + qs, '终端资产台账_' + stamp + '.xlsx')
          .catch((e) => this.$toast(e.message, 'err'));
      },

      openForm(r) {
        this.badField = '';
        // 用 FORM_KEYS 铺底，新增一列就不必再改这里两遍
        const blank = { id: 0, department: (this.fDept || ''), stat_category: (this.fStat || '') };
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

      /**
       * 客户端先按与服务端 keyOf 同一套规则挡一次。
       * 服务端才是权威（它还会归一化 MAC），这里挡是为了不让人白填一屏再被退回。
       */
      identifyOk(f) {
        if (!f) return false;
        if ((f.mac || '').trim() || (f.sn || '').trim() || (f.asset_no || '').trim()
          || (f.hostname || '').trim()) return true;
        return !!((f.department || '').trim() && (f.location || '').trim());
      },

      async save() {
        if (!this.identifyOk(this.form)) {
          this.badField = 'key';
          this.$toast('认不出这是哪台设备，请看弹窗顶部的说明', 'err');
          // 红条在弹窗最上方，用户很可能已经滚到底部按的保存 —— 滚回去让他看见
          this.$nextTick(() => {
            const box = document.querySelector('.modal .modal-body');
            if (box && box.scrollTo) box.scrollTo({ top: 0, behavior: 'smooth' });
            else if (box) box.scrollTop = 0;
            const el = document.querySelector('.modal .form-alert');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
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
          + (n ? '\n\n这台设备有 ' + n + ' 张历史工单，删除后工单会保留但不再关联到设备。' : '')
          + '\n\n它占用的 IP 地址会在【IP 管理】里同时释放。';
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
