/* ============================================================================
 *  app.js ― 保守ナレッジ閲覧ツール 本体スクリプト
 * ----------------------------------------------------------------------------
 *  役割 : SQLiteデータベース(incident_db.sqlite)をブラウザ内で読み込み、
 *         検索・絞り込み・一覧/詳細表示を行う。
 *  依存 : sql-wasm.js / sql-wasm.wasm (SQLiteをブラウザ内で動かすエンジン)
 *         ※ このファイルは index.html の末尾で sql-wasm.js の後に読み込むこと。
 *  データ送信 : 一切なし。全処理は利用者の端末のブラウザ内で完結する。
 * ========================================================================== */

/* ---- グローバル状態 ------------------------------------------------------- */
let db=null;        // 読み込んだSQLiteデータベース(sql.jsのDatabaseインスタンス)
let SQLlib=null;    // sql.jsエンジン本体(初回のみ初期化)

/* ---- 小さなヘルパー ------------------------------------------------------- */
// id からDOM要素を取得する短縮関数
const $=id=>document.getElementById(id);

// HTMLエスケープ。DB由来の文字列をそのまま画面に出す前に必ず通す(XSS対策)
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// 検索語(kw)を <mark> で強調表示する。エスケープしてから語で分割・連結するので安全。
function hi(text,kw){
  if(text==null) return '';
  if(!kw) return esc(text);
  return String(text).split(kw).map(esc).join('<mark>'+esc(kw)+'</mark>');
}

// 設備稼働状況の文字列から重大度(色分けクラス)を判定する。
//   sev-crit(赤)=監視/制御不可など  sev-warn(橙)=手動運転など  sev-ok(緑)=通常稼働
//   label は先頭行のみ(元データは改行を含む場合があるため)
function severity(s){
  if(!s) return {cls:'sev-neutral',label:'—'};
  const t=s.replace(/\s/g,'');
  if(/(監視不可|監視操作不可|監視制御不可|制御不可|運転不能|運用離脱|ボイラ停止|^停止|運転停止)/.test(t)) return {cls:'sev-crit',label:s.split('\n')[0]};
  if(/(手動|仮復旧|支障|渋滞|片系)/.test(t)) return {cls:'sev-warn',label:s.split('\n')[0]};
  if(/(運転継続|通常稼働|通常運用|運転稼働|稼働中|運用中)/.test(t)) return {cls:'sev-ok',label:s.split('\n')[0]};
  return {cls:'sev-neutral',label:s.split('\n')[0]};
}

// incidents テーブルから取得する列。SELECT と表示で共通利用する。
const COLS=['id','item_no','response_date','equipment_type','model_number','model_name',
  'series_name','failure_type','defect_name','situation','operation_status','investigation_result','remarks'];

// SQLを実行して結果を配列(オブジェクトの配列)で返す共通関数。
// params を渡すとプレースホルダ($like等)に安全にバインドする。
function query(sql,params){
  const st=db.prepare(sql); if(params) st.bind(params);
  const out=[]; while(st.step()) out.push(st.getAsObject()); st.free(); return out;
}

/* ---- データベースの読み込み ---------------------------------------------- */
// sql.jsエンジンを初回だけ初期化する。wasmは同ディレクトリ(./)から読み込む。
async function ensureEngine(){
  if(!SQLlib){
    $('statusText').textContent='エンジン読込中…';
    SQLlib=await initSqlJs({locateFile:f=>'./'+f});
  }
}

// バイト列(ArrayBuffer)からDBを開く。incidents テーブルの有無で妥当性を確認。
async function loadBuffer(buf,name){
  $('err').textContent='';
  try{
    await ensureEngine();
    db=new SQLlib.Database(new Uint8Array(buf));
    query("SELECT 1 FROM incidents LIMIT 1"); // テーブル存在チェック(無ければcatchへ)
    onLoaded(name);
  }catch(e){
    $('err').textContent='読み込めませんでした: '+(e.message||e)+'  （incidents テーブルを含むSQLiteファイルか確認してください）';
    $('statusText').textContent='DB未読込';
  }
}

// <input type=file> や ドラッグ&ドロップで選ばれたファイルを読み込む。
async function loadFile(file){ await loadBuffer(await file.arrayBuffer(), file.name); }

// 同ディレクトリの incident_db.sqlite を自動取得(http/https配信時に成功)。
// file:// で開いた場合などは失敗するので、手動選択オーバーレイを表示する。
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

/* ---- 読み込み完了後の初期化 ---------------------------------------------- */
// 指定列の重複しない値を絞り込み用プルダウン(select)に流し込む。
function fillSelect(sel,col){
  const rows=query(`SELECT DISTINCT ${col} v FROM incidents WHERE ${col} IS NOT NULL ORDER BY ${col}`);
  sel.innerHTML='<option value="">すべて</option>'+rows.map(r=>`<option>${esc(r.v)}</option>`).join('');
}

// DB読み込み完了時に一度だけ呼ぶ。プルダウン生成→件数表示→初回検索。
function onLoaded(name){
  $('overlay').style.display='none';
  $('dot').classList.add('live');
  fillSelect($('eq'),'equipment_type'); // 機種名
  fillSelect($('ft'),'failure_type');   // 故障種別
  const total=query("SELECT COUNT(*) c FROM incidents")[0].c;
  $('statusText').textContent=`${esc(name)} ・ 全${total}件`;
  search();
  if(typeof recoBuild==='function') recoBuild(); // 類似事例相談(recommender.js)の索引を作成
}

/* ---- 検索(絞り込み条件からSQLを組み立てて実行) -------------------------- */
function search(){
  if(!db) return;
  const kw=$('kw').value.trim();
  const cond=[], p={};
  // キーワード: 主要な文字列列を横断してLIKE部分一致(2文字以下の語も対象)
  if(kw){
    p.$like='%'+kw+'%';
    cond.push(`(defect_name LIKE $like OR situation LIKE $like OR investigation_result LIKE $like
      OR remarks LIKE $like OR equipment_type LIKE $like OR model_number LIKE $like OR model_name LIKE $like
      OR series_name LIKE $like OR failure_type LIKE $like)`);
  }
  // 機種名・故障種別・対応日(期間)での絞り込み(選択された条件のみ追加)
  if($('eq').value){cond.push('equipment_type = $eq'); p.$eq=$('eq').value;}
  if($('ft').value){cond.push('failure_type = $ft'); p.$ft=$('ft').value;}
  if($('from').value){cond.push('response_date >= $from'); p.$from=$('from').value;}
  if($('to').value){cond.push('response_date <= $to'); p.$to=$('to').value;}
  const where=cond.length?'WHERE '+cond.join(' AND '):'';
  // 対応日の新しい順に並べて取得
  const rows=query(`SELECT ${COLS.join(',')} FROM incidents ${where}
    ORDER BY response_date DESC, item_no DESC`,p);
  render(rows,kw);
  // 絞り込み中はハンバーガーに印(ドット)、スマホの「結果を見る」に件数を反映
  const active=$('kw').value||$('eq').value||$('ft').value||$('from').value||$('to').value;
  $('menuBtn').classList.toggle('active',!!active);
  $('drawerApply').textContent=`結果を見る（${rows.length}件）`;
}

/* ---- 一覧の描画 ----------------------------------------------------------- */
// PC/タブレットでは表、スマホではCSSでカード表示に切り替わる(styles.css参照)。
function render(rows,kw){
  $('resultCount').textContent=`${rows.length} 件`;
  const tb=$('rows');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="5" style="padding:26px;color:var(--muted)">該当するインシデントはありません。条件を変えてお試しください。</td></tr>`; setDetail(null); return; }
  // 各行のHTMLを生成(td のクラスはスマホ時のカード配置にも使用)
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
  // 行タップで選択状態にして詳細を表示。スマホでは詳細を全画面スライド表示。
  Array.from(tb.children).forEach(tr=>{
    tr.onclick=()=>{
      Array.from(tb.children).forEach(x=>x.classList.remove('sel'));
      tr.classList.add('sel');
      setDetail(rows[+tr.dataset.i],kw);
      if(mq.matches) $('detailPanel').classList.add('open');
    };
  });
  // PC/タブレットは先頭行を自動選択。スマホは一覧優先で詳細は閉じておく。
  if(!mq.matches){ setDetail(rows[0],kw); tb.firstElementChild.classList.add('sel'); }
  else setDetail(null);
}

/* ---- 詳細パネルの描画 ----------------------------------------------------- */
// 短い項目用セル(2列グリッド)
function cell(k,v,kw){ return `<div class="d-cell"><div class="k">${k}</div><div class="v">${v?hi(v,kw):'—'}</div></div>`; }
// 長文用ブロック(値が無ければ何も描かない)
function block(k,v,kw){ if(!v) return ''; return `<div class="d-block"><div class="k">${k}</div><div class="v">${hi(v,kw)}</div></div>`; }

// 選択された1件の全項目を詳細パネルに表示する。r が null なら案内文を表示。
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

/* ---- イベント登録 --------------------------------------------------------- */
// mq: 画面幅720px以下(スマホ)判定。レイアウト分岐に使用。
const mq=window.matchMedia('(max-width:720px)');
const toolbar=$('toolbar');

// スマホ時の検索ドロワー(右からスライド)の開閉
function openDrawer(){ toolbar.classList.add('open'); $('backdrop').classList.add('show'); }
function closeDrawer(){ toolbar.classList.remove('open'); $('backdrop').classList.remove('show'); }
$('menuBtn').onclick=openDrawer;      // ハンバーガー(≡)で開く
$('drawerClose').onclick=closeDrawer; // ドロワー内の×で閉じる
$('drawerApply').onclick=closeDrawer; // 「結果を見る」で閉じる
$('backdrop').onclick=closeDrawer;    // 背景タップで閉じる
$('detailBack').onclick=()=>$('detailPanel').classList.remove('open'); // スマホ詳細の戻る

// 手動ファイル選択(自動読込に失敗した場合のフォールバック)
$('openBtn').onclick=$('openBtn2').onclick=()=>$('fileInput').click();
$('fileInput').onchange=e=>{ if(e.target.files[0]) loadFile(e.target.files[0]); };

// 各絞り込み入力の変更で即検索
['kw','eq','ft','from','to'].forEach(id=>{ const el=$(id); el.oninput=search; el.onchange=search; });
$('clearBtn').onclick=()=>{ ['kw','eq','ft','from','to'].forEach(id=>$(id).value=''); search(); };

// オーバーレイへのドラッグ&ドロップでDBを読み込む
const drop=$('drop');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) loadFile(f); });

/* ---- 起動 ----------------------------------------------------------------- */
autoLoad(); // ページ表示時に同ディレクトリのDBを自動読み込み
