"""
本地预览服务器。

浏览器加载 ES Module 不能用 file:// 直接打开，必须走 http，所以用它：

    python serve.py           # 然后访问 http://localhost:8088

端口可以在命令行改： python serve.py 9000
"""

import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8088
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # 开发时禁缓存，改完刷新就能看到
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


if __name__ == "__main__":
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"麻将游戏已启动： http://localhost:{PORT}")
        print("Ctrl+C 结束")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
