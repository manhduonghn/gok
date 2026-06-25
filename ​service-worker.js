const PROXY_PREFIX = '/proxy-stream';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith(PROXY_PREFIX)) {
    event.respondWith(handleVirtualRequest(event));
  }
});

async function handleVirtualRequest(event) {
  const url = new URL(event.request.url);
  const playlistUrl = url.searchParams.get("url");

  if (!playlistUrl) {
    return new Response("Missing ?url=", { status: 400 });
  }

  try {
    const manifest = await fetchAndProcessPlaylist(playlistUrl);

    return new Response(manifest, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}

async function fetchAndProcessPlaylist(playlistUrl) {
  const res = await fetch(playlistUrl);
  if (!res.ok) throw new Error("Cannot fetch playlist");

  let text = await res.text();

  // Resolve absolute URLs cho các dòng không phải comment
  text = text.replace(/^[^#].*$/gm, (line) => {
    try {
      return new URL(line.trim(), playlistUrl).toString();
    } catch {
      return line;
    }
  });

  // Nếu là master playlist -> đi sâu stream con
  if (text.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split("\n");

    for (let i = 1; i < lines.length; i++) {
      if (lines[i - 1].includes("#EXT-X-STREAM-INF")) {
        const subUrl = new URL(lines[i].trim(), playlistUrl).toString();
        return fetchAndProcessPlaylist(subUrl);
      }
    }
  }

  return cleanManifest(text, playlistUrl);
}

function cleanManifest(manifest, baseUrl) {
  const lines = manifest.split(/\r?\n/);
  const result = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // 1. Bỏ qua dòng trống hoặc các dòng comment rác của hệ thống (###)
    if (!line || line.startsWith("###")) {
      i++;
      continue;
    }

    // 2. XỬ LÝ ĐỒNG BỘ CẶP: Thẻ thời lượng #EXTINF và URL phân đoạn phim ngay dưới nó
    if (line.startsWith("#EXTINF:")) {
      let extinfLine = lines[i];
      
      let nextIdx = i + 1;
      while (nextIdx < lines.length && (!lines[nextIdx].trim() || lines[nextIdx].trim().startsWith("###"))) {
        nextIdx++;
      }

      if (nextIdx < lines.length) {
        const nextLine = lines[nextIdx].trim();

        if (nextLine.startsWith("#")) {
          result.push(extinfLine);
          i++;
          continue;
        }

        let url;
        try {
          url = new URL(nextLine, baseUrl).toString();
        } catch {
          i = nextIdx + 1;
          continue;
        }

        // Lọc quảng cáo thông qua logic filter đường dẫn
        const cleanedUrl = processSegment(url);

        if (cleanedUrl) {
          // PHIM CHÍNH -> Giữ lại cả cặp (Dòng thời lượng + URL sạch quảng cáo)
          result.push(extinfLine);
          result.push(cleanedUrl);
        } else {
          // QUẢNG CÁO -> Bỏ qua cả cặp thời lượng + URL quảng cáo này
          console.log("👉 Đã chặn quảng cáo:", url);
          
          // Gỡ bỏ thẻ #EXT-X-DISCONTINUITY rác đi kèm ngay trước quảng cáo nếu có
          if (result.length > 0 && result[result.length - 1].trim().startsWith("#EXT-X-DISCONTINUITY")) {
            result.pop();
            console.log("🔥 Đã xóa thẻ #EXT-X-DISCONTINUITY đi kèm quảng cáo");
          }
        }

        i = nextIdx + 1;
        continue;
      }
    }

    // 3. Khử trùng lặp các tag khởi tạo m3u8 nằm rải rác ở giữa file
    if (line.startsWith("#EXTM3U") || line.startsWith("#EXT-X-VERSION") || line.startsWith("#EXT-X-PLAYLIST-TYPE")) {
      if (result.length > 0) { 
        i++;
        continue;
      }
    }

    // 4. Giữ nguyên các thẻ tag kỹ thuật hợp lệ khác
    if (line.startsWith("#")) {
      result.push(lines[i]);
    } else {
      try {
        const url = new URL(line, baseUrl).toString();
        const cleanedUrl = processSegment(url);
        if (cleanedUrl) result.push(cleanedUrl);
      } catch {}
    }

    i++;
  }

  // Dọn dẹp các thẻ #EXT-X-DISCONTINUITY thừa ở cuối luồng nếu quảng cáo nằm cuối danh sách
  while (result.length > 0 && result[result.length - 1].trim().startsWith("#EXT-X-DISCONTINUITY")) {
    result.pop();
  }

  return result.join("\n").replace(/\n{2,}/g, "\n").trim();
}

/* ====================================
   FILTER LOGIC NHẬN DIỆN QUẢNG CÁO
==================================== */
function normalizeConvertPath(url) {
  return url.replace(/\/convertv\d+\//g, "/");
}

function isTsFile(url) {
  return typeof url === "string" && url.endsWith(".ts");
}

function isValidMovieSegment(url) {
  return /^https?:\/\/[^/]+\/\d{8}\/[A-Za-z0-9]+\/\d+kb\/hls\/.+\.ts$/i.test(url);
}

function processSegment(url) {
  if (!url) return null;
  const cleanedUrl = normalizeConvertPath(url);
  if (!isTsFile(cleanedUrl)) return null;
  if (!isValidMovieSegment(cleanedUrl)) return null;
  return cleanedUrl;
}
