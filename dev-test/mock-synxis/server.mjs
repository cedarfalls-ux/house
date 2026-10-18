// Minimal imitation of SynXis Control Center, used only to test the extension.
// Flow: default.aspx (Reports mega menu) -> SPH -> Forecast (loads in an iframe)
// -> Date Range select (post-back) -> Generate Report (window.open popup)
// -> ReportViewer page (async "Loading...") -> Export CSV (UTF-16 file).
//
// Cookie "rvmode" changes the report viewer so each export fallback can be tested:
//   sys (default) - ASP.NET Sys.Application viewer object with ExportUrlBase
//   html          - no viewer object, ExportUrlBase only inside page HTML
//   click         - only the "CSV (comma delimited)" menu link works
// Cookie "menumode" changes the Reports menu:
//   js (default) - opens on click
//   css          - opens on CSS :hover only, which scripted events cannot trigger
//   shadow       - inside a closed shadow root of a web component
//   none         - no menu at all (tests the saved Forecast page address)
// Cookie "bankpopup=1" shows the "You do not have a Bank open" dialog after every
// dashboard load; it blocks the menus until NO (or X) is clicked.
// The dashboard also has "Next Year" dropdowns that are NOT the Forecast Date Range.

import https from 'node:https';
import fs from 'node:fs';

const [, , certFile, keyFile, portArg] = process.argv;
const port = Number(portArg || 8443);
let lastReport = { report: 'none', range: 'none' };
export const exportLog = [];

const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p[0]),
  );

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function dashboard(menuMode, { bankPopup, sphDash }) {
  // Header + Reports mega menu. In "shadow" mode it lives inside a CLOSED shadow
  // root of a web component, like a design-system header; "none" has no menu.
  const menu = `
<style>
  .top{display:flex;gap:24px;padding:20px 30px;border-bottom:1px solid #ddd}
  .top a{color:#333;text-decoration:none}
  #mega{position:absolute;top:70px;left:30px;right:30px;background:#fff;border:1px solid #ccc;padding:20px;display:none;opacity:0;transition:opacity .2s}
  #mega.open{display:flex;opacity:1}
  ${menuMode === 'css' ? '.top:hover ~ #mega, #mega:hover{display:flex;opacity:1}' : ''}
  .left div{padding:8px 12px;cursor:pointer}
  .left div.sel{background:#0f7c8c;color:#fff}
  .panel{display:none;margin-left:40px}
  .panel.show{display:block}
  .panel a{display:block;padding:4px 0;color:#333}
  #homeMenu{position:absolute;top:60px;left:30px;background:#fff;border:1px solid #ccc;display:none}
  #homeMenu.open{display:block}
  #homeMenu a{display:block;padding:8px 14px}
</style>
<div class="top">
  <a href="javascript:void(0)" id="navHome">Home</a><a href="#">Front Office</a><a href="#">Accounting</a>
  <a href="javascript:void(0)" id="navReports">Reports</a><a href="#">Support</a>
</div>
<div id="homeMenu"><a href="/CC/default.aspx">Dashboard</a><a href="/CC/default.aspx?dash=sph">SPH Dashboard</a></div>
<div id="mega">
  <div class="left">
    <h3>Reports</h3>
    <div data-p="classic"${sphDash ? '' : ' class="sel"'}>Reports <span>&rarr;</span></div>
    <div data-p="subs">Subscriptions</div>
    <div data-p="sph"${sphDash ? ' class="sel"' : ''}><span>SynXis Property Hub (SPH)</span></div>
  </div>
  <div class="panel${sphDash ? '' : ' show'}" id="p-classic"><b>Classic</b>
    <a href="javascript:void(0)" data-r="decoy">Forecast</a>
    <a href="javascript:void(0)" data-r="decoy">Arrivals</a>
  </div>
  <div class="panel" id="p-subs"><b>Subscriptions</b></div>
  <div class="panel${sphDash ? ' show' : ''}" id="p-sph">
    <div><b>Accounting</b><a href="javascript:void(0)">Cashier Closing</a></div>
    <div><b>Front Office</b><ul>
      <li><a href="javascript:void(0)">Availability</a></li>
      <li><a href="javascript:void(0)" data-r="forecast"><span>Forecast</span></a></li>
      <li><a href="javascript:void(0)">Forecast By Market Segment</a></li>
      <li><a href="javascript:void(0)">Forecast By Rate Plan</a></li>
    </ul></div>
  </div>
</div>`;
  const header =
    menuMode === 'none' ? '<div class="top">Home | Front Office</div>'
      : menuMode === 'shadow' ? `<aven-header></aven-header><template id="tpl">${menu}</template>`
        : `<div id="hdr">${menu}</div>`;
  return page(
    'SynXis Central Reservation System',
    `
<style>body{font-family:sans-serif;margin:0} iframe{width:100%;height:600px;border:0}</style>
${header}
<div id="home"><h2>Good evening</h2>
  <p>Projections period <select id="proj"><option>Today</option><option selected>Next 7 Days</option><option>Next Year</option></select></p>
  <div style="display:none">Expanded view <select><option>Next Month</option><option>Next Year</option></select></div>
</div>
${bankPopup ? `<div id="bankModal" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center">
  <div style="background:#fff;padding:24px;border-radius:6px"><button id="bankX">&times;</button>
    <div><b>You do not have a Bank open</b><div>Would you like to open a Bank?</div></div>
    <button id="bankNo">NO</button> <button id="bankYes">YES</button></div></div>` : ''}
<iframe id="content" src="about:blank"></iframe>
<script>
  const mode = ${JSON.stringify(menuMode || 'js')};
  window.bankOpen = false;
  const modal = document.getElementById('bankModal');
  if (modal) {
    // Shows up a moment after every page load and blocks the menus until closed.
    setTimeout(() => { modal.style.display = 'flex'; window.bankOpen = true; }, 1200);
    const close = () => { modal.style.display = 'none'; window.bankOpen = false; };
    document.getElementById('bankNo').addEventListener('click', close);
    document.getElementById('bankX').addEventListener('click', close);
    document.getElementById('bankYes').addEventListener('click', () => { location.href = '/CC/OpenBank.aspx'; });
  }
  function wire(root) {
    const mega = root.getElementById('mega');
    const homeMenu = root.getElementById('homeMenu');
    if (mode !== 'css') {
      root.getElementById('navReports').addEventListener('click', () => { if (!window.bankOpen) mega.classList.toggle('open'); });
      root.getElementById('navHome').addEventListener('click', () => { if (!window.bankOpen) homeMenu.classList.toggle('open'); });
    }
    root.querySelectorAll('.left div').forEach((d) => d.addEventListener('click', () => {
      root.querySelectorAll('.left div').forEach((x) => x.classList.remove('sel'));
      root.querySelectorAll('.panel').forEach((x) => x.classList.remove('show'));
      d.classList.add('sel');
      root.getElementById('p-' + d.dataset.p).classList.add('show');
    }));
    root.querySelectorAll('[data-r]').forEach((a) => a.addEventListener('click', () => {
      mega.classList.remove('open');
      document.getElementById('home').style.display = 'none';
      document.getElementById('content').src = '/CC/reports/criteria.aspx?report=' + a.dataset.r;
    }));
  }
  // Menu builds itself a moment after load, like a slow SPA.
  setTimeout(() => {
    if (mode === 'none') return;
    if (mode === 'shadow') {
      customElements.define('aven-header', class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: 'closed' });
          root.append(document.getElementById('tpl').content.cloneNode(true));
          wire(root);
        }
      });
    } else {
      wire(document);
    }
  }, 700);
</script>`,
  );
}

function criteria(url) {
  const report = url.searchParams.get('report') || 'forecast';
  const range = url.searchParams.get('range') || 'Next Month';
  const ranges = ['None Selected', 'Today', 'Tomorrow', 'Date-to-Month-End', 'Date-to-Year-End', 'Next 3 Days',
    'Next 7 Days', 'Next 2 Weeks', 'Next Month', 'Next 3 Months', 'Next 6 Months', 'Next Year'];
  return page(
    'Forecast',
    `
<div class="toolbar"><a href="#">SUBSCRIBE</a> |
  <a href="javascript:void(0)" id="gen" style="text-transform:uppercase"><img alt="" src="data:,">Generate Report</a></div>
<div class="breadcrumb">Reports &gt; SynXis Property Hub (SPH) &gt; Front Office</div>
<h1>Forecast</h1><div>Forecast</div>
<form id="f"><input type="hidden" name="report" value="${report}">
  Date Range : <select name="range" id="range" onchange="setTimeout(() => this.form.submit(), 300)">
  ${ranges.map((r) => `<option value="${r}"${r === range ? ' selected' : ''}>${r}</option>`).join('')}
  </select></form>
<script>
  document.getElementById('gen').addEventListener('click', () => {
    window.open('/CC/reports/ReportViewerRun.aspx?report=${report}&range=' + encodeURIComponent(document.getElementById('range').value),
      'rpt', 'width=1200,height=800');
  });
</script>`,
  );
}

const EXPORT_BASE =
  '/CC/Reserved.ReportViewerWebControl.axd?ReportSession=abc123&Culture=1033&ControlID=c0ffee&OpType=Export&FileName=Forecast&ContentDisposition=OnlyHtmlInline&Format=';

function reportViewer(url, mode) {
  lastReport = { report: url.searchParams.get('report'), range: url.searchParams.get('range') };
  const title = lastReport.report === 'forecast' ? 'Forecast Report' : 'Decoy Report';
  const sys =
    mode === 'sys'
      ? `
  var viewer = {
    loadedAt: Date.now() + 3000,
    get_isLoading: function () { return Date.now() < this.loadedAt; },
    _getInternalViewer: function () { return { ExportUrlBase: ${JSON.stringify(EXPORT_BASE)} }; },
    exportReport: function (f) { window.open(${JSON.stringify(EXPORT_BASE)} + encodeURIComponent(f), '_blank'); }
  };
  window.Sys = { Application: { getComponents: function () { return [{ id: 'other' }, viewer]; } } };
  window.$find = function () { return viewer; };`
      : mode === 'html'
        ? `
  window.$find = function () { return { exportReport: function (f) { window.open(${JSON.stringify(EXPORT_BASE)} + f, '_blank'); } }; };
  var initData = {"ExportUrlBase":${JSON.stringify(EXPORT_BASE).replace(/\//g, '\\/').replace(/&/g, '\\u0026')},"Other":1};`
        : `
  window.$find = function () { return { exportReport: function (f) { window.open('/CC/Reserved.ReportViewerWebControl.axd?' + 'ReportSession=abc123&OpType=Export&Format=' + f, '_blank'); } }; };`;
  return page(
    'Forecast',
    `
<div id="ReportViewer1_toolbar">
  <span>1 of 8</span> <input> Find | Next
  <div class="export"><a title="Export" href="javascript:void(0)">Export</a>
    <div style="display:none">
      <a href="javascript:void(0)" onclick="$find('ReportViewer1').exportReport('XML');">XML file with report data</a>
      <a href="javascript:void(0)" onclick="$find('ReportViewer1').exportReport('CSV');">CSV (comma delimited)</a>
      <a href="javascript:void(0)" onclick="$find('ReportViewer1').exportReport('PDF');">PDF</a>
    </div></div>
</div>
<div id="ReportViewer1_AsyncWait"><div>Loading...</div></div>
<div id="ReportViewer1_content"></div>
<script>${sys}
  setTimeout(function () {
    document.getElementById('ReportViewer1_AsyncWait').style.display = 'none';
    document.getElementById('ReportViewer1_content').innerHTML =
      '<h3>${title} : ' + ${JSON.stringify(lastReport.range)} + '</h3><table><tr><td>10/17/2026</td><td>52</td></tr></table>';
  }, 3000);
</script>`,
  );
}

function csvBytes() {
  const rows = [
    'Report,Range',
    `${lastReport.report},${lastReport.range}`,
    'Date,Total Rooms,Rooms Sold,Occupied %,Total Room Revenue,ADR',
    '10/17/2026,52,34,69.39%,"4,339.20",127.62',
    '10/18/2026,52,8,16.33%,736.99,92.12',
  ];
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows.join('\r\n') + '\r\n', 'utf16le')]);
}

const server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const c = cookies(req);
  const loggedIn = c.sess === '1';
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  console.log(`[mock] ${req.method} ${url.pathname}${url.search} ${loggedIn ? '' : '(not logged in)'}`);

  if (url.pathname === '/CC/Login.aspx') {
    if (url.searchParams.get('auto') === '1') {
      return send(302, '', { 'Set-Cookie': 'sess=1; Path=/; Secure; SameSite=Lax', Location: '/CC/default.aspx' });
    }
    return send(200, page('Login', '<form>User <input name="u"> Password <input type="password" name="p"></form>'));
  }
  if (url.pathname === '/__export_log') return send(200, JSON.stringify(exportLog), { 'Content-Type': 'application/json' });
  if (!loggedIn) return send(302, '', { Location: '/CC/Login.aspx' });

  if (url.pathname === '/CC/default.aspx') return send(200, dashboard(c.menumode, { bankPopup: c.bankpopup === '1', sphDash: url.searchParams.get('dash') === 'sph' }));
  if (url.pathname === '/CC/reports/criteria.aspx') return send(200, criteria(url));
  if (url.pathname === '/CC/reports/ReportViewerRun.aspx') return send(200, reportViewer(url, c.rvmode || 'sys'));
  if (url.pathname === '/CC/Reserved.ReportViewerWebControl.axd') {
    exportLog.push({ format: url.searchParams.get('Format'), ...lastReport, mode: c.rvmode || 'sys' });
    if (url.searchParams.get('Format') !== 'CSV') return send(400, 'bad format');
    return send(200, csvBytes(), {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename=Forecast.csv',
    });
  }
  send(404, 'not found');
});

server.listen(port, '127.0.0.1', () => console.log(`[mock] listening on ${port}`));
