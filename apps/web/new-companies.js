(() => {
  let rows=[];
  async function load() {
    if(Array.isArray(window.NEW_COMPANY_STATIC_ROWS))return window.NEW_COMPANY_STATIC_ROWS;
    return (await fetchJson('/api/v1/new-companies')).rows || [];
  }
  async function show(name,button) {
    try {
      rows=await load();
      const record=rows.find(row=>row['企业名称']===name);
      if(!record) { button.replaceWith(document.createTextNode(name)); return; }
      const dialog=document.createElement('dialog');dialog.className='nc-dialog';
      const title=document.createElement('h2');title.textContent='企业信息';
      const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close();
      const header=document.createElement('header');header.append(title,close);dialog.append(header);
      const contact=document.createElement('p');contact.className='nc-contact';
      contact.textContent=[record['拜访员工']&&('跟进人：'+record['拜访员工']),record['拜访日期']&&('最近拜访：'+record['拜访日期'])].filter(Boolean).join(' · ');dialog.append(contact);
      function section(labelText,valueText) {
        const block=document.createElement('section');block.className='nc-prose';
        const label=document.createElement('h3');label.textContent=labelText;
        const value=document.createElement('p');value.textContent=valueText;
        block.append(label,value);dialog.append(block);
      }
      const sentence=parts=>parts.filter(Boolean).map(x=>String(x).trim().replace(/[。；;]+$/,'')).join('。')+'。';
      section('企业情况',sentence([name,record['所属行业']&&('所属行业为'+record['所属行业']),record['主营业务'],record['员工规模']&&('员工规模'+record['员工规模']),record['注册资本']&&('注册资本'+record['注册资本']),record['法定代表人']&&('法定代表人为'+record['法定代表人']),record['注册地址']?('注册地址为'+record['注册地址']):record['所在地']&&('位于'+record['所在地'])]));
      const needs=[record['需求及跟进'],record['意向区域']&&('意向区域为'+record['意向区域']),record['用房需求']&&('用房需求为'+record['用房需求']),record['预计落地时间']&&('预计落地时间为'+record['预计落地时间']),record['跟进阶段']&&('当前处于'+record['跟进阶段'])];
      section('企业需求',needs.some(Boolean)?sentence(needs):'尚未明确具体需求。');
      section('下一步安排',record['下一步安排']||'尚未明确后续安排。');
      dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
    } catch { if(typeof notify==='function')notify('企业信息暂时无法读取，请稍后再试。'); }
  }
  function decorate() {
    const root=document.querySelector('.rp-manager-report');if(!root||!rows.length)return;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const texts=[];
    while(walker.nextNode()) {const n=walker.currentNode;if(!n.parentElement.closest('button,a,.rp-employee-name,style,script')&&n.parentElement.closest('.rp-business-copy'))texts.push(n);}
    const ordered=rows.flatMap(row=>{const name=row['企业名称'];return [...new Set([name,name.replace(/有限公司$/,'')])].filter(n=>n.length>=4).map(label=>({name:label,recordName:name}));});
    for(const text of texts) {
      let value=text.textContent;const fragment=document.createDocumentFragment();let changed=false;
      while(value) {
        const matches=ordered.map(row=>({...row,index:value.indexOf(row.name)})).filter(x=>x.name&&x.index>=0).sort((a,b)=>a.index-b.index||b.name.length-a.name.length);
        if(!matches.length){fragment.append(document.createTextNode(value));break;}
        const match=matches[0];fragment.append(document.createTextNode(value.slice(0,match.index)));
        const button=document.createElement('button');button.className='nc-link';button.textContent=match.name;button.onclick=event=>{event.stopPropagation();void show(match.recordName,button);};fragment.append(button);value=value.slice(match.index+match.name.length);changed=true;
      }
      if(changed)text.replaceWith(fragment);
    }
  }
  let timer;
  const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(decorate,80);});
  observer.observe(document.getElementById('app'),{childList:true,subtree:true});
  const refresh=async()=>{try{rows=await load();decorate();}catch{}};
  window.addEventListener('hashchange',()=>setTimeout(refresh,800));
  setTimeout(refresh,1000);
})();
