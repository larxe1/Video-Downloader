# Free Video Downloader (Microsoft Edge Extension)

A 100% free, local Microsoft Edge extension (Manifest V3) that detects videos playing or loading on your current tab and saves them to your `Downloads` folder — with **no subscriptions, no paywalls, and no watermarks**.

## How to Load It in Microsoft Edge (Takes 1 Minute)

1. Open Microsoft Edge and go to **`edge://extensions`** in the address bar.
2. Turn ON **Developer mode** (the toggle on the left sidebar or top corner).
3. Click **Load unpacked**, select this folder (`D:\Code\Video Downloader`), and click **Select Folder**.
4. Pin **Free Video Downloader** to your toolbar from the puzzle-piece Extensions icon so it stays one click away.

## How to Use It

1. Open any webpage with a video and press **Play** for a couple of seconds.
2. The extension icon badge will show the number of videos found on that tab.
3. Click the **Free Video Downloader** icon:
   - For standard video files (`.mp4`, `.webm`, `.mov`, etc.), click **Download** to save immediately.
   - For streaming videos (`HLS / .m3u8`), click **Download** for the highest quality or **Qualities** to pick a resolution (`1080p`, `720p`, `480p`, etc.).
   - If a video doesn't appear right away, click **Rescan**.

## What It Supports (and Limits)

- **Works great for:** Direct video files (`.mp4`, `.webm`, `.mov`, `.mkv`), embedded HTML5 video players, and unencrypted HLS streams (`.m3u8`, including AES-128 streams).
- **Known limits:** DRM-encrypted streaming sites (Netflix, Disney+, Prime Video) and sites that use heavily obfuscated/split streams (like YouTube or encrypted DASH) cannot be downloaded directly by a browser extension alone.
