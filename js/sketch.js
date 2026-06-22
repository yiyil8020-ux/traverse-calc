// 略图绘制
// 输入：coordinates 数组 [{name, x, y}, ...] + 选项
// 输出：把导线画到 canvas 上，自动适配 + 高 DPI 清晰

export function drawTraverse(canvas, coordinates, opts = {}) {
  if (!canvas || !coordinates || coordinates.length < 2) return;
  const { isClosed = true, startName = '' } = opts;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(rect.width, 300) * dpr;
  canvas.height = Math.max(rect.height, 240) * dpr;
  canvas.style.width = Math.max(rect.width, 300) + 'px';
  canvas.style.height = Math.max(rect.height, 240) + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  const padding = 28;

  // 计算包围盒
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of coordinates) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // 测量坐标系下：X是纵轴（North，垂直向上），Y是横轴（East，水平向右）
  // 对应屏幕/画布：Y 映射到横向 cx，X 映射到纵向 cy
  const rangeX = Math.max(maxX - minX, 1e-6); // Northing 范围（纵向）
  const rangeY = Math.max(maxY - minY, 1e-6); // Easting 范围（横向）

  // 等比例缩放：Easting 对应画布宽度 W，Northing 对应画布高度 H
  const scale = Math.min((W - 2 * padding) / rangeY, (H - 2 * padding) / rangeX);
  const offX = (W - rangeY * scale) / 2 - minY * scale;
  const offY = (H - rangeX * scale) / 2 - minX * scale;

  const toCanvas = (p) => ({
    cx: p.y * scale + offX,              // 测绘 Y（东）对应画布横向
    cy: H - (p.x * scale + offY)         // 测绘 X（北）对应画布纵向（需翻转以使得大值在上方）
  });

  // 背景
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  // 网格（细）
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  const gridStep = chooseGridStep(rangeY * scale, W);
  // 垂直网格线（对应常数 Y，即 surveying Y = gy）
  for (let gy = Math.floor(minY / gridStep) * gridStep; gy <= maxY; gy += gridStep) {
    const cx = gy * scale + offX;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  }
  // 水平网格线（对应常数 X，即 surveying X = gx）
  for (let gx = Math.floor(minX / gridStep) * gridStep; gx <= maxX; gx += gridStep) {
    const cy = H - (gx * scale + offY);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
  }

  // 导线边
  ctx.strokeStyle = isClosed ? '#0f766e' : '#1d4ed8';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  coordinates.forEach((p, i) => {
    const c = toCanvas(p);
    if (i === 0) ctx.moveTo(c.cx, c.cy);
    else ctx.lineTo(c.cx, c.cy);
  });
  if (isClosed) {
    const c0 = toCanvas(coordinates[0]);
    ctx.lineTo(c0.cx, c0.cy);
  }
  ctx.stroke();

  // 顶点
  coordinates.forEach((p, i) => {
    const c = toCanvas(p);
    // 起点/终点特殊标记
    const isStart = i === 0;
    const isEnd = i === coordinates.length - 1 && !isClosed;
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, isStart ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = isStart ? '#dc2626' : (isEnd ? '#7c3aed' : '#0f766e');
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 标签
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 12px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = p.name || '';
    const labelX = c.cx + 9;
    const labelY = c.cy - 9;
    // 背景框
    const m = ctx.measureText(label);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(labelX - 3, labelY - 8, m.width + 6, 16);
    ctx.fillStyle = isStart ? '#dc2626' : (isEnd ? '#7c3aed' : '#0f172a');
    ctx.fillText(label, labelX, labelY);
  });

  // 比例尺（取 100m 或 10m 或 1m）
  const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const targetPx = W * 0.25;
  const targetMeter = targetPx / scale;
  let scaleStep = niceSteps[niceSteps.length - 1];
  for (const s of niceSteps) {
    if (s >= targetMeter) { scaleStep = s; break; }
  }
  const scaleLen = scaleStep * scale;
  const sx = padding, sy = H - padding / 2;
  ctx.strokeStyle = '#475569'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + scaleLen, sy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx + scaleLen, sy - 4); ctx.lineTo(sx + scaleLen, sy + 4); ctx.stroke();
  ctx.fillStyle = '#0f172a'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.font = '600 11px -apple-system, sans-serif';
  ctx.fillText(`${scaleStep} m`, sx, sy - 6);
}

function chooseGridStep(targetPx, W) {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const ideal = W / 8;
  for (const c of candidates) {
    if (c * 50 >= ideal) return c;
  }
  return candidates[candidates.length - 1];
}
