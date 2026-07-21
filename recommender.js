/* ============================================================================
 *  recommender.js ― 「類似インシデント相談」チャット機能
 * ----------------------------------------------------------------------------
 *  役割 : 利用者が入力した普段の文章から、語彙が近い過去インシデントを
 *         スコア順に提示する(チャットボット風UI)。
 *  方式 : 日本語の文字bigram + BM25(検索ランキング) + 日常語→専門語の同義語展開。
 *         生成AI(LLM)ではなく、ブラウザ内で完結する類似度ベースの推薦。
 *  依存 : app.js のグローバル(db, query, setDetail, esc, mq, $ 等)を利用。
 *         index.html では app.js の後に読み込むこと。
 *         app.js の onLoaded() 内から recoBuild() が呼ばれてインデックスを作る。
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
const RECO_K1=1.2, RECO_B=0.75;   // BM25パラメータ(標準値)

/* ---- インデックス用の状態 ------------------------------------------------- */
let RECO={rows:[],docs:[],tf:[],df:{},N:0,avgdl:1,ready:false};

// 正規化: 全角→半角(NFKC)、小文字化、空白除去
function recoNorm(s){ return s?s.normalize('NFKC').toLowerCase().replace(/\s+/g,''):''; }
// 文字bigram(2文字ずつ)。日本語を分かち書きせずに類似度を取れる。
function recoBigrams(s){
  s=recoNorm(s); if(s.length<=1) return s?[s]:[];
  const a=[]; for(let i=0;i<s.length-1;i++) a.push(s.slice(i,i+2)); return a;
}
// 1件の検索対象テキスト(主要な文字列列を連結)
function recoDocText(r){
  return ['defect_name','situation','investigation_result','remarks','equipment_type','failure_type']
    .map(k=>r[k]||'').join(' ');
}

/* ---- インデックス構築(DB読み込み後に app.js から呼ばれる) ---------------- */
function recoBuild(){
  const cols='id,item_no,response_date,equipment_type,model_number,model_name,series_name,failure_type,defect_name,situation,operation_status,investigation_result,remarks';
  RECO.rows=query(`SELECT ${cols} FROM incidents`);
  RECO.docs=RECO.rows.map(r=>recoBigrams(recoDocText(r)));
  RECO.N=RECO.docs.length || 1;
  RECO.avgdl=RECO.docs.reduce((s,d)=>s+d.length,0)/RECO.N || 1;
  RECO.df={}; RECO.tf=[];
  RECO.docs.forEach(d=>{
    const c={}; new Set(d).forEach(t=>RECO.df[t]=(RECO.df[t]||0)+1);
    d.forEach(t=>c[t]=(c[t]||0)+1); RECO.tf.push(c);
  });
  RECO.ready=true;
}
// IDF(希少な語ほど重み大)
function recoIdf(t){ const df=RECO.df[t]||0; return Math.log(1+(RECO.N-df+0.5)/(df+0.5)); }

// クエリを同義語で拡張してから照合語(bigram集合)を作る
function recoExpand(q){
  let add=[]; for(const key in RECO_SYN){ if(q.indexOf(key)>=0) add=add.concat(RECO_SYN[key]); }
  return q+' '+add.join(' ');
}

/* ---- 検索(入力文 → スコア順の事例) --------------------------------------- */
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
// スコアを関連度ラベルに変換(利用者向けの目安)
function recoLabel(s){ return s>=15?['関連度 高','sev-ok']:s>=7?['関連度 中','sev-warn']:['関連度 低','sev-neutral']; }

/* ======================= チャットUI ======================================= */
function chatAddUser(text){
  const m=document.createElement('div'); m.className='chat-msg user'; m.textContent=text;
  $('chatMessages').appendChild(m); chatScroll();
}
function chatAddBot(html){
  const m=document.createElement('div'); m.className='chat-msg bot'; m.innerHTML=html;
  $('chatMessages').appendChild(m); chatScroll(); return m;
}
function chatScroll(){ const c=$('chatMessages'); c.scrollTop=c.scrollHeight; }

// 推薦結果をカードとして描画し、クリックで詳細を開けるようにする
function chatRenderResults(hits){
  const bot=chatAddBot(`近い過去事例を <b>${hits.length}件</b> 見つけました。カードをタップすると詳細を表示します。`);
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
// 推薦カードを選んだとき: 詳細を表示し、チャットを閉じる
function chatSelect(r){
  setDetail(r,'');
  if(mq.matches){ $('detailPanel').classList.add('open'); }
  chatClose();
}

// 送信処理: 入力文 → 検索 → 返答
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

/* ---- チャットパネルの開閉 ------------------------------------------------- */
function chatOpen(){ $('chatPanel').classList.add('open'); $('chatBackdrop').classList.add('show'); setTimeout(()=>$('chatInput').focus(),100); }
function chatClose(){ $('chatPanel').classList.remove('open'); $('chatBackdrop').classList.remove('show'); }

/* ---- イベント登録 --------------------------------------------------------- */
$('chatBtn').onclick=chatOpen;
$('chatClose').onclick=chatClose;
$('chatBackdrop').onclick=chatClose;
$('chatSend').onclick=()=>chatSend();
// Enterで送信(Shift+Enterは改行)
$('chatInput').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); chatSend(); } });
// 例文チップ: クリックでそのまま相談
Array.from(document.querySelectorAll('.chat-chip')).forEach(ch=>{ ch.onclick=()=>chatSend(ch.textContent); });
