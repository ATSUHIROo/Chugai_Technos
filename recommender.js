/* ============================================================================
 *  recommender.js ― 「類似インシデントに相談」チャット機能
 * ----------------------------------------------------------------------------
 *  役割 : 利用者が入力した普段の文章から、語彙が近い過去インシデントをスコア順に
 *         提示する(チャットボット風UI)。
 *  方式 : 日本語の文字bigram + BM25(検索ランキング) + 日常語→専門語の同義語展開。
 *         生成AI(LLM)ではなく、ブラウザ内で完結する類似度ベースの推薦。外部通信なし。
 *
 *  ★app.js への依存(グローバル契約) ― index.html で app.js の後に読み込むこと:
 *      query(sql)        : SQL実行(インデックス構築で incidents を読む)
 *      db                : 読み込み済みか判定に使用(query内部でも使用)
 *      setDetail(row)    : 詳細パネルに1件表示
 *      selectRowById(id) : 一覧で該当行を選択・強調・スクロール(一覧と詳細の同期)
 *      currentRows       : いま一覧に表示中の行(選択事例が一覧にあるか判定)
 *      search()          : 絞り込み解除後に一覧を再描画
 *      severity(status)  : 稼働状況→色分けクラス
 *      esc(s)            : HTMLエスケープ
 *      mq                : スマホ幅判定(matchMedia)
 *      $(id)             : getElementById短縮
 *  ★app.js からの呼び出し: DB読み込み完了時に onLoaded() が recoBuild() を呼ぶ。
 * ========================================================================== */

/* ---- 日常語 → 関連する技術語(クエリ拡張用の同義語辞書) --------------------
 *  ここを増やすほど「普段の言い回し」で技術用語の事例に当たりやすくなる。
 *  形式:  "入力に含まれうる語": ["追加で照合したい語", ...]                     */
const RECO_SYN={
 "停電":["電源","電源断","UPS","停電"], "電気":["電源","UPS"], "雷":["落雷"], "かみなり":["落雷"],
 "見えない":["表示","監視","モニタ"], "映らない":["表示","モニタ","ITV"], "表示されない":["表示","モニタ"],
 "監視できない":["監視不可","監視"], "止まった":["停止","運転停止","制御不可","運転不能"], "止まる":["停止","運転停止"],
 "動かない":["停止","運転停止","制御不可"], "操作できない":["制御不可","監視操作不可"], "制御できない":["制御不可"],
 "数字":["指示値","表示","ゼロ","マイナス","誤差","積算"], "数値":["指示値","表示","誤差","積算"], "値":["指示値","表示","誤差"],
 "おかしい":["異常","不具合","誤差"], "異常":["異常","不具合"], "水位":["水位"], "流量":["流量","電磁流量計"], "流れ":["流量"],
 "圧力":["圧力","圧力伝送器"], "ポンプ":["ポンプ","配水ポンプ","ろ過ポンプ"], "基板":["基板"], "ボード":["基板"],
 "通信":["通信","テレメータ","伝送"], "つながらない":["通信","テレメータ","伝送"], "警報":["警報","アラーム"],
 "アラーム":["警報","アラーム"], "鳴った":["警報","アラーム"], "再起動":["再起動","復旧"], "リセット":["リセット","再起動","復旧"],
};
const RECO_K1=1.2, RECO_B=0.75;   // BM25パラメータ(標準値)。K1=語頻度の効き、B=文書長補正

/** 推薦インデックスの状態(recoBuildで構築)。rows=元行, tf=語頻度, df=文書頻度, N=件数, avgdl=平均文書長 */
let RECO={rows:[],docs:[],tf:[],df:{},N:0,avgdl:1,ready:false};

/**
 * 文字列を正規化する(全角→半角=NFKC、小文字化、空白除去)。
 * @param {string} s  正規化対象
 * @returns {string} 正規化後の文字列
 */
function recoNorm(s){ return s?s.normalize('NFKC').toLowerCase().replace(/\s+/g,''):''; }

/**
 * 文字列を文字bigram(2文字ずつ)に分解する。日本語を分かち書きせず類似度を取れる。
 * @param {string} s  対象文字列
 * @returns {string[]} bigramの配列(例 '流量計'→['流量','量計'])
 */
function recoBigrams(s){
  s=recoNorm(s); if(s.length<=1) return s?[s]:[];
  const a=[]; for(let i=0;i<s.length-1;i++) a.push(s.slice(i,i+2)); return a;
}

/**
 * 1件のインシデントを検索対象テキスト(主要な文字列列の連結)にする。
 * @param {Object} r  incidents の1行(列名→値)
 * @returns {string} 連結テキスト
 */
function recoDocText(r){
  return ['defect_name','situation','investigation_result','remarks','equipment_type','failure_type']
    .map(k=>r[k]||'').join(' ');
}

/**
 * 推薦インデックスを構築する。全インシデントを読み、BM25用の統計(tf/df/avgdl)を作る。
 * DB読み込み完了時に app.js の onLoaded() から呼ばれる。
 * @param なし ― データは query() 経由で incidents から取得
 * @returns {void}
 * 参照グローバル: query()
 * 副作用: RECO を更新(ready=trueに)
 */
function recoBuild(){
  const cols='id,item_no,response_date,equipment_type,model_number,model_name,series_name,failure_type,defect_name,situation,operation_status,investigation_result,remarks';
  RECO.rows=query(`SELECT ${cols} FROM incidents`);
  RECO.docs=RECO.rows.map(r=>recoBigrams(recoDocText(r)));
  RECO.N=RECO.docs.length || 1;
  RECO.avgdl=RECO.docs.reduce((s,d)=>s+d.length,0)/RECO.N || 1;
  RECO.df={}; RECO.tf=[];
  RECO.docs.forEach(d=>{
    const c={}; new Set(d).forEach(t=>RECO.df[t]=(RECO.df[t]||0)+1); // 文書頻度df
    d.forEach(t=>c[t]=(c[t]||0)+1); RECO.tf.push(c);                 // 語頻度tf
  });
  RECO.ready=true;
}

/**
 * IDF(逆文書頻度)。希少な語ほど大きな重みになる。
 * @param {string} t  bigram
 * @returns {number} IDF値
 * 参照グローバル: RECO(df,N)
 */
function recoIdf(t){ const df=RECO.df[t]||0; return Math.log(1+(RECO.N-df+0.5)/(df+0.5)); }

/**
 * 入力文を同義語辞書で拡張する(日常語に対応する技術語を末尾に追記)。
 * @param {string} q  利用者の入力文
 * @returns {string} 拡張後の文字列(元文＋補足語)
 * 参照グローバル: RECO_SYN
 */
function recoExpand(q){
  let add=[]; for(const key in RECO_SYN){ if(q.indexOf(key)>=0) add=add.concat(RECO_SYN[key]); }
  return q+' '+add.join(' ');
}

/**
 * 入力文に近い過去インシデントをBM25でスコア付けし、上位を返す。
 * @param {string} text     利用者の入力文(チャット欄 #chatInput の値、または例文チップ)
 * @param {number} [topN=4] 返す件数
 * @returns {{row:Object,score:number}[]} スコア降順の配列(row=incidentsの1行)
 * 参照グローバル: RECO, recoIdf()
 */
function recoSearch(text,topN=4){
  if(!RECO.ready) return [];
  const qt=new Set(recoBigrams(recoExpand(text)));
  const scored=[];
  for(let i=0;i<RECO.tf.length;i++){
    const c=RECO.tf[i]; const dl=RECO.docs[i].length||1; let s=0;
    qt.forEach(t=>{ const f=c[t]; if(f) s+=recoIdf(t)*(f*(RECO_K1+1))/(f+RECO_K1*(1-RECO_B+RECO_B*dl/RECO.avgdl)); });
    if(s>0) scored.push({row:RECO.rows[i],score:s});
  }
  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,topN);
}

/**
 * スコアを利用者向けの関連度ラベルに変換する。
 * @param {number} s  recoSearchのスコア
 * @returns {[string,string]} [ラベル文言, バッジ用CSSクラス]
 */
function recoLabel(s){ return s>=15?['関連度 高','sev-ok']:s>=7?['関連度 中','sev-warn']:['関連度 低','sev-neutral']; }

/* =============================== チャットUI ============================== */

/**
 * 利用者の発言バブルを追加する。
 * @param {string} text  表示文字列(利用者の入力)
 * @returns {void}
 * 副作用: #chatMessages に追加してスクロール
 */
function chatAddUser(text){
  const m=document.createElement('div'); m.className='chat-msg user'; m.textContent=text;
  $('chatMessages').appendChild(m); chatScroll();
}

/**
 * ボットの発言バブルを追加する。
 * @param {string} html  バブル内のHTML(件数案内など)
 * @returns {HTMLElement} 追加した要素
 * 副作用: #chatMessages に追加してスクロール
 */
function chatAddBot(html){
  const m=document.createElement('div'); m.className='chat-msg bot'; m.innerHTML=html;
  $('chatMessages').appendChild(m); chatScroll(); return m;
}

/** チャット表示を最下部までスクロールする。副作用: #chatMessages のscrollTop */
function chatScroll(){ const c=$('chatMessages'); c.scrollTop=c.scrollHeight; }

/**
 * 推薦結果をカードとして描画し、クリックで詳細を開けるようにする。
 * @param {{row:Object,score:number}[]} hits  recoSearchの結果
 * @returns {void}
 * 参照グローバル: severity(), esc()
 * 副作用: #chatMessages にボット発言＋カード群を追加
 */
function chatRenderResults(hits){
  chatAddBot(`近い過去事例を <b>${hits.length}件</b> 見つけました。カードをタップすると詳細を表示します。`);
  const wrap=document.createElement('div'); wrap.className='reco-list';
  hits.forEach(h=>{
    const r=h.row, sv=severity(r.operation_status), lb=recoLabel(h.score);
    const card=document.createElement('div'); card.className='reco-card';
    card.innerHTML=`
      <div class="reco-top">
        <span class="reco-date">${esc(r.response_date||'')}</span>
        <span class="badge ${lb[1]}">${lb[0]}</span>
      </div>
      <div class="reco-eq">${esc(r.equipment_type||'—')}${r.failure_type?` ・ <span class="reco-ft">${esc(r.failure_type)}</span>`:''}</div>
      <div class="reco-defect">${esc(r.defect_name||r.situation||'—')}</div>
      <div class="reco-status"><span class="dot2 ${sv.cls}"></span>${esc(sv.label)}</div>`;
    card.onclick=()=>chatSelect(r);
    wrap.appendChild(card);
  });
  $('chatMessages').appendChild(wrap); chatScroll();
}

/**
 * 推薦カードを選んだとき、一覧側でも同じインシデントを選択・強調し、詳細も表示する。
 * (詳細だけ変わって一覧がずれる=利用者の誤解、を防ぐため一覧と同期させる)
 * @param {Object} r  選んだインシデント行(recoSearch結果のrow)
 * @returns {void}
 * 参照グローバル: currentRows, search(), selectRowById(), setDetail(), mq, $()
 * 副作用: 必要なら絞り込み解除→再検索、一覧の該当行を選択、詳細表示、チャットを閉じる
 */
function chatSelect(r){
  // 選択事例が現在の一覧(絞り込み結果)に無いと一覧と詳細がずれるため、
  // その場合は絞り込みを解除して全件表示にしてから探す。
  const inList = typeof currentRows!=='undefined' && currentRows.some(x=>String(x.id)===String(r.id));
  if(!inList){
    ['kw','eq','ft','from','to'].forEach(id=>$(id).value='');
    if(typeof search==='function') search(); // 全件を再描画(一覧を最新化)
  }
  const ok = (typeof selectRowById==='function') && selectRowById(r.id); // 一覧で選択・強調・スクロール＋詳細
  if(!ok) setDetail(r,''); // 念のためのフォールバック(通常はここに来ない)
  if(mq.matches){ $('detailPanel').classList.add('open'); }
  chatClose();
}

/**
 * 送信処理: 入力文を検索し、結果(または見つからない案内)を返す。
 * @param {string} [text]  送信する文字列。省略時は #chatInput の値を使う(例文チップから渡す場合あり)
 * @returns {void}
 * 参照グローバル: RECO(ready), recoSearch()
 * 副作用: #chatInput クリア、#chatMessages に発言追加
 */
function chatSend(text){
  const q=(text!=null?text:$('chatInput').value).trim();
  if(!q) return;
  $('chatInput').value='';
  chatAddUser(q);
  if(!RECO.ready){ chatAddBot('データベースの読み込みが完了してからお試しください。'); return; }
  const hits=recoSearch(q,4);
  if(!hits.length){
    chatAddBot('近い事例が見つかりませんでした。別の言い方や、機器名（例: テレメータ、流量計、ポンプ）を含めてみてください。');
  }else{
    chatRenderResults(hits);
  }
}

/** チャットパネルを開く。副作用: #chatPanel/#chatBackdrop 表示、#chatInput にフォーカス */
function chatOpen(){ $('chatPanel').classList.add('open'); $('chatBackdrop').classList.add('show'); setTimeout(()=>$('chatInput').focus(),100); }
/** チャットパネルを閉じる。副作用: #chatPanel/#chatBackdrop 非表示 */
function chatClose(){ $('chatPanel').classList.remove('open'); $('chatBackdrop').classList.remove('show'); }

/* ------------------------------ イベント登録 ---------------------------- */
$('chatBtn').onclick=chatOpen;         // ヘッダーの「類似事例に相談」で開く
$('chatClose').onclick=chatClose;      // ×で閉じる
$('chatBackdrop').onclick=chatClose;   // 背景タップで閉じる
$('chatSend').onclick=()=>chatSend();  // 送信ボタン
// Enterで送信(Shift+Enterは改行)
$('chatInput').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); chatSend(); } });
// 例文チップ: クリックでその文言をそのまま相談
Array.from(document.querySelectorAll('.chat-chip')).forEach(ch=>{ ch.onclick=()=>chatSend(ch.textContent); });
