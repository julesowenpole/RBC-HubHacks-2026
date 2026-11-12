# source: Microsoft Copilot
# see readme file for the proper command
import threading
import webview

from app import app

def run_flask():
    app.run(port=5000, use_reloader=False)

if __name__ == "__main__":
    threading.Thread(
        target=run_flask,
        daemon=True
    ).start()

    webview.create_window(
        "Fish Eye",
        "http://127.0.0.1:5000"
    )

    webview.start()