// minifuse Web UI — 三栏布局(Preact):
// 左栏 sessions(project 下拉在其顶部)| 中栏 traces | 右栏 trace 详情(树 + 属性面板)

import { render } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";

/* ---------------- 样式 ---------------- */
const CSS = `
:root,[data-theme=dark]{
--bg:#0b0d10;--bg2:#0d1014;--bg3:#161b22;--border:#141920;--border2:#232a33;
--text:#d7dce3;--muted:#8b949e;--hover:#131a23;--sel:#182434;--selborder:#264f78;--input-bg:#161b22;--input-shadow:none;
--accent:#1f6feb;--accentbar:#2a6fdb66;--link:#7ab0ff;--btn-fg:#fff;--danger:#b62324;
--bg-sticky:#0b0d10ee;
--b-gen-bg:#3d2a00;--b-gen-fg:#ffb454;--b-tool-bg:#0c2d4d;--b-tool-fg:#6cb6ff;
--b-span-bg:#1d2b1d;--b-span-fg:#7ee787;--b-ev-bg:#2d1d2d;--b-ev-fg:#d2a8ff;
--b-err-bg:#3d0f10;--b-err-fg:#ff7b72;
--jv-key:#7ab0ff;--jv-str:#7ee787;--jv-num:#ffb454;--jv-bool:#d2a8ff}
[data-theme=light]{
--bg:#f6f8fa;--bg2:#ffffff;--bg3:#eef1f4;--border:#e4e8ec;--border2:#d0d7de;
--text:#1f2328;--muted:#656d76;--hover:#eaeef2;--sel:#dbeafe;--selborder:#93c5fd;--input-bg:#ffffff;--input-shadow:0 1px 3px rgba(31,35,40,.08);
--accent:#1f6feb;--accentbar:#1f6feb33;--link:#0969da;--btn-fg:#fff;--danger:#cf222e;
--bg-sticky:#f6f8faee;
--b-gen-bg:#fff3d6;--b-gen-fg:#8a5300;--b-tool-bg:#dbeeff;--b-tool-fg:#0a5399;
--b-span-bg:#dcf5de;--b-span-fg:#1a5e20;--b-ev-bg:#f1e3f7;--b-ev-fg:#6a2f8a;
--b-err-bg:#ffe8e8;--b-err-fg:#b62324;
--jv-key:#0969da;--jv-str:#116329;--jv-num:#953800;--jv-bool:#8250df}
*{box-sizing:border-box;margin:0}
html,body,#root{height:100%}
body{font-family:ui-monospace,'SF Mono',Menlo,monospace;background:var(--bg);color:var(--text);font-size:13px}
a{color:var(--link);text-decoration:none}
.topbar{display:flex;gap:16px;align-items:center;padding:8px 14px;background:var(--bg2);border-bottom:1px solid var(--border2);flex:none}
.topbar .brand{font-weight:700;color:var(--btn-fg);letter-spacing:.5px}
.topbar nav a{margin-right:10px;padding:4px 8px;border-radius:6px}
.topbar nav a.on{background:var(--sel);color:var(--btn-fg)}
.cols{display:flex;height:100%;min-height:0}
.col{overflow-y:auto;min-height:0}
.col-sessions{width:240px;flex:none;border-right:1px solid var(--border);background:var(--bg2);position:relative}
.col-traces{width:400px;flex:none;border-right:1px solid var(--border);position:relative;background:var(--bg2)}
.col-tree{min-width:0;background:var(--bg2)}
.col-detail{min-width:0;display:flex;flex-direction:column;overflow:hidden}
.vsplit{width:7px;flex:none;cursor:col-resize;position:relative;z-index:3}
.vsplit::after{content:"";position:absolute;top:0;bottom:0;left:2px;width:3px;background:var(--border);border-radius:2px}
.vsplit:hover::after,.vsplit.drag::after{background:var(--accent)}
.col.gone{display:none}
/* 分割线折叠把手(VS Code 风格):骑在栏右缘分割线中央 */
.foldbar{position:absolute;right:-14px;top:50%;transform:translateY(-50%);width:28px;height:96px;
background:var(--input-bg);border:1.5px solid var(--border2);border-radius:9px;
display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:6;
color:var(--text);box-shadow:var(--input-shadow)}
.foldbar:hover{border-color:var(--accent);color:var(--link)}
.foldbar svg{display:block}
/* 折叠后的细条:把手贴中央 */
.rail{width:24px;flex:none;border-right:1px solid var(--border);background:var(--bg2);cursor:pointer;
display:flex;align-items:center;justify-content:center;color:var(--muted);writing-mode:vertical-rl;
letter-spacing:3px;font-size:12px;padding:12px 0;user-select:none}
.rail:hover{background:var(--sel);color:var(--btn-fg)}
.colhead{padding:10px 12px 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px;position:sticky;top:0;background:var(--bg-sticky);backdrop-filter:blur(3px);z-index:2;display:flex;align-items:center}
.colhead .fold{margin-left:auto;cursor:pointer;padding:0 6px;border-radius:4px;color:var(--muted)}
.colhead .fold:hover{background:var(--border2);color:var(--btn-fg)}
.refresh-ico{margin-left:auto;cursor:pointer;display:flex;align-items:center;color:var(--muted);padding:2px 4px;border-radius:4px}
.refresh-ico:hover{color:var(--link);animation:spin .6s linear}
@keyframes spin{to{transform:rotate(360deg)}}
select,input{background:var(--input-bg);color:var(--text);border:1px solid var(--border2);border-radius:8px;
padding:6px 8px;font-family:inherit;font-size:12px;width:100%;box-shadow:var(--input-shadow)}
select{appearance:none;-webkit-appearance:none;padding:6px 26px 6px 10px;cursor:pointer;
background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237a828c' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
background-repeat:no-repeat;background-position:right 9px center}
select:hover{border-color:var(--accent)}
select:focus{outline:none;border-color:var(--accent)}
option{background:var(--input-bg);color:var(--text)}
button{background:var(--accent);color:var(--btn-fg);border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:12px}
button.ghost{background:var(--border2);color:var(--text)}
button.danger{background:var(--danger)}
.sess-item{padding:8px 12px;cursor:pointer;border-left:2px solid transparent}
.sess-item:hover{background:var(--hover)}
.sess-item.sel{background:var(--sel);border-left-color:var(--accent)}
.sess-item .n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess-item .m{color:var(--muted);font-size:11px;margin-top:2px}
.trace-row{padding:8px 12px;cursor:pointer;border-left:2px solid transparent;border-bottom:1px solid var(--border)}
.trace-row:hover{background:var(--hover)}
.trace-row.sel{background:var(--sel);border-left-color:var(--accent)}
.trace-row .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.fnid{color:var(--muted);font-weight:400}
.trace-row .m{color:var(--muted);font-size:11px;margin-top:3px;display:flex;gap:10px}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px}
.badge.GENERATION{background:var(--b-gen-bg);color:var(--b-gen-fg)}
.badge.TOOL{background:var(--b-tool-bg);color:var(--b-tool-fg)}
.badge.SPAN{background:var(--b-span-bg);color:var(--b-span-fg)}
.badge.EVENT{background:var(--b-ev-bg);color:var(--b-ev-fg)}
.badge.err{background:var(--b-err-bg);color:var(--b-err-fg)}
.badge.ok{background:var(--b-span-bg);color:var(--b-span-fg)}
.dhead{padding:10px 14px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg-sticky);backdrop-filter:blur(3px);z-index:2}
.dlayout{display:flex;gap:0;align-items:flex-start;min-height:0;flex:1}
.treecol{flex:1.35;min-width:0;padding:10px;overflow-y:auto}
.detailcol{flex:1;min-width:0;padding:10px;overflow-y:auto}
.node{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;margin-bottom:2px;cursor:pointer;border:1px solid transparent;position:relative}
.node:hover{background:var(--hover)}
.node.sel{background:var(--sel);border-color:var(--selborder)}
.node .bar{position:absolute;bottom:0;left:0;height:3px;background:color-mix(in srgb, var(--accent) 35%, transparent);border-radius:2px;min-width:8px}
.tree-caret{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;
cursor:pointer;color:var(--muted);font-size:15px;line-height:1;border-radius:4px;user-select:none}
.tree-caret:hover{background:var(--hover);color:var(--text)}
.tree-caret.leaf{visibility:hidden;pointer-events:none}
.dur{color:var(--muted);min-width:56px;text-align:right;margin-left:auto}
.kv{margin-top:10px}
.kv h4{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.kv pre{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto;max-height:none;white-space:pre-wrap;word-break:break-all;font-size:12px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px}
.col-detail>.card{flex:1;margin:10px;overflow-y:auto;display:flex;flex-direction:column}
.col-detail>.card .kv{flex:none}
.acc{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;margin-top:4px}
.acc-item{display:flex;flex-direction:column;min-height:0;flex:none}
.acc-item.open{flex:1;min-height:0}
.acc-head{cursor:pointer;padding:9px 2px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px;
border-top:1px solid var(--border);display:flex;align-items:center;gap:6px;user-select:none}
.acc-head:hover{color:var(--text)}
.acc-head::before{content:"▸";font-size:16px;transition:transform .15s;color:var(--muted);margin-right:2px}
.acc-item.open .acc-head{color:var(--text)}
.acc-item.open .acc-head::before{transform:rotate(90deg)}
.iotabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:8px;flex:none}
.iotab{padding:6px 16px;cursor:pointer;color:var(--muted);font-size:12px;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}

/* ---------------- Formatted(易读)视图 ---------------- */
.fmt-tabs{display:flex;gap:2px;margin-left:auto;margin-right:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden;flex:none}
.fmt-tab{padding:3px 10px;font-size:11px;cursor:pointer;color:var(--muted);background:transparent;border:none}
.fmt-tab.on{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--text);font-weight:600}
.pretty{display:flex;flex-direction:column;gap:10px;padding:12px 4px;overflow-y:auto;flex:1;min-height:0}
.msg{display:grid;grid-template-columns:84px minmax(0,1fr);gap:10px;align-items:start;padding:2px 0}
.msg-role{width:84px;text-align:center;font-size:11px;font-weight:700;padding:3px 0;border-radius:6px;letter-spacing:.02em;white-space:nowrap;box-sizing:border-box}
/* 角色徽标:暗/亮主题分别用高对比实色(底色/文字) */
[data-theme="dark"] .role-system{background:#334155;color:#e2e8f0}
[data-theme="dark"] .role-user{background:#1d4ed8;color:#eff6ff}
[data-theme="dark"] .role-assistant{background:#15803d;color:#f0fdf4}
[data-theme="dark"] .role-tool{background:#b45309;color:#fffbeb}
[data-theme="dark"] .role-toolcall{background:#7e22ce;color:#faf5ff}
[data-theme="dark"] .role-reasoning{background:#475569;color:#f1f5f9}
[data-theme="light"] .role-system{background:#e2e8f0;color:#334155}
[data-theme="light"] .role-user{background:#bfdbfe;color:#1e40af}
[data-theme="light"] .role-assistant{background:#bbf7d0;color:#166534}
[data-theme="light"] .role-tool{background:#fde68a;color:#92400e}
[data-theme="light"] .role-toolcall{background:#e9d5ff;color:#6b21a8}
[data-theme="light"] .role-reasoning{background:#e2e8f0;color:#475569}
[data-theme="dark"] .role-err{background:#7f1d1d;color:#fee2e2}
[data-theme="light"] .role-err{background:#fecaca;color:#7f1d1d}
.err-body{border-color:#b91c1c !important;background:color-mix(in srgb,#dc2626 7%,var(--bg2)) !important}
.msg-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px}
.ptext-body{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.65;color:var(--text)}
.ptext-body .md{white-space:normal}
/* 折叠态统一高度:与 system 卡(900 字符 md)的典型高度一致,底部渐隐提示可展开 */
.ptext-clamped{max-height:460px;overflow:hidden;position:relative}
.ptext-clamped::after{content:"";position:absolute;left:0;right:0;bottom:0;height:56px;background:linear-gradient(transparent,var(--bg2));pointer-events:none}
.md{font-size:12.5px;line-height:1.7;color:var(--text);min-width:0}
.md p{margin:2px 0}
.md .md-h{font-weight:700;margin:10px 0 4px;line-height:1.4;color:var(--text)}
.md h3.md-h{font-size:14.5px}
.md h4.md-h{font-size:13.5px}
.md h5.md-h,.md h6.md-h{font-size:12.5px}
.md ul,.md ol{margin:4px 0;padding-left:22px}
.md li{margin:2px 0}
.md-code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--text) 10%,transparent);word-break:break-word}
.md a.md-link{color:var(--accent,#4d9fff);text-decoration:underline}
.md hr{border:none;border-top:1px solid var(--border);margin:8px 0}
.md blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--border);color:var(--muted)}
.md-tablewrap{margin:8px 0;overflow-x:auto;border:1px solid var(--border);border-radius:10px}
.md-table{border-collapse:collapse;width:100%;font-size:12px;line-height:1.6}
.md-table th,.md-table td{padding:9px 16px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.md-table thead th{font-weight:500;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--border)}
.md-table tbody tr:last-child td{border-bottom:none}
.md-table tbody tr:hover{background:color-mix(in srgb,var(--text) 4%,transparent)}
.md-prewrap{border:1px solid var(--border);border-radius:8px;overflow:hidden;margin:6px 0}
.md-prehead{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;background:color-mix(in srgb,var(--text) 6%,transparent);font-size:11px;color:var(--muted)}
.md-precopy{border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:11px;padding:2px 4px}
.md-precopy:hover{color:var(--text)}
.md-pre{margin:0;padding:10px;overflow-x:auto;font-size:12px;line-height:1.5;background:color-mix(in srgb,var(--text) 4%,transparent)}
.md-pre code{font-family:ui-monospace,Menlo,monospace;white-space:pre}
/* 语法高亮:暗/亮两套配色 */
[data-theme="dark"] .tok-kw{color:#c792ea}
[data-theme="dark"] .tok-str{color:#9ece6a}
[data-theme="dark"] .tok-num{color:#ff9e64}
[data-theme="dark"] .tok-com{color:#6b7394;font-style:italic}
[data-theme="dark"] .tok-key{color:#7aa2f7}
[data-theme="dark"] .tok-fn{color:#7dcfff}
[data-theme="light"] .tok-kw{color:#7c3aed}
[data-theme="light"] .tok-str{color:#15803d}
[data-theme="light"] .tok-num{color:#b45309}
[data-theme="light"] .tok-com{color:#94a3b8;font-style:italic}
[data-theme="light"] .tok-key{color:#1d4ed8}
[data-theme="light"] .tok-fn{color:#0e7490}
.ptext-more{margin-top:4px;font-size:11px;padding:2px 8px}
.ptree{border-left:2px solid var(--border);padding-left:8px;margin:2px 0}
.pstr{white-space:pre-wrap;word-break:break-word;font-size:12px}
.pnum{color:var(--b-gen-fg,#fbbf24);font-size:12px}
.pnull{color:var(--muted);font-size:12px}
.ptool-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-bottom:4px;border-bottom:1px dashed var(--border);font-size:11px}
[data-theme="dark"] .ptool-name{font-size:12px;font-weight:600;color:#fcd34d}
[data-theme="light"] .ptool-name{font-size:12px;font-weight:600;color:#92400e}
.pmeta{font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
.toolcall{border:1px solid var(--border);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:color-mix(in srgb,var(--bg2) 60%,transparent)}
.toolcall-head{display:flex;gap:8px;align-items:center}
.toolcall-head .msg-role{width:auto;padding:3px 8px;margin:0}
.toolcall-name{font-size:12.5px;font-weight:600;color:var(--text)}
.pkv{border:1px dashed var(--border);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.pkv-row{display:flex;gap:10px;font-size:12px;align-items:flex-start}
.pkv-k{flex:none;width:110px;color:var(--muted);font-weight:600;padding-top:1px}
.pkv-v{flex:1;min-width:0}
/* 工具定义行列表(tools,嵌在 .msg-body 卡片内) */
.tools-list{display:flex;flex-direction:column}
.tool-def+.tool-def{border-top:1px solid var(--border)}
.tool-def-head{display:flex;gap:8px;align-items:center;padding:7px 2px;cursor:pointer}
.tool-def-head:hover .tool-def-name{color:var(--accent,#4d9fff)}
.tool-def-caret{color:var(--muted);font-size:10px;width:12px;flex:none}
.tool-def-name{font-size:12.5px;font-weight:600;color:var(--text);font-family:ui-monospace,Menlo,monospace}
.tool-def-desc{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.tool-def-body{padding:2px 2px 8px 20px;display:flex;flex-direction:column;gap:6px}
/* session 筛选框 */
.sess-search{width:100%;box-sizing:border-box;background:var(--input-bg);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:12px;padding:8px 10px;min-height:36px;outline:none;box-shadow:var(--input-shadow);font-family:inherit}
.sess-search:focus{border-color:var(--accent)}
.sess-search::placeholder{color:var(--muted)}
.match-count{margin-left:6px;color:var(--accent,#4d9fff);font-weight:700;text-transform:none;letter-spacing:0}
/* 详情面板快速滚动按钮 */
.fastbtns{position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:5}
.fastbtn{width:38px;height:38px;border-radius:50%;border:1px solid var(--border2);background:var(--bg3);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s,color .15s}
/* 深色主题:明显高于卡片底的实心圆 + 近白箭头,避免与卡片融为一体 */
[data-theme=dark] .fastbtn{background:#242b35;border-color:#46505c;color:#f2f5f8;box-shadow:0 3px 14px rgba(0,0,0,.6)}
[data-theme=dark] .fastbtn:hover{background:#303844;border-color:#58a6ff;color:#58a6ff}
[data-theme=light] .fastbtn{background:#ffffff;border-color:#c3ccd5;color:#24292f;box-shadow:0 2px 10px rgba(31,35,40,.16)}
[data-theme=light] .fastbtn:hover{background:#f6f8fa;border-color:#1f6feb;color:#1f6feb}
.iotab:hover{color:var(--text)}
.iotab.on{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.acc-tools{display:flex;gap:6px;margin-left:auto}
.acc-tools .mini{cursor:pointer;font-size:11px;color:var(--muted);padding:2px 8px;border:1px solid var(--border2);border-radius:6px;background:var(--bg3)}
.acc-tools .mini:hover{color:var(--link);border-color:var(--accent)}
.jv{font-size:12px;line-height:1.55}
.jv-wrap{font-size:12px;line-height:1.6}
.jr{display:flex;align-items:flex-start;min-height:19px}
.jr:hover{background:var(--hover)}
.jr-no{flex:none;width:38px;text-align:right;padding-right:10px;color:var(--muted);opacity:.5;user-select:none;font-size:10.5px;line-height:1.6}
.jr-main{flex:1;min-width:0;display:flex;align-items:flex-start}
.jr-caret{flex:none;width:13px;text-align:center;cursor:pointer;color:var(--muted);user-select:none;font-size:9px;line-height:1.7}
.jr-caret.leaf{visibility:hidden}
.jv-key{flex:none;color:var(--text);white-space:nowrap}
.jv-brace{color:var(--muted)}
.jv-summary{color:var(--muted);cursor:default}
.jr-copy{flex:none;margin-left:6px;cursor:pointer;color:var(--border2);opacity:0;font-size:11px}
.jr:hover .jr-copy{opacity:1}
.jr-copy:hover{color:var(--link)}
.jv-tools{display:flex;gap:6px;margin-bottom:8px;justify-content:flex-end}
.jv-tools .mini{cursor:pointer;font-size:11px;color:var(--muted);padding:1px 8px;border:1px solid var(--border2);border-radius:6px;background:var(--bg2)}
.jv-tools .mini:hover{color:var(--link);border-color:var(--accent)}
.jv-row{display:block}
.jv-key{color:var(--jv-key)}
.jv-items{color:var(--muted);cursor:pointer;user-select:none}
.jv-items:hover{color:var(--text)}
.jv-str{color:var(--jv-str);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.jv-num{color:var(--jv-num)}
.jv-bool{color:var(--jv-bool)}
.jv-null{color:var(--muted)}
.jv-expand{color:var(--muted);cursor:pointer;font-style:italic;border-bottom:1px dashed var(--border2)}
.jv-expand:hover{color:var(--link);border-bottom-color:var(--link)}
.acc-body{flex:1;overflow:auto;margin:0 0 8px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;
padding:10px;white-space:pre-wrap;word-break:break-all;font-size:12px;min-height:0}
.col-detail>.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center}
.muted{color:var(--muted)}
.empty{padding:30px 16px;color:var(--muted);text-align:center}
.pager{padding:8px 12px}
main.admin{padding:24px auto;max-width:860px;margin:0 auto;padding:20px}
.admin-head{display:flex;align-items:baseline;gap:12px;margin:14px 0 18px}
.admin-head h2{font-size:18px}
.admin-head .sub{color:var(--muted);font-size:12px}
.sect{margin-bottom:20px}
.sect>h4{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px}
.newbar{display:flex;gap:10px}
.newbar input{flex:1;padding:8px 12px}
.newbar button{padding:8px 18px;border-radius:8px}
.proj-card{border:1px solid var(--border);border-radius:12px;background:var(--input-bg);
box-shadow:var(--input-shadow);margin-bottom:12px;overflow:visible}
.proj-row{display:flex;align-items:center;gap:10px;padding:12px 16px}
.proj-name{font-weight:600;font-size:14px}
.proj-keys-n{color:var(--muted);font-size:12px;background:var(--bg3);padding:2px 10px;border-radius:10px}
.proj-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.keylist{border-top:1px solid var(--border);padding:10px 16px 12px}
.keyrow{display:flex;align-items:center;gap:10px;padding:6px 0}
.keyrow .dot{width:6px;height:6px;border-radius:50%;background:#3fb950;flex:none}
.keyrow code{background:var(--bg3);padding:3px 8px;border-radius:6px;font-size:11px}
.kv-row{display:flex;align-items:center;gap:8px;padding:5px 0}
.kv-row .lbl{color:var(--muted);width:64px;flex:none;font-size:12px}
.kv-row code{background:var(--bg3);border:1px solid var(--border);padding:4px 8px;border-radius:6px;font-size:11px;
flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copybtn{flex:none;background:var(--bg3);color:var(--muted);border:1px solid var(--border);border-radius:6px;
padding:3px 10px;cursor:pointer;font-size:11px}
.copybtn:hover{color:var(--link);border-color:var(--accent)}
.copybtn.done{color:var(--b-span-fg);border-color:var(--b-span-fg)}
@keyframes glowIn{0%{transform:scale(.98);opacity:0;box-shadow:0 0 0 0 rgba(63,185,80,.5)}
  60%{box-shadow:0 0 0 8px rgba(63,185,80,.18)}100%{transform:none;opacity:1}}
.newkey-card{border:1.5px solid var(--b-span-fg) !important;
background:linear-gradient(135deg,var(--b-span-bg),var(--input-bg) 65%) !important;
box-shadow:0 4px 18px rgba(63,185,80,.25) !important;animation:glowIn .5s ease}
@keyframes freshIn{0%{transform:translateX(-6px);opacity:0}100%{transform:none;opacity:1}}
.keyrow.fresh{animation:freshIn .35s ease;background:linear-gradient(90deg,var(--b-span-bg),transparent 70%);
border-radius:8px;padding-left:8px;margin:2px 0}
.keyrow.fresh .dot{background:var(--b-span-fg);box-shadow:0 0 6px var(--b-span-fg)}
.badge-new{font-size:10px;padding:1px 7px;border-radius:8px;background:var(--b-span-bg);color:var(--b-span-fg);
font-weight:700;letter-spacing:.5px;flex:none}
.modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;display:flex;align-items:center;justify-content:center}
.modal{background:var(--input-bg);border:1px solid var(--border2);border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);
padding:18px;width:360px;max-width:92vw}
.modal h4{font-size:14px;margin-bottom:4px}
.modal .sub{color:var(--muted);font-size:12px;margin-bottom:12px}
.modal input{margin-bottom:14px;padding:8px 12px}
.modal .btns{display:flex;gap:8px;justify-content:flex-end}
.menu-wrap{position:relative;display:inline-block}
.menu{position:absolute;right:0;top:110%;background:var(--input-bg);border:1px solid var(--border2);border-radius:8px;
box-shadow:0 4px 14px rgba(0,0,0,.28);z-index:20;min-width:130px;padding:4px}
.menu .mi{padding:6px 12px;border-radius:6px;cursor:pointer;color:var(--b-err-fg);font-size:12px;white-space:nowrap}
.menu .mi:hover{background:var(--hover)}
table{width:100%;border-collapse:collapse;margin-top:12px}
th{color:var(--muted);text-align:left;font-weight:500;padding:8px;border-bottom:1px solid var(--border2);font-size:12px}
td{padding:8px;border-bottom:1px solid var(--bg3)}

.col-sessions{display:flex;flex-direction:column;overflow:hidden}
.sess-scroll{flex:1;overflow-y:auto;min-height:0}
.theme-toggle{width:calc(100% - 20px);margin:8px 10px 10px;padding:6px 12px;border-radius:8px;flex:none;
background:var(--bg2);border:1px solid var(--border2);color:var(--text);cursor:pointer;font-family:inherit;font-size:12px;text-align:center}
.theme-toggle:hover{border-color:var(--accent);color:var(--link)}
.settings-wrap{position:relative;flex:none}
.settings-menu{position:absolute;bottom:calc(100% + 6px);left:10px;right:10px;background:var(--input-bg);
border:1px solid var(--border2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.32);z-index:60;padding:4px}
.settings-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text)}
.settings-item:hover{background:var(--hover)}
.settings-cur{margin-left:auto;color:var(--muted);font-size:11px}
.settings-static{cursor:default !important}
.settings-static:hover{background:transparent !important}
.settings-sub{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 18px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text)}
.settings-sub:hover{background:var(--hover)}
.settings-check{width:14px;flex:none;color:var(--accent);font-size:11px}
.settings-sep{height:1px;background:var(--border);margin:4px 6px}
.pp{display:flex;gap:8px;padding:10px 12px 6px;flex:none;align-items:stretch}
.dd{position:relative;flex:1;min-width:0}
.dd-btn{width:100%;text-align:left;display:flex;align-items:center;gap:8px;padding:8px 28px 8px 12px;min-height:36px;
background:var(--input-bg);border:1px solid var(--border2);border-radius:8px;cursor:pointer;
box-shadow:var(--input-shadow);font-size:12px;color:var(--text);position:relative;font-family:inherit}
.dd-btn:hover{border-color:var(--accent)}
.dd-btn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-btn::after{content:"";position:absolute;right:11px;top:50%;width:7px;height:7px;
border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);
transform:translateY(-70%) rotate(45deg);pointer-events:none}
.dd-menu{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--input-bg);
border:1px solid var(--border2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.32);z-index:50;
padding:4px;max-height:280px;overflow:auto}
.dd-item{padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12px}
.dd-item:hover{background:var(--hover)}
.dd-item.on{background:var(--sel);font-weight:600}
`;

/* ---------------- helpers ---------------- */
type Project = { id: string; name: string; created_at: number };
const $ = <T,>(s: string) => JSON.parse(localStorage.getItem(s) ?? "null") as T | null;
const save = (s: string, v: unknown) => localStorage.setItem(s, JSON.stringify(v));
async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
function fmtMs(ms?: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}
const fmtTs = (ts: number) => new Date(ts).toLocaleString();
const fmtBytes = (b?: number | null) => {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};
const fmtCost = (c?: number | null) => (c == null ? "—" : `$${c < 0.01 ? c.toFixed(5) : c.toFixed(3)}`);

/* ---------------- trace 详情(右栏) ---------------- */
type Obs = any;
function buildTree(observations: Obs[]) {
  const byId = new Map<string, Obs>();
  observations.forEach((o) => byId.set(o.id, { ...o, children: [] }));
  // parent 指向自己 → 视为根,防止渲染无限递归
  const parentOf = new Map<string, string | null>();
  for (const o of byId.values()) {
    const pid = o.parent_id;
    parentOf.set(o.id, pid && pid !== o.id && byId.has(pid) ? pid : null);
  }
  const roots: Obs[] = [];
  for (const o of byId.values()) {
    const pid = parentOf.get(o.id)!;
    if (pid) byId.get(pid)!.children.push(o);
    else roots.push(o);
  }
  // 环检测(a↔b 互为父):链走不完的节点提升为根并断开,避免节点从树上消失
  for (const o of byId.values()) {
    const seen = new Set<string>([o.id]);
    let cur = parentOf.get(o.id) ?? null;
    let cyclic = false;
    while (cur) {
      if (seen.has(cur)) { cyclic = true; break; }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    if (cyclic) {
      const pid = parentOf.get(o.id)!;
      const p = pid ? byId.get(pid) : null;
      if (p) p.children = p.children.filter((c: Obs) => c.id !== o.id);
      parentOf.set(o.id, null);
      roots.push(o);
    }
  }
  roots.sort((a, b) => a.start_time - b.start_time);
  return roots;
}
function treeRange(nodes: Obs[]): [number, number] {
  let min = Infinity, max = -Infinity;
  const walk = (n: Obs) => {
    min = Math.min(min, n.start_time);
    max = Math.max(max, n.end_time ?? n.start_time);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return [min, max === -Infinity ? min : max];
}
function FoldHandle({ dir, onClick, title }: { dir: "left" | "right"; onClick: () => void; title: string }) {
  return (
    <div class="foldbar" onClick={onClick} title={title}>
      {dir === "left"
        ? <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        : <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>}
    </div>
  );
}

function ProjectPicker({ projects, projectId, onChange }: { projects: Project[]; projectId: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".dd")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const cur = projects.find((p) => p.id === projectId);
  return (
    <div class="dd">
      <button class="dd-btn" onClick={(e: any) => { e.stopPropagation(); setOpen(!open); }}>
        <span class="nm">● {cur?.name ?? "选择项目"}</span>
      </button>
      {open && (
        <div class="dd-menu">
          {projects.map((p) => (
            <div class={`dd-item ${p.id === projectId ? "on" : ""}`}
              onClick={() => { setOpen(false); if (p.id !== projectId) onChange(p.id); }}>
              {p.id === projectId ? "● " : ""}{p.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- litefuse / react18-json-view 风格 JSON 视图 ---- */
const JV_STR_LIMIT = 500;          // collapseStringsAfterLength
const JV_OBJ_LIMIT = 20;           // collapseObjectsAfterLength
type JvMode = "expand" | "collapse" | "auto";

/** deepParseJson:递归解析嵌套的字符串化 JSON */
function deepParseJson(v: unknown): unknown {
  if (typeof v === "string") {
    const s = v.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try { return deepParseJson(JSON.parse(s)); } catch { return v; }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(deepParseJson);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepParseJson(val);
    return out;
  }
  return v;
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
}

/** collapseStringMode="word":按词边界截断 */
function truncateAtWord(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"));
  return at > limit * 0.6 ? cut.slice(0, at) : cut;
}

function JvString({ v }: { v: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = v.length > JV_STR_LIMIT;
  const text = long && !expanded ? truncateAtWord(v, JV_STR_LIMIT) : v;
  return (
    <span class="jv-str">
      "{text}
      {long && !expanded && (
        <>
          {"\n"}
          <span class="jv-expand" onClick={(e: any) => { e.stopPropagation(); setExpanded(true); }}>
            ...expand ({v.length - text.length} more characters)
          </span>
          {"\n"}
        </>
      )}
      "
    </span>
  );
}

function JvNode({ name, value, depth, index, mode = "auto" }: {
  name?: string; value: any; depth: number; index?: number; mode?: JvMode;
}) {
  const isArr0 = Array.isArray(value);
  const entryCount = isArr0 ? (value as any[]).length
    : value !== null && typeof value === "object" ? Object.keys(value).length : 0;
  const initOpen = mode === "expand" ? true : mode === "collapse" ? false : entryCount <= JV_OBJ_LIMIT;
  const [open, setOpen] = useState(initOpen);
  const pad = `padding-left:${depth * 14}px`;
  const isObj = value !== null && typeof value === "object";
  const label = index !== undefined
    ? <span class="jv-key">{index}: </span>
    : name !== undefined ? <span class="jv-key">{name}: </span> : null;
  if (!isObj) {
    let body: any;
    if (value === null || value === undefined) body = <span class="jv-null">null</span>;
    else if (typeof value === "string") body = <JvString v={value} />;
    else if (typeof value === "number") body = <span class="jv-num">{String(value)}</span>;
    else if (typeof value === "boolean") body = <span class="jv-bool">{String(value)}</span>;
    else body = <span class="jv-str">{String(value)}</span>;
    return <div class="jv-row" style={pad}>{label}{body}</div>;
  }
  const isArr = Array.isArray(value);
  const entries: [any, any][] = isArr
    ? (value as any[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, any>);
  const openB = isArr ? "[" : "{";
  const closeB = isArr ? "]" : "}";
  return (
    <div>
      <div class="jv-row" style={pad}>
        {label}
        <span class="jv-items" onClick={() => setOpen(!open)}>
          {openB} {entries.length} items {open ? "\u2304" : "\u203A"} {!open ? closeB : ""}
        </span>
      </div>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <JvNode key={String(k)} value={v} depth={depth + 1} mode={mode} {...(isArr ? { index: k as number } : { name: k as string })} />
          ))}
          <div class="jv-row"><span style={`padding-left:${depth * 14}px`}>{closeB}</span></div>
        </>
      )}
    </div>
  );
}

/** AI SDK tools → OpenAI Chat Completions tools 格式 */
function toOpenAiTools(tools: any): any {
  if (typeof tools === "string") {
    try { tools = JSON.parse(tools); } catch { return tools; }
  }
  if (!Array.isArray(tools)) return tools;
  return tools.map((raw) => {
    // 元素可能是被字符串化的对象(AI SDK 双编码)
    let t = raw;
    if (typeof t === "string") {
      try { t = JSON.parse(t); } catch { return raw; }
    }
    if (!t || typeof t !== "object") return t;
    if ("function" in t) return t; // 已是 OpenAI 格式
    const params = t.inputSchema ?? t.parameters ?? {};
    return { type: "function", function: { name: t.name, description: t.description, parameters: params } };
  });
}

/** AI SDK messages → OpenAI messages(assistant.tool_calls / role=tool) */
function toOpenAiMessages(msgs: any): any {
  if (typeof msgs === "string") {
    try { msgs = JSON.parse(msgs); } catch { return msgs; }
  }
  if (!Array.isArray(msgs)) return msgs;
  const out: any[] = [];
  for (const raw of msgs) {
    let m = raw;
    if (typeof m === "string") {
      try { m = JSON.parse(m); } catch { out.push(raw); continue; }
    }
    if (!m || typeof m !== "object") { out.push(m); continue; }
    const content = m.content;
    if (!Array.isArray(content)) {
      // AI SDK 旧形态:toolCalls / toolInvocations 挂在消息顶层
      const top = m.toolCalls ?? m.tool_invocations ?? m.toolInvocations;
      if (Array.isArray(top) && top.length) {
        out.push({
          role: m.role ?? "assistant",
          content: content || null,
          tool_calls: top.map((c: any) => ({
            id: c.toolCallId,
            type: "function",
            function: { name: c.toolName, arguments: typeof (c.input ?? c.args) === "string" ? (c.input ?? c.args) : JSON.stringify(c.input ?? c.args ?? {}) },
          })),
        });
        continue;
      }
      out.push({
        role: m.role,
        content: content ?? null,
        // tool 结果消息保留 id/工具名,Formatted 视图要用
        ...(m.role === "tool" || m.tool_call_id || m.toolCallId
          ? { tool_call_id: m.tool_call_id ?? m.toolCallId ?? undefined, name: m.name ?? m.toolName ?? undefined }
          : {}),
      });
      continue;
    }
    const texts = content.filter((c: any) => c?.type === "text").map((c: any) => c.text);
    const calls = content.filter((c: any) => c?.type === "tool-call");
    const results = content.filter((c: any) => c?.type === "tool-result");
    if (calls.length) {
      out.push({
        role: m.role ?? "assistant",
        content: texts.length ? texts.join("\n") : null,
        tool_calls: calls.map((c: any) => ({
          id: c.toolCallId,
          type: "function",
          function: { name: c.toolName, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}) },
        })),
      });
    } else if (texts.length) {
      out.push({ role: m.role ?? "user", content: texts.join("\n") });
    }
    for (const r of results) {
      const raw = r.output ?? r.result;
      const val = typeof raw === "string" ? raw : (raw?.value ?? raw);
      out.push({ role: "tool", tool_call_id: r.toolCallId, content: typeof val === "string" ? val : JSON.stringify(val ?? "") });
    }
  }
  return out;
}

/** Input:组织成一次模型请求体 { model, messages, tools }(OpenAI Chat Completions 形态) */
function buildInputPayload(sel: any, allObs?: any[]): unknown {
  const a = (sel?.attributes && typeof sel.attributes === "object") ? sel.attributes : {};
  const findTools = (): unknown => {
    const own = tryJson(a["ai.prompt.tools"]);
    if (own != null) return own;
    for (const o of allObs ?? []) {
      const oa = (o?.attributes && typeof o.attributes === "object") ? o.attributes : {};
      if (oa["ai.prompt.tools"] != null) return tryJson(oa["ai.prompt.tools"]);
    }
    return undefined;
  };
  if (sel.type === "TOOL") {
    // TOOL 节点只展示本次工具调用:工具名 + 参数(不带 tools 定义列表)
    const out: Record<string, unknown> = {};
    if (a["ai.toolCall.name"] != null) out.tool = a["ai.toolCall.name"];
    if (sel.input != null) out.arguments = tryJson(sel.input);
    return Object.keys(out).length ? out : sel.input ?? undefined;
  }
  const raw = sel.input;
  let messages: unknown = tryJson(a["ai.prompt.messages"]);
  if (messages == null) {
    if (Array.isArray(raw)) messages = raw;
    else if (raw && typeof raw === "object" && "messages" in (raw as any)) messages = (raw as any).messages;
    else if (raw != null) messages = raw;
  }
  const system = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any).system : undefined;
  if (system && Array.isArray(messages) && !(messages as any[]).some((m) => m?.role === "system")) {
    messages = [{ role: "system", content: system }, ...(messages as any[])];
  }
  const tools = findTools();
  const out: Record<string, unknown> = {};
  const model = a["ai.model.id"] ?? sel.model;
  if (model) out.model = model;
  if (messages != null) out.messages = toOpenAiMessages(messages);
  if (tools != null) out.tools = toOpenAiTools(tools);
  const choice = a["ai.prompt.toolChoice"];
  if (choice != null) out.tool_choice = tryJson(choice);
  return Object.keys(out).length ? out : undefined;
}

/** Output:组织成 assistant 消息 { role, content, tool_calls } */
function buildOutputPayload(sel: any): unknown {
  const a = (sel?.attributes && typeof sel.attributes === "object") ? sel.attributes : {};
  const text = a["ai.response.text"] != null ? tryJson(a["ai.response.text"]) : undefined;
  const calls = a["ai.response.toolCalls"] != null ? tryJson(a["ai.response.toolCalls"]) : undefined;
  const reasoning = a["ai.response.reasoning"] != null ? tryJson(a["ai.response.reasoning"]) : undefined;
  if (text != null || calls != null || reasoning != null) {
    const out: Record<string, unknown> = { role: "assistant" };
    // response.text 本身是完整 assistant 消息(AI SDK 双重编码)时展开字段
    if (text != null && text && typeof text === "object" && !Array.isArray(text) && (text as any).role != null) {
      const t = text as any;
      out.content = t.content ?? null;
      if (t.reasoning != null && reasoning == null) out.reasoning = t.reasoning;
      if (out.tool_calls == null) {
        const tc = t.toolCalls ?? t.tool_calls;
        if (tc != null) out.tool_calls = tc;
      }
      if (t.finishReason != null) out.finish_reason = t.finishReason;
    } else if (text != null) {
      out.content = text;
    }
    if (reasoning != null) out.reasoning = reasoning;
    if (calls != null) out.tool_calls = calls;
    return out;
  }
  return sel.output ?? undefined;
}

/* ---------------- Formatted 视图(Litefuse 风格):按角色渲染消息 ---------------- */

const ROLE_META: Record<string, { label: string; cls: string }> = {
  system: { label: "system", cls: "role-system" },
  user: { label: "user", cls: "role-user" },
  assistant: { label: "assistant", cls: "role-assistant" },
  tool: { label: "tool", cls: "role-tool" },
  toolcall: { label: "tool-call", cls: "role-toolcall" },
};

/* ---------------- 极简 Markdown(标题/列表/行内代码/粗斜体/链接/围栏代码块) ---------------- */

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 行内标记;先全量转义再注入自己的标签,无 XSS 面 */
function inlineMd(s: string): string {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  out = out.replace(/\*\*([^*](?:[^*]*[^*])?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

/** GFM 表格行拆分;`\|` 转义先占位再还原 */
function splitMdRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "").replace(/\\\|/g, "\u0000");
  return t.split("|").map((c) => c.trim().replace(/\u0000/g, "|"));
}

/** 表头分隔行:每个单元格形如 --- / :---: / ---: */
const isMdSepRow = (line: string): boolean => {
  const cells = splitMdRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
};

function mdTableHtml(header: string[], rows: string[][]): string {
  const th = header.map((c) => `<th>${inlineMd(c)}</th>`).join("");
  const trs = rows
    .map((r) => `<tr>${header.map((_, ci) => `<td>${inlineMd(r[ci] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md-tablewrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

/* ---------------- 代码块轻量语法高亮(零依赖,字符串/注释优先占位防误染) ---------------- */

type TokRule = { re: RegExp; cls: string };

const SQL_RULES: TokRule[] = [
  { re: /'(?:[^']|'')*'/g, cls: "tok-str" },
  { re: /"(?:[^"]|"")*"/g, cls: "tok-str" },
  { re: /--[^\n]*/g, cls: "tok-com" },
  { re: /\/\*[\s\S]*?\*\//g, cls: "tok-com" },
  { re: /\b\d+(?:\.\d+)?\b/g, cls: "tok-num" },
  { re: /\b(?:select|from|where|join|left|right|inner|outer|full|cross|on|as|and|or|not|null|is|in|like|between|group|by|order|having|limit|offset|union|all|distinct|case|when|then|else|end|with|insert|into|values|update|set|delete|create|table|view|if|exists|using|asc|desc|current_date|current_timestamp|interval|cast|coalesce)\b/gi, cls: "tok-kw" },
  { re: /\b[A-Za-z_]\w*(?=\s*\()/g, cls: "tok-fn" },
];

const JSON_RULES: TokRule[] = [
  { re: /"(?:[^"\\]|\\.)*"\s*(?=:)/g, cls: "tok-key" },
  { re: /"(?:[^"\\]|\\.)*"/g, cls: "tok-str" },
  { re: /\b(?:true|false|null)\b/g, cls: "tok-kw" },
  { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, cls: "tok-num" },
];

const YAML_RULES: TokRule[] = [
  { re: /#[^\n]*/g, cls: "tok-com" },
  { re: /'(?:[^'])*'|"(?:[^"])*"/g, cls: "tok-str" },
  { re: /^[ \t]*-?[ \t]*[\w.\-/<>\[\]]+(?=:)/gm, cls: "tok-key" },
  { re: /\b(?:true|false|null|yes|no|on|off)\b/gi, cls: "tok-kw" },
  { re: /\b\d+(?:\.\d+)?\b/g, cls: "tok-num" },
];

const JS_RULES: TokRule[] = [
  { re: /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, cls: "tok-str" },
  { re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g, cls: "tok-com" },
  { re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|async|await|yield|try|catch|finally|throw|import|export|from|default|delete|void)\b/g, cls: "tok-kw" },
  { re: /\b(?:true|false|null|undefined|NaN)\b/g, cls: "tok-num" },
  { re: /\b0x[\da-fA-F]+|\b\d+(?:\.\d+)?\b/g, cls: "tok-num" },
  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/g, cls: "tok-fn" },
];

const PY_RULES: TokRule[] = [
  { re: /'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, cls: "tok-str" },
  { re: /#[^\n]*/g, cls: "tok-com" },
  { re: /\b(?:def|return|if|elif|else|for|while|import|from|class|with|as|try|except|finally|raise|lambda|pass|break|continue|and|or|not|in|is|global|yield|async|await)\b/g, cls: "tok-kw" },
  { re: /\b(?:True|False|None)\b/g, cls: "tok-num" },
  { re: /\b\d+(?:\.\d+)?\b/g, cls: "tok-num" },
  { re: /\b[A-Za-z_]\w*(?=\s*\()/g, cls: "tok-fn" },
];

const SH_RULES: TokRule[] = [
  { re: /#[^\n]*/g, cls: "tok-com" },
  { re: /'[^']*'|"[^"]*"/g, cls: "tok-str" },
  { re: /\$\w+|\$\{[^}]*\}/g, cls: "tok-key" },
  { re: /\b(?:cd|ls|grep|awk|sed|cat|echo|export|source|curl|wget|mkdir|rm|cp|mv|chmod|chown|sudo|apt|brew|git|bun|npm|pnpm|yarn|docker|python|python3|for|in|do|done|if|then|elif|else|fi|while|case|esac)\b/g, cls: "tok-kw" },
  { re: /\b\d+\b/g, cls: "tok-num" },
];

function langRules(lang?: string): TokRule[] {
  const l = (lang ?? "").toLowerCase();
  if (/^(sql|postgres|postgresql|mysql|sqlite)$/.test(l)) return SQL_RULES;
  if (/^json$/.test(l)) return JSON_RULES;
  if (/^(ya?ml)$/.test(l)) return YAML_RULES;
  if (/^(js|javascript|ts|typescript|jsx|tsx)$/.test(l)) return JS_RULES;
  if (/^(py|python)$/.test(l)) return PY_RULES;
  if (/^(sh|bash|shell|zsh|console|terminal)$/.test(l)) return SH_RULES;
  return [];
}

/** 独立扫描各规则再按位置合并:字符串/注释起点更早,内部的关键字自然被跳过 */
function highlightCode(code: string, lang?: string): string {
  const rules = langRules(lang);
  if (!rules.length) return escHtml(code);
  const marks: Array<{ start: number; end: number; cls: string }> = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(code))) {
      if (m[0].length === 0) { r.re.lastIndex++; continue; }
      marks.push({ start: m.index, end: m.index + m[0].length, cls: r.cls });
    }
  }
  marks.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: string[] = [];
  let pos = 0;
  for (const mk of marks) {
    if (mk.start < pos) continue;
    out.push(escHtml(code.slice(pos, mk.start)));
    out.push(`<span class="${mk.cls}">${escHtml(code.slice(mk.start, mk.end))}</span>`);
    pos = mk.end;
  }
  out.push(escHtml(code.slice(pos)));
  return out.join("");
}

function CodeBlockMd({ code, lang }: { code: string; lang?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); } catch { /* ignore */ }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <div class="md-prewrap">
      <div class="md-prehead"><span>{lang || "text"}</span><button class="md-precopy" onClick={copy}>{done ? "✓ 已复制" : "复制"}</button></div>
      <pre class="md-pre"><code dangerouslySetInnerHTML={{ __html: highlightCode(code, lang) }} /></pre>
    </div>
  );
}

type MdSeg = { t: "html"; html: string } | { t: "code"; code: string; lang?: string };

/** 块级解析:fenced code > 标题 > 列表 > 引用/分隔线 > 段落(软换行保留为 <br/>) */
function parseMd(src: string): MdSeg[] {
  const lines = src.split("\n");
  const segs: MdSeg[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) { segs.push({ t: "html", html: `<p>${para.map(inlineMd).join("<br/>")}</p>` }); para = []; }
  };
  const flushList = () => {
    if (list) {
      const tag = list.kind === "ol" ? "ol" : "ul";
      segs.push({ t: "html", html: `<${tag}>${list.items.map((x) => `<li>${inlineMd(x)}</li>`).join("")}</${tag}>` });
      list = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      segs.push({ t: "code", code: buf.join("\n"), lang: fence[1] || undefined });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const lvl = Math.min(6, h[1].length + 2); // # 映射到 h3 起,消息内不抢卡片层级
      segs.push({ t: "html", html: `<h${lvl} class="md-h">${inlineMd(h[2])}</h${lvl}>` });
      i++; continue;
    }
    // GFM 表格:当前行含 | 且下一行是 --- 分隔行
    if (line.includes("|") && i + 1 < lines.length && isMdSepRow(lines[i + 1])) {
      flushPara(); flushList();
      const header = splitMdRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].includes("|")) {
        rows.push(splitMdRow(lines[i]));
        i++;
      }
      segs.push({ t: "html", html: mdTableHtml(header, rows) });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) { flushList(); list = { kind, items: [] }; }
      list.items.push((ul ? ul[1] : ol![1]));
      i++; continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); flushList(); segs.push({ t: "html", html: "<hr/>" }); i++; continue; }
    if (/^\s*>/.test(line)) {
      flushPara(); flushList();
      segs.push({ t: "html", html: `<blockquote>${inlineMd(line.replace(/^\s*>\s?/, ""))}</blockquote>` });
      i++; continue;
    }
    if (!line.trim()) { flushPara(); flushList(); i++; continue; }
    para.push(line.replace(/^\s+/, ""));
    i++;
  }
  flushPara(); flushList();
  return segs;
}

function MarkdownView({ text }: { text: string }) {
  return (
    <div class="md">
      {parseMd(text).map((s, i) => s.t === "code"
        ? <CodeBlockMd key={i} code={s.code} lang={s.lang} />
        : <div key={i} dangerouslySetInnerHTML={{ __html: s.html }} />)}
    </div>
  );
}

/** 长文本折叠展示(点击展开);md=true 时按 Markdown 渲染 */
/** 详情面板快速滚动按钮:↑ 回顶部 / ↓ 跳到底部(如最新一条用户消息);内容不可滚动时自动隐藏 */
function FastScrollButtons({ containerRef }: { containerRef: { current: HTMLElement | null } }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      const sc = containerRef.current?.querySelector<HTMLElement>(".acc-body");
      setShow(!!sc && sc.scrollHeight > sc.clientHeight + 60);
    };
    check();
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(check);
    });
    if (containerRef.current) mo.observe(containerRef.current, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [containerRef]);
  const go = (toTop: boolean) => {
    const sc = containerRef.current?.querySelector<HTMLElement>(".acc-body");
    if (!sc) return;
    sc.scrollTo({ top: toTop ? 0 : sc.scrollHeight, behavior: "smooth" });
  };
  return (
    <div class="fastbtns">
      <button class="fastbtn" title="回到顶部" aria-label="回到顶部" onClick={() => go(true)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
      </button>
      <button class="fastbtn" title="跳到底部" aria-label="跳到底部" onClick={() => go(false)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /><path d="M19 12l-7 7-7-7" /></svg>
      </button>
    </div>
  );
}

/** 底部「设置」按钮 + 弹出菜单:外观主题切换 / 项目管理 */
const THEME_OPTIONS: Array<{ v: string; label: string }> = [
  { v: "light", label: "浅色" },
  { v: "dark", label: "深色" },
  { v: "system", label: "跟随系统" },
];

/** 底部「设置」按钮 + 弹出菜单:外观主题(三选)/ 项目管理 */
function SettingsMenu({ theme, setTheme, onAdmin }: { theme: string; setTheme: (t: string) => void; onAdmin: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".settings-wrap")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const themeLabel = THEME_OPTIONS.find((o) => o.v === theme)?.label ?? theme;
  return (
    <div class="settings-wrap" ref={wrapRef}>
      {open && (
        <div class="settings-menu">
          <div class="settings-item settings-static">
            <span>外观主题</span>
            <span class="settings-cur">{themeLabel}</span>
          </div>
          {THEME_OPTIONS.map((o) => (
            <div class="settings-sub" key={o.v} onClick={() => { setTheme(o.v); }}>
              <span class="settings-check">{theme === o.v ? "✓" : ""}</span>
              <span>{o.label}</span>
            </div>
          ))}
          <div class="settings-sep" />
          <div class="settings-item" onClick={() => { setOpen(false); onAdmin(); }}>
            <span>项目管理</span>
          </div>
        </div>
      )}
      <button class="theme-toggle" onClick={() => setOpen(!open)} title="设置">
        设置
      </button>
    </div>
  );
}

function PrettyText({ text, limit = 900, md = false }: { text: string; limit?: number; md?: boolean }) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const long = text.length > limit;
  const shown = long && !open ? text.slice(0, limit) : text;
  const toggle = () => {
    const willCollapse = open;
    setOpen(!open);
    if (willCollapse) {
      // 收起后内容高度骤减,滚动位置还停在旧偏移;把该卡片顶部滚回可视区
      requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
  };
  return (
    <div class="ptext" ref={cardRef}>
      <div class={`ptext-body ${long && !open ? "ptext-clamped" : ""}`}>{md ? <MarkdownView text={shown} /> : shown}</div>
      {long && (
        <button class="ghost ptext-more" onClick={toggle}>
          {open ? "收起" : `展开全部(${text.length} 字符)`}
        </button>
      )}
    </div>
  );
}

/** 标量/小对象内联展示;对象走 JvNode(默认折叠) */
function PrettyValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span class="pnull">null</span>;
  if (typeof v === "string") {
    const s = v.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      let parsed: unknown;
      try { parsed = JSON.parse(s); } catch { parsed = undefined; }
      if (parsed !== undefined) return <div class="ptree"><JvNode value={parsed} depth={0} mode="collapse" /></div>;
    }
    return <span class="pstr">{v.length > 300 ? v.slice(0, 300) + "…" : v}</span>;
  }
  if (typeof v === "number" || typeof v === "boolean") return <span class="pnum">{String(v)}</span>;
  return <div class="ptree"><JvNode value={v} depth={0} mode="collapse" /></div>;
}

/** tool_call 条目:工具名 + arguments 树 */
function ToolCallRow({ call }: { call: any }) {
  const name = call?.function?.name ?? call?.toolName ?? call?.tool_name ?? "tool";
  let args = call?.function?.arguments ?? call?.input ?? call?.arguments ?? call?.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* 保留原串 */ }
  }
  return (
    <div class="toolcall">
      <div class="toolcall-head">
        <span class={`msg-role ${ROLE_META.toolcall.cls}`}>{ROLE_META.toolcall.label}</span>
        <span class="toolcall-name">{name}</span>
      </div>
      {args != null && <PrettyValue v={args} />}
    </div>
  );
}

/** 单条消息:角色徽标 + 内容(user/assistant 文本、tool_calls、tool 结果) */
function PrettyMessage({ m }: { m: any }) {
  if (!m || typeof m !== "object") return <div class="msg"><div class="msg-body"><PrettyValue v={m} /></div></div>;
  const role: string = m.role ?? "user";
  const meta = ROLE_META[role] ?? { label: role, cls: "role-tool" };
  const calls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls
    : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "tool-call") : [];
  const content = typeof m.content === "string" ? m.content
    : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : null;
  // 标识行放最上面:工具名 + tool_call_id(tool 结果/带名消息)
  const hasHead = m.name != null || m.tool_call_id != null;
  // system/user/assistant 的文本按 Markdown 渲染;tool 结果多为 YAML/JSON,保持纯文本
  const useMd = role === "system" || role === "user" || role === "assistant";
  // 完全空的消息(无内容/无调用/无标识)不渲染,避免空白卡片
  const hasBody = (content != null && content !== "")
    || (m.content != null && (!Array.isArray(m.content) || m.content.length > 0));
  if (!hasHead && calls.length === 0 && !hasBody) return null;
  return (
    <div class="msg">
      <span class={`msg-role ${meta.cls}`}>{meta.label}</span>
      <div class="msg-body">
        {hasHead && (
          <div class="ptool-head">
            {m.name != null && <span class="ptool-name">{String(m.name)}</span>}
            {m.tool_call_id != null && <span class="pmeta">{String(m.tool_call_id)}</span>}
          </div>
        )}
        {content != null && content !== "" && <PrettyText text={content} md={useMd} />}
        {content == null && m.content != null && <PrettyValue v={m.content} />}
        {calls.map((c: any, i: number) => <ToolCallRow key={i} call={c} />)}
      </div>
    </div>
  );
}

/** 工具定义归一:兼容 OpenAI {type,function:{...}} / AI SDK {name,description,parameters} / 字符串化 */
function toolInfo(raw: any): { name: string; desc?: string; params?: unknown } {
  let t = raw;
  if (typeof t === "string") {
    try { t = JSON.parse(t); } catch { return { name: String(raw) }; }
  }
  const f = t?.function ?? t;
  let params = f?.parameters ?? f?.input_schema ?? t?.parameters ?? t?.input_schema;
  if (typeof params === "string") {
    try { params = JSON.parse(params); } catch { /* 保留原串 */ }
  }
  return {
    name: f?.name ?? t?.name ?? "?",
    desc: typeof f?.description === "string" ? f.description : undefined,
    params,
  };
}

/** 工具定义行列表(放在 .msg-body 卡片内;外层徽标/卡片由调用方提供) */
function ToolsList({ tools }: { tools: unknown }) {
  const arr = Array.isArray(tools) ? tools : [tools];
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  const toggle = (i: number) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };
  if (!arr.length) return null;
  return (
    <div class="tools-list">
      {arr.map((raw, i) => {
        const info = toolInfo(raw);
        const open = openSet.has(i);
        return (
          <div class="tool-def" key={i}>
            <div class="tool-def-head" onClick={() => toggle(i)}>
              <span class="tool-def-caret">{open ? "▾" : "▸"}</span>
              <span class="tool-def-name">{info.name}</span>
              {info.desc && !open && <span class="tool-def-desc">{info.desc.length > 80 ? info.desc.slice(0, 80) + "…" : info.desc}</span>}
            </div>
            {open && (
              <div class="tool-def-body">
                {info.desc && <PrettyText text={info.desc} limit={400} />}
                {info.params != null && <div class="ptree"><JvNode value={info.params} depth={0} mode="collapse" /></div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 其余字段(model/tools/tool_choice/finishReason…)的键值行 */
function PrettyKvRows({ entries }: { entries: [string, unknown][] }) {
  return (
    <div class="pkv">
      {entries.map(([k, v]) => (
        <div class="pkv-row" key={k}>
          <span class="pkv-k">{k}</span>
          <div class="pkv-v"><PrettyValue v={v} /></div>
        </div>
      ))}
    </div>
  );
}

/** Formatted 总入口:识别 payload 形态分发;不认识时回退 JSON 树 */
function PrettyPayload({ payload }: { payload: unknown }) {
  const p = payload;
  if (typeof p === "string") return <div class="pretty"><PrettyText text={p} md /></div>;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    return <div class="pretty"><JvNode value={deepParseJson(p)} depth={0} mode="auto" /></div>;
  }
  const obj = p as Record<string, unknown>;
  // 形态 1:{ messages, tools, ... }(模型请求);tools 与消息同一布局(左徽标+右卡片)
  // 其余标量字段(model/tool_choice 等)不展示,保持对话流干净
  if (Array.isArray(obj.messages)) {
    const { messages, tools } = obj;
    return (
      <div class="pretty">
        {(messages as any[]).map((m, i) => <PrettyMessage key={i} m={m} />)}
        {tools != null && Array.isArray(tools) && (tools as any[]).length > 0 && (
          <div class="msg">
            <span class="msg-role role-reasoning">tools</span>
            <div class="msg-body"><ToolsList tools={tools} /></div>
          </div>
        )}
      </div>
    );
  }
  // 形态 2:{ role:"assistant", content/reasoning/tool_calls }(模型输出)
  if (obj.role === "assistant") {
    // 消息卡片已渲染 content/tool_calls/reasoning,键值区只放剩余字段,避免重复
    const { role: _r, content: _c, reasoning, tool_calls: _t, ...rest2 } = obj as any;
    return (
      <div class="pretty">
        {reasoning != null && (
          <div class="msg">
            <span class="msg-role role-reasoning">reasoning</span>
            <div class="msg-body">
              {typeof reasoning === "string"
                ? <PrettyText text={reasoning} />
                : <PrettyValue v={reasoning} />}
            </div>
          </div>
        )}
        <PrettyMessage m={obj} />
        {Object.entries(rest2).length > 0 && <PrettyKvRows entries={Object.entries(rest2)} />}
      </div>
    );
  }
  // 形态 3:{ tool, arguments }(工具调用节点)
  if ("tool" in obj && "arguments" in obj) {
    return (
      <div class="pretty">
        <ToolCallRow call={{ toolName: obj.tool, input: obj.arguments }} />
      </div>
    );
  }
  // 兜底:整棵 JSON 树
  return <div class="pretty"><JvNode value={deepParseJson(p)} depth={0} mode="auto" /></div>;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch {
      const ta = document.createElement("textarea");
      ta.value = value; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div class="kv-row">
      <span class="lbl">{label}</span>
      <code title={value}>{value}</code>
      <button class={`copybtn ${done ? "done" : ""}`} onClick={copy}>{done ? "✓ 已复制" : "复制"}</button>
    </div>
  );
}

const tryJson = (s: unknown) => {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
};

function TraceDetail({ projectId, traceId }: { projectId: string; traceId: string }) {
  const [d, setD] = useState<any>(null);
  const [sel, setSel] = useState<Obs | null>(null);
  const cardWrapRef = useRef<HTMLDivElement | null>(null); // 详情卡片容器(快速滚动按钮定位)
  const [openKeys, setOpenKeys] = useState<Set<string> | null>(null); // 各 section 独立折叠;null=默认开第一个
  const [treeSeed, setTreeSeed] = useState<{ n: number; mode: JvMode }>({ n: 0, mode: "auto" }); // JSON 树全展开/全折叠
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // 树:自由折叠(默认全展开)
  const [ioTab, setIoTab] = useState<"input" | "output">("input"); // 第四栏 Input/Output tab
  const [fmtMode, setFmtMode] = useState<"pretty" | "json">(() => ($<"pretty" | "json">("mf_fmt")) ?? "pretty"); // 格式化 / JSON
  useEffect(() => { save("mf_fmt", fmtMode); }, [fmtMode]);
  // 第3/4栏占比(可拖动,记忆)。用 flex-grow 比例分配剩余空间,避免 basis% 溢出把第4栏挤成 0
  const [treePct, setTreePct] = useState<number>(() => $<number>("mf_tree_pct") ?? 55);
  useEffect(() => { save("mf_tree_pct", treePct); }, [treePct]);
  const startDrag = (e: any) => {
    e.preventDefault();
    const wrap = (e.currentTarget as HTMLElement).parentElement;
    const treeEl = wrap?.querySelector(".col-tree") as HTMLElement | null;
    const detailEl = wrap?.querySelector(".col-detail") as HTMLElement | null;
    // 按"树+面板"的当前实际可用宽度换算百分比(排除 sessions/traces 两栏)
    const avail =
      (treeEl?.getBoundingClientRect().width ?? 0) + (detailEl?.getBoundingClientRect().width ?? 0) || 1;
    const startX = e.clientX, startPct = treePct;
    const handle = e.currentTarget;
    handle.classList.add("drag");
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const deltaPct = ((ev.clientX - startX) / avail) * 100;
      setTreePct(Math.min(85, Math.max(25, startPct + deltaPct)));
    };
    const onUp = () => {
      handle.classList.remove("drag");
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  useEffect(() => {
    setD(null); setSel(null); setOpenKeys(null); setTreeSeed({ n: 0, mode: "auto" }); setCollapsed(new Set()); setIoTab("input");
    api(`/api/v1/traces/${traceId}?projectId=${projectId}`).then(setD)
      .catch((e) => setD({ error: String(e) }));
  }, [traceId]);
  if (!d) return <div class="empty">加载中…</div>;
  if (d.error) {
    const msg = String(d.error);
    const notFound = msg.includes("404");
    return (
      <div class="empty">
        {notFound
          ? <>该 trace 不存在<br /><span style="font-size:12px">项目可能已被删除,或 trace 已被保留策略清理;<br />请从左侧重新选择项目 / trace</span></>
          : <>✗ {msg}</>}
      </div>
    );
  }
  const roots = buildTree(d.observations);
  const [t0, t1] = treeRange(roots);
  const total = Math.max(1, t1 - t0);
  // 树:默认全展开,每个节点可自由折叠/展开(无互斥)
  const toggleTree = (id: string) => {
    setCollapsed((prev) => {
      const cur = new Set(prev);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      return cur;
    });
  };
  const Node = ({ o, depth }: { o: Obs; depth: number }) => {
    const st = (o.end_time ?? o.start_time) - o.start_time;
    const left = ((o.start_time - t0) / total) * 100;
    const width = Math.max(0.5, (st / total) * 100);
    const hasKids = o.children?.length > 0;
    const folded = collapsed.has(o.id);
    return (
      <div>
        <div class={`node ${sel?.id === o.id ? "sel" : ""}`} style={`margin-left:${depth * 16}px`}
          onClick={() => { setSel(o); setIoTab("input"); }}>
          <span class="bar" style={`left:${left}%;width:${width}%`} />
          <span class={`tree-caret ${hasKids ? "branch" : "leaf"}`}
            onClick={(e: any) => { e.stopPropagation(); if (hasKids) toggleTree(o.id); }}>
            {hasKids ? (folded ? "▸" : "▾") : "·"}
          </span>
          <span class={`badge ${o.type}`}>{o.type}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{o.name}</span>
          {hasKids && folded && <span class="muted" style="font-size:11px">({o.children.length})</span>}
          {o.level === "ERROR" && <span class="badge err">ERROR</span>}
          <span class="dur">{fmtMs(st)}</span>
        </div>
        {hasKids && !folded && o.children.map((c: Obs) => <Node o={c} depth={depth + 1} />)}
      </div>
    );
  };
  return (
    <>
      <div class="col col-tree" style={`flex:${treePct} 1 0`}>
        <div class="dhead">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <b style="font-size:14px">{d.trace.name}{d.trace.function_id ? <span class="fnid" style="font-weight:400"> ({d.trace.function_id})</span> : null}</b>
            <span class={`badge ${d.trace.status === "error" ? "err" : "ok"}`}>{d.trace.status}</span>
            {d.trace.session_id && <span class="badge SPAN" title={d.trace.session_id}>session {String(d.trace.session_id).slice(0, 8)}…</span>}
          </div>
          <div class="muted" style="margin-top:4px;font-size:12px">
            {fmtTs(d.trace.start_time)} · {fmtMs(d.trace.end_time != null ? d.trace.end_time - d.trace.start_time : null)}
            {" · "}{d.trace.model ?? "—"} · {d.trace.input_tokens ?? "—"}/{d.trace.output_tokens ?? "—"} tok · {fmtCost(d.trace.total_cost)}
          </div>
        </div>
        <div class="treecol">
          {roots.map((r) => <Node o={r} depth={0} />)}
        </div>
      </div>
      <div class="vsplit" onMouseDown={startDrag} title="拖动调整树/面板占比"></div>
      <div class="col col-detail" style={`flex:${100 - treePct} 1 0`}>
        {sel ? (
          <div class="card" style="margin:10px;position:relative" ref={cardWrapRef}>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex:none">
              <span class={`badge ${sel.type}`}>{sel.type}</span><b>{sel.name}</b>
            </div>
            <FastScrollButtons containerRef={cardWrapRef} />
            <div class="iotabs">
              <span class={`iotab ${ioTab === "input" ? "on" : ""}`} onClick={() => { setIoTab("input"); setTreeSeed((s) => ({ n: s.n + 1, mode: "auto" })); }}>Input</span>
              <span class={`iotab ${ioTab === "output" ? "on" : ""}`} onClick={() => { setIoTab("output"); setTreeSeed((s) => ({ n: s.n + 1, mode: "auto" })); }}>Output</span>
              <div class="fmt-tabs" title="切换显示格式">
                <button class={`fmt-tab ${fmtMode === "pretty" ? "on" : ""}`} onClick={() => setFmtMode("pretty")}>格式化</button>
                <button class={`fmt-tab ${fmtMode === "json" ? "on" : ""}`} onClick={() => setFmtMode("json")}>JSON</button>
              </div>
            </div>
            {(() => {
              const payload = ioTab === "input" ? buildInputPayload(sel, d.observations) : buildOutputPayload(sel);
              if (payload === undefined || payload === null) {
                // 失败节点没有 output/input 数据时,展示 status_message 里的错误详情
                if (sel.level === "ERROR" && sel.status_message) {
                  return (
                    <div class="acc-body">
                      <div class="pretty">
                        <div class="msg">
                          <span class="msg-role role-err">error</span>
                          <div class="msg-body err-body"><PrettyText text={sel.status_message} /></div>
                        </div>
                      </div>
                    </div>
                  );
                }
                return <div class="empty" style="padding:24px">该节点没有 {ioTab} 数据</div>;
              }
              if (fmtMode === "pretty") {
                return (
                  <div class="acc-body">
                    <div class="pretty" key={`${sel.id}-${ioTab}-pretty`}>
                      <PrettyPayload payload={deepParseJson(payload)} />
                    </div>
                  </div>
                );
              }
              return (
                <div class="acc-body">
                  <div class="jv-tools">
                    <span class="mini" onClick={() => setTreeSeed((s) => ({ n: s.n + 1, mode: "expand" }))}>展开全部</span>
                    <span class="mini" onClick={() => setTreeSeed((s) => ({ n: s.n + 1, mode: "collapse" }))}>折叠全部</span>
                    <span class="mini" onClick={() => copyText(sectionText(payload))}>复制</span>
                  </div>
                  <div class="jv" key={`${sel.id}-${ioTab}-${treeSeed.n}`}>
                    <JvNode value={deepParseJson(payload)} depth={0} mode={treeSeed.mode} />
                  </div>
                </div>
              );
            })()}
          </div>
        ) : <div class="empty" style="padding-top:80px">← 点击树上节点<br />查看 input/output</div>}
        {d.scores?.length > 0 && (
          <div class="card"><h4>scores</h4>
            {d.scores.map((s: any) => <div>{s.name}: <b>{s.value ?? s.string_value}</b></div>)}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------- 三栏主界面 ---------------- */
const ADMIN_OPT = "__admin__";
function Workspace({ projects, onAdmin, theme, setTheme }: { projects: Project[]; onAdmin: () => void; theme: string; setTheme: (t: string) => void }) {
  // 初始状态从 URL 恢复(刷新不丢选中)
  const initQ = new URLSearchParams((location.hash.split("?")[1] ?? ""));
  const [projectId, setProjectId] = useState(() => initQ.get("project") ?? $<string>("mf_project") ?? projects[0]?.id);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessCursor, setSessCursor] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initQ.get("session")); // null = 加载中/无 session
  // session 筛选:按 project 存 localStorage,下次进来保留;后端遍历该项目全部 session 做 LIKE 匹配
  const [sessFilter, setSessFilter] = useState(() => localStorage.getItem(`mf_sessfilter:${projectId}`) ?? "");
  const [sessFilterQ, setSessFilterQ] = useState(sessFilter); // 防抖后的查询词
  const [sessLoading, setSessLoading] = useState(false);
  useEffect(() => {
    setSessFilter(localStorage.getItem(`mf_sessfilter:${projectId}`) ?? "");
  }, [projectId]);
  useEffect(() => {
    const t = setTimeout(() => setSessFilterQ(sessFilter), 300);
    return () => clearTimeout(t);
  }, [sessFilter]);
  const onSessFilterInput = (v: string) => {
    setSessFilter(v);
    if (projectId) localStorage.setItem(`mf_sessfilter:${projectId}`, v);
  };
  const [traces, setTraces] = useState<any[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [traceId, setTraceId] = useState<string | null>(initQ.get("trace"));
  // 前两栏折叠(记忆在 localStorage)
  const [foldSess, setFoldSess] = useState(() => $<boolean>("mf_fold_sess") ?? false);
  const [foldTraces, setFoldTraces] = useState(() => $<boolean>("mf_fold_traces") ?? false);
  useEffect(() => { save("mf_fold_sess", foldSess); }, [foldSess]);
  useEffect(() => { save("mf_fold_traces", foldTraces); }, [foldTraces]);

  useEffect(() => { if (projectId) save("mf_project", projectId); }, [projectId]);
  // 选择状态进 URL:#/w?project=…&session=…&trace=…(刷新原样恢复)
  useEffect(() => {
    const q = new URLSearchParams();
    if (projectId) q.set("project", projectId);
    if (sessionId) q.set("session", sessionId);
    if (traceId) q.set("trace", traceId);
    const h = "#/w" + (q.toString() ? "?" + q.toString() : "");
    if (location.hash !== h) history.replaceState(null, "", h);
  }, [projectId, sessionId, traceId]);
  const firstProjectRun = useRef(true);
  // 外部改 URL(hash 编辑/同页链接跳转)时同步选中状态;
  // 自己写 URL 走 replaceState,不触发 hashchange,不会形成回环。
  useEffect(() => {
    const onHash = () => {
      const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
      const p = q.get("project");
      const s = q.get("session");
      const t = q.get("trace");
      setProjectId((cur) => (p && p !== cur ? p : cur));
      setSessionId((cur) => ((s ?? null) !== cur ? (s ?? null) : cur));
      setTraceId((cur) => ((t ?? null) !== cur ? (t ?? null) : cur));
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  // 合并 session 列表(fresh 覆盖同 id,保留 prev 独有项),按最近时间排序
  const mergeSessions = (prev: any[], fresh: any[]): any[] => {
    const byId = new Map(prev.map((s) => [s.id, s]));
    for (const s of fresh) byId.set(s.id, s);
    return [...byId.values()].sort((a, b) => b.last_ts - a.last_ts);
  };
  // sessions 第一页:projectId 或筛选词变化时触发;q 走后端 LIKE,遍历项目全部 session
  useEffect(() => {
    if (!projectId) return;
    // 首次挂载跳过清空(保留从 URL 恢复的选中),仅切换 project 时重置
    if (firstProjectRun.current) firstProjectRun.current = false;
    else { setSessions([]); setSessionId(null); setTraceId(null); }
    const params = new URLSearchParams({ projectId, limit: "50" });
    if (sessFilterQ.trim()) params.set("q", sessFilterQ.trim());
    setSessLoading(true);
    api(`/api/v1/sessions?${params}`).then((d) => {
      const items = d.items ?? [];
      setSessions(items);
      setSessCursor(d.nextCursor ?? null);
      // session 必选:加载后若当前未选/已失效,自动选第一个
      setSessionId((cur) => (cur && items.some((s) => s.id === cur) ? cur : (items[0]?.id ?? null)));
      setSessLoading(false);
    }).catch(() => { setSessLoading(false); });
  }, [projectId, sessFilterQ]);
  const loadMoreSessions = async () => {
    if (sessCursor == null) return;
    const params = new URLSearchParams({ projectId, limit: "50", cursor: String(sessCursor) });
    if (sessFilterQ.trim()) params.set("q", sessFilterQ.trim());
    try {
      const d = await api(`/api/v1/sessions?${params}`);
      setSessions((prev) => mergeSessions(prev, d.items ?? []));
      setSessCursor(d.nextCursor ?? null);
    } catch { }
  };
  useEffect(() => {
    if (!projectId) return;
    const q = new URLSearchParams({ projectId, limit: "50" });
    if (sessionId) q.set("sessionId", sessionId);
    setTraces([]); setCursor(null);
    api(`/api/v1/traces?${q}`).then((d) => { setTraces(d.items ?? []); setCursor(d.nextCursor); }).catch(() => { });
  }, [projectId, sessionId]);
  // 拉取最新 traces(增量 prepend,不打扰已加载内容);供手动 ⟳ 与自动轮询共用
  // 供轮询读取的最新筛选词(ref 避免闭包陈旧)
  const sessFilterRef = useRef(sessFilter);
  useEffect(() => { sessFilterRef.current = sessFilter; }, [sessFilter]);
  const refreshLatest = useCallback(async () => {
    if (!projectId || document.visibilityState !== "visible") return;
    const q = new URLSearchParams({ projectId, limit: "50" });
    if (sessionId) q.set("sessionId", sessionId);
    try {
      const d = await api(`/api/v1/traces?${q}`);
      setTraces((prev) => {
        if (!prev.length) return d.items ?? [];
        const known = new Set(prev.map((t: any) => t.id));
        const fresh = (d.items ?? []).filter((t: any) => !known.has(t.id));
        return fresh.length ? [...fresh, ...prev] : prev;
      });
      // 轮询的 sessions 刷新必须带当前筛选词,否则会把不匹配的 session merge 回列表
      const sp = new URLSearchParams({ projectId, limit: "50" });
      const sf = sessFilterRef.current.trim();
      if (sf) sp.set("q", sf);
      api(`/api/v1/sessions?${sp}`).then((s) => {
        // 轮询只合并第一页,保留已通过 Show more 加载的尾部
        setSessions((prev) => mergeSessions(prev, s.items ?? []));
      }).catch(() => { });
    } catch { }
  }, [projectId, sessionId]);
  useEffect(() => {
    const iv = setInterval(refreshLatest, 10000); // 10s 自动轮询(页面可见时)
    return () => clearInterval(iv);
  }, [refreshLatest]);
  const loadMore = async () => {
    if (!cursor) return;
    const q = new URLSearchParams({ projectId, limit: "50", cursor: String(cursor) });
    if (sessionId) q.set("sessionId", sessionId);
    const d = await api(`/api/v1/traces?${q}`);
    setTraces((t) => [...t, ...(d.items ?? [])]);
    setCursor(d.nextCursor);
  };

  return (
    <div class="cols">
      {/* 第1栏:sessions(可折叠) */}
      {foldSess ? (
        <div class="rail" onClick={() => setFoldSess(false)} title="展开 Sessions">SESSIONS »</div>
      ) : (
        <div class="col col-sessions">
          <div class="colhead">SESSIONS</div>
          <div class="sess-scroll">
            <div class="colhead">项目筛选</div>
            <div style="padding:0 10px 10px">
              <ProjectPicker projects={projects} projectId={projectId} onChange={setProjectId} />
            </div>
            <div class="colhead">Session 筛选{sessFilter && sessions.length > 0 && (
              <span class="match-count">({sessions.length} 匹配)</span>
            )}</div>
            <div style="padding:0 10px 6px">
              <input class="sess-search" placeholder="按 session-id 片段筛选…" value={sessFilter}
                onInput={(e: any) => onSessFilterInput(e.target.value)} />
              {sessFilter && sessions.length === 0 && (
              <div class="muted" style="font-size:11px;padding:4px 2px 0">没有匹配的 session</div>
            )}
            </div>
            {!sessionId && sessLoading && (
              <div class="sess-item sel"><div class="m">加载 session 中…</div></div>
            )}
            {sessions.map((s) => (
              <div class={`sess-item ${sessionId === s.id ? "sel" : ""}`} onClick={() => setSessionId(s.id)}>
                <div class="n" title={s.id}>{s.id}</div>
                <div class="m">{s.trace_count_now ?? s.trace_count} traces · {fmtCost(s.total_cost)}<br />最近 {fmtTs(s.last_ts)}</div>
              </div>
            ))}
            {sessCursor != null && (
              <div class="pager"><button class="ghost" onClick={loadMoreSessions}>Show more</button></div>
            )}
            {!sessions.length && !sessFilter && <div class="empty" style="padding:14px">暂无 session<br /><span style="font-size:11px">带 sessionId 的 trace 会自动聚合</span></div>}
          </div>
          <SettingsMenu theme={theme} setTheme={setTheme} onAdmin={onAdmin} />
          <FoldHandle dir="left" onClick={() => setFoldSess(true)} title="收起 Sessions" />
        </div>
      )}

      {/* 第2栏:traces(可折叠) */}
      {foldTraces ? (
        <div class="rail" onClick={() => setFoldTraces(false)} title="展开 Traces">TRACES »</div>
      ) : (
        <div class="col col-traces">
          <div class="colhead">Traces{sessionId ? ` · ${String(sessionId).slice(0, 8)}…` : ""}
            <span class="refresh-ico" onClick={() => { refreshLatest(); }} title="拉取最新 traces">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </span></div>
          {traces.map((t) => (
            <div class={`trace-row ${traceId === t.id ? "sel" : ""}`} onClick={() => setTraceId(t.id)}>
              <div class="n">{t.name}{t.function_id ? <span class="fnid"> ({t.function_id})</span> : null}</div>
              <div class="m">
                <span>{fmtTs(t.ts)}</span><span>{fmtMs(t.latency_ms)}</span>
                <span>{t.input_tokens ?? "—"}/{t.output_tokens ?? "—"} tok</span>
                <span class={`badge ${t.status === "error" ? "err" : "ok"}`}>{t.status}</span>
              </div>
            </div>
          ))}
          {!traces.length && <div class="empty">暂无 trace</div>}
          {cursor && <div class="pager"><button class="ghost" onClick={loadMore}>Show more</button></div>}
          <FoldHandle dir="left" onClick={() => setFoldTraces(true)} title="收起 Traces" />
        </div>
      )}

      {/* 第3+4栏:树 + 属性面板 */}
      {traceId && projectId
        ? <TraceDetail projectId={projectId} traceId={traceId} />
        : <>
            <div class="col col-tree"><div class="empty" style="padding-top:80px">← 选择一条 trace 查看调用树</div></div>
            <div class="col col-detail" />
          </>}
    </div>
  );
}

/* ---------------- 管理页 ---------------- */
function AdminPage({ onChanged, onBack }: { onChanged: () => void; onBack: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [newName, setNewName] = useState("");
  const [created, setCreated] = useState<any>(null);
  const [keys, setKeys] = useState<Record<string, any[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [menuPid, setMenuPid] = useState<string | null>(null);
  const [namingFor, setNamingFor] = useState<any>(null); // 正在起名的 project
  const [keyName, setKeyName] = useState("");
  const [freshPk, setFreshPk] = useState<string | null>(null); // 刚生成的 key(高亮)
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".menu-wrap")) setMenuPid(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const safe = useCallback(async (fn: () => Promise<void>) => {
    try { setError(null); await fn(); }
    catch (e: any) { setError(`操作失败:${String(e?.message ?? e).slice(0, 160)}`); }
  }, []);
  const refresh = useCallback(async () => {
    await safe(async () => setProjects((await api("/api/v1/admin/projects")).projects));
  }, [safe]);
  useEffect(() => { refresh(); }, [refresh]);
  const loadKeys = (pid: string) => safe(async () => {
    const d = await api(`/api/v1/admin/projects/${pid}/keys`);
    setKeys((k) => ({ ...k, [pid]: d.keys }));
  });
  const mkKey = () => safe(async () => {
    const p = namingFor;
    setNamingFor(null);
    const k = await api(`/api/v1/admin/projects/${p.id}/keys`,
      { method: "POST", body: JSON.stringify({ name: keyName.trim() || null }) });
    setFreshPk(k.publicKey);
    setCreated({ project: p, key: k });
    loadKeys(p.id); refresh();
  });
  const mkProject = () => safe(async () => {
    if (!newName.trim()) { setError("请先填写 project 名称"); return; }
    await api("/api/v1/admin/projects", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
    setNewName(""); refresh(); onChanged();
  });
  return (
    <main class="admin">
      <div style="margin-bottom:6px"><a href="#/" onClick={onBack}>← 返回工作区</a></div>
      <div class="admin-head"><h2>项目管理</h2><span class="sub">project · 接入 key · observations 分区</span></div>
      {error && <div class="card" style="border-color:var(--danger);color:var(--b-err-fg);margin-bottom:14px">{error}</div>}
      {created && (
        <div class="card newkey-card" style="margin-bottom:14px">
          <h4 style="color:var(--b-span-fg);margin-bottom:6px">✓ 新 key 已生成(仅显示一次)— 请立即复制保存</h4>
          <div class="kv-row"><span class="lbl">project</span><code>{created.project.name}</code></div>
          <CopyRow label="public" value={created.key.publicKey} />
          <CopyRow label="secret" value={created.key.secretKey} />
        </div>
      )}
      <div class="sect">
        <h4>新建项目</h4>
        <div class="newbar">
          <input placeholder="项目名称,如 cappy-agent" value={newName} onInput={(e: any) => setNewName(e.target.value)}
            onKeyDown={(e: any) => { if (e.key === "Enter") mkProject(); }} />
          <button onClick={mkProject}>新建</button>
        </div>
      </div>
      <div class="sect">
        <h4>key 管理</h4>
        {projects.map((p: any) => (
          <div class="proj-card">
            <div class="proj-row">
              <span class="proj-name">{p.name}</span>
              <span class="proj-keys-n">{p.key_count ?? (keys[p.id]?.length ?? 0)} keys</span>
              {p.storage && (
                <span class="proj-keys-n" title="observations 分区数/保留上限 · 文件总容量">
                  {p.storage.partitionCount}/{p.max_partitions ?? p.storage.maxPartitions} 分区 · {fmtBytes(p.storage.totalBytes)}
                </span>
              )}
              <span class="proj-actions">
                <button class="ghost" onClick={() => {
                  if (keys[p.id]) setKeys((k: any) => { const n = { ...k }; delete n[p.id]; return n; });
                  else loadKeys(p.id);
                }}>{keys[p.id] ? "收起" : "查看"}</button>
                <button class="ghost" onClick={() => { setKeyName(""); setNamingFor(p); }}>新增 key</button>
                <span class="menu-wrap">
                  <button class="ghost" style="padding:4px 10px" title="更多"
                    onClick={(e: any) => { e.stopPropagation(); setMenuPid(menuPid === p.id ? null : p.id); }}>⋯</button>
                  {menuPid === p.id && (
                    <span class="menu">
                      <span class="mi" style="color:var(--text)" onClick={() => safe(async () => {
                        setMenuPid(null);
                        const cur = p.max_partitions ?? p.max_shards ?? 3;
                        const v = prompt(`保留几个 observations 分区(3-20,每个上限 1GB,当前 ${cur})`, String(cur));
                        if (v == null) return;
                        const n = Number(v);
                        if (!Number.isFinite(n) || n < 3 || n > 20) { setError("请输入 3-20 之间的数字"); return; }
                        await api(`/api/v1/admin/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ maxPartitions: n }) });
                        refresh();
                      })}>设置保留分区数…</span>
                      <span class="mi" onClick={() => safe(async () => {
                        setMenuPid(null);
                        if (confirm(`删除 project "${p.name}"?数据文件一并删除`)) {
                          await api(`/api/v1/admin/projects/${p.id}`, { method: "DELETE" });
                          refresh(); onChanged();
                        }
                      })}>删除项目…</span>
                    </span>
                  )}
                </span>
              </span>
            </div>
            {keys[p.id] && (
              <div class="keylist">
                {keys[p.id].length === 0 && <div class="muted" style="font-size:12px;padding:4px 0">暂无 key,点上方「新增 key」生成</div>}
                {keys[p.id].map((k: any) => (
                  <div class={`keyrow ${k.public_key === freshPk ? "fresh" : ""}`}>
                    <span class="dot" />
                    <code>{k.public_key}</code>
                    {k.public_key === freshPk && <span class="badge-new">NEW</span>}
                    <span class="muted" style="font-size:11px">{k.name ?? ""}</span>
                    <button class="ghost" style="margin-left:auto;padding:2px 10px" onClick={() => safe(async () => {
                      await api(`/api/v1/admin/projects/${p.id}/keys/${k.id}`, { method: "DELETE" });
                      loadKeys(p.id); refresh();
                    })}>吊销</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {!projects.length && <div class="empty">还没有项目 — 上面新建一个</div>}
      </div>
      {namingFor && (
        <div class="modal-mask" onClick={() => setNamingFor(null)}>
          <div class="modal" onClick={(e: any) => e.stopPropagation()}>
            <h4>新增接入 key</h4>
            <div class="sub">给 key 起个名字,方便记住它用在哪(项目:{namingFor.name})</div>
            <input placeholder="如:本地调试 / 生产接入 / cappy-agent" value={keyName}
              onInput={(e: any) => setKeyName(e.target.value)}
              onKeyDown={(e: any) => { if (e.key === "Enter" && namingFor) mkKey(); }} />
            <div class="btns">
              <button class="ghost" onClick={() => setNamingFor(null)}>取消</button>
              <button onClick={() => mkKey()}>创建 key</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ---------------- App ---------------- */
function App() {
  const [view, setView] = useState<"work" | "admin">(location.hash.includes("admin") ? "admin" : "work");
  const [projects, setProjects] = useState<Project[] | null>(null);
  // 外观主题:light / dark / system(跟随系统,实时响应系统切换)
  const [theme, setTheme] = useState<string>(() => $<string>("mf_theme") ?? "system");
  useEffect(() => {
    save("mf_theme", theme);
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (mql.matches ? "dark" : "light") : theme;
    };
    apply();
    if (theme === "system") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
  }, [theme]);
  const refreshProjects = useCallback(() => {
    fetch("/api/v1/projects").then((r) => r.json()).then((d) => setProjects(d.projects ?? [])).catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    refreshProjects();
    const on = () => setView(location.hash.includes("admin") ? "admin" : "work");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, [refreshProjects]);


  if (view === "admin") {
    return <AdminPage onChanged={refreshProjects} onBack={() => { location.hash = "#/"; setView("work"); }} />;
  }
  if (projects === null) return <div class="empty" style="height:100vh;display:flex;align-items:center;justify-content:center">加载中…</div>;
  if (!projects.length) {
    return <AdminPage onChanged={refreshProjects} onBack={() => { refreshProjects(); }} />;
  }
  return <Workspace projects={projects} onAdmin={() => { location.hash = "#/admin"; setView("admin"); }}
    theme={theme} setTheme={setTheme} />;
}

const styleEl = document.createElement("style");
styleEl.textContent = CSS;
document.head.appendChild(styleEl);
render(<App />, document.getElementById("root")!);
