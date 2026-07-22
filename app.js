/* ============================================================================
 *  app.js ― 保守ナレッジ閲覧ツール 本体スクリプト
 * ----------------------------------------------------------------------------
 *  役割 : SQLiteデータベース(incident_db.sqlite)をブラウザ内で読み込み、
 *         検索・絞り込み・一覧/詳細表示を行う。
 *  依存 : sql-wasm.js / sql-wasm.wasm (SQLiteをブラウザ内で動かすエンジン)
 *         ※ index.html では sql-wasm.js → app.js → recommender.js の順で読み込む。
 *  データ送信 : 一切なし。全処理は利用者の端末のブラウザ内で完結する。
 *
 *  ★起動方法と読み込み経路:
 *    (1) サーバー経由(GitHub Pages / VS CodeのLive Server / 同梱のserve.py)
 *        → incident_db.sqlite と sql-wasm.wasm を fetch で読み込む(通常経路)。
 *    (2) index.html をダブルクリックで直接開く(file://)
 *        → ブラウザの制限で fetch が使えないため、同梱の base64 データ
 *          (sql-wasm-base64.js / incident_db_base64.js)を <script> で読み込んで動作する。
 *        ※ incident_db.sqlite を差し替えた場合は make_offline_data.py を実行して
 *          incident_db_base64.js を作り直すこと(file:// 用のデータが古いままになるため)。
 * ========================================================================== */

/* ============================ グローバル状態 ============================== */
let db=null;        // 読み込んだSQLiteデータベース(sql.jsのDatabaseインスタンス)。未読込はnull
let SQLlib=null;    // sql.jsエンジン本体。initSqlJs()の結果を初回だけ保持
let currentRows=[]; // いま一覧に表示中の行の配列。チャットからの選択を一覧へ同期する際に参照

/* ============================ 汎用ヘルパー ================================ */

/**
 * id からDOM要素を取得する短縮関数。
 * @param {string} id  取得したい要素のid属性(index.html内で定義)
 * @returns {HTMLElement|null}
 */
const $=id=>document.getElementById(id);

/**
 * 文字列をHTMLエスケープする。DB由来の文字列を画面に出す前に必ず通す(XSS対策)。
 * @param {*} s  エスケープ対象(DBの各列の値など。null/数値も可)
 * @returns {string} エスケープ済み文字列
 */
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/**
 * 検索語を <mark> で強調表示する。エスケープしてから語で分割・連結するので安全。
 * @param {*} text     表示する元テキスト(DBの列の値)
 * @param {string} kw  強調したい検索語(検索欄 #kw の値。空なら強調なし)
 * @returns {string} 強調タグ入りのHTML文字列
 */
function hi(text,kw){
  if(text==null) return '';
  if(!kw) return esc(text);
  return String(text).split(kw).map(esc).join('<mark>'+esc(kw)+'</mark>');
}

/**
 * 設備稼働状況の文字列から重大度(色分けクラス)を判定する。
 * @param {string} s  incidents.operation_status の値(改行を含む場合あり)
 * @returns {{cls:string,label:string}} cls=CSSクラス(sev-crit/warn/ok/neutral)、label=先頭行の文言
 */
function severity(s){
  if(!s) return {cls:'sev-neutral',label:'—'};
  const t=s.replace(/\s/g,'');
  if(/(監視不可|監視操作不可|監視制御不可|制御不可|運転不能|運用離脱|ボイラ停止|^停止|運転停止)/.test(t)) return {cls:'sev-crit',label:s.split('\n')[0]};
  if(/(手動|仮復旧|支障|渋滞|片系)/.test(t)) return {cls:'sev-warn',label:s.split('\n')[0]};
  if(/(運転継続|通常稼働|通常運用|運転稼働|稼働中|運用中)/.test(t)) return {cls:'sev-ok',label:s.split('\n')[0]};
  return {cls:'sev-neutral',label:s.split('\n')[0]};
}

/** incidents テーブルから取得する列。SELECT と表示・詳細で共通利用する。 */
const COLS=['id','item_no','response_date','equipment_type','model_number','model_name',
  'series_name','failure_type','defect_name','situation','operation_status','investigation_result','remarks'];

/**
 * SQLを実行し、結果を「列名→値のオブジェクト」の配列で返す共通関数。
 * @param {string} sql     実行するSQL(プレースホルダ $name を含められる)
 * @param {Object} [params] $name にバインドする値の連想配列(例 {$like:'%x%'})
 * @returns {Object[]} 各行のオブジェクト配列
 * 参照グローバル: db
 */
function query(sql,params){
  const st=db.prepare(sql); if(params) st.bind(params);
  const out=[]; while(st.step()) out.push(st.getAsObject()); st.free(); return out;
}

/* ============================ DBの読み込み ================================ */

/**
 * いま file:// で開かれているか(＝ローカルでHTMLを直接開いた状態か)。
 * true の場合、ブラウザの制限で fetch が使えないため、同梱のbase64データを使う経路に切り替える。
 * @type {boolean}
 */
const IS_FILE = location.protocol==='file:';

/**
 * JSファイルを動的に読み込む。file:// では fetch が禁止される一方、
 * <script> による読み込みは許可されるため、オフライン用データの取得に使う。
 * @param {string} src  読み込むJSのパス(例 'sql-wasm-base64.js')
 * @returns {Promise<void>} 読み込み完了で解決、失敗で reject
 * 副作用: <head> に script 要素を追加
 */
function loadScript(src){
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src=src;
    s.onload=()=>resolve();
    s.onerror=()=>reject(new Error(src+' を読み込めませんでした'));
    document.head.appendChild(s);
  });
}

/**
 * base64文字列をバイト列に復元する。
 * @param {string} b64  base64文字列(sql-wasm-base64.js / incident_db_base64.js の中身)
 * @returns {Uint8Array} 復元したバイト列
 */
function b64ToBytes(b64){
  const bin=atob(b64), n=bin.length, a=new Uint8Array(n);
  for(let i=0;i<n;i++) a[i]=bin.charCodeAt(i);
  return a;
}

/**
 * 読み込みオーバーレイを表示し、見出し・案内文を差し替える。
 * @param {string} note    #autoNote に表示する案内文(状況に応じたメッセージ)
 * @param {string} [title] #overlayTitle に表示する見出し(省略時は変更しない)
 * @returns {void}
 * 副作用: #overlay を表示、#autoNote(と指定時#overlayTitle)を更新
 */
function showOverlay(note,title){
  $('overlay').style.display='flex';
  if(note) $('autoNote').textContent=note;
  if(title && $('overlayTitle')) $('overlayTitle').textContent=title;
}

/**
 * sql.jsエンジンを初回だけ初期化する。
 * @returns {Promise<void>}
 * 参照グローバル: SQLlib(未初期化なら生成), initSqlJs(sql-wasm.js が定義), IS_FILE
 * 動作環境による分岐:
 *   - http/https : locateFile で同ディレクトリの sql-wasm.wasm を取得(通常経路)
 *   - file://    : wasmはfetchできないため、sql-wasm-base64.js を読み込み
 *                  wasmBinary として直接渡す(これが無いとファイル選択も失敗する)
 * 副作用: #statusText を更新
 */
async function ensureEngine(){
  if(SQLlib) return;
  $('statusText').textContent='エンジン読込中…';
  if(IS_FILE){
    // オフライン(ダブルクリック)起動: 同梱のbase64からwasmを復元して渡す
    if(typeof SQL_WASM_BASE64==='undefined') await loadScript('sql-wasm-base64.js');
    SQLlib=await initSqlJs({wasmBinary:b64ToBytes(SQL_WASM_BASE64)});
  }else{
    // サーバー経由(GitHub Pages / Live Server / serve.py)
    SQLlib=await initSqlJs({locateFile:f=>'./'+f}); // 例: 'sql-wasm.wasm' → './sql-wasm.wasm'
  }
}

/**
 * バイト列(ArrayBuffer)からDBを開く。incidents テーブルの有無で妥当性を確認。
 * @param {ArrayBuffer} buf  SQLiteファイルの中身(fetch結果 or 選択ファイルの読み取り結果)
 * @param {string} name      表示用のファイル名(状態表示に使用)
 * @returns {Promise<void>}
 * 副作用: db を設定、成功時 onLoaded()、失敗時 #err にメッセージ
 */
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

/**
 * ファイル選択やドラッグ&ドロップで得た File を読み込む。
 * @param {File} file  <input type=file> #fileInput で選択、または drop されたファイル
 * @returns {Promise<void>}
 */
async function loadFile(file){ await loadBuffer(await file.arrayBuffer(), file.name); }

/**
/**
 * 起動時にデータベースを自動で読み込む。
 * @returns {Promise<void>}
 * 動作環境による分岐:
 *   - http/https : 同ディレクトリの incident_db.sqlite を fetch(通常経路)
 *   - file://    : fetchが使えないため、同梱の incident_db_base64.js から復元
 *                  ※DBを差し替えたら make_offline_data.py で作り直すこと
 * 副作用: 成功でdb設定、失敗時は #overlay に案内を表示して手動選択へ
 */
async function autoLoad(){
  if(IS_FILE){
    try{
      if(typeof INCIDENT_DB_BASE64==='undefined') await loadScript('incident_db_base64.js');
      await loadBuffer(b64ToBytes(INCIDENT_DB_BASE64).buffer,'incident_db.sqlite');
    }catch(e){
      showOverlay('同梱データ（incident_db_base64.js）を読み込めませんでした（'+(e.message||e)+'）。下のボタンから incident_db.sqlite を選択してください。','DBを読み込めませんでした');
    }
    return;
  }
  try{
    const resp=await fetch('incident_db.sqlite',{cache:'no-store'});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    await loadBuffer(await resp.arrayBuffer(),'incident_db.sqlite');
  }catch(e){
    showOverlay('同ディレクトリのDBを自動取得できませんでした（'+(e.message||e)+'）。手動でファイルを選択してください。','DBを自動取得できませんでした');
  }
}

/* ======================== 読み込み完了後の初期化 ========================= */

/**
 * 指定列の重複しない値を、絞り込み用プルダウン(select)に流し込む。
 * @param {HTMLSelectElement} sel  対象のselect要素(#eq または #ft)
 * @param {string} col             値を集める列名(equipment_type / failure_type)
 * @returns {void}
 * 参照グローバル: query()
 */
function fillSelect(sel,col){
  const rows=query(`SELECT DISTINCT ${col} v FROM incidents WHERE ${col} IS NOT NULL ORDER BY ${col}`);
  sel.innerHTML='<option value="">すべて</option>'+rows.map(r=>`<option>${esc(r.v)}</option>`).join('');
}

/**
 * DB読み込み完了時に一度だけ呼ぶ初期化。プルダウン生成→件数表示→初回検索→相談索引作成。
 * @param {string} name  読み込んだファイル名(状態表示用)。loadBuffer から渡される
 * @returns {void}
 * 副作用: #overlay 非表示、#dot/#statusText 更新、search() 実行、recoBuild()呼出
 */
function onLoaded(name){
  $('overlay').style.display='none';
  $('dot').classList.add('live');
  fillSelect($('eq'),'equipment_type'); // 機種名プルダウン
  fillSelect($('ft'),'failure_type');   // 故障種別プルダウン
  const total=query("SELECT COUNT(*) c FROM incidents")[0].c;
  $('statusText').textContent=`${esc(name)} ・ 全${total}件`;
  search();
  if(typeof recoBuild==='function') recoBuild(); // 類似事例相談(recommender.js)の索引を作成
}

/* ========================= 検索(条件→SQL→一覧) ========================= */

/**
 * 画面の絞り込み条件を読み取ってSQLを組み立て、実行結果で一覧を再描画する。
 * @param なし ― 画面の各入力欄の現在値を直接読む:
 *   #kw=キーワード, #eq=機種名, #ft=故障種別, #from=対応日(開始), #to=対応日(終了)
 * @returns {void}
 * 参照グローバル: db, query(), render()
 * 副作用: render()で#rowsを再描画、#menuBtnの絞り込み印、#drawerApplyの件数更新
 */
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
  // 機種名・故障種別・対応日(期間)の絞り込み(選択された条件のみ追加)
  if($('eq').value){cond.push('equipment_type = $eq'); p.$eq=$('eq').value;}
  if($('ft').value){cond.push('failure_type = $ft'); p.$ft=$('ft').value;}
  if($('from').value){cond.push('response_date >= $from'); p.$from=$('from').value;}
  if($('to').value){cond.push('response_date <= $to'); p.$to=$('to').value;}
  const where=cond.length?'WHERE '+cond.join(' AND '):'';
  // 対応日の新しい順に取得
  const rows=query(`SELECT ${COLS.join(',')} FROM incidents ${where}
    ORDER BY response_date DESC, item_no DESC`,p);
  render(rows,kw);
  // 絞り込み中はハンバーガーに印、スマホの「結果を見る」に件数を反映
  const active=$('kw').value||$('eq').value||$('ft').value||$('from').value||$('to').value;
  $('menuBtn').classList.toggle('active',!!active);
  $('drawerApply').textContent=`結果を見る（${rows.length}件）`;
}

/* ============================ 一覧の描画 ================================= */

/**
 * 検索結果の行配列を一覧(表)に描画する。PC/タブレットは表、スマホはCSSでカード表示。
 * @param {Object[]} rows  表示する行(search()やチャット同期時の全件)。各要素は列名→値
 * @param {string} kw      強調する検索語(検索欄の値。空可)
 * @returns {void}
 * 副作用: currentRows更新, #rows再描画, #resultCount更新, 行クリックで詳細表示
 */
function render(rows,kw){
  $('resultCount').textContent=`${rows.length} 件`;
  const tb=$('rows'); currentRows=rows; // いまの一覧行を保持(チャット選択の同期に使用)
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="5" style="padding:26px;color:var(--muted)">該当するインシデントはありません。条件を変えてお試しください。</td></tr>`; setDetail(null); return; }
  // 各行のHTMLを生成。data-i=配列添字、data-id=incidents.id(チャット同期で使用)。
  // td のクラス(c-date等)はスマホ時のカード配置にも使う。
  tb.innerHTML=rows.map((r,i)=>{
    const sv=severity(r.operation_status);
    return `<tr data-i="${i}" data-id="${r.id}">
      <td class="c-date">${esc(r.response_date||'')}</td>
      <td class="c-eq">${hi(r.equipment_type||'—',kw)}${r.model_number?`<div class="sub">${hi(r.model_number,kw)}</div>`:''}</td>
      <td class="c-failure">${hi(r.failure_type||'—',kw)}</td>
      <td class="c-defect">${hi(r.defect_name||'—',kw)}</td>
      <td class="c-status"><span class="badge ${sv.cls}">${esc(sv.label)}</span></td>
    </tr>`;
  }).join('');
  // 行クリック: 選択状態にして詳細表示。スマホでは詳細を全画面スライド表示。
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

/**
 * 一覧内の指定インシデントを選択・強調し、その行までスクロールして詳細も表示する。
 * (チャット「類似事例に相談」からの選択を一覧に同期するために使う)
 * @param {number|string} id  選択したい incidents.id(recommender.js の chatSelect から渡される)
 * @returns {boolean} 一覧に該当行があれば選択して true、無ければ false
 * 参照グローバル: currentRows, setDetail()
 * 副作用: 該当trに .sel、スクロール、#detail更新
 */
function selectRowById(id){
  const tr=document.querySelector(`#rows tr[data-id="${id}"]`);
  if(!tr) return false;
  Array.from($('rows').children).forEach(x=>x.classList.remove('sel'));
  tr.classList.add('sel');
  tr.scrollIntoView({block:'nearest'});
  const row=currentRows.find(x=>String(x.id)===String(id));
  if(row) setDetail(row,'');
  return true;
}

/* ============================ 詳細パネル ================================= */

/**
 * 詳細パネル用の「短い項目」セル(2列グリッド)のHTMLを返す。
 * @param {string} k   見出しラベル(例 '機種名')
 * @param {*} v        値(incidentsの該当列)
 * @param {string} kw  強調する検索語
 * @returns {string} セルのHTML
 */
function cell(k,v,kw){ return `<div class="d-cell"><div class="k">${k}</div><div class="v">${v?hi(v,kw):'—'}</div></div>`; }

/**
 * 詳細パネル用の「長文ブロック」のHTMLを返す。値が無ければ空文字(描画しない)。
 * @param {string} k   見出しラベル(例 '調査結果')
 * @param {*} v        値(incidentsの該当列)
 * @param {string} kw  強調する検索語
 * @returns {string} ブロックのHTML(値なしなら'')
 */
function block(k,v,kw){ if(!v) return ''; return `<div class="d-block"><div class="k">${k}</div><div class="v">${hi(v,kw)}</div></div>`; }

/**
 * 選択された1件の全項目を詳細パネルに表示する。
 * @param {Object|null} r  表示するインシデント行(列名→値)。null なら案内文を表示
 * @param {string} [kw]    強調する検索語(省略可)
 * @returns {void}
 * 副作用: #detail を書き換え
 */
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

/* ============================ イベント登録 =============================== */
// mq: 画面幅720px以下(スマホ)判定。レイアウト分岐に使用。recommender.js からも参照される。
const mq=window.matchMedia('(max-width:720px)');
const toolbar=$('toolbar');

/** 検索ドロワー(スマホ時に右からスライド)を開く。副作用: #toolbar/#backdrop */
function openDrawer(){ toolbar.classList.add('open'); $('backdrop').classList.add('show'); }
/** 検索ドロワーを閉じる。副作用: #toolbar/#backdrop */
function closeDrawer(){ toolbar.classList.remove('open'); $('backdrop').classList.remove('show'); }
$('menuBtn').onclick=openDrawer;      // ハンバーガー(≡)で開く
$('drawerClose').onclick=closeDrawer; // ドロワー内の×で閉じる
$('drawerApply').onclick=closeDrawer; // 「結果を見る」で閉じる
$('backdrop').onclick=closeDrawer;    // 背景タップで閉じる
$('detailBack').onclick=()=>$('detailPanel').classList.remove('open'); // スマホ詳細の戻る

// 手動ファイル選択(自動読込に失敗した場合や file:// でのフォールバック)
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

/* ================================ 起動 ================================== */
autoLoad(); // ページ表示時に(http/https環境なら)同ディレクトリのDBを自動読み込み
