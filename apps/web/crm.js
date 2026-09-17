// CRM is a business record module; knowledge entries remain reference material.
const CRM_ROOT = '/api/v1/workspace/crm';
const CRM_REL = { prospect: '潜在企业', serving: '在服企业', paused: '暂停跟进', exited: '已退出' };
const CRM_OPERATING = { unknown: '未核实', active: '正常经营', suspended: '暂停经营', closed: '已注销' };
const CRM_RISKS = { none: '暂无标记', watch: '需要关注', high: '重点风险' };
const CRM_SERVICE = { pending: '待处理', working: '跟进中', waiting: '待外部反馈', resolved: '已解决', paused: '暂停' };
const CRM_TYPES = { visit: '走访', call: '电话沟通', meeting: '会议', material: '资料对接', other: '其他' };
const CRM_EVENT_LABELS = { company_created: '建立档案', company_updated: '更新档案', project_created: '新增项目', project_updated: '更新项目', service_created: '新增服务', service_updated: '更新服务', followup: '跟进记录', knowledge_linked: '关联资料' };
const CRM_FIELDS = { name: '企业名称', aliases: '别名', industry: '行业', park: '园区', ownerId: '负责人', relationship: '业务关系', operatingStatus: '经营情况', contactName: '联系人', contactRole: '联系人职务', contactPhone: '联系方式', summary: '目前情况', nextAction: '下一步', nextDate: '下次跟进', risk: '风险级别', riskNote: '风险说明', archived: '归档状态', title: '事项名称', description: '说明', dueDate: '计划日期', stageId: '推进阶段', status: '服务状态', outcome: '处理结果' };
const crmDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
CRM_FIELDS.collaboratorIds = '协作人员';
function crmButton(label, action, cls = 'secondary-button') {
  const button = el('button', cls, label); button.type = 'button'; button.addEventListener('click', action); return button;
}
function crmSelect(options, value = '', placeholder) {
  const input = el('select', 'login-input');
  if (placeholder !== undefined) { const option = el('option', '', placeholder); option.value = ''; input.append(option); }
  for (const [key, label] of options) { const option = el('option', '', label); option.value = key; input.append(option); }
  input.value = value; return input;
}
function crmInput(value = '', type = 'text', max = 200) { const input = el('input', 'login-input'); input.type = type; input.value = value; input.maxLength = max; return input; }
function crmText(value = '', max = 2000) { const input = el('textarea', 'item-background'); input.value = value; input.maxLength = max; input.rows = 3; return input; }
function crmBadge(text, kind = '') { return el('span', `crm-badge ${kind}`, text); }
function crmOwner(options, id) { return options.users.find((u) => u.id === id)?.name || options.displayNames?.[id] || (id ? '相关负责人' : '待分配'); }
function crmStage(options, id) { return options.stages.find((s) => s.id === id)?.label || '未设置'; }
function crmTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }
function crmMetric(label, number, note) { const node = el('div', 'crm-metric'); node.append(el('p', '', label), el('strong', '', number), el('small', '', note)); return node; }
function crmEmpty(message) { return el('div', 'empty-state', message); }
function crmModal(title, description, setup, save, savedLabel = '保存并留痕') {
  const dialog = el('dialog', 'crm-dialog');
  const form = el('form', 'crm-form');
  const head = el('div', 'crm-modal-head');
  const titleNode = el('h2', '', title); titleNode.id = 'crm-dialog-title';
  dialog.setAttribute('aria-labelledby', titleNode.id);
  head.append(titleNode, crmButton('关闭', () => dialog.close(), 'quiet-button'));
  const fields = el('div', 'crm-form-grid');
  const status = el('p', 'crm-form-error'); status.setAttribute('role', 'alert');
  const footer = el('div', 'crm-modal-footer');
  const submit = el('button', 'primary-button', savedLabel); submit.type = 'submit';
  footer.append(crmButton('取消', () => dialog.close(), 'quiet-button'), submit);
  form.append(head, el('p', 'muted', description), fields, status, footer); dialog.append(form);
  const collect = setup(fields);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; status.textContent = '';
    try { await save(collect()); dialog.close(); }
    catch (error) { status.textContent = error.message === 'UNAUTHORIZED' ? '登录过期，请关闭窗口后重新登录。' : error.message; }
    finally { submit.disabled = false; }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal(); return dialog;
}
function crmField(container, name, control, wide = false) {
  const wrapper = labeled(name, control); if (wide) wrapper.classList.add('crm-wide'); container.append(wrapper); return control;
}
function crmSource(container, options) {
  return crmField(container, '来源日报（可选，仅已确认版本）', crmSelect(options.reports.map((r) => [r.id, `${r.report_date} · ${r.name} · v${r.version}`]), '', '后台人工录入'), true);
}
function crmCompanyEditor(company, options, done) {
  crmModal(company ? '编辑企业档案' : '新增企业档案', '企业概况由人工核实维护。经营情况不确定时请选择“未核实”；同名企业不会自动合并。', (grid) => {
    const controls = {};
    controls.name = crmField(grid, '企业名称 *', crmInput(company?.name, 'text', 120)); controls.name.required = true;
    controls.aliases = crmField(grid, '常用简称 / 别名', crmInput(company?.aliases?.join('，'), 'text', 500));
    controls.industry = crmField(grid, '行业', crmInput(company?.industry, 'text', 80));
    controls.park = crmField(grid, '所属 / 意向园区', crmInput(company?.park, 'text', 80));
    controls.ownerId = crmField(grid, '企业负责人', crmSelect(options.users.map((u) => [u.id, `${u.name}${u.department ? ` · ${u.department}` : ''}`]), company?.ownerId || (!options.permissions?.canAssign ? WS_CONTEXT.me.id : ''), '待分配'));
    controls.ownerId.disabled = !options.permissions?.canAssign;
    if (company?.ownerId && !options.users.some((u)=>u.id===company.ownerId)) { const current=el('option','',company.ownerName||'当前负责人');current.value=company.ownerId;controls.ownerId.append(current);controls.ownerId.value=company.ownerId; }
    const collaborators = el('div', 'crm-checkboxes'), choices = [];
    for (const user of options.users) { const check=el('input');check.type='checkbox';check.value=user.id;check.checked=Boolean(company?.collaboratorIds?.includes(user.id));check.disabled=!options.permissions?.canAssign;const label=el('label');label.append(check,document.createTextNode(user.name));collaborators.append(label);choices.push(check); }
    crmField(grid, '协作人员（负责人无需重复选择）', collaborators, true);
    controls.relationship = crmField(grid, '业务关系', crmSelect(Object.entries(CRM_REL), company?.relationship || 'prospect'));
    controls.operatingStatus = crmField(grid, '经营情况（需有核实依据）', crmSelect(Object.entries(CRM_OPERATING), company?.operatingStatus || 'unknown'));
    controls.risk = crmField(grid, '风险标记', crmSelect(Object.entries(CRM_RISKS), company?.risk || 'none'));
    controls.contactName = crmField(grid, '主要联系人', crmInput(company?.contactName, 'text', 60));
    controls.contactRole = crmField(grid, '联系人职务', crmInput(company?.contactRole, 'text', 60));
    controls.contactPhone = crmField(grid, '联系方式', crmInput(company?.contactPhone, 'text', 60));
    controls.nextDate = crmField(grid, '下次跟进日期', crmInput(company?.nextDate, 'date'));
    controls.summary = crmField(grid, '目前情况（人工维护，不代表 AI 核实）', crmText(company?.summary), true);
    controls.nextAction = crmField(grid, '下一步安排', crmText(company?.nextAction, 500), true);
    controls.riskNote = crmField(grid, '风险说明 / 需协调事项', crmText(company?.riskNote, 500), true);
    const source = crmSource(grid, options);
    let archived, reason;
    if (company) {
      archived = crmField(grid, '档案状态（归档后停止跟进，历史保留）', crmSelect([['false', '正常维护'], ['true', '归档保留']], String(company.archived)), true);
      reason = crmField(grid, '本次修改原因 / 信息依据 *', crmText('', 1000), true); reason.required = true;
    }
    return () => ({ ...Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value])), ownerId: options.permissions?.canAssign ? controls.ownerId.value : company?.ownerId || WS_CONTEXT.me.id, collaboratorIds: options.permissions?.canAssign ? choices.filter((c)=>c.checked&&c.value!==controls.ownerId.value).map((c)=>c.value) : company?.collaboratorIds || [], aliases: controls.aliases.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean), archived: archived?.value === 'true', reason: reason?.value || '', sourceReportId: source.value, ...(company ? { version: company.version } : {}) });
  }, async (body) => {
    const result = await fetchJson(`${CRM_ROOT}/companies${company ? `/${company.id}` : ''}`, { method: company ? 'PUT' : 'POST', body: JSON.stringify(body) });
    notify(company ? '企业档案已更新，变更已留痕' : '企业档案已建立'); await done(result.company);
  });
}
function crmRecordEditor(company, kind, record, options, done) {
  const title = kind === 'project' ? '招商项目' : '服务事项';
  crmModal(`${record ? '编辑' : '新增'}${title}`, '阶段与状态由人工确认。此处的变更会写入企业时间线，不会改写原始日报。', (grid) => {
    const name = crmField(grid, `${title}名称 *`, crmInput(record?.title, 'text', 120), true); name.required = true;
    const owner = crmField(grid, '负责人', crmSelect(options.users.map((u) => [u.id, u.name]), record?.ownerId ?? company.ownerId, '待分配'));
    owner.disabled = !options.permissions?.canAssign;
    const currentOwner = record?.ownerId ?? company.ownerId;
    if (currentOwner && !options.users.some((u)=>u.id===currentOwner)) { const current=el('option','',crmOwner(options,currentOwner));current.value=currentOwner;owner.append(current);owner.value=currentOwner; }
    const stage = crmField(grid, kind === 'project' ? '当前阶段' : '处理状态', crmSelect(kind === 'project' ? options.stages.map((s) => [s.id, s.label]) : Object.entries(CRM_SERVICE), record?.stageId || record?.status || (kind === 'project' ? options.stages[0].id : 'pending')));
    const description = crmField(grid, '需求与背景', crmText(record?.description), true);
    const next = crmField(grid, '下一步', crmText(record?.nextAction, 500), true);
    const due = crmField(grid, '计划日期', crmInput(record?.dueDate, 'date'));
    let outcome;
    if (kind === 'service') {
      outcome = crmField(grid, '处理结果（已解决时必填）', crmText(record?.outcome, 1000), true);
      const update = () => { outcome.required = stage.value === 'resolved'; }; stage.addEventListener('change', update); update();
    }
    const source = crmSource(grid, options);
    const reason = crmField(grid, record ? '变更原因 / 阶段推进依据 *' : '记录依据（可选）', crmText('', 1000), true); reason.required = Boolean(record);
    return () => ({ title: name.value, ownerId: options.permissions?.canAssign ? owner.value : record?.ownerId ?? WS_CONTEXT.me.id, [kind === 'project' ? 'stageId' : 'status']: stage.value, description: description.value, nextAction: next.value, dueDate: due.value, outcome: outcome?.value || '', reason: reason.value, sourceReportId: source.value, ...(record ? { version: record.version } : {}) });
  }, async (body) => {
    await fetchJson(`${CRM_ROOT}/companies/${company.id}/${kind === 'project' ? 'projects' : 'services'}${record ? `/${record.id}` : ''}`, { method: record ? 'PUT' : 'POST', body: JSON.stringify(body) });
    notify(`${title}已保存`); await done();
  });
}
function crmFollowupEditor(company, records, options, done) {
  crmModal('记录企业跟进', '记录已经发生的联系和结果，不自动推进阶段。这里的下一步是历史记录；如需到期提醒，请另在企业档案或对应事项中更新当前下一步和计划日期。', (grid) => {
    const type = crmField(grid, '跟进方式', crmSelect(Object.entries(CRM_TYPES), 'call'));
    const occurred = crmField(grid, '实际发生日期 *', crmInput(crmDate(), 'date')); occurred.required = true; occurred.max = crmDate();
    const item = crmField(grid, '关联招商项目 / 服务事项', crmSelect(records.map((r) => [r.id, `${r.kind === 'project' ? '项目' : '服务'} · ${r.title}`]), '', '企业层面的跟进'), true);
    const content = crmField(grid, '沟通内容与实际结果 *', crmText('', 3000), true); content.required = true;
    const next = crmField(grid, '下一步安排', crmText('', 500), true);
    const due = crmField(grid, '本次记录的计划日期（不创建提醒）', crmInput('', 'date'));
    const source = crmSource(grid, options);
    return () => ({ type: type.value, occurredOn: occurred.value, recordId: item.value, content: content.value, nextAction: next.value, dueDate: due.value, sourceReportId: source.value });
  }, async (body) => {
    await fetchJson(`${CRM_ROOT}/companies/${company.id}/followups`, { method: 'POST', body: JSON.stringify(body) }); notify('跟进已留存'); await done();
  }, '保存跟进记录');
}
function crmStageEditor(options, done) {
  crmModal('招商阶段配置', '可以改名、调整顺序、新增阶段。已有标识和结果类型保持稳定，避免改变历史记录的含义。', (grid) => {
    const list = el('div', 'crm-stage-list crm-wide'); grid.append(list);
    function add(stage, existing) {
      const row = el('div', 'crm-stage-row');
      const name = crmInput(stage.label, 'text', 30); name.required = true; name.setAttribute('aria-label', '阶段名称');
      const outcome = crmSelect([['open', '推进中'], ['won', '成功落地'], ['lost', '终止']], stage.outcome); outcome.disabled = existing; outcome.setAttribute('aria-label', '阶段结果类型');
      row.crmValue = () => ({ id: stage.id, label: name.value, outcome: outcome.value });
      const actions = el('div', 'crm-inline-actions');
      actions.append(crmButton('上移', () => { if (row.previousElementSibling) list.insertBefore(row, row.previousElementSibling); }, 'quiet-button'), crmButton('下移', () => { if (row.nextElementSibling) list.insertBefore(row.nextElementSibling, row); }, 'quiet-button'));
      row.append(name, outcome, actions); list.append(row);
    }
    options.stages.forEach((stage) => add(stage, true));
    grid.append(crmButton('＋ 新增阶段', () => { if (list.children.length >= 20) return notify('最多20个阶段'); add({ id: `stage_${Date.now().toString(36)}_${list.children.length}`, label: '', outcome: 'open' }, false); }));
    return () => ({ stages: [...list.children].map((row) => row.crmValue()), previousStages: options.stages });
  }, async (body) => { await fetchJson(`${CRM_ROOT}/stages`, { method: 'PUT', body: JSON.stringify(body) }); notify('阶段配置已保存'); await done(); });
}
async function renderCompaniesLegacy(hash = location.hash) {
  app.replaceChildren(el('p', 'muted', '正在读取企业档案…'));
  const segments = hash.replace('#/companies', '').split('/').filter(Boolean);
  try {
    if (segments.length) return await crmRenderDetail(decodeURIComponent(segments[0]), segments[1] || 'overview', hash);
    const [data, options] = await Promise.all([fetchJson(CRM_ROOT), fetchJson(`${CRM_ROOT}/options`)]);
    if (location.hash !== hash) return;
    app.replaceChildren();
    const actions = el('div', 'crm-inline-actions');
    actions.append(crmButton('阶段配置', () => crmStageEditor(options, () => renderCompanies())), crmButton('＋ 新增企业', () => crmCompanyEditor(null, options, (company) => { location.hash = `#/companies/${company.id}`; }), 'primary-button'));
    app.append(pageHeading('企业管理', '以企业为中心，持续记录招商进展与服务情况。', actions));
    if (data.companies.some((c) => c.isDemo)) app.append(el('div', 'notice warning', '演示模式：带“虚构演示”标记的企业及跟进均为虚构，仅用于验证功能，不代表真实招商成果。'));
    const active = data.companies.filter((c) => !c.archived), activeIds = new Set(active.map((c) => c.id));
    const metrics = el('div', 'crm-metrics');
    metrics.append(crmMetric('维护中的企业', active.length, '不含归档'), crmMetric('推进中的项目', data.records.filter((r) => activeIds.has(r.companyId) && r.kind === 'project' && options.stages.find((s) => s.id === r.stageId)?.outcome === 'open').length, '按项目阶段统计'), crmMetric('未结服务事项', data.records.filter((r) => activeIds.has(r.companyId) && r.kind === 'service' && r.status !== 'resolved').length, '含等待与暂停'), crmMetric('需关注企业', active.filter((c) => c.risk !== 'none').length, '人工风险标记')); app.append(metrics);
    const filters = el('div', 'crm-filters');
    const search = crmInput('', 'search'); search.placeholder = '搜索企业、简称、行业或园区'; search.setAttribute('aria-label', '搜索企业');
    const owner = crmSelect(options.users.map((u) => [u.id, u.name]), '', '全部负责人'); owner.setAttribute('aria-label', '筛选负责人');
    const relation = crmSelect(Object.entries(CRM_REL), '', '全部业务关系'); relation.setAttribute('aria-label', '筛选业务关系');
    const stage = crmSelect(options.stages.map((s) => [s.id, s.label]), '', '全部招商阶段'); stage.setAttribute('aria-label', '筛选招商阶段');
    const archive = crmSelect([['active', '维护中'], ['archived', '已归档'], ['all', '全部档案']], 'active'); archive.setAttribute('aria-label', '筛选归档状态');
    filters.append(search, owner, relation, stage, archive); app.append(filters);
    const count = el('p', 'crm-result-count'), grid = el('div', 'crm-company-grid'); app.append(count, grid);
    function refresh() {
      const query = search.value.trim().toLowerCase();
      const companies = data.companies.filter((c) => (!query || [c.name, ...(c.aliases || []), c.industry, c.park].join(' ').toLowerCase().includes(query)) && (!owner.value || c.ownerId === owner.value) && (!relation.value || c.relationship === relation.value) && (!stage.value || data.records.some((r) => r.companyId === c.id && r.kind === 'project' && r.stageId === stage.value)) && (archive.value === 'all' || c.archived === (archive.value === 'archived')));
      count.textContent = `共 ${companies.length} 家企业`; grid.replaceChildren();
      if (!companies.length) grid.append(crmEmpty(data.companies.length ? '没有匹配的企业，请调整筛选条件。' : '还没有企业档案。点击“新增企业”开始维护。'));
      for (const company of companies) {
        const records = data.records.filter((r) => r.companyId === company.id);
        const card = el('a', 'crm-company-card'); card.href = `#/companies/${company.id}`;
        const top = el('div', 'crm-card-top'); top.append(el('span', 'crm-monogram', company.name.replace('示例·', '').slice(0, 1)), crmBadge(CRM_REL[company.relationship]));
        if (company.isDemo) top.append(crmBadge('虚构演示', 'demo')); if (company.archived) top.append(crmBadge('已归档'));
        card.append(top, el('h3', '', company.name), el('p', 'crm-card-sub', `${company.industry || '行业待补'} · ${company.park || '园区待定'}`), el('p', 'crm-card-summary', company.summary || '尚未维护目前情况'));
        const chips = el('div', 'crm-chips'); for (const id of new Set(records.filter((r) => r.kind === 'project').map((r) => r.stageId))) chips.append(crmBadge(crmStage(options, id), 'green'));
        if (!chips.children.length) chips.append(crmBadge('暂无招商项目'));
        if (company.risk !== 'none') chips.append(crmBadge(CRM_RISKS[company.risk], 'warning')); card.append(chips);
        const foot = el('div', 'crm-card-foot'); foot.append(el('span', '', `负责人 ${crmOwner(options, company.ownerId)}`), el('span', '', `${records.filter((r) => r.kind === 'service' && r.status !== 'resolved').length} 项服务待处理`)); card.append(foot);
        card.append(el('p', 'crm-next-line', `最近跟进 ${company.lastFollowup || '暂无记录'}`));
        card.append(el('p', 'crm-next-line', company.nextDate ? `下次跟进 ${company.nextDate}${company.nextDate < crmDate() ? ' · 计划日期已过' : ''}` : '下次跟进日期未设置')); grid.append(card);
      }
    }
    search.addEventListener('input', refresh); [owner, relation, stage, archive].forEach((control) => control.addEventListener('change', refresh)); refresh();
  } catch (error) { if (location.hash === hash) handlePageError(error); }
}
async function crmRenderDetail(id, selectedTab, hash) {
  const [data, options] = await Promise.all([fetchJson(`${CRM_ROOT}/companies/${encodeURIComponent(id)}`), fetchJson(`${CRM_ROOT}/options`)]);
  if (location.hash !== hash) return;
  const company = data.company; app.replaceChildren();
  const back = el('a', 'back', '← 企业管理'); back.href = '#/companies'; app.append(back);
  const reload = () => renderCompanies(location.hash);
  const actions = el('div', 'crm-inline-actions');
  actions.append(crmButton('编辑档案', () => crmCompanyEditor(company, options, reload)));
  if (!company.archived) actions.append(crmButton('＋ 记录跟进', () => crmFollowupEditor(company, data.records, options, reload), 'primary-button'));
  app.append(pageHeading(company.name, `${company.industry || '行业待补'} · ${company.park || '园区待定'} · 负责人 ${crmOwner(options, company.ownerId)}`, actions));
  if (company.isDemo) app.append(el('div', 'notice warning', '虚构演示档案：不代表真实企业、项目或招商成果。'));
  if (company.archived) app.append(el('div', 'notice warning', '该企业已归档，历史记录保留。需要继续跟进时，请在编辑档案中恢复为“正常维护”。'));
  const nav = el('nav', 'crm-detail-nav'); nav.setAttribute('aria-label', '企业档案栏目');
  const tabs = [['overview', '企业概况'], ['projects', '招商项目'], ['services', '服务事项'], ['timeline', '跟进时间线'], ['knowledge', '关联资料']];
  if (!tabs.some(([key]) => key === selectedTab)) selectedTab = 'overview';
  for (const [key, label] of tabs) { const a = el('a', selectedTab === key ? 'active' : '', label); a.href = `#/companies/${id}/${key}`; if (key === selectedTab) a.setAttribute('aria-current', 'page'); nav.append(a); } app.append(nav);
  const panel = el('section', 'crm-detail-panel'); app.append(panel);
  if (selectedTab === 'overview') {
    const layout = el('div', 'crm-overview');
    const main = el('section', 'panel'); main.append(el('h3', '', '目前情况'), el('p', 'crm-body-copy', company.summary || '暂无说明。请在编辑档案中记录已核实情况。'), el('p', 'muted', `人工维护 · 档案 v${company.version} · 最近活动 ${crmTime(company.updatedAt)}`));
    const badges = el('div', 'crm-chips'); badges.append(crmBadge(CRM_REL[company.relationship], 'green'), crmBadge(`经营情况：${CRM_OPERATING[company.operatingStatus]}`), crmBadge(CRM_RISKS[company.risk], company.risk === 'none' ? '' : 'warning')); main.append(badges);
    main.append(el('h3', 'crm-section-heading', '下一步与风险'), el('p', 'crm-body-copy', company.nextAction || '尚未维护下一步安排'), el('p', 'muted', `计划跟进：${company.nextDate || '未设置'}`));
    if (company.riskNote) main.append(el('p', 'notice warning', company.riskNote));
    const side = el('section', 'panel'); side.append(el('h3', '', '档案信息'));
    const info = el('dl', 'crm-definition');
    for (const [label, value] of [['常用简称', company.aliases?.join('、')], ['负责人', crmOwner(options, company.ownerId)], ['主要联系人', company.contactName], ['职务', company.contactRole], ['联系方式', company.contactPhone], ['建立时间', crmTime(company.createdAt)]]) info.append(el('dt', '', label), el('dd', '', value || '待补充'));
    side.append(info); layout.append(main, side); panel.append(layout);
    const brief = el('div', 'crm-overview-links');
    for (const [kind, label, tab] of [['project', '招商项目', 'projects'], ['service', '服务事项', 'services']]) {
      const section = el('section', 'panel'); section.append(el('h3', '', label));
      const records = data.records.filter((r) => r.kind === kind);
      for (const record of records) { const row = el('a', 'crm-brief-row'); row.href = `#/companies/${id}/${tab}`; row.append(el('span', '', record.title), crmBadge(kind === 'project' ? crmStage(options, record.stageId) : CRM_SERVICE[record.status], 'green')); section.append(row); }
      if (!records.length) section.append(el('p', 'muted', `暂无${label}`)); brief.append(section);
    } panel.append(brief);
  } else if (selectedTab === 'projects' || selectedTab === 'services') {
    const kind = selectedTab === 'projects' ? 'project' : 'service', title = kind === 'project' ? '招商项目' : '服务事项';
    panel.append(pageHeading(title, kind === 'project' ? '同一家企业可有多个项目，分别跟踪推进阶段。' : '记录诉求、处理进展和结果，与招商阶段分开维护。', company.archived ? undefined : crmButton(`＋ 新增${title}`, () => crmRecordEditor(company, kind, null, options, reload))));
    const records = data.records.filter((r) => r.kind === kind);
    if (!records.length) panel.append(crmEmpty(`暂无${title}，可从已明确的需求开始建立。`));
    for (const record of records) {
      const card = el('article', 'crm-record-card'), top = el('div', 'crm-card-top'); top.append(el('h3', '', record.title), crmBadge(kind === 'project' ? crmStage(options, record.stageId) : CRM_SERVICE[record.status], 'green'));
      if (!company.archived) top.append(crmButton('更新进展', () => crmRecordEditor(company, kind, record, options, reload), 'quiet-button')); card.append(top);
      card.append(el('p', 'crm-body-copy', record.description || '暂无背景说明'), el('p', 'muted', `负责人 ${crmOwner(options, record.ownerId)} · 计划日期 ${record.dueDate || '未设置'} · v${record.version}`));
      if (record.nextAction) card.append(el('p', 'crm-body-copy', `下一步：${record.nextAction}`)); if (record.outcome) card.append(el('p', 'notice', `处理结果：${record.outcome}`)); panel.append(card);
    }
  } else if (selectedTab === 'timeline') {
    panel.append(pageHeading('跟进时间线', '保留人工操作、阶段变更与关联来源；按实际发生日期倒序展示。'));
    for (const event of data.events) panel.append(crmEvent(event, options));
    if (!data.events.length) panel.append(crmEmpty('暂无跟进记录。'));
  } else {
    const linkAction = company.archived ? undefined : crmButton('＋ 关联知识资料', () => {
      crmModal('关联知识资料', '引用现有资料，并保存关联时的内容快照。企业状态仍在企业管理中维护。', (grid) => {
        const select = crmField(grid, '选择已启用资料 *', crmSelect(options.knowledge.filter((k) => k.active).map((k) => [k.id, `${k.title} · v${k.version}`]), '', '请选择'), true); select.required = true;
        if (!options.knowledge.some((k) => k.active)) grid.append(el('p', 'muted', '还没有启用资料，请先前往知识库创建。'));
        return () => ({ knowledgeId: select.value });
      }, async (body) => { await fetchJson(`${CRM_ROOT}/companies/${id}/knowledge`, { method: 'POST', body: JSON.stringify(body) }); notify('资料快照已关联'); await reload(); });
    });
    panel.append(pageHeading('关联资料', '企业介绍、园区材料等保留在知识库；按当前权限查看资料，管理员可审计关联时快照。', linkAction));
    const go = el('a', 'back', '前往知识库维护资料 →'); go.href = '#/knowledge'; panel.append(go);
    for (const link of data.links) {
      const entry = JSON.parse(link.snapshot_json), current = link.content_view === 'current', card = el('article', 'crm-record-card'); card.append(el('h3', '', entry.title), el('p', 'muted', `${current ? '当前授权内容' : '关联快照'} v${entry.version} · ${crmTime(link.created_at)}${!current && link.current_version !== entry.version ? ` · 知识库已更新为 v${link.current_version}，可重新关联` : ''}${!link.current_active ? ' · 当前资料已停用' : ''}`));
      const detail = el('details', 'crm-evidence'); detail.append(el('summary', '', current ? '查看当前资料内容' : '查看关联时的资料内容'), el('p', 'crm-body-copy', entry.content || entry.summary)); card.append(detail); panel.append(card);
    }
    if (!data.links.length) panel.append(crmEmpty('尚未关联资料。关联不会复制一份企业状态到知识库。'));
  }
}
function crmDisplay(key, value, options) {
  if (key === 'ownerId') return crmOwner(options, value);
  if (key === 'collaboratorIds') return Array.isArray(value) && value.length ? value.map((id)=>crmOwner(options,id)).join('、') : '未设置';
  if (key === 'stageId') return crmStage(options, value);
  if (key === 'relationship') return CRM_REL[value]; if (key === 'operatingStatus') return CRM_OPERATING[value];
  if (key === 'status') return CRM_SERVICE[value]; if (key === 'risk') return CRM_RISKS[value];
  if (key === 'archived') return value ? '已归档' : '正常维护';
  return Array.isArray(value) ? value.join('、') || '未填写' : value || '未填写';
}
function crmEvent(event, options) {
  const details = JSON.parse(event.details_json), card = el('article', 'crm-timeline-event');
  const top = el('div', 'crm-card-top'); top.append(crmBadge(CRM_EVENT_LABELS[event.kind] || '操作记录'), el('span', 'muted', `${event.occurred_on} · ${event.actor_name || (event.actor_id === 'demo-system' ? '演示系统' : '后台管理员')}`)); card.append(top, el('p', 'crm-body-copy', event.content));
  if (details.type) card.append(el('p', 'muted', `方式：${CRM_TYPES[details.type] || details.type}`));
  if (details.nextAction) card.append(el('p', 'crm-body-copy', `下一步：${details.nextAction}${details.dueDate ? ` · ${details.dueDate}` : ''}`));
  if (details.before && details.after) {
    const changes = el('div', 'crm-changes');
    for (const [key, value] of Object.entries(details.after)) if (JSON.stringify(details.before[key]) !== JSON.stringify(value)) changes.append(el('p', '', `${CRM_FIELDS[key] || key}：${key === 'stageId' && details.stageBefore ? details.stageBefore : crmDisplay(key, details.before[key], options)} → ${key === 'stageId' && details.stageAfter ? details.stageAfter : crmDisplay(key, value, options)}`));
    card.append(changes);
  }
  if (!details.before && details.after) {
    const snapshot = el('details', 'crm-evidence'); snapshot.append(el('summary', '', '查看建立时的记录'));
    for (const [key, value] of Object.entries(details.after)) if (value !== '' && (!Array.isArray(value) || value.length)) snapshot.append(el('p', 'crm-body-copy', `${CRM_FIELDS[key] || key}：${key === 'stageId' && details.stageAfter ? details.stageAfter : crmDisplay(key, value, options)}`));
    card.append(snapshot);
  }
  if (event.source_report_id) {
    const source = el('details', 'crm-evidence'); source.append(el('summary', '', `关联日报来源 · ${event.source_report_date || ''}`), el('p', 'crm-body-copy', event.source_summary || '来源引用已留存，可在日报记录中核查。')); card.append(source);
  }
  if (details.snapshot) { const source = el('details', 'crm-evidence'); source.append(el('summary', '', `历史资料快照 · v${details.snapshot.version}`), el('p', 'crm-body-copy', details.snapshot.content)); card.append(source); }
  card.append(el('p', 'crm-event-time', `记录时间 ${crmTime(event.created_at)}`)); return card;
}
