const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const {chromium}=createRequire(path.resolve(process.env.WORKSPACE_NODE_MODULES,'../package.json'))('playwright');
(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const errors=[];fs.mkdirSync('.tmp',{recursive:true});
 for(const width of [320,390,1440]){
  const page=await browser.newPage({viewport:{width,height:844}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('templates/approved/manager-weekly.html')).href);
  const cards=page.locator('.rp-task-selector>.rp-select-card');assert.equal(await cards.count(),5);
  const headings=await cards.locator('.rp-card-heading>span').allTextContents();
  assert.deepEqual(headings,['重点企业完成进度','培训与活动','企业服务与对接','综合事务','其他工作']);
  const boxes=await cards.evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width}}));
  assert(boxes[0].w>boxes[1].w*1.8);assert.equal(boxes[1].y,boxes[2].y);assert.equal(boxes[3].y,boxes[4].y);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(width===390)await page.screenshot({path:'.tmp/approved-manager-390.png',fullPage:false});
  await page.locator('.rp-employee-name:visible').first().click();
  await page.locator('.sn-back:visible').click();assert(await page.locator('#app').isVisible());
  await page.locator('.sn-item-link:visible').first().click();
  assert.equal(await page.locator('dialog[open]').count(),1);
  if(width===390)await page.screenshot({path:'.tmp/approved-dialog-390.png'});
  await page.close();
 }
 const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.resolve('templates/approved/employee-weekly.html')).href);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'.tmp/approved-employee-390.png',fullPage:false});
 await page.locator('.mw-back').click();assert(page.url().endsWith('/manager-weekly.html'));
 // Render the shipped dynamic functions against synthetic facts, without a real API or identity.
 const dynamic=await browser.newPage({viewport:{width:390,height:844}});dynamic.on('pageerror',e=>errors.push(e.message));
 await dynamic.setContent('<body class="mobile-weekly"><main id="app" class="mobile-weekly-content"></main><div id="toast"></div></body>');
 for(const file of ['style.css','crm.css','workspace.css','review-design.css','weekly-mobile.css'])await dynamic.addStyleTag({content:fs.readFileSync('apps/web/'+file,'utf8')});
 for(const file of ['crm.js','workspace.js','reporting.js','app.js']){
  let code=fs.readFileSync('apps/web/'+file,'utf8');if(file==='app.js')code=code.replace(/route\(\);\s*$/,'');await dynamic.addScriptTag({content:code});
 }
 await dynamic.evaluate(()=>{
  WS_SESSION={userId:'lead'};
  const items=['企业走访','开展活动','梳理合同','综合事务','其他工作'].map((name,i)=>({workItemId:String(i),name,metric:{mode:'count',total:5,unit:'项'},days:[{date:'2026-08-31',completedCount:3,progressValue:60,progressText:'已完成资料整理，后续沟通正在安排。'}]}));
  app.replaceChildren(rpManagerReport([{userId:'example',name:'示例员工',progress:{items}}],'2026-08-31'));
 });
 assert.equal(await dynamic.locator('.rp-task-selector>.rp-select-card').count(),5);
 assert(await dynamic.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await dynamic.screenshot({path:'.tmp/dynamic-manager-390.png',fullPage:false});
 await browser.close();assert.deepEqual(errors,[]);console.log('Approved templates: five cards, 1+2+2 layout, navigation, item dialog, 320/390/1440 fit passed');
})().catch(e=>{console.error(e);process.exitCode=1});
