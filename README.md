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

## Video Thumbnails in the Popup

Each detected video card displays a thumbnail preview when available (using the video's poster image, a captured video frame, or the page's preview image). If a site blocks image previews or no thumbnail is available yet, a clean format placeholder is shown instead.

## Reloading After Updates (Dev Workflow)

When you make changes to the extension files, Edge needs to reload the extension for the changes to take effect. You have two easy ways:

### Option 1: Automatic Reload While Editing (Recommended)

1. Double-click **`scripts/start-auto-reload.bat`** (or run `npm run dev:reload` in a terminal). Leave that window open while editing.
2. Make sure **Auto-reload during dev** is checked under **Settings** in the extension popup (it is on by default).
3. Whenever you save an extension file, Microsoft Edge will automatically reload the extension within a fraction of a second. (If the helper window isn't running, the extension stays quiet and does nothing extra.)

### Option 2: One-Click Reload Button in the Popup

Click the circular **Reload extension** icon button in the top-right header of the popup anytime to immediately reload the extension without opening `edge://extensions`.

## What It Supports (and Limits)

- **Works great for:** Direct video files (`.mp4`, `.webm`, `.mov`, `.mkv`), embedded HTML5 video players, and unencrypted HLS streams (`.m3u8`, including AES-128 streams).
- **Known limits:** DRM-encrypted streaming sites (Netflix, Disney+, Prime Video) and sites that use heavily obfuscated/split streams (like YouTube or encrypted DASH) cannot be downloaded directly by a browser extension alone.
