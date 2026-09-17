const API_BASE = String(window.__POC_CONFIG__?.apiBaseUrl ?? '').replace(/\/$/, '');
const TOKEN_KEY = (location.pathname || '').endsWith('/employee-weekly.html') ? 'assistant_public_employee_session' : 'assistant_poc_session';
const app = document.getElementById('app');
const toast = document.getElementById('toast');
const headerTitle = document.getElementById('header-title');
const runtimeClock = document.getElementById('runtime-clock');
const ROUTE_TITLES = {
  companies: '企业管理',
  admin: '运营工作台', users: '人员管理', items: '周计划事项', daily: '日报记录', weekly: '周报与反馈',
  settings: '规则配置', knowledge: '知识库', governance: '审计与归档', report: '周报详情',
};
document.getElementById('menu-toggle')?.addEventListener('click', () => document.body.classList.toggle('menu-open'));
document.querySelector('.side-nav')?.addEventListener('click', () => document.body.classList.remove('menu-open'));
document.getElementById('logout')?.addEventListener('click', async () => {
  wsInvalidateIdentity();
  const logoutRun = WS_ROUTE_RUN;
  app.replaceChildren(el('p', 'muted', '正在退出登录…'));
  try { if (token()) await fetchJson('/api/v1/auth/logout', { method: 'POST' }); } catch { /* 本地仍清除会话。 */ }
  finally {
    if (logoutRun === WS_ROUTE_RUN) {
      sessionStorage.removeItem(TOKEN_KEY);
      showLogin();
    }
  }
});

function updateRuntimeClock() {
  if (!runtimeClock) return;
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  runtimeClock.textContent = `实时运行中  ${time}`;
}
updateRuntimeClock();
if (typeof window.setInterval === 'function') window.setInterval(updateRuntimeClock, 1000);

function token() {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

function currentMonday() {
  const now = new Date();
  const day = now.getDay() || 7;
  now.setDate(now.getDate() - day + 1);
  return now.toISOString().slice(0, 10);
}

async function fetchJson(path, options = {}) {
  const routeRun = WS_ROUTE_RUN;
  path = wsApiPath(path);
  const headers = new Headers(options.headers ?? {});
  if (token()) headers.set('authorization', `Bearer ${token()}`);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(API_BASE + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (routeRun !== WS_ROUTE_RUN) throw new Error('页面已切换，请在当前页面重试');
  if (response.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    if(path !== '/api/v1/auth/login') showLogin('登录已过期，请重新获取个人入口或使用管理员访问码');
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2600);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* HTTP IP入口回退到传统复制。 */ }
  }
  const input = el('textarea'); input.value = value; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('请手动选择并复制绑定码');
}

function pageHeading(title, description, action) {
  const heading = el('div', 'page-heading');
  const copy = el('div');
  copy.append(el('h2', '', title), el('p', '', description));
  heading.appendChild(copy);
  if (action) heading.appendChild(action);
  return heading;
}

function labeled(label, control) {
  const node = el('label', 'field-label', label);
  node.appendChild(control);
  return node;
}

function showLogin(message = '') {
  wsInvalidateIdentity();
  document.body.classList.add('logged-out');
  app.replaceChildren();
  const card = el('form', 'login-card');
  const mobile = typeof mwRoute === 'function';
  card.appendChild(el('h2', 'page-title', mobile ? '日报助手 · 工作周报' : '日报助手工作平台'));
  card.appendChild(el('p', 'login-help', mobile ? '请通过收到的专属周报链接进入。' : '员工请在企微私聊日报助手发送“我的工作台”，通过专属链接进入。以下访问码入口仅供后台管理员使用。'));
  const input = el('input', 'login-input');
  input.type = 'password';
  input.name = 'accessCode';
  input.autocomplete = 'one-time-code';
  input.placeholder = '访问码';
  input.required = true;
  card.appendChild(input);
  const button = el('button', 'primary-button', '登录');
  button.type = 'submit';
  card.appendChild(button);
  const error = el('div', 'error', message);
  card.appendChild(error);
  card.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    error.textContent = '';
    try {
      const result = await fetchJson('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ accessCode: input.value }),
      });
      sessionStorage.setItem(TOKEN_KEY, result.token);
      document.body.classList.remove('logged-out');
      history.replaceState(null, '', mobile ? (location.hash || '#/weekly') : /^#\/records\//.test(location.hash)?location.hash:'#/workspace');
      route();
    } catch (loginError) {
      error.textContent = loginError.message === 'UNAUTHORIZED' ? '访问码不正确' : `登录失败：${loginError.message}`;
    } finally {
      button.disabled = false;
    }
  });
  app.appendChild(card);
  input.focus();
}

async function renderDashboard() {
  app.replaceChildren();
  app.appendChild(pageHeading('本周运营概览', '查看员工填报、事项进度和缺报情况，点击人员可进入周报详情。'));
  try {
    const data = await fetchJson('/api/v1/dashboard');
    app.appendChild(statsRow(data));
    const grid = el('div', 'card-grid');
    for (const employee of data.employees) grid.appendChild(empCard(employee, data.weekId));
    app.appendChild(grid);
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') return showLogin('登录已过期，请重新登录');
    app.appendChild(el('div', 'error', `加载失败：${error.message}`));
  }
}

function statsRow(data) {
  const employees = data.employees;
  const average = employees.length
    ? Math.round(employees.reduce((sum, employee) => sum + employee.completionRate, 0) / employees.length)
    : 0;
  const totalMissing = employees.reduce((sum, employee) => sum + employee.missingDays, 0);
  const row = el('div', 'stats');
  row.appendChild(stat('员工', `${employees.length} 人`));
  row.appendChild(stat('平均完成率', `${average}%`));
  row.appendChild(stat('总缺报', `${totalMissing} 天`));
  return row;
}

function stat(label, value) {
  const node = el('div', 'stat');
  node.appendChild(el('div', 'stat-label', label));
  node.appendChild(el('div', 'stat-value', value));
  return node;
}

function empCard(employee, weekId) {
  const card = el('button', 'card');
  card.type = 'button';
  card.appendChild(el('div', 'card-name', employee.name));
  card.appendChild(el('div', 'card-sub', `事项 ${employee.workItemCount} 项 · 填报率 ${employee.submissionRate}% · 缺报 ${employee.missingDays} 天`));
  const tags = el('div', 'tags');
  for (const name of (employee.itemNames ?? []).slice(0, 3)) tags.appendChild(el('span', 'tag', name));
  card.appendChild(tags);
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  fill.style.width = `${Math.max(0, Math.min(100, employee.completionRate))}%`;
  bar.appendChild(fill);
  card.appendChild(bar);
  card.appendChild(el('div', 'card-rate', `事项平均进度 ${employee.completionRate}%`));
  card.addEventListener('click', () => { location.hash = `#/report/${employee.userId}/${weekId}`; });
  return card;
}

async function renderReport(hash) {
  const [userId, weekId] = hash.replace('#/report/', '').split('/');
  app.replaceChildren();
  const back = el('a', 'back', '← 返回看板');
  back.href = '#/admin';
  app.appendChild(back);
  try {
    const report = await fetchJson(`/api/v1/reports/${encodeURIComponent(userId)}/${encodeURIComponent(weekId)}`);
    app.appendChild(el('h2', 'page-title', `${report.name} · 周报 ${report.weekId} · v${report.version||1}`));
    app.append(rpFeedbackTop(report.feedback||[],report,report.canFeedback,rpScopedFeedback));
    if(report.progressSnapshot) app.append(rpSummary(report.progressSnapshot,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(report.generatedAt))));
    if(WS_SESSION?.resourceScoped) app.appendChild(el('p','notice','本入口仅展示该次发布快照。查看全部历史或填写本人工作，请在企微发送“我的工作台”。'));
    if(!report.progressSnapshot) app.appendChild(el('div', 'report-content', report.content));
    app.appendChild(rpDownloadButton(`${report.name}-${report.weekId}-周报-v${report.version||1}`));
    for (const section of (report.progressSnapshot?[]:report.sections ?? []).filter(section=>!/交流|老板反馈|领导反馈/.test(section.title))) {
      const sectionCard = el('section', 'report-section');
      sectionCard.appendChild(el('h3', '', section.title));
      sectionCard.appendChild(el('p', '', section.body));
      app.appendChild(sectionCard);
    }
    if(report.progressSnapshot&&typeof rpTimeline==='function') app.appendChild(rpTimeline(report.progressSnapshot,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(report.generatedAt)),report.sourceSnapshot));
    else {
    app.appendChild(el('div', 'section-title', '本周事项进度'));
    const progressGrid = el('div', 'progress-grid');
    for (const item of report.itemProgress ?? []) progressGrid.appendChild(progressCard(item));
    if (!report.itemProgress?.length) progressGrid.appendChild(el('div', 'daily', '本周尚未设置事项。'));
    app.appendChild(progressGrid);
    }
    const overall=report.sourceSnapshot?.reasons?.find(reason=>!reason.workItemId);if(overall) app.append(el('h3','section-title','整周总体分析'),el('p','ws-prose',overall.content));
    if(report.missingDays.length) app.appendChild(el('p','muted',`缺报提醒：${report.missingDays.join('、')}`));
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') return showLogin('登录已过期，请重新登录');
    app.appendChild(el('div', 'error', `加载失败：${error.message}`));
  }
}

function progressCard(item) {
  const card = el('article', 'progress-card');
  const head = el('div', 'progress-head');
  head.append(el('strong', '', item.name), el('span', 'progress-value', item.progressValue==null||!item.lastDate?'未知':`${item.progressValue}%`));
  card.appendChild(head);
  if (item.planBackground) card.appendChild(el('div', 'card-sub', item.planBackground));
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  fill.style.width = `${Math.max(0, Math.min(100, item.progressValue))}%`;
  bar.appendChild(fill);
  card.appendChild(bar);
  if (item.progressText) card.appendChild(el('p', 'progress-copy', item.progressText));
  if (item.issues?.length) card.appendChild(el('p', 'risk-text', `原因/卡点：${item.issues.join('；')}`));
  if (item.nextActions?.length) card.appendChild(el('p', 'next-text', `下一步：${item.nextActions.join('；')}`));
  card.appendChild(el('div', 'card-sub', item.lastDate ? `最近确认：${item.lastDate} · ${item.progressType}` : '暂无已确认进展'));
  return card;
}

function dailyCard(daily) {
  const card = el('article', 'daily');
  card.appendChild(el('strong', '', daily.report_date));
  card.appendChild(el('p', '', daily.summary ?? ''));
  let progress = [];
  try { progress = JSON.parse(daily.progress_json ?? '[]'); } catch { progress = []; }
  for (const item of Array.isArray(progress) ? progress : []) {
    card.appendChild(el('div', 'daily-progress', `${item.progressType ?? '其他'} · ${item.progressValue==null?'未知':`${item.progressValue}%`} · ${item.progressText ?? ''}`));
  }
  return card;
}

function feedbackForm(userId, weekId, list, reportId = '') {
  const form = el('form', 'feedback-form');
  const input = el('textarea', 'feedback-input');
  input.placeholder = '输入给员工的反馈';
  input.required = true;
  input.maxLength = 2000;
  input.setAttribute('aria-label', '给员工的反馈');
  const button = el('button', 'primary-button', '发送反馈');
  button.type = 'submit';
  const status = el('span', 'form-status');
  form.append(input, button, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await fetchJson(reportId ? `/api/v1/workspace/weekly-reports/${encodeURIComponent(reportId)}/feedback` : `/api/v1/reports/${encodeURIComponent(userId)}/${encodeURIComponent(weekId)}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ content: input.value }),
      });
      list.querySelector('p.muted')?.remove();
      list.appendChild(el('div', 'feedback', input.value));
      input.value = '';
      status.textContent = '已入库，等待企微通知';
    } catch (error) {
      status.textContent = `发送失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

function table(headers, rows) {
  const wrapper = el('div', 'table-wrap');
  const node = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) headRow.appendChild(el('th', '', header));
  head.appendChild(headRow);
  node.appendChild(head);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) tr.appendChild(el('td', '', cell == null ? '' : String(cell)));
    body.appendChild(tr);
  }
  node.appendChild(body);
  wrapper.appendChild(node);
  return wrapper;
}

async function renderUsers(resultMessage = null) {
  app.replaceChildren();
  try {
    const data = await fetchJson('/api/v1/admin/users');
    const users = data.users;
    const addButton = el('button', 'primary-button', '新增人员');
    addButton.type = 'button';
    app.appendChild(pageHeading('人员与汇报关系', '先建立内部人员档案，再由员工通过一次性绑定码关联自己的企微账号。', addButton));

    const addForm = el('form', 'editor-card');
    addForm.hidden = true;
    const formGrid = el('div', 'editor-grid');
    const name = el('input', 'login-input'); name.required = true; name.maxLength = 64; name.placeholder = '例如：张三';
    const department = el('input', 'login-input'); department.maxLength = 64; department.placeholder = '例如：企业服务部';
    const role = roleSelect(data.roles, 'employee');
    const manager = managerSelect(users, '', '');
    formGrid.append(labeled('姓名', name), labeled('部门', department), labeled('角色', role), labeled('直属上级', manager));
    const addActions = el('div', 'person-actions');
    const create = el('button', 'primary-button', '创建并生成绑定码'); create.type = 'submit';
    const cancel = el('button', 'secondary-button', '取消'); cancel.type = 'button';
    const addStatus = el('span', 'form-status');
    addActions.append(create, cancel, addStatus);
    addForm.append(el('h3', '', '新增人员档案'), formGrid, addActions);
    addButton.addEventListener('click', () => { addForm.hidden = false; name.focus(); });
    cancel.addEventListener('click', () => { addForm.hidden = true; addForm.reset(); });
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault(); create.disabled = true;
      try {
        const created = await fetchJson('/api/v1/admin/users', {
          method: 'POST', body: JSON.stringify({ name: name.value, department: department.value, role: role.value, managerUserId: manager.value }),
        });
        await renderUsers({ message: `${created.user.name}已创建，请立即复制绑定码`, userId: created.user.id, code: created.activationCode, expiresAt: created.activationExpiresAt });
      } catch (error) { addStatus.textContent = `创建失败：${error.message}`; create.disabled = false; }
    });
    app.appendChild(addForm);

    const directoryNote = el('section', 'directory-note');
    const noteCopy = el('div');
    noteCopy.append(el('div', 'directory-note-title', '人员维护方式'), el('p', 'directory-note-copy', data.directory.notice));
    directoryNote.append(noteCopy, el('span', 'badge', '无需填写 userid'));
    app.appendChild(directoryNote);
    if (resultMessage?.message) app.appendChild(el('div', 'save-banner', resultMessage.message));
    if (!users.length) {
      app.appendChild(el('div', 'empty-state', '还没有人员档案。点击“新增人员”开始配置。'));
      return;
    }

    const grid = el('div', 'people-grid');
    for (const user of users) {
      const form = el('form', 'person-editor');
      const heading = el('div', 'person-heading');
      const identity = el('div');
      identity.append(el('h3', 'person-name', user.name), el('p', 'person-meta', `${user.department || '未设置部门'} · ${user.managerName ? `向 ${user.managerName} 汇报` : '无直属上级'}`));
      const headBadges = el('div', 'toolbar');
      headBadges.appendChild(el('span', `badge ${user.bindingStatus}`, user.bindingStatus === 'bound' ? '已绑定企微' : '待绑定'));
      if (user.directReportCount > 0) headBadges.appendChild(el('span', 'report-count', `${user.directReportCount} 位直属人员`));
      heading.append(identity, headBadges);

      const displayName = el('input', 'login-input'); displayName.maxLength = 64; displayName.value = user.name;
      const departmentInput = el('input', 'login-input'); departmentInput.maxLength = 64; departmentInput.value = user.department || '';
      const roleInput = roleSelect(data.roles, user.role);
      const managerInput = managerSelect(users, user.managerUserId, user.id);
      form.append(heading, labeled('姓名', displayName), labeled('部门', departmentInput), labeled('角色', roleInput), labeled('直属上级', managerInput));

      if (resultMessage?.userId === user.id && resultMessage.code) {
        const activation = el('div', 'activation-box');
        const copy = el('div');
        copy.append(el('div', 'muted', '一次性绑定码（离开本页后不再显示）'), el('div', 'activation-code', resultMessage.code));
        const copyButton = el('button', 'secondary-button', '复制绑定码'); copyButton.type = 'button';
        copyButton.addEventListener('click', async () => {
          try { await copyText(resultMessage.code); notify('绑定码已复制'); }
          catch (error) { notify(error.message); }
        });
        activation.append(copy, copyButton);
        form.appendChild(activation);
      }

      const actions = el('div', 'person-actions');
      const save = el('button', 'primary-button', '保存'); save.type = 'submit';
      const issue = el('button', 'secondary-button', user.activationStatus === 'available' ? '重置绑定码' : '生成绑定码'); issue.type = 'button';
      const unbind = el('button', 'danger-button', '解除绑定'); unbind.type = 'button'; unbind.hidden = user.bindingStatus !== 'bound';
      const status = el('span', 'form-status');
      actions.append(save, issue, unbind, status);
      form.appendChild(actions);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); save.disabled = true;
        try {
          await fetchJson(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, {
            method: 'PUT', body: JSON.stringify({ displayName: displayName.value, department: departmentInput.value, role: roleInput.value, managerUserId: managerInput.value }),
          });
          await renderUsers({ message: `${displayName.value}的人员配置已保存` });
        } catch (error) { status.textContent = `保存失败：${error.message}`; save.disabled = false; }
      });
      issue.addEventListener('click', async () => {
        issue.disabled = true;
        try {
          const result = await fetchJson(`/api/v1/admin/users/${encodeURIComponent(user.id)}/activation-code`, { method: 'POST' });
          await renderUsers({ message: `${user.name}的新绑定码已生成，旧码已失效`, userId: user.id, code: result.activationCode, expiresAt: result.activationExpiresAt });
        } catch (error) { status.textContent = `生成失败：${error.message}`; issue.disabled = false; }
      });
      unbind.addEventListener('click', async () => {
        if (!window.confirm(`确定解除${user.name}当前企微账号的绑定吗？`)) return;
        unbind.disabled = true;
        try {
          const result = await fetchJson(`/api/v1/admin/users/${encodeURIComponent(user.id)}/unbind`, { method: 'POST' });
          await renderUsers({ message: `${user.name}已解除绑定，新绑定码已生成`, userId: user.id, code: result.activationCode, expiresAt: result.activationExpiresAt });
        } catch (error) { status.textContent = `解除失败：${error.message}`; unbind.disabled = false; }
      });
      grid.appendChild(form);
    }
    app.appendChild(grid);
  } catch (error) { handlePageError(error); }
}

function roleSelect(roles, selected) {
  const select = el('select', 'login-input');
  for (const item of roles) {
    const option = el('option', '', item.label); option.value = item.value; option.selected = item.value === selected; select.appendChild(option);
  }
  return select;
}

function managerSelect(users, selected, excludedId) {
  const select = el('select', 'login-input');
  const none = el('option', '', '无直属上级'); none.value = ''; select.appendChild(none);
  for (const user of users.filter((item) => item.id !== excludedId && item.role !== 'employee')) {
    const option = el('option', '', user.name); option.value = user.id; option.selected = user.id === selected; select.appendChild(option);
  }
  return select;
}

async function renderItems() {
  app.replaceChildren(pageHeading('周计划事项', '按人员和自然周维护计划事项；事项修改保留版本，周一创建的事项从周二起不能直接删除。'));
  try {
    const { users } = await fetchJson('/api/v1/admin/users');
    const form = el('form', 'editor-card');
    const select = el('select', 'login-input');
    for (const user of users.filter((item) => item.role === 'employee')) {
      const option = el('option', '', user.name);
      option.value = user.id;
      select.appendChild(option);
    }
    const week = el('input', 'login-input');
    week.type = 'date';
    week.value = currentMonday();
    const itemName = el('input', 'login-input');
    itemName.placeholder = '新增事项名称';
    itemName.required = true;
    const itemBackground = el('textarea', 'item-background');
    itemBackground.placeholder = '事项计划及背景描述';
    const current = el('div', 'current-items');
    const load = async () => {
      if (!select.value) return;
      const data = await fetchJson(`/api/v1/admin/items?userId=${encodeURIComponent(select.value)}&weekId=${encodeURIComponent(week.value)}`);
      current.replaceChildren(el('div', 'section-title', '已有事项'));
      if (!data.items.length) current.appendChild(el('div', 'daily', '当前周暂无事项。'));
      for (const item of data.items) {
        const row = el('div', 'item-editor');
        const currentName = el('input', 'login-input'); currentName.value = item.name;
        const currentBackground = el('textarea', 'item-background');
        currentBackground.value = item.plan_background;
        currentBackground.placeholder = '事项计划及背景';
        const actions = el('div', 'item-actions');
        const save = el('button', 'secondary-button', `保存 v${item.version}`); save.type = 'button';
        const remove = el('button', 'danger-button', '删除'); remove.type = 'button';
        const itemStatus = el('span', 'form-status');
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            await fetchJson(`/api/v1/admin/items/${encodeURIComponent(item.id)}`, {
              method: 'PUT',
              body: JSON.stringify({ version: item.version, name: currentName.value, planBackground: currentBackground.value }),
            });
            await load();
          } catch (error) { itemStatus.textContent = `保存失败：${error.message}`; }
          finally { save.disabled = false; }
        });
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await fetchJson(`/api/v1/admin/items/${encodeURIComponent(item.id)}`, {
              method: 'DELETE', body: JSON.stringify({ version: item.version }),
            });
            await load();
          } catch (error) { itemStatus.textContent = `删除失败：${error.message}`; }
          finally { remove.disabled = false; }
        });
        actions.append(save, remove, itemStatus);
        row.append(currentName, currentBackground, actions);
        current.appendChild(row);
      }
    };
    select.addEventListener('change', () => void load());
    week.addEventListener('change', () => void load());
    const button = el('button', 'primary-button', '追加事项');
    button.type = 'submit';
    const status = el('span', 'form-status');
    form.append(el('h3', '', '选择人员与周次'), labeled('员工', select), labeled('周一日期', week), current, el('h3', 'section-title', '追加新事项'), labeled('事项名称', itemName), labeled('计划与背景', itemBackground), button, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await fetchJson('/api/v1/admin/items', {
          method: 'POST',
          body: JSON.stringify({
            userId: select.value,
            weekId: week.value,
            items: [{ name: itemName.value, planBackground: itemBackground.value }],
          }),
        });
        itemName.value = '';
        itemBackground.value = '';
        status.textContent = '事项已保存';
        await load();
      } catch (error) { status.textContent = `保存失败：${error.message}`; }
    });
    app.appendChild(form);
    await load();
  } catch (error) { handlePageError(error); }
}

async function renderDailyHistory() {
  app.replaceChildren(pageHeading('日报记录', '已确认日报、待确认草稿和原始工作记录均在这里留存，便于追溯。'));
  try {
    const data = await fetchJson('/api/v1/admin/daily-reports');
    app.appendChild(table(
      ['日期', '员工', '版本', '状态', '摘要', '来源数'],
      data.reports.map((report) => [report.report_date, report.user_name, report.version, report.status, report.summary, report.source_count]),
    ));
    app.appendChild(el('h3', 'section-title', '最近原始消息'));
    app.appendChild(table(
      ['时间', '日期', '员工', '类型', '处理状态', '原文'],
      data.sources.map((source) => [source.created_at, source.report_date, source.user_name, source.content_type, source.process_status, source.text_content]),
    ));
  } catch (error) { handlePageError(error); }
}

async function renderWeeklyHistory() {
  app.replaceChildren(pageHeading('周报与反馈', '周报按模板从已确认日报生成，管理者反馈会留存并通知对应员工。'));
  try {
    const data = await fetchJson('/api/v1/admin/weekly-reports');
    app.appendChild(table(
      ['周起始', '员工', '版本', '模板版本', '反馈数', '摘要'],
      data.reports.map((report) => [report.week_id, report.user_name, report.version, report.template_version, report.feedback_count, report.content]),
    ));
  } catch (error) { handlePageError(error); }
}

async function renderAuditLogs() {
  app.replaceChildren(pageHeading('审计日志', '查看关键配置、确认、反馈、绑定和导出操作。'));
  try {
    const data = await fetchJson('/api/v1/admin/audit-logs');
    app.appendChild(table(
      ['时间', '操作人', '动作', '资源类型', '资源ID', '详情'],
      data.logs.map((log) => [log.created_at, log.actor_name ?? log.actor_user_id ?? '系统', log.action, log.resource_type, log.resource_id, log.details_json]),
    ));
  } catch (error) { handlePageError(error); }
}

async function renderExports() {
  app.replaceChildren(pageHeading('导出归档', '按年度、季度和人员生成完整留存包。'));
  try {
    const { users } = await fetchJson('/api/v1/admin/users');
    const form = el('form', 'editor-card');
    const year = el('input', 'login-input'); year.type = 'number'; year.min = '2000'; year.max = '2100'; year.value = String(new Date().getFullYear());
    const quarter = el('select', 'login-input');
    for (const [value, label] of [['', '全年'], ['1', '第一季度'], ['2', '第二季度'], ['3', '第三季度'], ['4', '第四季度']]) {
      const option = el('option', '', label); option.value = value; quarter.appendChild(option);
    }
    const user = el('select', 'login-input');
    const all = el('option', '', '全部人员'); all.value = ''; user.appendChild(all);
    for (const item of users) {
      const option = el('option', '', item.name); option.value = item.id; user.appendChild(option);
    }
    const button = el('button', 'primary-button', '导出JSON归档'); button.type = 'submit';
    const status = el('span', 'form-status');
    form.append(year, quarter, user, button, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        const archive = await fetchJson('/api/v1/admin/exports', {
          method: 'POST',
          body: JSON.stringify({ year: Number(year.value), quarter: quarter.value, userId: user.value }),
        });
        const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob);
        const link = el('a');
        link.href = href;
        link.download = `日报助手归档-${year.value}${quarter.value ? `-Q${quarter.value}` : ''}${user.value ? `-${user.value}` : ''}.json`;
        link.click();
        URL.revokeObjectURL(href);
        status.textContent = '归档已生成并记录审计日志';
      } catch (error) { status.textContent = `导出失败：${error.message}`; }
      finally { button.disabled = false; }
    });
    app.appendChild(form);
  } catch (error) { handlePageError(error); }
}

async function renderGovernance() {
  app.replaceChildren();
  try {
    app.appendChild(pageHeading('审计与归档', '关键操作形成不可见于普通员工的审计记录，业务数据可按周期导出归档。'));
    const [userData, auditData] = await Promise.all([
      fetchJson('/api/v1/admin/users'), fetchJson('/api/v1/admin/audit-logs'),
    ]);
    const grid = el('div', 'governance-grid');
    const exportPanel = el('form', 'editor-card');
    exportPanel.append(el('h3', '', '导出业务归档'), el('p', 'muted', '包含日报版本、原始记录、周报、事项与管理反馈。'));
    const year = el('input', 'login-input'); year.type = 'number'; year.min = '2000'; year.max = '2100'; year.value = String(new Date().getFullYear());
    const quarter = el('select', 'login-input');
    for (const [value, label] of [['', '全年'], ['1', '第一季度'], ['2', '第二季度'], ['3', '第三季度'], ['4', '第四季度']]) { const option = el('option', '', label); option.value = value; quarter.appendChild(option); }
    const user = el('select', 'login-input');
    const all = el('option', '', '全部人员'); all.value = ''; user.appendChild(all);
    for (const item of userData.users) { const option = el('option', '', item.name); option.value = item.id; user.appendChild(option); }
    const exportButton = el('button', 'primary-button', '生成并下载归档'); exportButton.type = 'submit';
    const exportStatus = el('span', 'form-status');
    exportPanel.append(labeled('年份', year), labeled('范围', quarter), labeled('人员', user), exportButton, exportStatus);
    exportPanel.addEventListener('submit', async (event) => {
      event.preventDefault(); exportButton.disabled = true;
      try {
        const archive = await fetchJson('/api/v1/admin/exports', { method: 'POST', body: JSON.stringify({ year: Number(year.value), quarter: quarter.value, userId: user.value }) });
        const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob); const link = el('a'); link.href = href;
        link.download = `日报助手归档-${year.value}${quarter.value ? `-Q${quarter.value}` : ''}.json`; link.click(); URL.revokeObjectURL(href);
        exportStatus.textContent = '归档已生成，操作已记入审计日志'; notify('归档已下载');
      } catch (error) { exportStatus.textContent = `导出失败：${error.message}`; }
      finally { exportButton.disabled = false; }
    });
    const auditPanel = el('section', 'panel');
    auditPanel.appendChild(el('h3', '', '最近操作记录'));
    auditPanel.appendChild(el('p', 'muted', '按时间倒序展示最近 500 条关键操作。'));
    auditPanel.appendChild(table(
      ['时间', '操作人', '动作', '对象', '详情'],
      auditData.logs.map((log) => [log.created_at, log.actor_name ?? '系统', actionLabel(log.action), `${log.resource_type} · ${log.resource_id}`, readableDetails(log.details_json)]),
    ));
    grid.append(exportPanel, auditPanel); app.appendChild(grid);
  } catch (error) { handlePageError(error); }
}

function actionLabel(action) {
  const labels = {
    'admin.user_created': '新增人员', 'admin.user_assignment_updated': '更新人员配置',
    'admin.activation_code_issued': '生成绑定码', 'admin.user_unbound': '解除企微绑定', 'user.wecom_bound': '确认企微绑定',
    'daily_report.draft_generated': '生成日报草稿', 'daily_report.confirmed': '确认日报入库',
    'weekly_report.feedback_added': '提交管理反馈', 'admin.settings_updated': '更新规则',
    'admin.template_version_created': '发布模板版本', 'admin.knowledge_created': '新增知识资料',
    'admin.knowledge_updated': '更新知识资料', 'admin.archive_exported': '导出归档',
  };
  return labels[action] ?? action;
}

function readableDetails(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return Object.entries(parsed).slice(0, 4).map(([key, value]) => `${key}: ${value ?? '-'}`).join('；') || '-';
  } catch { return '-'; }
}

async function renderTemplates() {
  location.hash = '#/knowledge';
}

async function renderSettings() {
  app.replaceChildren();
  try {
    const settings = await fetchJson('/api/v1/admin/settings');
    app.appendChild(pageHeading('规则配置', '集中管理日报、周报、提醒、确认和留存规则；保存后新任务立即按新规则执行。'));
    const form = el('form', 'editor-card');
    form.appendChild(el('h3', '', '汇报规则'));
    const grid = el('div', 'editor-grid');
    const boundary = el('select', 'login-input');
    for (const [value, label] of [['natural_week', '周一至周日'], ['work_week', '周一至周五']]) {
      const option = el('option', '', label); option.value = value; boundary.appendChild(option);
    }
    boundary.value = settings.weekBoundary;
    const max = el('input', 'login-input');
    max.type = 'number'; max.min = '1'; max.max = '100'; max.value = String(settings.maxWorkItems);
    const confirmPolicy = el('select', 'login-input');
    for (const [value, label] of [['button_and_text', '卡片按钮或明确文字均可确认'], ['button_only', '仅卡片按钮可确认']]) {
      const option = el('option', '', label); option.value = value; confirmPolicy.appendChild(option);
    }
    confirmPolicy.value = settings.confirmPolicy;
    const progressMode = el('select', 'login-input');
    for (const [value, label] of [['cumulative', '累计进度（0–100%）'], ['incremental', '记录当日增量'], ['subitem', '按子任务完成情况']]) {
      const option = el('option', '', label); option.value = value; progressMode.appendChild(option);
    }
    progressMode.value = settings.progressMode;
    const planReminderAt = el('input', 'login-input'); planReminderAt.type = 'time'; planReminderAt.value = settings.planReminderAt;
    const dailyReminderAt = el('input', 'login-input'); dailyReminderAt.type = 'time'; dailyReminderAt.value = settings.dailyReminderAt;
    const weeklyGenerateAt = el('input', 'login-input'); weeklyGenerateAt.type = 'time'; weeklyGenerateAt.value = settings.weeklyGenerateAt;
    const sourceRetentionDays = el('input', 'login-input'); sourceRetentionDays.type = 'number'; sourceRetentionDays.min = '30'; sourceRetentionDays.max = '3650'; sourceRetentionDays.value = String(settings.sourceRetentionDays);
    const attachmentRetentionDays = el('input', 'login-input'); attachmentRetentionDays.type = 'number'; attachmentRetentionDays.min = '7'; attachmentRetentionDays.max = '3650'; attachmentRetentionDays.value = String(settings.attachmentRetentionDays);
    grid.append(
      labeled('周报统计周期', boundary), labeled('每人每周事项上限', max),
      labeled('日报确认方式', confirmPolicy), labeled('进度记录方式', progressMode),
      labeled('原始文字记录留存（天）', sourceRetentionDays), labeled('原始附件留存（天）', attachmentRetentionDays),
    );
    const button = el('button', 'primary-button', '保存配置'); button.type = 'submit';
    const status = el('span', 'form-status');
    const actions = el('div', 'person-actions'); actions.append(button, status);
    form.append(grid, actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await fetchJson('/api/v1/admin/settings', {
          method: 'POST', body: JSON.stringify({
            weekBoundary: boundary.value, maxWorkItems: Number(max.value), confirmPolicy: confirmPolicy.value,
            progressMode: progressMode.value,
            sourceRetentionDays: Number(sourceRetentionDays.value), attachmentRetentionDays: Number(attachmentRetentionDays.value),
          }),
        });
        status.textContent = '规则已保存，新任务立即生效';
        notify('规则配置已保存');
      } catch (error) { status.textContent = `保存失败：${error.message}`; }
    });
    app.appendChild(form);
    await renderDirectorySettings();
  } catch (error) { handlePageError(error); }
}

async function renderDirectorySettings() {
  const section = el('section', 'editor-card');
  section.append(el('h3', '', '员工与企业名录'), el('p', 'muted', '在普通企微表格中维护员工和企业；配置、模板、工作记录及日报周报保存在本地。'));
  app.append(section);
  try {
    let data = await fetchJson('/api/v1/admin/directory');
    const form = el('form', 'editor-grid');
    const input = el('input', 'login-input'); input.type = 'url'; input.value = data.url; input.placeholder = '粘贴人员表格链接';
    const companyInput = el('input', 'login-input'); companyInput.type = 'url'; companyInput.value = data.companyUrl || ''; companyInput.placeholder = '粘贴企业表格链接';
    const save = el('button', 'primary-button', '保存链接'); save.type = 'submit';
    const sync = el('button', 'secondary-button', '同步名录'); sync.type = 'button';
    const status = el('p', 'form-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const hint = el('p', 'muted');
    const refresh = () => {
      sync.disabled = !data.url || !data.companyUrl || data.busy;
      hint.textContent = data.lastSync ? `上次同步：${new Date(data.lastSync.at).toLocaleString('zh-CN')}，员工 ${data.lastSync.employees} 人，企业 ${data.lastSync.companies} 家。` : '还没有同步名录。先保存链接，再同步；读取失败会保留原有数据。';
    };
    const actions = el('div', 'person-actions'); actions.append(save, sync);
    form.append(labeled('人员表格链接', input), labeled('企业表格链接', companyInput), actions);
    const columns = el('details'); columns.append(el('summary', '', '查看两张表的表头'));
    for (const [label, values] of [['员工', data.employeeColumns], ['企业', data.companyColumns]]) {
      columns.append(el('p', 'muted', `${label}表格（首行表头，可复制）：`), el('pre', '', values.join('\t')));
    }
    columns.append(el('p', 'muted', '人员表维护负责人和员工；企业表维护企业名称。负责人查看团队，企业首次导入默认由员工负责。绑定码由系统签发；在表格里修改文字不会生成有效绑定码。名称用于识别记录，改名请先核对；删除行不会删除历史。'));
    section.append(form, hint, status, columns);
    refresh();
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; sync.disabled = true;
      try {
        if (Boolean(input.value.trim()) !== Boolean(companyInput.value.trim())) throw new Error('请同时填写人员和企业表格链接');
        data = await fetchJson('/api/v1/admin/directory', { method: 'PUT', body: JSON.stringify({ url: input.value, companyUrl: companyInput.value }) });
        input.value = data.url; companyInput.value = data.companyUrl; status.textContent = '链接已保存在本地。点击“同步名录”读取表格。';
      } catch (error) { status.textContent = `保存失败：${error.message}`; }
      finally { save.disabled = false; refresh(); }
    });
    sync.addEventListener('click', async () => {
      if (input.value.trim() !== data.url || companyInput.value.trim() !== data.companyUrl) { status.textContent = '链接已修改，请先保存再同步。'; return; }
      save.disabled = true; sync.disabled = true; input.disabled = true; companyInput.disabled = true; status.textContent = '正在读取员工与企业名录，请稍候……';
      try {
        const result = await fetchJson('/api/v1/admin/directory/sync', { method: 'POST' });
        data.lastSync = result; status.textContent = '同步完成，可到人员管理和企业管理查看。';
      } catch (error) { status.textContent = `同步失败：${error.message}`; }
      finally { save.disabled = false; input.disabled = false; companyInput.disabled = false; refresh(); }
    });
  } catch (error) { section.append(el('p', 'error', `无法读取名录设置：${error.message}`)); }
}

const KNOWLEDGE_TYPES = [
  ['service_company', '企业参考资料'], ['park_material', '园区资料'], ['policy', '政策资料'], ['guide', '办事指南'],
  ['daily_template', '日报模板'], ['weekly_template', '周报模板'],
];

async function renderKnowledgeLegacy(selectedKind = 'service_company', selectedId = '') {
  app.replaceChildren();
  try {
    app.appendChild(pageHeading('知识库', '维护企业参考资料、园区资料、政策和汇报模板；企业状态与推进阶段请在“企业管理”维护。'));
    const tabs = el('div', 'knowledge-tabs');
    for (const [value, label] of KNOWLEDGE_TYPES) {
      const button = el('button', `knowledge-tab${value === selectedKind ? ' active' : ''}`, label); button.type = 'button';
      button.addEventListener('click', () => void renderKnowledge(value));
      tabs.appendChild(button);
    }
    app.appendChild(tabs);
    if (selectedKind === 'daily_template' || selectedKind === 'weekly_template') {
      const data = await fetchJson('/api/v1/admin/templates');
      app.appendChild(templateBuilder(selectedKind === 'daily_template' ? 'daily' : 'weekly', data.templates));
      return;
    }
    const data = await fetchJson(`/api/v1/admin/knowledge?kind=${encodeURIComponent(selectedKind)}`);
    const entries = data.entries;
    const selected = entries.find((entry) => entry.id === selectedId) ?? null;
    const layout = el('div', 'knowledge-layout');
    const left = el('section', 'panel');
    const leftHead = el('div', 'page-heading');
    const label = KNOWLEDGE_TYPES.find(([value]) => value === selectedKind)?.[1] ?? '资料';
    const headCopy = el('div'); headCopy.append(el('h3', '', label), el('p', '', `${entries.length} 条资料`));
    const add = el('button', 'secondary-button', '新增'); add.type = 'button';
    add.addEventListener('click', () => void renderKnowledge(selectedKind));
    leftHead.append(headCopy, add); left.appendChild(leftHead);
    const list = el('div', 'knowledge-list');
    if (!entries.length) list.appendChild(el('div', 'empty-state', '暂无资料，请先新增一条。'));
    for (const entry of entries) {
      const item = el('button', `knowledge-item${selected?.id === entry.id ? ' active' : ''}`); item.type = 'button';
      item.append(el('h4', '', entry.title), el('p', '', `${entry.active ? '已启用' : '已停用'} · v${entry.version} · ${entry.summary || '暂无摘要'}`));
      item.addEventListener('click', () => void renderKnowledge(selectedKind, entry.id));
      list.appendChild(item);
    }
    left.appendChild(list);
    layout.append(left, knowledgeEditor(selectedKind, selected));
    app.appendChild(layout);
  } catch (error) { handlePageError(error); }
}

function knowledgeEditor(kind, entry, chooseKind = false) {
  const form = el('form', 'editor-card');
  form.appendChild(el('h3', '', entry ? '编辑资料' : '新增资料'));
  const category = chooseKind ? crmSelect(KNOWLEDGE_TYPES.filter(([key])=>!key.endsWith('_template')),kind) : null;
  if(category) form.appendChild(labeled('资料类型',category));
  const title = el('input', 'login-input'); title.required = true; title.maxLength = 120; title.value = entry?.title ?? '';
  const summary = el('textarea', 'item-background'); summary.maxLength = 500; summary.value = entry?.summary ?? ''; summary.placeholder = '用一两句话说明资料用途';
  const content = el('textarea', 'template-editor'); content.required = true; content.value = entry?.content ?? ''; content.placeholder = '粘贴经过确认的资料正文。当前支持文字内容。';
  const tags = el('input', 'login-input');
  try { tags.value = JSON.parse(entry?.tags_json ?? '[]').join('，'); } catch { tags.value = ''; }
  const sourceName = el('input', 'login-input'); sourceName.value = entry?.source_name ?? ''; sourceName.placeholder = '例如：2026园区招商手册.docx';
  const active = el('select', 'login-input');
  for (const [value, label] of [['true', '启用（可供日报助手引用）'], ['false', '停用（仅保留历史）']]) {
    const option = el('option', '', label); option.value = value; active.appendChild(option);
  }
  active.value = entry?.active === 0 ? 'false' : 'true';
  form.append(labeled('资料名称', title), labeled('摘要', summary), labeled('正文内容', content), labeled('标签（用逗号分隔）', tags), labeled('来源文件或出处', sourceName), labeled('使用状态', active));
  const actions = el('div', 'person-actions');
  const save = el('button', 'primary-button', entry ? '保存修改' : '创建资料'); save.type = 'submit';
  const status = el('span', 'form-status'); actions.append(save, status); form.appendChild(actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    const payload = {
      kind: category?.value || kind, title: title.value, summary: summary.value, content: content.value, sourceName: sourceName.value,
      tags: tags.value.split(/[，,]/).map((value) => value.trim()).filter(Boolean), active: active.value === 'true',
    };
    try {
      const result = entry
        ? await fetchJson(`/api/v1/admin/knowledge/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: JSON.stringify({ ...payload, version: entry.version }) })
        : await fetchJson('/api/v1/admin/knowledge', { method: 'POST', body: JSON.stringify(payload) });
      notify(entry ? '资料已保存' : '资料已创建');
      await renderKnowledge(payload.kind, result.entry.id);
    } catch (error) { status.textContent = `保存失败：${error.message}`; save.disabled = false; }
  });
  return form;
}

function templateBuilder(kind, templates) {
  const active = templates.find((template) => template.kind === kind && template.active === 1);
  let parts = [];
  try {
    const parsed = JSON.parse(active?.content ?? '{}');
    const source = kind === 'daily' ? parsed.fields : parsed.sections;
    parts = Array.isArray(source) ? source.map((item) => typeof item === 'string'
      ? { title: item, guidance: '', required: true }
      : { title: item.title || item.name || '', guidance: item.guidance || item.instruction || '', required: item.required !== false }) : [];
  } catch { parts = []; }
  if (!parts.length) parts = kind === 'daily'
    ? ['工作事项', '当日进展', '问题原因', '下一步计划'].map((title) => ({ title, guidance: '', required: true }))
    : ['本周计划与进展', '问题与原因', '下周安排', '交流反馈'].map((title) => ({ title, guidance: '', required: true }));
  const form = el('form', 'editor-card');
  const title = kind === 'daily' ? '日报模板' : '周报模板';
  form.append(el('h3', '', title), el('p', 'muted', '每次保存都会生成新版本，历史报告仍保留原模板版本。'));
  const name = el('input', 'login-input'); name.required = true; name.value = active?.name ?? `默认${title}`;
  form.appendChild(labeled('模板名称', name));
  const builder = el('div', 'template-builder');
  const preview = el('div', 'split-stack');
  const render = () => {
    builder.replaceChildren(); preview.replaceChildren();
    parts.forEach((part, index) => {
      const row = el('div', 'template-section');
      const number = el('span', 'template-index', String(index + 1));
      const field = el('input', 'login-input'); field.value = part.title; field.placeholder = kind === 'daily' ? '字段名称' : '章节名称';
      const guidance = el('input', 'login-input'); guidance.value = part.guidance; guidance.placeholder = '填写日报助手整理这一项时遵循的规则';
      const required = el('select', 'login-input');
      for (const [value, label] of [['true', '必填'], ['false', '选填']]) { const option = el('option', '', label); option.value = value; required.appendChild(option); }
      required.value = String(part.required);
      const controls = el('div', 'toolbar');
      const up = el('button', 'secondary-button', '↑'); up.type = 'button'; up.disabled = index === 0;
      const down = el('button', 'secondary-button', '↓'); down.type = 'button'; down.disabled = index === parts.length - 1;
      const remove = el('button', 'danger-button', '删除'); remove.type = 'button';
      field.addEventListener('input', () => { part.title = field.value; updatePreview(); });
      guidance.addEventListener('input', () => { part.guidance = guidance.value; updatePreview(); });
      required.addEventListener('change', () => { part.required = required.value === 'true'; updatePreview(); });
      up.addEventListener('click', () => { [parts[index - 1], parts[index]] = [parts[index], parts[index - 1]]; render(); });
      down.addEventListener('click', () => { [parts[index + 1], parts[index]] = [parts[index], parts[index + 1]]; render(); });
      remove.addEventListener('click', () => { parts.splice(index, 1); render(); });
      controls.append(up, down, remove); row.append(number, field, guidance, required, controls); builder.appendChild(row);
    });
    updatePreview();
  };
  const updatePreview = () => {
    preview.replaceChildren();
    parts.forEach((part, index) => {
      const item = el('div', 'template-preview');
      item.append(el('h4', '', `${index + 1}. ${part.title || '未命名'}${part.required ? ' *' : ''}`), el('p', '', part.guidance || '由日报助手根据已确认工作记录整理'));
      preview.appendChild(item);
    });
  };
  render();
  const add = el('button', 'secondary-button', '＋ 添加字段'); add.type = 'button';
  add.addEventListener('click', () => { parts.push({ title: '', guidance: '', required: true }); render(); });
  const save = el('button', 'primary-button', '保存为新版本'); save.type = 'submit';
  const status = el('span', 'form-status', active ? `当前 v${active.version}` : '');
  const actions = el('div', 'person-actions'); actions.append(add, save, status);
  form.append(builder, el('h4', 'section-title', '效果预览'), preview, actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const normalized = parts.map((part) => ({ title: part.title.trim(), guidance: part.guidance.trim(), required: part.required })).filter((part) => part.title);
    if (!normalized.length) { status.textContent = '至少保留一个字段'; return; }
    save.disabled = true;
    try {
      const content = JSON.stringify(kind === 'daily' ? { fields: normalized } : { sections: normalized });
      const result = await fetchJson('/api/v1/admin/templates', { method: 'POST', body: JSON.stringify({ kind, name: name.value, content }) });
      notify(`${title}已保存为 v${result.template.version}`);
      await renderKnowledge(`${kind}_template`);
    } catch (error) { status.textContent = `保存失败：${error.message}`; save.disabled = false; }
  });
  return form;
}

function handlePageError(error) {
  if (error.message === 'UNAUTHORIZED') return showLogin('登录已过期，请重新登录');
  app.appendChild(el('div', 'error', `加载失败：${error.message}`));
}

async function exchangeAccessGrant(hash) {
  const run = WS_ROUTE_RUN;
  app.replaceChildren(el('div', 'login-card', '正在验证企微报告链接…'));
  try {
    const grantToken = decodeURIComponent(hash.slice('#/access/'.length));
    const result = await fetchJson('/api/v1/access-grants/exchange', {
      method: 'POST', body: JSON.stringify({ token: grantToken }),
    });
    sessionStorage.setItem(TOKEN_KEY, result.token);
    history.replaceState(null, '', result.route);
    route();
  } catch (error) {
    if (run === WS_ROUTE_RUN) showLogin(`报告链接无效、已使用或已过期：${error.message}`);
  }
}

function route() {
  // Report links always open the standalone mobile surface, including old shared links.
  if (typeof mwRoute !== 'function' && /^#\/(?:records\/(?:weekly|week)(?:[/?]|$)|report\/|access\/)/.test(location.hash)) {
    location.replace('weekly.html' + location.hash); return;
  }
  void wsRoute();
}

window.addEventListener('hashchange', route);
route();
