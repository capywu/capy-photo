// 背景執行緒：產生縮圖 / 預覽圖，並計算相似度指紋與整體清晰度
self.onmessage = async (ev) => {
  const { id, buf, type, orientation } = ev.data;
  try {
    const blob = new Blob([buf], { type: type || 'image/jpeg' });
    const isJpegInRaw = orientation && orientation !== 1;
    const bmp = await createImageBitmap(blob, { imageOrientation: isJpegInRaw ? 'none' : 'from-image' });
    const rot = isJpegInRaw ? orientation : 1;
    const swap = rot === 6 || rot === 8 || rot === 5 || rot === 7;
    const W = swap ? bmp.height : bmp.width, H = swap ? bmp.width : bmp.height;
    const draw = (maxSide) => {
      const s = Math.min(1, maxSide / Math.max(W, H));
      const w = Math.round(W * s), h = Math.round(H * s);
      const c = new OffscreenCanvas(w, h); const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.save();
      if (rot === 6) { x.translate(w, 0); x.rotate(Math.PI / 2); }
      else if (rot === 8) { x.translate(0, h); x.rotate(-Math.PI / 2); }
      else if (rot === 3) { x.translate(w, h); x.rotate(Math.PI); }
      const dw = swap ? h : w, dh = swap ? w : h;
      x.drawImage(bmp, 0, 0, dw, dh);
      x.restore();
      return c;
    };
    const pv = draw(2048);
    const th = draw(420);
    // dHash 9x8
    const hc = new OffscreenCanvas(9, 8); const hx = hc.getContext('2d'); hx.drawImage(th, 0, 0, 9, 8);
    const hd = hx.getImageData(0, 0, 9, 8).data; let hash = '';
    let bits = 0, nb = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const a = hd[(y * 9 + x) * 4] + hd[(y * 9 + x) * 4 + 1] + hd[(y * 9 + x) * 4 + 2];
      const b = hd[(y * 9 + x + 1) * 4] + hd[(y * 9 + x + 1) * 4 + 1] + hd[(y * 9 + x + 1) * 4 + 2];
      bits = (bits << 1) | (a > b ? 1 : 0); nb++;
      if (nb === 4) { hash += bits.toString(16); bits = 0; nb = 0; }
    }
    // 整體清晰度：中央區域縮到 512 的拉普拉斯變異數（取最清楚的區塊）
    const sc = new OffscreenCanvas(512, Math.round(512 * H / W)); const sx = sc.getContext('2d', { willReadFrequently: true });
    sx.drawImage(pv, 0, 0, sc.width, sc.height);
    const d = sx.getImageData(0, 0, sc.width, sc.height).data; const w = sc.width, h = sc.height;
    const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const B = 64; let best = 0;
    for (let by = 0; by + B <= h; by += B / 2) for (let bx = 0; bx + B <= w; bx += B / 2) {
      let s = 0, s2 = 0, n = 0;
      for (let y = by + 1; y < by + B - 1; y++) for (let x = bx + 1; x < bx + B - 1; x++) { const i = y * w + x; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n++; }
      const v = s2 / n - (s / n) ** 2; if (v > best) best = v;
    }
    // 直方圖（給資訊面板）
    const hist = new Array(64).fill(0);
    for (let i = 0; i < w * h; i += 3) hist[Math.min(63, (g[i] / 4) | 0)]++;
    const pvBlob = await pv.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    const thBlob = await th.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const pvBuf = await pvBlob.arrayBuffer(), thBuf = await thBlob.arrayBuffer();
    self.postMessage({ id, ok: true, preview: pvBuf, thumb: thBuf, hash, sharp: best, hist, w: W, h: H, pw: pv.width, ph: pv.height }, [pvBuf, thBuf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
