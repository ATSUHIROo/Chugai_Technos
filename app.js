let db=null, SQLlib=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function hi(text,kw){
  if(text==null) return '';
  if(!kw) return esc(text);
  return String(text).split(kw).map(esc).join('<mark>'+esc(kw)+'</mark>');
}
function severity(s){
  if(!s) return {cls:'sev-neutral',label:'—'};
  const t=s.replace(/\s/g,'');
  if(/(監視不可|監視操作不可|監視制御不可|制御不可|運転不能|運用離脱|ボイラ停止|^停止|運転停止)/.test(t)) return {cls:'sev-crit',label:s.split('\n')[0]};
  if(/(手動|仮復旧|支障|渋滞|片系)/.test(t)) return {cls:'sev-warn',label:s.split('\n')[0]};
  if(/(運転継続|通常稼働|通常運用|運転稼働|稼働中|運用中)/.test(t)) return {cls:'sev-ok',label:s.split('\n')[0]};
  return {cls:'sev-neutral',label:s.split('\n')[0]};
}
const COLS=['id','item_no','response_date','equipment_type','model_number','model_name',
  'series_name','failure_type','defect_name','situation','operation_status','investigation_result','remarks'];

function query(sql,params){
  const st=db.prepare(sql); if(params) st.bind(params);
  const out=[]; while(st.step()) out.push(st.getAsObject()); st.free(); return out;
}

async function ensureEngine(){
  if(!SQLlib){
    $('statusText').textContent='エンジン読込中…';
    SQLlib=await initSqlJs({locateFile:f=>'./'+f});
  }
}
async function loadBuffer(buf,name){
  $('err').textContent='';
  try{
    await ensureEngine();
    db=new SQLlib.Database(new Uint8Array(buf));
    query("SELECT 1 FROM incidents LIMIT 1");
    onLoaded(name);
  }catch(e){
    $('err').textContent='読み込めませんでした: '+(e.message||e)+'  （incidents テーブルを含むSQLiteファイルか確認してください）';
    $('statusText').textContent='DB未読込';
  }
}
async function loadFile(file){ await loadBuffer(await file.arrayBuffer(), file.name); }

async function autoLoad(){
  try{
    const resp=await fetch('incident_db.sqlite',{cache:'no-store'});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    await loadBuffer(await resp.arrayBuffer(),'incident_db.sqlite');
  }catch(e){
    $('overlay').style.display='flex';
    $('autoNote').textContent='同ディレクトリのDBを自動取得できませんでした。ファイルを選択してください。';
  }
}

function fillSelect(sel,col){
  const rows=query(`SELECT DISTINCT ${col} v FROM incidents WHERE ${col} IS NOT NULL ORDER BY ${col}`);
  sel.innerHTML='<option value="">すべて</option>'+rows.map(r=>`<option>${esc(r.v)}</option>`).join('');
}

function onLoaded(name){
  $('overlay').style.display='none';
  $('dot').classList.add('live');
  fillSelect($('eq'),'equipment_type');
  fillSelect($('ft'),'failure_type');
  const total=query("SELECT COUNT(*) c FROM incidents")[0].c;
  $('statusText').textContent=`${esc(name)} ・ 全${total}件`;
  search();
}

function search(){
  if(!db) return;
  const kw=$('kw').value.trim();
  const cond=[], p={};
  if(kw){
    p.$like='%'+kw+'%';
    cond.push(`(defect_name LIKE $like OR situation LIKE $like OR investigation_result LIKE $like
      OR remarks LIKE $like OR equipment_type LIKE $like OR model_number LIKE $like OR model_name LIKE $like
      OR series_name LIKE $like OR failure_type LIKE $like)`);
  }
  if($('eq').value){cond.push('equipment_type = $eq'); p.$eq=$('eq').value;}
  if($('ft').value){cond.push('failure_type = $ft'); p.$ft=$('ft').value;}
  if($('from').value){cond.push('response_date >= $from'); p.$from=$('from').value;}
  if($('to').value){cond.push('response_date <= $to'); p.$to=$('to').value;}
  const where=cond.length?'WHERE '+cond.join(' AND '):'';
  const rows=query(`SELECT ${COLS.join(',')} FROM incidents ${where}
    ORDER BY response_date DESC, item_no DESC`,p);
  render(rows,kw);
  const active=$('kw').value||$('eq').value||$('ft').value||$('from').value||$('to').value;
  $('menuBtn').classList.toggle('active',!!active);
  $('drawerApply').textContent=`結果を見る（${rows.length}件）`;
}

function render(rows,kw){
  $('resultCount').textContent=`${rows.length} 件`;
  const tb=$('rows');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="5" style="padding:26px;color:var(--muted)">該当するインシデントはありません。条件を変えてお試しください。</td></tr>`; setDetail(null); return; }
  tb.innerHTML=rows.map((r,i)=>{
    const sv=severity(r.operation_status);
    return `<tr data-i="${i}">
      <td class="c-date">${esc(r.response_date||'')}</td>
      <td class="c-eq">${hi(r.equipment_type||'—',kw)}${r.model_number?`<div class="sub">${hi(r.model_number,kw)}</div>`:''}</td>
      <td class="c-failure">${hi(r.failure_type||'—',kw)}</td>
      <td class="c-defect">${hi(r.defect_name||'—',kw)}</td>
      <td class="c-status"><span class="badge ${sv.cls}">${esc(sv.label)}</span></td>
    </tr>`;
  }).join('');
  Array.from(tb.children).forEach(tr=>{
    tr.onclick=()=>{
      Array.from(tb.children).forEach(x=>x.classList.remove('sel'));
      tr.classList.add('sel');
      setDetail(rows[+tr.dataset.i],kw);
      if(mq.matches) $('detailPanel').classList.add('open');
    };
  });
  if(!mq.matches){ setDetail(rows[0],kw); tb.firstElementChild.classList.add('sel'); }
  else setDetail(null);
}

function cell(k,v,kw){ return `<div class="d-cell"><div class="k">${k}</div><div class="v">${v?hi(v,kw):'—'}</div></div>`; }
function block(k,v,kw){ if(!v) return ''; return `<div class="d-block"><div class="k">${k}</div><div class="v">${hi(v,kw)}</div></div>`; }

function setDetail(r,kw){
  const d=$('detail');
  if(!r){ d.innerHTML='<div class="hint">一覧から行を選択すると、調査結果・備考を含む全項目を表示します。</div>'; return; }
  const sv=severity(r.operation_status);
  d.innerHTML=`
    <div class="d-top">
      <span class="badge ${sv.cls}">${esc(r.operation_status?r.operation_status.split('\n')[0]:'—')}</span>
      <span class="id">項目 #${esc(r.item_no??'')} ・ ${esc(r.response_date||'')}</span>
    </div>
    <div class="d-grid">
      ${cell('機種名',r.equipment_type,kw)}
      ${cell('故障種別',r.failure_type,kw)}
      ${cell('型式',r.model_number,kw)}
      ${cell('モデル名',r.model_name,kw)}
      ${cell('シリーズ名',r.series_name,kw)}
      ${cell('設備稼働状況',r.operation_status,kw)}
    </div>
    ${block('不良内容名',r.defect_name,kw)}
    ${block('状況',r.situation,kw)}
    ${block('調査結果',r.investigation_result,kw)}
    ${block('備考',r.remarks,kw)}
  `;
}

// events
const mq=window.matchMedia('(max-width:720px)');
const toolbar=$('toolbar');
function openDrawer(){ toolbar.classList.add('open'); $('backdrop').classList.add('show'); }
function closeDrawer(){ toolbar.classList.remove('open'); $('backdrop').classList.remove('show'); }
$('menuBtn').onclick=openDrawer;
$('drawerClose').onclick=closeDrawer;
$('drawerApply').onclick=closeDrawer;
$('backdrop').onclick=closeDrawer;
$('detailBack').onclick=()=>$('detailPanel').classList.remove('open');

$('openBtn').onclick=$('openBtn2').onclick=()=>$('fileInput').click();
$('fileInput').onchange=e=>{ if(e.target.files[0]) loadFile(e.target.files[0]); };
['kw','eq','ft','from','to'].forEach(id=>{ const el=$(id); el.oninput=search; el.onchange=search; });
$('clearBtn').onclick=()=>{ ['kw','eq','ft','from','to'].forEach(id=>$(id).value=''); search(); };

const drop=$('drop');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) loadFile(f); });

autoLoad();
