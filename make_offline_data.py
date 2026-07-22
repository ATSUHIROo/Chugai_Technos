#!/usr/bin/env python3
# ============================================================================
#  make_offline_data.py ― オフライン(file://)用データファイルの生成スクリプト
# ----------------------------------------------------------------------------
#  目的 : ブラウザで index.html を「直接ダブルクリックで開いた場合(file://)」でも
#         動くように、SQLiteエンジンとデータベースをJavaScriptファイルに埋め込む。
#         (file:// では fetch が禁止されており .wasm や .sqlite を読めないため)
#
#  生成物:
#    sql-wasm-base64.js    … sql-wasm.wasm       を base64 で格納
#    incident_db_base64.js … incident_db.sqlite  を base64 で格納
#
#  ★重要: incident_db.sqlite を新しいデータに差し替えたら、このスクリプトを
#          実行して incident_db_base64.js を作り直してください。
#          （作り直さないと、file:// で開いたときだけ古いデータが表示されます）
#
#  使い方: このフォルダで  python3 make_offline_data.py
# ============================================================================
import base64, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))

# (入力ファイル, 出力ファイル, JS変数名) の対応
TARGETS = [
    ("sql-wasm.wasm",      "sql-wasm-base64.js",    "SQL_WASM_BASE64"),
    ("incident_db.sqlite", "incident_db_base64.js", "INCIDENT_DB_BASE64"),
]

def build(src_name, out_name, var_name):
    """1ファイルをbase64化してJSファイルとして書き出す。

    src_name : 埋め込む元ファイル名(このフォルダ内)
    out_name : 出力するJSファイル名
    var_name : JS側から参照するグローバル変数名(app.jsが参照)
    """
    src = os.path.join(HERE, src_name)
    if not os.path.exists(src):
        print(f"  [スキップ] {src_name} が見つかりません")
        return False
    with open(src, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    header = (f"/* 自動生成ファイル ― 編集しないでください\n"
              f"   生成元 : {src_name}\n"
              f"   生成方法: python3 make_offline_data.py\n"
              f"   用途   : file:// で開いた場合のみ app.js から読み込まれます */\n")
    with open(os.path.join(HERE, out_name), "w", encoding="utf-8") as f:
        f.write(header + f'var {var_name}="{b64}";\n')
    print(f"  {src_name}  →  {out_name}  ({len(b64):,} 文字)")
    return True

if __name__ == "__main__":
    print("オフライン用データを生成します…")
    ok = all([build(*t) for t in TARGETS])
    print("完了しました。" if ok else "一部のファイルを生成できませんでした。")
    sys.exit(0 if ok else 1)
