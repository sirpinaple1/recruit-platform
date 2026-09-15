# -*- coding: utf-8 -*-
"""9 个工作台界面的内容片段（body 部分）。结构、文案、色值对齐 Ardot《MVP 原型 v2》。"""

def svg(paths, size=16, sw=1.4, fill='none'):
    return ('<svg width="%d" height="%d" viewBox="0 0 16 16" fill="%s" '
            'xmlns="http://www.w3.org/2000/svg">%s</svg>') % (size, size, fill, paths)


ICONS = {
    'grid': svg('<g stroke="currentColor" stroke-width="1.4" fill="none">'
                '<rect x="2" y="2" width="5" height="5" rx="1.4"/>'
                '<rect x="9" y="2" width="5" height="5" rx="1.4"/>'
                '<rect x="2" y="9" width="5" height="5" rx="1.4"/>'
                '<rect x="9" y="9" width="5" height="5" rx="1.4"/></g>'),
    'briefcase': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round">'
                     '<rect x="2" y="5" width="12" height="9" rx="1.6"/>'
                     '<path d="M6 5V3.6A1.6 1.6 0 0 1 7.6 2h.8A1.6 1.6 0 0 1 10 3.6V5"/>'
                     '<path d="M2 8.6h12"/></g>'),
    'users': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">'
                 '<circle cx="6.4" cy="5.8" r="2.4"/>'
                 '<path d="M2.2 13.4c0-2.2 1.9-3.6 4.2-3.6s4.2 1.4 4.2 3.6"/>'
                 '<path d="M10.6 4.1a2.4 2.4 0 0 1 0 4.4"/>'
                 '<path d="M12 10c1.2.5 1.8 1.7 1.8 3.4"/></g>'),
    'calendar': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">'
                    '<rect x="2" y="3.5" width="12" height="10.5" rx="1.6"/>'
                    '<path d="M2 6.8h12"/><path d="M5.5 2v3M10.5 2v3"/></g>'),
    'chart': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">'
                 '<path d="M2 13.5h12"/><path d="M4.2 11.4V8.6"/>'
                 '<path d="M8 11.4V5.4"/><path d="M11.8 11.4V9.6"/></g>'),
    'globe': svg('<g stroke="currentColor" stroke-width="1.4" fill="none">'
                 '<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/>'
                 '<path d="M8 2c1.6 1.8 2.5 3.9 2.5 6S9.6 12.2 8 14C6.4 12.2 5.5 10.1 5.5 8S6.4 3.8 8 2Z"/></g>'),
    'search': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round">'
                  '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.6 10.6 13.6 13.6"/></g>', 14),
    'sparkle': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">'
               '<path d="M7 1.4 8.35 5.65 12.6 7 8.35 8.35 7 12.6 5.65 8.35 1.4 7 5.65 5.65Z" '
               'fill="#7C4DFF"/><circle cx="11.6" cy="2.4" r="1.3" fill="#7C4DFF" opacity=".55"/></svg>',
    'bell': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round">'
                '<path d="M8 2.2a3.9 3.9 0 0 1 3.9 3.9v2.3l1 2.1H3.1l1-2.1V6.1A3.9 3.9 0 0 1 8 2.2Z"/>'
                '<path d="M6.5 12.5a1.5 1.5 0 0 0 3 0"/></g>'),
    'plus': svg('<g stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round">'
                '<path d="M8 3.4v9.2M3.4 8h9.2"/></g>', 13),
    'close': svg('<g stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round">'
                 '<path d="M4 4 12 12M12 4 4 12"/></g>', 14),
    'info': svg('<g stroke="currentColor" stroke-width="1.4" fill="none">'
                '<circle cx="8" cy="8" r="6"/><path d="M8 7.3v4" stroke-linecap="round"/>'
                '<circle cx="8" cy="4.9" r=".8" fill="currentColor" stroke="none"/></g>', 14),
    'file': svg('<g stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round">'
                '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></g>', 14),
    'eye': svg('<g stroke="currentColor" stroke-width="1.4" fill="none">'
               '<path d="M1.8 8S4.4 4.2 8 4.2 14.2 8 14.2 8 11.6 11.8 8 11.8 1.8 8 1.8 8Z"/>'
               '<circle cx="8" cy="8" r="1.8"/></g>', 14),
}

NAV = [
    ('工作台', 's1-workbench.html', 'grid'),
    ('职位', 's2-jobs.html', 'briefcase'),
    ('候选人', 's5-candidate.html', 'users'),
    ('面试', 's7-interview-notes.html', 'calendar'),
    ('数据', 's9-analytics.html', 'chart'),
    ('简历门户', '../login-prototype.html', 'globe'),
]

TPL_STATS4 = ''
TD = '<div class="trow__t">%s</div><div class="trow__s">%s</div>'

# ---------------------------------------------------------------- S1 工作台
S1 = """
<div class="page">
  <div class="grid-stats">
    <div class="stat"><div class="stat__k">今日待办</div><div class="stat__v">8</div></div>
    <div class="stat"><div class="stat__k">逾期未处理</div><div class="stat__v stat__v--danger">2</div></div>
    <div class="stat"><div class="stat__k">在招职位</div><div class="stat__v">12</div></div>
    <div class="stat"><div class="stat__k">本月已入职</div><div class="stat__v">5</div></div>
  </div>

  <div class="cols">
    <div class="card">
      <div class="card__hd card__hd--plain">
        <span class="card__title">今日待办 <span class="badge">6</span></span>
        <a class="link" href="s1-workbench.html">查看全部</a>
      </div>

      <div class="group-hd group-hd--warning">逾期处理 · 1 项</div>
      <div class="row">
        <div>
          <div class="row__t">陈思远 · 二面评价待提交</div>
          <div class="row__s row__s--danger">后端工程师 · 已逾期 2 天</div>
        </div>
        <a class="link" href="s5-candidate.html">去处理</a>
      </div>

      <div class="group-hd">今天到期 · 5 项</div>
      <div class="row">
        <div>
          <div class="row__t">李婉 · 安排一面（线上会议）</div>
          <div class="row__s">算法工程师 · 今日 14:00 截止</div>
        </div>
        <a class="link" href="s6-interview-schedule.html">去处理</a>
      </div>
      <div class="row">
        <div>
          <div class="row__t">王磊 · 录用通知书待审批</div>
          <div class="row__s">产品经理 · 今日 18:00 截止</div>
        </div>
        <a class="link" href="s8-offer.html">去处理</a>
      </div>
      <div class="row">
        <div>
          <div class="row__t">3 份面试纪要已由 AI 生成，待确认</div>
          <div class="row__s">后端工程师 · 钉钉会议自动同步</div>
        </div>
        <a class="link" href="s7-interview-notes.html">查看</a>
      </div>
      <div class="row">
        <div>
          <div class="row__t">周航 · 二面评价待提交</div>
          <div class="row__s">算法工程师 · 今日 20:00 截止</div>
        </div>
        <a class="link" href="s5-candidate.html">去处理</a>
      </div>
      <div class="row">
        <div>
          <div class="row__t">2 份简历疑似重复，待确认合并</div>
          <div class="row__s">AI 查重命中 · 推荐池</div>
        </div>
        <a class="link" href="s5-candidate.html">查看</a>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card__hd card__hd--plain"><span class="card__title">快速开始</span></div>
        <div class="card__bd" style="padding-top:2px">
          <a class="btn btn--primary btn--block" href="s3-job-new.html">新建职位</a>
          <div class="quick-links">
            <a class="link" href="s5-candidate.html">上传候选人简历，AI 自动解析</a>
            <a class="link" href="s6-interview-schedule.html">邀请面试官加入协作</a>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__hd">
          <span class="card__title">招聘中职位</span>
          <a class="link" href="s2-jobs.html">查看全部</a>
        </div>
        <div class="card__bd" style="display:flex;flex-direction:column;gap:16px">
          <div class="mini">
            <div class="mini__hd"><span>后端工程师</span><span class="prog-num">2<i>/3</i></span></div>
            <div class="progress"><div class="progress__i" style="width:66%"></div></div>
          </div>
          <div class="mini">
            <div class="mini__hd"><span>算法工程师</span><span class="prog-num">1<i>/2</i></span></div>
            <div class="progress"><div class="progress__i" style="width:50%"></div></div>
          </div>
          <div class="mini">
            <div class="mini__hd"><span>产品经理</span><span class="prog-num">3<i>/4</i></span></div>
            <div class="progress"><div class="progress__i progress__i--success" style="width:75%"></div></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__hd">
          <span class="card__title">今日面试日程</span>
          <a class="link" href="s6-interview-schedule.html">面试日历</a>
        </div>
        <div class="rows">
          <div class="row"><div class="sched">
            <span class="sched__t">14:00</span>
            <div><div class="row__t">李婉 · 一面</div><div class="row__s">后端工程师 · 线上会议</div></div>
          </div></div>
          <div class="row"><div class="sched">
            <span class="sched__t">15:30</span>
            <div><div class="row__t">周航 · 二面</div><div class="row__s">算法工程师 · 线上会议</div></div>
          </div></div>
          <div class="row"><div class="sched">
            <span class="sched__t">17:00</span>
            <div><div class="row__t">王磊 · 终面</div><div class="row__s">产品经理 · A 座 12F 会议室</div></div>
          </div></div>
        </div>
      </div>
    </div>
  </div>
</div>
"""

# ---------------------------------------------------------------- S2 职位列表
S2_TOOLBAR = """
<div class="toolbar">
  <div class="toolbar__search">%(search)s<span>搜索职位名称</span></div>
  <button class="select select--btn" type="button">全部状态</button>
  <button class="select select--btn" type="button">全部部门</button>
  <a class="btn btn--primary" href="s3-job-new.html" style="margin-left:auto">%(plus)s新建职位</a>
</div>""" % dict(search=ICONS['search'], plus=ICONS['plus'])

S2_ROWS = [
    ('后端工程师', '基础平台部 · 深圳', '2', '3', '招聘中', 'primary', '潘雨松', '今天 10:24', '查看'),
    ('算法工程师', '智能应用组 · 深圳', '1', '2', '招聘中', 'primary', '陈静', '昨天 18:02', '查看'),
    ('产品经理', '产品部 · 深圳', '3', '4', '招聘中', 'primary', '潘雨松', '9月8日', '查看'),
    ('前端工程师', '研发中心 · 深圳', '3', '3', '已完成', 'success', '陈静', '9月5日', '查看'),
    ('测试工程师', '质量部 · 东莞', '0', '2', '草稿', 'warning', '潘雨松', '9月2日', '编辑'),
    ('数据分析师', '智能应用组 · 深圳', '1', '1', '已暂停', 'neutral', '陈静', '8月28日', '查看'),
]

def s2_rows():
    out = []
    for t, s, a, b, chip, kind, owner, upd, act in S2_ROWS:
        href = 's3-job-new.html' if act == '编辑' else 's4-job-pipeline.html'
        out.append(
            '    <a class="trow" href="%s">\n'
            '      <div>%s</div>\n'
            '      <div class="prog-num">%s<i>/%s</i></div>\n'
            '      <div><span class="chip chip--%s">%s</span></div>\n'
            '      <div>%s</div>\n'
            '      <div class="trow__upd">%s</div>\n'
            '      <div><span class="link">%s</span></div>\n'
            '    </a>' % (href, TD % (t, s), a, b, kind, chip, owner, upd, act))
    return '\n'.join(out)

S2_TABLE = """
  <div class="table">
    <div class="thead">
      <div>职位</div><div>招聘进度</div><div>状态</div><div>负责人</div><div>更新时间</div><div>操作</div>
    </div>
%s
    <div class="tfoot">
      <span class="tfoot__n">共 12 个职位</span>
      <div class="pager">
        <span class="pager__i is-on">1</span><span class="pager__i">2</span><span class="pager__i">3</span>
      </div>
    </div>
  </div>""" % s2_rows()

S2 = """
<div class="page">
%s
%s
</div>
""" % (S2_TOOLBAR, S2_TABLE)

# ---------------------------------------------------------------- S3 新建职位（抽屉）
S3 = S2 + """
<div class="overlay"></div>
<div class="drawer">
  <div class="drawer__hd">
    <span class="drawer__title">新建职位</span>
    <a class="icon-btn icon-btn--bare" href="s2-jobs.html" aria-label="关闭">%(close)s</a>
  </div>
  <div class="drawer__bd">
    <div class="field">
      <label class="field__label">职位名称</label>
      <input class="input" value="高级后端工程师">
    </div>
    <div class="field">
      <label class="field__label">需求部门</label>
      <select class="select"><option>基础平台部</option><option>智能应用组</option><option>产品部</option></select>
    </div>
    <div class="field">
      <label class="field__label">招聘人数</label>
      <input class="input" value="3">
    </div>
    <div class="field">
      <label class="field__label">职位描述 JD</label>
      <textarea class="textarea" placeholder="粘贴 JD 文本，AI 将自动识别学历、经验与技术要求"></textarea>
    </div>
    <div class="note note--ai">%(spark)s<div><b>AI 已解析并回填</b>，请确认</div></div>
    <div class="chip-row">
      <span class="chip chip--neutral">本科及以上</span>
      <span class="chip chip--neutral">3-5 年经验</span>
      <span class="chip chip--neutral">Java/Go</span>
    </div>
  </div>
  <div class="drawer__ft">
    <a class="btn btn--default" href="s2-jobs.html">取消</a>
    <button class="btn btn--default" type="button">保存草稿</button>
    <button class="btn btn--primary" type="button">提交审批</button>
  </div>
</div>
""" % dict(close=ICONS['close'], spark=ICONS['sparkle'])

# ---------------------------------------------------------------- S4 职位详情 · 流水线
S4_COLS = [
    ('推荐池', '8', False, [
        ('李婉', '92', '3 年 · 字节跳动', ''),
        ('周航', '88', '5 年 · 腾讯', ''),
    ]),
    ('一面', '3', False, [
        ('陈思远', '85', '4 年 · 美团 · 待安排', ''),
        ('刘洋', '81', '2 年 · 快手', ''),
    ]),
    ('二面', '2', False, [
        ('杨帆', '90', '6 年 · 阿里 · 待评价', 'warning'),
        ('赵磊', '78', '3 年 · 京东', ''),
    ]),
    ('待定', '1', False, [
        ('孙悦', '75', '4 年 · 百度 · 待复聊', ''),
    ]),
    ('已录用', '1', True, [
        ('王磊', '94', '7 年 · 华为 · 已发 offer', 'success'),
    ]),
]

def s4_board():
    out = []
    for name, n, green, cards in S4_COLS:
        items = '\n'.join(
            '        <a class="pcard" href="s5-candidate.html">\n'
            '          <div class="pcard__t">%s · 匹配 %s</div>\n'
            '          <div class="pcard__s%s">%s</div>\n'
            '        </a>' % (t, m, (' pcard__s--' + k) if k else '', s)
            for t, m, s, k in cards)
        out.append(
            '      <div class="bcol%s">\n'
            '        <div class="bcol__hd"><span class="bcol__t">%s</span><span class="bcol__n">%s</span></div>\n'
            '        <div class="bcol__list">\n%s\n        </div>\n'
            '      </div>' % (' bcol--success' if green else '', name, n, items))
    return '\n'.join(out)

S4 = """
<div class="page">
  <div class="card">
    <div class="card__hd">
      <span class="card__title card__title--xl">后端工程师
        <span class="chip chip--primary">招聘中</span>
      </span>
      <a class="link" href="s3-job-new.html">编辑职位</a>
    </div>
    <div class="card__bd meta-row">
      <span>基础平台部 · 深圳</span>
      <span>招聘 <b>3</b> 人 · 已入职 <b>2</b></span>
      <span>负责人 <b>潘雨松</b></span>
      <span>截止 <b>10月30日</b></span>
    </div>
  </div>

  <div class="board">
%s
  </div>
</div>
""" % s4_board()

# ---------------------------------------------------------------- S5 候选人详情
S5 = """
<div class="page">
  <div class="cols">
    <div class="card">
      <div class="card__hd">
        <span class="card__title card__title--xl">李婉
          <span class="chip chip--primary">推荐池 · 后端工程师</span>
        </span>
        <span class="match">AI 匹配 92</span>
      </div>

      <div class="sec">
        <div class="note note--ai" style="margin:0">
          %(spark)s
          <div>
            <div class="note__t">AI 推荐理由</div>
            <div style="margin-top:3px">3 年 Go / Java 服务端经验，与 JD 核心技术栈完全匹配；有大流量网关项目经历；薪资预期在编制区间内。</div>
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">基本信息</div>
        <div class="kv-grid">
          <div class="kv"><span class="kv__k">手机</span><span class="kv__v">138****8821</span></div>
          <div class="kv"><span class="kv__k">邮箱</span><span class="kv__v">li***@example.com</span></div>
          <div class="kv"><span class="kv__k">所在地</span><span class="kv__v">深圳</span></div>
          <div class="kv"><span class="kv__k">学历</span><span class="kv__v">本科</span></div>
          <div class="kv"><span class="kv__k">工作年限</span><span class="kv__v">3 年</span></div>
          <div class="kv"><span class="kv__k">期望薪资</span><span class="kv__v">35-45K</span></div>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">教育背景</div>
        <div class="row-line">
          <span>华中科技大学 · 计算机科学与技术</span>
          <span class="row-line__side">2019 - 2023</span>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">工作经历</div>
        <div class="exp">
          <div class="exp__t">字节跳动 · 后端工程师</div>
          <div class="exp__s">2023.07 - 至今 · 负责网关服务研发</div>
        </div>
        <div class="exp" style="margin-top:14px">
          <div class="exp__t">腾讯 · 后端开发实习生</div>
          <div class="exp__s">2022.06 - 2023.06 · 分布式任务调度</div>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">技能标签</div>
        <div class="chip-row">
          <span class="chip chip--neutral">Go</span>
          <span class="chip chip--neutral">Java</span>
          <span class="chip chip--neutral">MySQL</span>
          <span class="chip chip--neutral">Redis</span>
          <span class="chip chip--neutral">Kubernetes</span>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">附件</div>
        <div class="row-line">
          <span class="file-line">%(file)s李婉-后端工程师-简历.pdf · 412 KB</span>
          <a class="link" href="#">预览</a>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card__hd card__hd--plain"><span class="card__title">下一步</span></div>
        <div class="card__bd" style="padding-top:2px;display:flex;flex-direction:column;gap:10px">
          <a class="btn btn--primary btn--block" href="s6-interview-schedule.html">安排一面</a>
          <button class="btn btn--default btn--block" type="button">退回推荐池</button>
          <a class="link" href="#" style="align-self:center;margin-top:2px">查看原始简历附件</a>
        </div>
      </div>

      <div class="card">
        <div class="card__hd card__hd--plain"><span class="card__title">流转记录</span></div>
        <div class="card__bd">
          <div class="timeline">
            <div class="tl">
              <span class="tl__dot"></span>
              <div class="tl__t">AI 推荐入库 · 匹配 92</div>
              <div class="tl__s">9月8日 14:20</div>
            </div>
            <div class="tl">
              <span class="tl__dot tl__dot--idle"></span>
              <div class="tl__t">简历解析完成</div>
              <div class="tl__s">9月8日 14:21 · 识别 12 个字段</div>
            </div>
            <div class="tl">
              <span class="tl__dot tl__dot--idle"></span>
              <div class="tl__t">进入推荐池 · 后端工程师</div>
              <div class="tl__s">9月8日 14:25</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__hd card__hd--plain"><span class="card__title">面试安排</span></div>
        <div class="card__bd">
          <div class="row-line">
            <span class="row-line__k">一面</span>
            <div>
              <div class="row__t">9月12日 14:00 · 待进行</div>
              <div class="row__s">面试官 张伟 · 线上会议</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
""" % dict(spark=ICONS['sparkle'], file=ICONS['file'])

# ---------------------------------------------------------------- S6 安排面试（弹窗）
S6 = """
<div class="overlay"></div>
<div class="modal-wrap">
  <div class="modal">
    <div class="modal__hd">
      <span class="modal__title">安排面试</span>
      <a class="icon-btn icon-btn--bare" href="s5-candidate.html" aria-label="关闭">%(close)s</a>
    </div>
    <div class="modal__bd">
      <div class="cand-box">
        <span class="avatar">李</span>
        <div>
          <div class="cand-box__t">李婉</div>
          <div class="cand-box__s">后端工程师 · 推荐池 → 一面</div>
        </div>
      </div>

      <div class="field">
        <label class="field__label">面试轮次</label>
        <select class="select"><option>一面</option><option>二面</option><option>终面</option></select>
      </div>

      <div class="field">
        <label class="field__label">面试方式</label>
        <div class="seg">
          <span class="seg__i is-on">线上会议</span>
          <span class="seg__i">线下面试</span>
        </div>
      </div>

      <div class="field">
        <label class="field__label">面试时间</label>
        <div class="two-col">
          <input class="input" value="2026-09-12 周五">
          <input class="input" value="14:00 - 15:00">
        </div>
      </div>

      <div class="field">
        <label class="field__label">面试官</label>
        <div class="interviewer">
          <span class="avatar avatar--sm">张</span>
          <span class="interviewer__n">张伟 · 技术负责人</span>
          <a class="link" href="#">+ 添加面试官</a>
        </div>
      </div>

      <div class="note note--info">%(info)s确认后自动创建钉钉日程与线上会议，并通知面试官</div>
    </div>
    <div class="modal__ft">
      <span class="modal__hint">预计占用面试官 1 小时</span>
      <div class="modal__acts">
        <a class="btn btn--default" href="s5-candidate.html">取消</a>
        <a class="btn btn--primary" href="s7-interview-notes.html">确认安排</a>
      </div>
    </div>
  </div>
</div>
""" % dict(close=ICONS['close'], info=ICONS['info'])

# ---------------------------------------------------------------- S7 面试纪要
S7 = """
<div class="page">
  <div class="cols" style="align-items:stretch">
    <div class="card">
      <div class="card__hd">
        <span class="card__title card__title--xl">二面纪要 · 杨帆
          <span class="chip chip--ai">钉钉 AI 自动生成</span>
        </span>
        <a class="link" href="#">查看原始转写</a>
      </div>

      <div class="sec">
        <div class="sec__hd">面试 AI 摘要</div>
        <p class="sec__p">候选人在二面中详细描述了在阿里主导的高并发订单系统重构，说明了分库分表方案与灰度切流策略，并现场实现了一致性哈希。对稳定性与容灾有清晰认识，追问下能给出明确的取舍理由。</p>
      </div>

      <div class="sec">
        <div class="sec__hd">关键要点</div>
        <div class="sec__list">
          <div class="sec__li">主导过日订单千万级系统的分库分表落地</div>
          <div class="sec__li">熟悉 Go 高并发模型，对 GC 调优有实操经验</div>
          <div class="sec__li">跨团队协作经验充分，沟通表达结构化</div>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">表现详情</div>
        <div class="sec__list">
          <div class="sec__li">现场手写一致性哈希实现，边界条件处理完整</div>
          <div class="sec__li">对灰度切流与回滚预案有明确分层设计，风险意识强</div>
          <div class="sec__li sec__li--warning">薪资预期 45K 超出编制上限 42K，需与用人部门确认</div>
        </div>
      </div>

      <div class="sec">
        <div class="sec__hd">候选人提问</div>
        <div class="sec__list">
          <div class="sec__li">团队当前的发布节奏与线上值班机制是怎样的？</div>
          <div class="sec__li">技术线未来半年是否会做云原生迁移？</div>
        </div>
      </div>
    </div>

    <div class="stack" style="height:100%">
      <div class="card" style="display:flex;flex-direction:column;flex:1 1 auto">
        <div class="card__hd"><span class="card__title">面试评价</span></div>
        <div class="card__bd" style="display:flex;flex-direction:column;gap:18px">
          <div class="field">
            <label class="field__label">能力维度评分</label>
            <div class="score-list">
              <div class="score"><span>专业能力</span><span class="score__v">4.5/5</span></div>
              <div class="score"><span>沟通表达</span><span class="score__v">4.5/5</span></div>
              <div class="score"><span>项目经验</span><span class="score__v">4.0/5</span></div>
              <div class="score"><span>团队协作</span><span class="score__v">4.0/5</span></div>
            </div>
          </div>

          <div class="field">
            <label class="field__label">面试结论</label>
            <select class="select"><option>进入下一轮</option><option>待定</option><option>不通过</option></select>
          </div>

          <div class="field">
            <label class="field__label">评价意见</label>
            <textarea class="textarea" style="height:88px">技术基础扎实，高并发场景有完整落地经验，建议进入终面考察架构设计能力。</textarea>
            <a class="link" href="#" style="margin-top:2px">AI 辅助生成评价意见</a>
          </div>
        </div>
        <div class="card__ft">
          <button class="btn btn--default" type="button" style="border:0">保存草稿</button>
          <a class="btn btn--primary" href="s5-candidate.html">提交评价</a>
        </div>
      </div>
    </div>
  </div>
</div>
"""

# ---------------------------------------------------------------- S8 录用通知书
S8 = """
<div class="page">
  <div class="cols">
    <div class="card">
      <div class="doc">
        <div class="doc__co">特里特科技（深圳）有限公司</div>
        <div class="doc__title">录用通知书</div>

        <p class="doc__p">尊敬的 <b>王磊</b> 先生 / 女士：</p>
        <p class="doc__p doc__mt">我们很高兴地通知您，经过全面的面试评估，您已通过我司「后端工程师」岗位的全部面试环节。现将录用事项通知如下：</p>

        <div class="doc__row"><span class="doc__k">录用岗位</span><span class="doc__v">后端工程师 · 基础平台部</span></div>
        <div class="doc__row"><span class="doc__k">薪资方案</span><span class="doc__v">38K × 15 薪</span></div>
        <div class="doc__row"><span class="doc__k">入职日期</span><span class="doc__v">2026-10-08 · 深圳市南山区</span></div>
        <div class="doc__row"><span class="doc__k">试用期</span><span class="doc__v">3 个月 · 转正后按绩效评估调薪</span></div>

        <p class="doc__p doc__mt">报到材料：身份证原件、学历学位证书、离职证明与近三个月银行流水，请于入职当天携带至 12F 人力资源部办理。</p>
        <p class="doc__p doc__mt">请于 2026-09-20 前回复确认，逾期未回复视为自动放弃本次录用。如有疑问请联系招聘负责人潘雨松。</p>

        <div class="doc__sign">
          <span>招聘负责人：潘雨松</span>
          <span>签发日期：2026-09-10</span>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card__hd card__hd--plain"><span class="card__title">Offer 概要</span></div>
        <div class="card__bd" style="padding-top:4px">
          <div class="kv-list">
            <div class="kv kv--wide"><span class="kv__k">候选人</span><span class="kv__v">王磊 · 7 年经验</span></div>
            <div class="kv kv--wide"><span class="kv__k">应聘岗位</span><span class="kv__v">后端工程师</span></div>
            <div class="kv kv--wide"><span class="kv__k">编制占用</span><span class="kv__v">3 人编制 · 占用 1</span></div>
            <div class="kv kv--wide"><span class="kv__k">Offer 状态</span><span class="kv__v"><span class="status-warning">待审批</span></span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__hd card__hd--plain"><span class="card__title">审批流程</span></div>
        <div class="card__bd">
          <div class="timeline">
            <div class="tl">
              <span class="tl__dot"></span>
              <div class="tl__t">招聘负责人 · 潘雨松</div>
              <div class="tl__s">已提交 · 9月10日 15:20</div>
            </div>
            <div class="tl">
              <span class="tl__dot tl__dot--warning"></span>
              <div class="tl__t">HRBP · 陈静</div>
              <div class="tl__s tl__s--warning">审批中</div>
            </div>
            <div class="tl">
              <span class="tl__dot tl__dot--idle"></span>
              <div class="tl__t">部门负责人 · 张伟</div>
              <div class="tl__s">待审批</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__bd" style="display:flex;flex-direction:column;gap:10px">
          <button class="btn btn--primary btn--block btn--lg" type="button">发送钉钉审批</button>
          <button class="btn btn--default btn--block btn--lg" type="button">下载 PDF</button>
          <div class="hint">审批通过后自动创建入职提醒并扣减编制</div>
        </div>
      </div>
    </div>
  </div>
</div>
"""

# ---------------------------------------------------------------- S9 数据
S9 = """
<div class="page">
  <div class="toolbar">
    <div class="seg seg--bare">
      <span class="seg__i is-on">近 90 天</span>
      <span class="seg__i">全部部门</span>
    </div>
    <a class="link" href="#" style="margin-left:auto">导出报表</a>
  </div>

  <div class="grid-stats grid-stats--3">
    <div class="stat"><div class="stat__k">在招职位</div><div class="stat__v">12</div></div>
    <div class="stat"><div class="stat__k">平均招聘周期</div><div class="stat__v">28 天</div></div>
    <div class="stat"><div class="stat__k">Offer 达成率</div><div class="stat__v">78%</div></div>
  </div>

  <div class="cols">
    <div class="card">
      <div class="card__hd">
        <span class="card__title">招聘漏斗</span>
        <span class="card__sub">近 90 天 · 全部部门</span>
      </div>
      <div class="card__bd">
        <div class="funnel">
          <div class="funnel__b" style="width:54%;background:#2D5BE3">推荐入库 128</div>
          <div class="funnel__b" style="width:43%;background:#4E77EA">简历通过 76</div>
          <div class="funnel__b" style="width:31%;background:#7A9BF0">面试完成 41</div>
          <div class="funnel__b" style="width:19%;background:#A8BDF5">发出 Offer 18</div>
          <div class="funnel__b funnel__b--success" style="width:14%">已入职 12</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__hd"><span class="card__title">环节转化率</span></div>
      <div class="card__bd" style="display:flex;flex-direction:column;gap:18px">
        <div class="rate"><span>简历通过率</span><span class="rate__v">59%</span></div>
        <div class="rate"><span>面试完成率</span><span class="rate__v">54%</span></div>
        <div class="rate"><span>Offer 发放率</span><span class="rate__v">44%</span></div>
        <div class="rate"><span>入职转化率</span><span class="rate__v rate__v--success">67%</span></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card__hd">
      <span class="card__title">各部门招聘进度</span>
      <span class="card__sub">按已入职 / 需求人数</span>
    </div>
    <div class="card__bd" style="display:flex;flex-direction:column;gap:18px">
      <div class="progress-row">
        <span class="progress-row__t">基础平台部</span>
        <div class="progress"><div class="progress__i" style="width:50%"></div></div>
        <span class="progress-row__v"><b>2</b> / 4</span>
      </div>
      <div class="progress-row">
        <span class="progress-row__t">智能应用组</span>
        <div class="progress"><div class="progress__i" style="width:33%"></div></div>
        <span class="progress-row__v"><b>1</b> / 3</span>
      </div>
      <div class="progress-row">
        <span class="progress-row__t">产品部</span>
        <div class="progress"><div class="progress__i progress__i--success" style="width:100%"></div></div>
        <span class="progress-row__v"><b>2</b> / 2</span>
      </div>
      <div class="progress-row">
        <span class="progress-row__t">研发中心</span>
        <div class="progress"><div class="progress__i" style="width:33%"></div></div>
        <span class="progress-row__v"><b>1</b> / 3</span>
      </div>
    </div>
  </div>
</div>
"""

SCREENS = {
    's1-workbench.html': dict(nav='工作台', title='工作台', body=S1),
    's2-jobs.html': dict(nav='职位', title='职位', body=S2),
    's3-job-new.html': dict(nav='职位', title='职位', body=S3, body_class='body--drawer'),
    's4-job-pipeline.html': dict(nav='职位', title='职位 / 后端工程师', body=S4, crumb=True),
    's5-candidate.html': dict(nav='候选人', title='候选人 / 李婉', body=S5, crumb=True),
    's6-interview-schedule.html': dict(nav='面试', title='面试安排', body=S6, body_class='body--drawer'),
    's7-interview-notes.html': dict(nav='面试', title='面试纪要 / 杨帆 · 二面', body=S7, crumb=True),
    's8-offer.html': dict(nav='候选人', title='录用通知书 / 王磊', body=S8, crumb=True),
    's9-analytics.html': dict(nav='数据', title='数据', body=S9),
}
