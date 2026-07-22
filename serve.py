#!/usr/bin/env python3
# ============================================================================
#  serve.py ― ローカル開発用の簡易HTTPサーバー
# ----------------------------------------------------------------------------
#  用途 : VS Code等でこのフォルダを開発する際、file:// では incident_db.sqlite の
#         自動読み込みができない(ブラウザ制限)。このサーバー経由で開けば動く。
#  使い方: このフォルダで  python3 serve.py   を実行し、表示されたURLをブラウザで開く。
#          ポートを変えたい場合:  python3 serve.py 8080
#  ※ VS Codeの拡張機能「Live Server」を使う場合はこのファイルは不要。
# ============================================================================
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500

class Handler(http.server.SimpleHTTPRequestHandler):
    # .wasm を正しいMIMEで配信する(古いPythonでも確実にするため明示)
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm"}
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # 開発中は毎回最新を読む
        super().end_headers()

os.chdir(os.path.dirname(os.path.abspath(__file__)))  # このファイルのある場所を配信ルートに
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"ローカルサーバーを起動しました → http://localhost:{PORT}/")
    print("停止するには Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました")
