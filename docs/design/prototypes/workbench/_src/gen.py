# -*- coding: utf-8 -*-
"""生成 9 个工作台界面（每屏独立 HTML，零外部依赖）。
壳层 / 组件样式集中在这里，各屏只提供 body 片段（见 screens.py）。
"""
import os, io, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from screens import SCREENS, NAV, ICONS

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CSS = """
/* ============================================================
   招聘中台 · 工作台设计令牌（与 Ardot《MVP 原型 v2》逐值对齐）
   ============================================================ */
:root{
  --primary:#2D5BE3;  --primary-tint:#EEF3FE;  --primary-line:#D6E0FB;
  --ai:#7C4DFF;       --ai-tint:#F3EEFF;       --ai-tint-2:#F7F5FF;  --ai-line:#E1D5FF;
  --success:#12A150;  --success-tint:#EAF6EF;
  --warning:#D97706;  --warning-tint:#FEF6E7;
  --danger:#DC2626;   --danger-tint:#FEF3F2;

  --bg:#F5F6F8;  --card:#FFFFFF;  --sidebar:#FCFCFD;  --hover:#F1F3F7;
  --border:#EDF0F2; --divider:#F1F2F4; --track:#EDEFF2;

  --t1:#14161A; --t2:#374151; --t3:#6B7280; --t4:#98A2B3;

  --r-card:8px; --r-btn:6px; --r-chip:4px;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{
  font-family:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  color:var(--t1);background:var(--bg);min-width:1180px;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none;}
button{font-family:inherit;border:0;background:none;cursor:pointer;}
svg{display:block;}
.app{display:flex;height:100vh;overflow:hidden;}

/* ===================== 侧栏 ===================== */
.sidebar{
  flex:0 0 240px;width:240px;background:var(--sidebar);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;padding:16px 12px 14px;
}
.sb__logo{display:flex;align-items:center;gap:10px;padding:4px 8px 20px;}
.sb__mark{width:28px;height:28px;border-radius:8px;background:var(--primary);
  display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
.sb__name{font-size:15px;font-weight:600;letter-spacing:.2px;}
.sb__nav{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;}
.nav{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;
  border-radius:8px;font-size:13px;color:var(--t2);
  transition:background .15s ease,color .15s ease;}
.nav:hover{background:var(--hover);}
.nav.is-active{background:var(--primary-tint);color:var(--primary);font-weight:500;}
.nav svg{flex:0 0 auto;}
.sb__user{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;}
.sb__user:hover{background:var(--hover);}
.sb__uname{font-size:12.5px;font-weight:500;line-height:1.35;}
.sb__urole{font-size:11px;color:var(--t4);line-height:1.35;}

/* ===================== 顶栏 ===================== */
.main{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;height:100vh;}
.topbar{
  flex:0 0 62px;height:62px;background:#fff;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 24px;
}
.tb__left{display:flex;align-items:baseline;gap:10px;min-width:0;}
.tb__title{font-size:15px;font-weight:600;white-space:nowrap;}
.tb__crumb{font-size:15px;font-weight:400;color:var(--t3);}
.tb__sep{font-size:15px;color:var(--t4);}
.tb__date{font-size:12px;color:var(--t4);white-space:nowrap;}
.tb__right{display:flex;align-items:center;gap:12px;}
.tb__search{width:236px;height:34px;border-radius:8px;background:var(--bg);
  display:flex;align-items:center;gap:8px;padding:0 10px;
  font-size:12.5px;color:var(--t4);}
.tb__search .kbd{margin-left:auto;font-size:10px;color:var(--t4);
  border:1px solid var(--border);border-radius:4px;padding:0 4px;background:#fff;line-height:15px;}
.btn-ai{display:flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:8px;
  background:var(--ai-tint);border:1px solid var(--ai-line);color:#6A3FE0;
  font-size:12.5px;font-weight:500;transition:background .18s;}
.btn-ai:hover{background:#EDE4FF;}
.icon-btn{position:relative;width:34px;height:34px;border:1px solid var(--border);border-radius:8px;
  display:flex;align-items:center;justify-content:center;color:var(--t3);background:#fff;
  transition:border-color .18s,color .18s;}
.icon-btn:hover{border-color:#D6DAE0;color:var(--t2);}
.icon-btn__dot{position:absolute;top:7px;right:8px;width:6px;height:6px;border-radius:50%;
  background:var(--danger);border:1.5px solid #fff;}

/* ===================== 内容区 ===================== */
.body{flex:1 1 auto;overflow:auto;background:var(--bg);padding:24px;position:relative;}
.page{display:flex;flex-direction:column;gap:20px;}

.avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#D9DDE5,#EEF0F4);
  display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--t3);flex:0 0 auto;}
.avatar--sm{width:22px;height:22px;font-size:10px;}

/* 卡片 */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-card);}
.card__hd{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 20px;border-bottom:1px solid var(--divider);}
.card__hd--plain{border-bottom:0;}
.card__title{font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;}
.card__sub{font-size:11.5px;color:var(--t4);}
.card__bd{padding:16px 20px;}
.card__bd--flush{padding:0 20px;}

/* 统计卡 */
.grid-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;}
.grid-stats--3{grid-template-columns:repeat(3,1fr);}
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--r-card);
  padding:16px 20px 18px;}
.stat__k{font-size:12px;color:var(--t3);}
.stat__v{font-size:28px;font-weight:700;letter-spacing:-.4px;margin-top:6px;line-height:1.15;}
.stat__v--danger{color:var(--danger);}

/* 两栏 */
.cols{display:grid;grid-template-columns:1fr 320px;gap:20px;align-items:start;}
.cols--320{grid-template-columns:320px 1fr;}
.stack{display:flex;flex-direction:column;gap:20px;}

/* chip / 徽标 */
.chip{display:inline-flex;align-items:center;gap:4px;height:21px;padding:0 8px;
  border-radius:var(--r-chip);font-size:11.5px;font-weight:500;white-space:nowrap;}
.chip--primary{background:var(--primary-tint);color:var(--primary);}
.chip--success{background:var(--success-tint);color:var(--success);}
.chip--warning{background:var(--warning-tint);color:var(--warning);}
.chip--danger{background:var(--danger-tint);color:var(--danger);}
.chip--neutral{background:#F3F4F6;color:var(--t2);font-weight:400;}
.chip--ai{background:var(--ai-tint);color:var(--ai);}
.chip--progress{background:var(--primary-tint);color:var(--primary);font-weight:400;}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;
  padding:0 5px;border-radius:9px;background:#F3F4F6;color:var(--t3);font-size:11px;font-weight:500;}

/* 按钮 */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:34px;padding:0 14px;border-radius:var(--r-btn);font-size:12.5px;font-weight:500;
  transition:background .18s,border-color .18s,color .18s;white-space:nowrap;}
.btn--primary{background:var(--primary);color:#fff;}
.btn--primary:hover{background:#2450CE;}
.btn--default{background:#fff;border:1px solid var(--border);color:var(--t2);}
.btn--default:hover{border-color:#D6DAE0;background:#FAFBFC;}
.btn--block{width:100%;}
.btn--lg{height:38px;font-size:13px;}
.link{font-size:12.5px;color:var(--primary);font-weight:500;transition:opacity .18s;}
.link:hover{opacity:.72;}
.link--quiet{font-size:12.5px;color:var(--t3);}
.link--quiet:hover{color:var(--t2);}

/* 表单 */
.field{display:flex;flex-direction:column;gap:8px;}
.field__label{font-size:12.5px;font-weight:500;color:var(--t2);}
.input,.select,.textarea{
  width:100%;height:38px;border:1px solid var(--border);border-radius:var(--r-btn);
  padding:0 12px;font-family:inherit;font-size:13px;color:var(--t1);background:#fff;
  transition:border-color .18s;outline:0;
}
.input::placeholder,.textarea::placeholder{color:var(--t4);}
.input:focus,.select:focus,.textarea:focus{border-color:var(--primary);}
.textarea{height:96px;padding:10px 12px;resize:none;line-height:1.65;}
.select{appearance:none;background-image:url("data:image/svg+xml;charset=utf8,%3Csvg width='12' height='12' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' stroke='%2398A2B3' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;padding-right:32px;}
.seg{display:flex;padding:3px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r-btn);}
.seg__i{flex:1;height:30px;display:flex;align-items:center;justify-content:center;
  border-radius:4px;font-size:12.5px;color:var(--t3);transition:background .18s,color .18s,box-shadow .18s;}
.seg__i.is-on{background:#fff;color:var(--t1);font-weight:500;box-shadow:0 1px 2px rgba(16,24,40,.06);}
.seg--bare{background:transparent;border:0;padding:0;gap:4px;}
.seg--bare .seg__i{flex:0 0 auto;height:34px;padding:0 16px;border:1px solid transparent;}
.seg--bare .seg__i.is-on{border-color:var(--border);box-shadow:0 1px 2px rgba(16,24,40,.05);}

/* 提示条 */
.note{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:var(--r-btn);
  font-size:12px;line-height:1.6;}
.note--ai{background:var(--ai-tint-2);color:#5B3FD1;}
.note--info{background:#F0F6FF;color:var(--primary);}
.note--ai .note__t{font-weight:600;color:var(--ai);}
.note__icon{flex:0 0 auto;margin-top:2px;}

/* 列表行 / 表格 */
.rows{display:flex;flex-direction:column;}
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;
  padding:13px 20px;border-bottom:1px solid var(--divider);}
.row:last-child{border-bottom:0;}
.row__t{font-size:13px;color:var(--t1);line-height:1.5;}
.row__s{font-size:11.5px;color:var(--t4);line-height:1.5;margin-top:2px;}
.row__s--danger{color:var(--danger);}
.row__s--warning{color:var(--warning);}

.group-hd{padding:8px 20px;font-size:11.5px;font-weight:500;color:var(--t3);background:#FAFBFC;}
.group-hd--warning{background:var(--warning-tint);color:var(--warning);}

.table{background:var(--card);border:1px solid var(--border);border-radius:var(--r-card);overflow:hidden;}
.thead,.trow{display:grid;align-items:center;gap:20px;padding:0 20px;}
.thead{height:40px;background:#FAFBFC;border-bottom:1px solid var(--divider);
  font-size:11.5px;font-weight:500;color:var(--t3);}
.trow{min-height:64px;border-bottom:1px solid var(--divider);font-size:13px;color:var(--t2);
  transition:background .15s;}
.trow:last-child{border-bottom:0;}
.trow:hover{background:#FAFBFC;}
.trow__t{font-size:13px;font-weight:600;color:var(--t1);line-height:1.45;}
.trow__s{font-size:11.5px;color:var(--t4);line-height:1.45;margin-top:1px;}
.prog-num{font-size:13px;font-weight:600;color:var(--t1);}
.prog-num i{font-style:normal;font-weight:400;color:var(--t4);}

.tfoot{display:flex;align-items:center;justify-content:space-between;height:52px;
  padding:0 20px;border-top:1px solid var(--divider);}
.tfoot__n{font-size:12px;color:var(--t3);}
.pager{display:flex;align-items:center;gap:6px;}
.pager__i{min-width:26px;height:26px;border-radius:6px;display:flex;align-items:center;
  justify-content:center;font-size:12.5px;color:var(--t3);}
.pager__i:hover{background:var(--hover);}
.pager__i.is-on{background:var(--primary);color:#fff;font-weight:500;}

/* 进度条 */
.progress{height:6px;border-radius:3px;background:var(--track);overflow:hidden;}
.progress__i{height:100%;border-radius:3px;background:var(--primary);}
.progress__i--success{background:var(--success);}
.progress-row{display:flex;align-items:center;gap:12px;}
.progress-row__t{width:78px;font-size:12.5px;color:var(--t2);flex:0 0 auto;}
.progress-row .progress{flex:1 1 auto;}
.progress-row__v{width:40px;text-align:right;font-size:12px;color:var(--t2);flex:0 0 auto;}
.progress-row__v b{font-weight:600;color:var(--t1);}

/* 时间线 */
.timeline{display:flex;flex-direction:column;}
.tl{position:relative;padding:0 0 18px 20px;}
.tl:last-child{padding-bottom:0;}
.tl::before{content:'';position:absolute;left:3.5px;top:12px;bottom:-2px;width:1px;background:var(--divider);}
.tl:last-child::before{display:none;}
.tl__dot{position:absolute;left:0;top:5px;width:8px;height:8px;border-radius:50%;
  background:var(--primary);box-shadow:0 0 0 3px var(--primary-tint);}
.tl__dot--warning{background:var(--warning);box-shadow:0 0 0 3px var(--warning-tint);}
.tl__dot--idle{background:#D0D5DD;box-shadow:0 0 0 3px #F2F4F7;}
.tl__t{font-size:12.5px;font-weight:500;color:var(--t1);line-height:1.5;}
.tl__s{font-size:11.5px;color:var(--t4);line-height:1.5;margin-top:2px;}
.tl__s--warning{color:var(--warning);}

/* 键值行 */
.kv{display:flex;align-items:flex-start;gap:12px;font-size:12.5px;line-height:1.6;}
.kv__k{width:74px;flex:0 0 auto;color:var(--t3);}
.kv__v{flex:1 1 auto;color:var(--t2);}
.kv__v b{font-weight:600;color:var(--t1);}
.kv--wide .kv__k{width:88px;}
.kv-list{display:flex;flex-direction:column;gap:10px;}
.kv-grid{display:grid;grid-template-columns:repeat(3,auto);justify-content:start;gap:12px 56px;}
.kv-grid .kv{display:flex;gap:10px;font-size:12.5px;line-height:1.6;}
.kv-grid .kv__k{width:auto;flex:0 0 auto;}
.kv-grid .kv__v{flex:0 0 auto;}

/* 标题小节 */
.sec{padding:16px 20px;border-bottom:1px solid var(--divider);}
.sec:last-child{border-bottom:0;}
.sec__hd{font-size:13px;font-weight:600;margin-bottom:10px;}
.sec__p{font-size:12.5px;color:var(--t2);line-height:1.75;}
.sec__list{display:flex;flex-direction:column;gap:8px;margin-top:2px;}
.sec__li{position:relative;padding-left:14px;font-size:12.5px;color:var(--t2);line-height:1.7;}
.sec__li::before{content:'';position:absolute;left:2px;top:8px;width:4px;height:4px;
  border-radius:50%;background:#C6CBD4;}
.sec__li--warning{color:var(--warning);}
.sec__li--warning::before{background:var(--warning);}

/* 招聘流水线 */
.board{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;}
.bcol{background:#F1F2F4;border-radius:var(--r-card);padding:10px;min-height:520px;}
.bcol--success{background:var(--success-tint);}
.bcol__hd{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 10px;}
.bcol__t{font-size:12.5px;font-weight:600;}
.bcol--success .bcol__t{color:var(--success);}
.bcol__n{font-size:12px;color:var(--t4);}
.bcol__list{display:flex;flex-direction:column;gap:8px;}
.pcard{background:#fff;border:1px solid var(--border);border-radius:6px;padding:10px 12px;
  transition:border-color .18s,box-shadow .18s;cursor:pointer;}
.pcard:hover{border-color:var(--primary-line);box-shadow:0 2px 8px rgba(16,24,40,.06);}
.pcard__t{font-size:12.5px;font-weight:600;line-height:1.5;}
.pcard__s{font-size:11px;color:var(--t4);line-height:1.5;margin-top:3px;}
.pcard__s--warning{color:var(--warning);}
.pcard__s--success{color:var(--success);}

/* 抽屉 / 弹窗 */
.overlay{position:absolute;inset:0;background:rgba(2,6,12,.4);z-index:20;
  animation:fadeIn .2s ease-out;}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes slideIn{from{transform:translateX(24px);opacity:0;}to{transform:none;opacity:1;}}
@keyframes popIn{from{transform:translateY(8px) scale(.99);opacity:0;}to{transform:none;opacity:1;}}
.drawer{position:absolute;top:0;right:0;bottom:0;width:580px;background:#fff;z-index:21;
  display:flex;flex-direction:column;box-shadow:-18px 0 44px rgba(16,24,40,.16);
  animation:slideIn .24s cubic-bezier(.22,.61,.36,1);}
.drawer__hd{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;
  padding:20px 40px 16px;}
.drawer__title{font-size:15px;font-weight:600;}
.drawer__bd{flex:1 1 auto;overflow:auto;padding:4px 40px 20px;
  display:flex;flex-direction:column;gap:18px;}
.drawer__ft{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:10px;
  padding:16px 40px 20px;border-top:1px solid var(--divider);}
.modal-wrap{position:absolute;inset:0;z-index:21;display:flex;align-items:center;justify-content:center;}
.modal{width:600px;max-height:calc(100% - 32px);background:#fff;border-radius:10px;
  display:flex;flex-direction:column;box-shadow:0 18px 44px rgba(16,24,40,.18);
  animation:popIn .22s cubic-bezier(.22,.61,.36,1);}
.modal__hd{display:flex;align-items:center;justify-content:space-between;padding:20px 28px 16px;}
.modal__title{font-size:15px;font-weight:600;}
.modal__bd{flex:1 1 auto;overflow:auto;padding:0 28px;display:flex;flex-direction:column;gap:18px;}
.modal__ft{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:16px 28px 20px;border-top:1px solid var(--divider);}
.cand-box{display:flex;align-items:center;gap:12px;background:var(--bg);border-radius:8px;
  padding:12px 14px;}
.cand-box__t{font-size:13px;font-weight:600;}
.cand-box__s{font-size:11.5px;color:var(--t4);margin-top:2px;}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;}

/* 漏斗 */
.funnel{display:flex;flex-direction:column;align-items:center;gap:14px;padding:26px 0 6px;}
.funnel__b{height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:12.5px;font-weight:500;}
.funnel__b--success{background:var(--success);}

/* 文档（录用通知书） */
.doc{padding:40px 56px;}
.doc__co{font-size:12px;color:var(--t3);text-align:center;}
.doc__title{font-size:21px;font-weight:700;text-align:center;margin:10px 0 26px;letter-spacing:1px;}
.doc__p{font-size:12.5px;color:var(--t2);line-height:1.9;}
.doc__row{display:flex;align-items:center;background:#FAFBFC;border-radius:6px;
  padding:12px 16px;margin:8px 0;font-size:12.5px;}
.doc__row .doc__k{width:110px;flex:0 0 auto;color:var(--t3);}
.doc__row .doc__v{color:var(--t1);font-weight:500;}
.doc__sign{display:flex;justify-content:space-between;font-size:12.5px;color:var(--t2);margin-top:26px;}
.doc__mt{margin-top:18px;}

/* 空态 / 说明 */
.empty-body{height:100%;}

/* ---------- 工具条（列表页 / 数据页） ---------- */
.toolbar{display:flex;align-items:center;gap:12px;}
.toolbar__search{display:flex;align-items:center;gap:8px;width:240px;height:34px;
  padding:0 12px;background:#fff;border:1px solid var(--border);border-radius:var(--r-btn);
  font-size:12.5px;color:var(--t4);}
.toolbar__search svg{color:var(--t4);flex:0 0 auto;}
.select--btn{width:auto;height:34px;padding:0 30px 0 12px;font-size:12.5px;color:var(--t2);
  cursor:pointer;text-align:left;}

/* ---------- 卡片标题大号 / 元信息行 ---------- */
.card__title--xl{font-size:17px;letter-spacing:-.2px;}
.card__ft{display:flex;align-items:center;justify-content:flex-end;gap:10px;
  padding:14px 20px;border-top:1px solid var(--divider);}
.meta-row{display:flex;align-items:center;gap:20px;font-size:12.5px;color:var(--t3);}
.meta-row b{font-weight:600;color:var(--t2);}
.match{font-size:12.5px;font-weight:600;color:var(--success);}
.row-line{display:flex;align-items:center;justify-content:space-between;gap:12px;
  font-size:12.5px;color:var(--t2);}
.row-line__side{font-size:12px;color:var(--t4);}
.row-line__k{width:44px;flex:0 0 auto;font-size:12.5px;color:var(--t3);}
.file-line{display:inline-flex;align-items:center;gap:7px;color:var(--t2);}
.file-line svg{color:var(--t4);flex:0 0 auto;}

/* ---------- 小组件 ---------- */
.quick-links{display:flex;flex-direction:column;gap:12px;margin-top:16px;}
.mini__hd{display:flex;align-items:center;justify-content:space-between;
  font-size:12.5px;color:var(--t2);margin-bottom:8px;}
.sched{display:flex;align-items:flex-start;gap:14px;}
.sched__t{min-width:40px;font-size:12.5px;font-weight:600;color:var(--t1);line-height:1.5;}
.chip-row{display:flex;flex-wrap:wrap;gap:8px;}
.exp__t{font-size:12.5px;font-weight:500;color:var(--t1);line-height:1.6;}
.exp__s{font-size:11.5px;color:var(--t4);line-height:1.6;margin-top:2px;}
.score-list{display:flex;flex-direction:column;gap:12px;}
.score{display:flex;align-items:center;justify-content:space-between;
  font-size:12.5px;color:var(--t2);}
.score__v{font-weight:600;color:var(--t1);}
.rate{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:var(--t2);}
.rate__v{font-size:13px;font-weight:600;color:var(--t1);}
.rate__v--success{color:var(--success);}
.status-warning{color:var(--warning);font-weight:500;}
.hint{font-size:11.5px;color:var(--t4);line-height:1.6;text-align:center;}
.interviewer{display:flex;align-items:center;gap:9px;}
.interviewer__n{font-size:12.5px;color:var(--t2);}
.modal__hint{font-size:11.5px;color:var(--t4);}
.modal__acts{display:flex;align-items:center;gap:10px;}
.icon-btn--bare{width:28px;height:28px;border:0;border-radius:6px;color:var(--t3);}
.icon-btn--bare:hover{background:var(--hover);color:var(--t2);}
.note--ai b{color:var(--ai);}
.body--drawer{overflow:hidden;}

/* ---------- 表格列宽 ---------- */
.thead,.trow{grid-template-columns:1fr 120px 110px 120px 130px 56px;}
.trow__upd{color:var(--t3);}
.doc__row .doc__k{width:130px;}

@media (max-width:1279px){
  .cols{grid-template-columns:1fr 300px;}
}
"""

def shell(title, body, nav_active, crumb=None, body_class=''):
    parts = title.split(' / ')
    if crumb and len(parts) > 1:
        tb = ('<span class="tb__crumb">%s</span><span class="tb__sep">/</span>'
              '<span class="tb__title">%s</span>') % (parts[0], ' / '.join(parts[1:]))
    else:
        tb = '<span class="tb__title">%s</span>' % (crumb or title)
    nav = '\n'.join(
        '      <a class="nav%s" href="%s">%s<span>%s</span></a>' % (
            ' is-active' if k == nav_active else '', href, ICONS[icon], k)
        for k, href, icon in NAV)
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tritree 招聘中台 · %(title)s</title>
<style>%(css)s</style>
</head>
<body>
<div class="app">

  <!-- ===================== 侧栏 ===================== -->
  <aside class="sidebar">
    <div class="sb__logo">
      <div class="sb__mark">
        <svg width="17" height="17" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M15 3 L22 13 H18.5 L24 22 H6 L11.5 13 H8 L15 3 Z" fill="#FFFFFF"/>
          <rect x="13" y="22" width="4" height="5" rx="1" fill="#FFFFFF" opacity="0.65"/>
        </svg>
      </div>
      <span class="sb__name">招聘中台</span>
    </div>

    <nav class="sb__nav">
%(nav)s
    </nav>

    <div class="sb__user">
      <span class="avatar">潘</span>
      <span>
        <span class="sb__uname">潘雨松</span><br>
        <span class="sb__urole">招聘负责人</span>
      </span>
    </div>
  </aside>

  <!-- ===================== 主区 ===================== -->
  <main class="main">
    <header class="topbar">
      <div class="tb__left">
        %(tb)s
        <span class="tb__date">9月10日 星期四</span>
      </div>
      <div class="tb__right">
        <div class="tb__search">
          %(icon_search)s
          <span>搜索职位、候选人</span>
          <span class="kbd">HK</span>
        </div>
        <button class="btn-ai" type="button">%(icon_ai)s AI 助手</button>
        <button class="icon-btn" type="button" aria-label="通知">%(icon_bell)s<span class="icon-btn__dot"></span></button>
        <span class="avatar">潘</span>
      </div>
    </header>

    <div class="body %(body_class)s">
%(body)s
    </div>
  </main>

</div>
</body>
</html>
""" % dict(title=title, css=CSS, nav=nav, tb=tb, body=body, body_class=body_class,
           icon_search=ICONS['search'], icon_ai=ICONS['sparkle'], icon_bell=ICONS['bell'])


def main():
    os.makedirs(OUT, exist_ok=True)
    for fname, spec in SCREENS.items():
        html = shell(spec['title'], spec['body'], spec['nav'],
                     crumb=spec.get('crumb'), body_class=spec.get('body_class', ''))
        path = os.path.join(OUT, fname)
        with io.open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        print('%-30s %6d bytes' % (fname, len(html.encode('utf-8'))))


if __name__ == '__main__':
    main()
