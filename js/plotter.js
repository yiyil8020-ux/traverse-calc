// 细部测量绘图模块
// 在导线控制网坐标系上标绘细部测量点，手动连线勾画建筑物轮廓
// 支持：方格纸/白纸背景、平移缩放、控制点/细部点标注、连线/闭合、导出 PNG/DXF

export class Plotter {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    // 数据
    this.controlPoints = [];   // [{name, x, y}] 从平差结果导入（三角形标记）
    this.detailPoints = [];    // [{name, x, y}] 细部测量点（圆点标记）
    this.polylines = [];       // [[pointRef, ...], ...] 已完成的折线/多边形
    this.currentPoly = null;   // 当前正在绘制的折线
    this.drawingMode = false;  // 是否在连线模式

    // 视图状态（测量坐标 → 画布像素）
    this.viewScale = 1;        // 像素/米
    this.panX = 0;             // 画布平移（CSS px）
    this.panY = 0;
    this.userScale = null;     // 用户手动设置的比例尺（如 500 表示 1:500），null 表示自动

    // 背景模式
    this.bgMode = 'grid';      // 'grid' | 'plain'

    // 交互状态
    this._dragging = false;
    this._lastPointer = null;
    this._pinchDist = null;
    this._hoverPoint = null;   // 鼠标悬停的点

    // 绑定事件
    this._bindEvents();
  }

  // ─────────────────────────────────────────
  // 数据管理
  // ─────────────────────────────────────────

  /** 从平差结果导入控制点 */
  setControlPoints(coords) {
    this.controlPoints = (coords || []).map(p => ({ name: p.name, x: p.x, y: p.y }));
    // 去重（闭合导线首尾点重复）
    const seen = new Set();
    this.controlPoints = this.controlPoints.filter(p => {
      const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.fitView();
  }

  /** 添加细部点 */
  addDetailPoint(name, x, y) {
    // 检查点名是否重复
    const allNames = this._allPoints().map(p => p.name);
    if (allNames.includes(name)) return false;
    this.detailPoints.push({ name, x: +x, y: +y });
    this.render();
    return true;
  }

  /** 批量添加细部点 (CSV/TSV 格式: name,x,y 每行一个) */
  addDetailPointsBatch(text) {
    const lines = text.trim().split(/\n/);
    let added = 0;
    for (const line of lines) {
      const parts = line.trim().split(/[,\t\s]+/);
      if (parts.length >= 3) {
        const [name, x, y] = parts;
        if (name && !isNaN(+x) && !isNaN(+y)) {
          if (this.addDetailPoint(name, +x, +y)) added++;
        }
      }
    }
    this.render();
    return added;
  }

  /** 删除细部点 */
  removeDetailPoint(name) {
    this.detailPoints = this.detailPoints.filter(p => p.name !== name);
    // 也从折线中移除引用
    this.polylines = this.polylines.map(poly =>
      poly.filter(ref => ref.name !== name)
    ).filter(poly => poly.length >= 2);
    if (this.currentPoly) {
      this.currentPoly = this.currentPoly.filter(ref => ref.name !== name);
    }
    this.render();
  }

  /** 获取所有点（控制点 + 细部点） */
  _allPoints() {
    return [...this.controlPoints, ...this.detailPoints];
  }

  // ─────────────────────────────────────────
  // 连线
  // ─────────────────────────────────────────

  startPolyline() {
    this.drawingMode = true;
    this.currentPoly = [];
    this.render();
  }

  /** 向当前折线添加一个点 */
  _addPointToPoly(point) {
    if (!this.currentPoly) return;
    // 避免连续重复
    if (this.currentPoly.length > 0 &&
        this.currentPoly[this.currentPoly.length - 1].name === point.name) return;
    this.currentPoly.push({ name: point.name, x: point.x, y: point.y });
    this.render();
  }

  /** 闭合当前折线 */
  closePolyline() {
    if (!this.currentPoly || this.currentPoly.length < 3) return;
    this.currentPoly.push({ ...this.currentPoly[0] }); // 首尾相连
    this.polylines.push([...this.currentPoly]);
    this.currentPoly = null;
    this.drawingMode = false;
    this.render();
  }

  /** 结束折线（不闭合） */
  finishPolyline() {
    if (!this.currentPoly || this.currentPoly.length < 2) {
      this.currentPoly = null;
      this.drawingMode = false;
      this.render();
      return;
    }
    this.polylines.push([...this.currentPoly]);
    this.currentPoly = null;
    this.drawingMode = false;
    this.render();
  }

  /** 撤销最后一段线 */
  undoLastSegment() {
    if (this.currentPoly && this.currentPoly.length > 0) {
      this.currentPoly.pop();
      this.render();
    }
  }

  /** 删除最后一条完成的折线 */
  undoLastPolyline() {
    if (this.polylines.length > 0) {
      this.polylines.pop();
      this.render();
    }
  }

  // ─────────────────────────────────────────
  // 视图控制
  // ─────────────────────────────────────────

  setBackground(type) {
    this.bgMode = type;
    this.render();
  }

  /** 设置用户比例尺（如 500 表示 1:500），null 表示自动 */
  setUserScale(scaleVal) {
    this.userScale = scaleVal;
    if (scaleVal) {
      // 1:500 → 每米对应的 CSS 像素数 = canvasWidth / (range * scale)
      // 不改变 panX/panY，只改变 viewScale
      // viewScale = CSS像素 / 米
      // 对于 1:scaleVal 在屏幕上每毫米代表 scaleVal 毫米 → 不太好直接算
      // 改为：重新 fitView 但用固定比例尺
      this._applyUserScale();
    } else {
      this.fitView();
    }
  }

  _applyUserScale() {
    if (!this.userScale) return;
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    // 1:N 比例尺下，1mm 屏幕距离 = N mm 实地距离
    // 假设屏幕 DPI ≈ 96 → 1 CSS px ≈ 0.264 mm
    // 1 CSS px 代表 N * 0.264 mm = N * 0.000264 m 实地距离
    // viewScale = 1 CSS px / (N * 0.000264 m) = 1 / (N * 0.000264) px/m
    // 但这样的比例尺在屏幕上可能太大或太小
    // 更实用的做法：保持用户可理解的方式
    // viewScale (px/m)，用户输入 1:500，意味着 1m 在图上占 1/500 * 1000mm = 2mm
    // 2mm ≈ 7.56 CSS px (at 96 DPI)
    // viewScale = 1000 / N / 0.264 ≈ 3780 / N px/m
    const mmPerPx = 25.4 / 96; // ≈ 0.2646 mm/px
    this.viewScale = 1 / (this.userScale * mmPerPx / 1000);

    // 居中显示所有点
    const pts = this._allPoints();
    if (pts.length === 0) return;
    let sumCx = 0, sumCy = 0;
    for (const p of pts) {
      sumCx += this._surveyToCanvasX(p);
      sumCy += this._surveyToCanvasY(p);
    }
    // 这里需要先计算出不带 pan 的中心，再设置 pan 使中心居中
    // 测量Y → 画布X: p.y * viewScale
    // 测量X → 画布Y: -p.x * viewScale (翻转北向上)
    let avgSurveyX = 0, avgSurveyY = 0;
    for (const p of pts) { avgSurveyX += p.x; avgSurveyY += p.y; }
    avgSurveyX /= pts.length;
    avgSurveyY /= pts.length;
    this.panX = W / 2 - avgSurveyY * this.viewScale;
    this.panY = H / 2 + avgSurveyX * this.viewScale;
    this.render();
  }

  /** 自适应缩放，让所有点都可见 */
  fitView() {
    const pts = this._allPoints();
    if (pts.length === 0) {
      this.viewScale = 1;
      this.panX = 0;
      this.panY = 0;
      this.render();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const padding = 60;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = Math.max(maxX - minX, 1e-6); // Northing (纵)
    const rangeY = Math.max(maxY - minY, 1e-6); // Easting (横)

    // Y 映射画布宽度, X 映射画布高度
    this.viewScale = Math.min(
      (W - 2 * padding) / rangeY,
      (H - 2 * padding) / rangeX
    );

    // 居中
    const centerY = (minY + maxY) / 2; // surveying Y → canvas X
    const centerX = (minX + maxX) / 2; // surveying X → canvas Y (flipped)
    this.panX = W / 2 - centerY * this.viewScale;
    this.panY = H / 2 + centerX * this.viewScale;

    this.render();
  }

  // ─────────────────────────────────────────
  // 坐标转换
  // ─────────────────────────────────────────

  /** 测量坐标 → 画布 CSS 像素 X */
  _surveyToCanvasX(p) {
    return p.y * this.viewScale + this.panX;
  }

  /** 测量坐标 → 画布 CSS 像素 Y */
  _surveyToCanvasY(p) {
    return -p.x * this.viewScale + this.panY;
  }

  /** 画布 CSS 像素 → 测量坐标 */
  _canvasToSurvey(cx, cy) {
    return {
      x: -(cy - this.panY) / this.viewScale,
      y: (cx - this.panX) / this.viewScale
    };
  }

  // ─────────────────────────────────────────
  // 渲染
  // ─────────────────────────────────────────

  render() {
    const canvas = this.canvas;
    const dpr = this.dpr;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width, 300);
    const H = Math.max(rect.height, 400);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1) 背景
    this._drawBackground(ctx, W, H);

    // 2) 坐标系网格 + 刻度
    this._drawGrid(ctx, W, H);

    // 3) 已完成的折线/多边形
    this._drawPolylines(ctx);

    // 4) 当前正在绘制的折线
    this._drawCurrentPoly(ctx);

    // 5) 控制点
    this._drawControlPoints(ctx);

    // 6) 细部点
    this._drawDetailPoints(ctx);

    // 7) 比例尺
    this._drawScaleBar(ctx, W, H);

    // 8) 坐标系标识
    this._drawAxisLabel(ctx, W, H);
  }

  _drawBackground(ctx, W, H) {
    if (this.bgMode === 'grid') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }
  }

  _drawGrid(ctx, W, H) {
    // 计算网格步长（米为单位的整数步长）
    const minPxStep = 20; // 最小像素步长
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let gridStep = candidates[candidates.length - 1];
    for (const c of candidates) {
      if (c * this.viewScale >= minPxStep) { gridStep = c; break; }
    }

    // 可见范围（测量坐标）
    const topLeft = this._canvasToSurvey(0, 0);
    const botRight = this._canvasToSurvey(W, H);
    const survMinY = Math.min(topLeft.y, botRight.y);
    const survMaxY = Math.max(topLeft.y, botRight.y);
    const survMinX = Math.min(topLeft.x, botRight.x);
    const survMaxX = Math.max(topLeft.x, botRight.x);

    if (this.bgMode === 'grid') {
      // 方格纸风格
      const majorEvery = 5; // 每5个小格一条粗线

      // 细线
      ctx.strokeStyle = '#d4edda';
      ctx.lineWidth = 0.5;

      // 竖线（对应 surveying Y 值）
      const startY = Math.floor(survMinY / gridStep) * gridStep;
      for (let gy = startY; gy <= survMaxY; gy += gridStep) {
        const cx = this._surveyToCanvasX({ y: gy });
        if (cx < -1 || cx > W + 1) continue;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
      }

      // 横线（对应 surveying X 值）
      const startX = Math.floor(survMinX / gridStep) * gridStep;
      for (let gx = startX; gx <= survMaxX; gx += gridStep) {
        const cy = this._surveyToCanvasY({ x: gx });
        if (cy < -1 || cy > H + 1) continue;
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
      }

      // 粗线
      const majorStep = gridStep * majorEvery;
      ctx.strokeStyle = '#a3d9a5';
      ctx.lineWidth = 1;

      const startYM = Math.floor(survMinY / majorStep) * majorStep;
      for (let gy = startYM; gy <= survMaxY; gy += majorStep) {
        const cx = this._surveyToCanvasX({ y: gy });
        if (cx < -1 || cx > W + 1) continue;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
      }

      const startXM = Math.floor(survMinX / majorStep) * majorStep;
      for (let gx = startXM; gx <= survMaxX; gx += majorStep) {
        const cy = this._surveyToCanvasY({ x: gx });
        if (cy < -1 || cy > H + 1) continue;
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
      }

      // 坐标刻度（标注在粗线上）
      ctx.fillStyle = '#6b7280';
      ctx.font = '10px -apple-system, "PingFang SC", sans-serif';

      // Y (东) 刻度在底部
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let gy = startYM; gy <= survMaxY; gy += majorStep) {
        const cx = this._surveyToCanvasX({ y: gy });
        if (cx < 30 || cx > W - 10) continue;
        ctx.fillText(this._formatCoord(gy), cx, H - 14);
      }

      // X (北) 刻度在左边
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let gx = startXM; gx <= survMaxX; gx += majorStep) {
        const cy = this._surveyToCanvasY({ x: gx });
        if (cy < 10 || cy > H - 20) continue;
        ctx.fillText(this._formatCoord(gx), 4, cy);
      }
    } else {
      // 白纸模式：只画非常淡的参考线
      ctx.strokeStyle = '#f0f0f0';
      ctx.lineWidth = 0.5;

      const majorStep = gridStep * 5;
      const startYM = Math.floor(survMinY / majorStep) * majorStep;
      for (let gy = startYM; gy <= survMaxY; gy += majorStep) {
        const cx = this._surveyToCanvasX({ y: gy });
        if (cx < -1 || cx > W + 1) continue;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
      }
      const startXM = Math.floor(survMinX / majorStep) * majorStep;
      for (let gx = startXM; gx <= survMaxX; gx += majorStep) {
        const cy = this._surveyToCanvasY({ x: gx });
        if (cy < -1 || cy > H + 1) continue;
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
      }
    }
  }

  _formatCoord(v) {
    if (Math.abs(v) < 0.001) return '0';
    if (Number.isInteger(v)) return v.toString();
    return v.toFixed(1);
  }

  _drawPolylines(ctx) {
    for (const poly of this.polylines) {
      if (poly.length < 2) continue;
      const isClosed = poly.length >= 3 &&
        poly[0].x === poly[poly.length - 1].x &&
        poly[0].y === poly[poly.length - 1].y;

      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const cx = this._surveyToCanvasX(poly[i]);
        const cy = this._surveyToCanvasY(poly[i]);
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }

      if (isClosed) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
        ctx.fill();
      }

      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  _drawCurrentPoly(ctx) {
    if (!this.currentPoly || this.currentPoly.length === 0) return;

    ctx.beginPath();
    for (let i = 0; i < this.currentPoly.length; i++) {
      const cx = this._surveyToCanvasX(this.currentPoly[i]);
      const cy = this._surveyToCanvasY(this.currentPoly[i]);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _isPointInCurrentPoly(p) {
    if (!this.currentPoly || this.currentPoly.length === 0) return false;
    return this.currentPoly.some(cp => cp.name === p.name);
  }

  _drawControlPoints(ctx) {
    for (const p of this.controlPoints) {
      const cx = this._surveyToCanvasX(p);
      const cy = this._surveyToCanvasY(p);
      
      const isSelected = this._isPointInCurrentPoly(p);
      const isLastSelected = this.currentPoly && this.currentPoly.length > 0 && 
                             this.currentPoly[this.currentPoly.length - 1].name === p.name;
                             
      let color = '#dc2626'; // 默认控制点颜色（红色）
      let size = 7;
      if (isSelected) {
        color = '#d97706'; // 选中时变成橙色
      }
      
      this._drawTriangle(ctx, cx, cy, size, color);
      
      // 如果是最后一个选中的点，画一个双层外环/光晕
      if (isLastSelected) {
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      
      this._drawPointLabel(ctx, p, cx, cy, color, isSelected);
    }
  }

  _drawDetailPoints(ctx) {
    for (const p of this.detailPoints) {
      const cx = this._surveyToCanvasX(p);
      const cy = this._surveyToCanvasY(p);

      const isSelected = this._isPointInCurrentPoly(p);
      const isLastSelected = this.currentPoly && this.currentPoly.length > 0 && 
                             this.currentPoly[this.currentPoly.length - 1].name === p.name;

      // 圆点
      ctx.beginPath();
      let radius = 4;
      let color = '#2563eb'; // 默认细部点颜色（蓝色）
      
      if (isSelected) {
        color = '#f59e0b'; // 选中时变成橙色
        radius = 5.5;      // 稍微大一点
      }
      
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 如果是最后一个选中的点，画一个双层外环/光晕
      if (isLastSelected) {
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      this._drawPointLabel(ctx, p, cx, cy, isSelected ? '#d97706' : '#1e40af', isSelected);
    }
  }

  /** 绘制三角形标记 */
  _drawTriangle(ctx, cx, cy, r, color) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx - r * 0.866, cy + r * 0.5);
    ctx.lineTo(cx + r * 0.866, cy + r * 0.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** 绘制点标注（点号 + 坐标） */
  _drawPointLabel(ctx, p, cx, cy, color, isSelected = false) {
    const label = p.name || '';
    const coordText = `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`;

    ctx.font = isSelected ? 'bold 11px -apple-system, "PingFang SC", sans-serif' : '600 11px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    const labelX = cx + 10;
    const labelY = cy - 4;

    // 点名
    const m1 = ctx.measureText(label);
    ctx.fillStyle = isSelected ? 'rgba(254, 243, 199, 0.95)' : 'rgba(255,255,255,0.85)';
    ctx.fillRect(labelX - 2, labelY - 12, m1.width + 4, 14);
    
    if (isSelected) {
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(labelX - 2, labelY - 12, m1.width + 4, 14);
    }
    
    ctx.fillStyle = color;
    ctx.fillText(label, labelX, labelY);

    // 坐标
    ctx.font = '9px -apple-system, "PingFang SC", sans-serif';
    const m2 = ctx.measureText(coordText);
    ctx.fillStyle = isSelected ? 'rgba(254, 243, 199, 0.95)' : 'rgba(255,255,255,0.85)';
    ctx.fillRect(labelX - 2, labelY, m2.width + 4, 12);
    
    if (isSelected) {
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(labelX - 2, labelY, m2.width + 4, 12);
    }
    
    ctx.fillStyle = isSelected ? '#b45309' : '#6b7280';
    ctx.fillText(coordText, labelX, labelY + 11);
  }

  _drawScaleBar(ctx, W, H) {
    // 比例尺
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const targetPx = W * 0.2;
    const targetMeter = targetPx / this.viewScale;
    let scaleStep = niceSteps[niceSteps.length - 1];
    for (const s of niceSteps) {
      if (s >= targetMeter) { scaleStep = s; break; }
    }
    const scaleLen = scaleStep * this.viewScale;
    const sx = 16, sy = H - 20;

    ctx.strokeStyle = '#374151'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + scaleLen, sy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx + scaleLen, sy - 4); ctx.lineTo(sx + scaleLen, sy + 4); ctx.stroke();

    ctx.fillStyle = '#374151';
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${scaleStep} m`, sx, sy - 6);

    // 显示当前比例尺
    if (this.userScale) {
      ctx.textAlign = 'right';
      ctx.fillText(`1:${this.userScale}`, W - 16, sy - 6);
    }
  }

  _drawAxisLabel(ctx, W, H) {
    // 在右上角画一个小坐标系指示
    const ox = W - 50, oy = 30;
    const len = 25;

    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = '#6b7280';
    ctx.font = '600 10px -apple-system, sans-serif';

    // X 轴 (北 → 上)
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - len); ctx.stroke();
    // 箭头
    ctx.beginPath(); ctx.moveTo(ox, oy - len - 4);
    ctx.lineTo(ox - 3, oy - len + 2); ctx.lineTo(ox + 3, oy - len + 2); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('X(N)', ox, oy - len - 5);

    // Y 轴 (东 → 右)
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + len, oy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox + len + 4, oy);
    ctx.lineTo(ox + len - 2, oy - 3); ctx.lineTo(ox + len - 2, oy + 3); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Y(E)', ox + len + 5, oy);
  }

  // ─────────────────────────────────────────
  // 交互事件
  // ─────────────────────────────────────────

  _bindEvents() {
    const c = this.canvas;

    // Pointer events for drag/pan
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    // Wheel zoom
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Touch pinch zoom
    c.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this._onTouchEnd(e));

    // Click for drawing mode
    c.addEventListener('click', (e) => this._onClick(e));
  }

  _getPointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onPointerDown(e) {
    if (e.pointerType === 'touch') return; // handled by touch events
    this._dragging = true;
    this._lastPointer = this._getPointerPos(e);
    this.canvas.setPointerCapture(e.pointerId);
  }

  _onPointerMove(e) {
    if (!this._dragging || e.pointerType === 'touch') return;
    const pos = this._getPointerPos(e);
    const dx = pos.x - this._lastPointer.x;
    const dy = pos.y - this._lastPointer.y;
    this.panX += dx;
    this.panY += dy;
    this._lastPointer = pos;
    this.render();
  }

  _onPointerUp(e) {
    this._dragging = false;
    this._lastPointer = null;
  }

  _onWheel(e) {
    e.preventDefault();
    const pos = this._getPointerPos(e);
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    this._zoomAt(pos.x, pos.y, factor);
  }

  _onTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const t = e.touches;
      this._pinchDist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      this._pinchCenter = {
        x: (t[0].clientX + t[1].clientX) / 2,
        y: (t[0].clientY + t[1].clientY) / 2
      };
    } else if (e.touches.length === 1) {
      this._dragging = true;
      const rect = this.canvas.getBoundingClientRect();
      this._lastPointer = {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
  }

  _onTouchMove(e) {
    if (e.touches.length === 2 && this._pinchDist !== null) {
      e.preventDefault();
      const t = e.touches;
      const newDist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const factor = newDist / this._pinchDist;
      const rect = this.canvas.getBoundingClientRect();
      const cx = (t[0].clientX + t[1].clientX) / 2 - rect.left;
      const cy = (t[0].clientY + t[1].clientY) / 2 - rect.top;
      this._zoomAt(cx, cy, factor);
      this._pinchDist = newDist;
    } else if (e.touches.length === 1 && this._dragging) {
      const rect = this.canvas.getBoundingClientRect();
      const pos = { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
      if (this._lastPointer) {
        const dx = pos.x - this._lastPointer.x;
        const dy = pos.y - this._lastPointer.y;
        this.panX += dx;
        this.panY += dy;
      }
      this._lastPointer = pos;
      this.render();
    }
  }

  _onTouchEnd(e) {
    if (e.touches.length < 2) {
      this._pinchDist = null;
      this._pinchCenter = null;
    }
    if (e.touches.length === 0) {
      this._dragging = false;
      this._lastPointer = null;
    }
  }

  _zoomAt(cx, cy, factor) {
    const oldScale = this.viewScale;
    this.viewScale *= factor;
    // 限制缩放范围
    this.viewScale = Math.max(0.001, Math.min(10000, this.viewScale));
    const realFactor = this.viewScale / oldScale;
    // 以 (cx, cy) 为中心缩放
    this.panX = cx - (cx - this.panX) * realFactor;
    this.panY = cy - (cy - this.panY) * realFactor;
    this.render();
  }

  _onClick(e) {
    if (!this.drawingMode) return;
    const pos = this._getPointerPos(e);
    // 找最近的点
    const hitRadius = 15; // CSS px
    let nearest = null;
    let minDist = Infinity;
    for (const p of this._allPoints()) {
      const cx = this._surveyToCanvasX(p);
      const cy = this._surveyToCanvasY(p);
      const d = Math.hypot(cx - pos.x, cy - pos.y);
      if (d < minDist && d < hitRadius) {
        minDist = d;
        nearest = p;
      }
    }
    if (nearest) {
      this._addPointToPoly(nearest);
    }
  }

  // ─────────────────────────────────────────
  // 导出
  // ─────────────────────────────────────────

  /** 导出为 PNG 数据 URL */
  exportPNG() {
    return this.canvas.toDataURL('image/png');
  }

  /** 导出为 DXF 字符串 (AutoCAD R12 兼容) */
  exportDXF() {
    let dxf = '';

    // HEADER
    dxf += '0\nSECTION\n2\nHEADER\n';
    dxf += '9\n$ACADVER\n1\nAC1009\n'; // R12 format
    dxf += '0\nENDSEC\n';

    // TABLES (minimal)
    dxf += '0\nSECTION\n2\nTABLES\n';
    // Layer table
    dxf += '0\nTABLE\n2\nLAYER\n70\n3\n';
    // Layer: CONTROL
    dxf += '0\nLAYER\n2\nCONTROL\n70\n0\n62\n1\n6\nCONTINUOUS\n'; // red
    // Layer: DETAIL
    dxf += '0\nLAYER\n2\nDETAIL\n70\n0\n62\n5\n6\nCONTINUOUS\n'; // blue
    // Layer: OUTLINE
    dxf += '0\nLAYER\n2\nOUTLINE\n70\n0\n62\n3\n6\nCONTINUOUS\n'; // green
    dxf += '0\nENDTAB\n';
    dxf += '0\nENDSEC\n';

    // ENTITIES
    dxf += '0\nSECTION\n2\nENTITIES\n';

    // 控制点 (POINT + TEXT)
    // DXF 坐标：X=东(surveying Y), Y=北(surveying X)
    for (const p of this.controlPoints) {
      // Point entity
      dxf += `0\nPOINT\n8\nCONTROL\n10\n${p.y.toFixed(4)}\n20\n${p.x.toFixed(4)}\n30\n0.0\n`;
      // Text label
      dxf += `0\nTEXT\n8\nCONTROL\n10\n${(p.y + 0.5).toFixed(4)}\n20\n${(p.x + 0.5).toFixed(4)}\n30\n0.0\n40\n0.5\n1\n${p.name}\n`;
    }

    // 细部点 (POINT + TEXT)
    for (const p of this.detailPoints) {
      dxf += `0\nPOINT\n8\nDETAIL\n10\n${p.y.toFixed(4)}\n20\n${p.x.toFixed(4)}\n30\n0.0\n`;
      dxf += `0\nTEXT\n8\nDETAIL\n10\n${(p.y + 0.5).toFixed(4)}\n20\n${(p.x + 0.5).toFixed(4)}\n30\n0.0\n40\n0.3\n1\n${p.name}\n`;
    }

    // 折线/多边形 (POLYLINE)
    for (const poly of this.polylines) {
      if (poly.length < 2) continue;
      const isClosed = poly.length >= 3 &&
        Math.abs(poly[0].x - poly[poly.length - 1].x) < 1e-6 &&
        Math.abs(poly[0].y - poly[poly.length - 1].y) < 1e-6;

      dxf += `0\nPOLYLINE\n8\nOUTLINE\n66\n1\n70\n${isClosed ? 1 : 0}\n`;
      const pts = isClosed ? poly.slice(0, -1) : poly;
      for (const p of pts) {
        dxf += `0\nVERTEX\n8\nOUTLINE\n10\n${p.y.toFixed(4)}\n20\n${p.x.toFixed(4)}\n30\n0.0\n`;
      }
      dxf += '0\nSEQEND\n8\nOUTLINE\n';
    }

    dxf += '0\nENDSEC\n';
    dxf += '0\nEOF\n';

    return dxf;
  }

  /** 触发文件下载 */
  downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  downloadPNG(filename = '细部测量图.png') {
    const dataUrl = this.exportPNG();
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  downloadDXF(filename = '细部测量图.dxf') {
    this.downloadFile(this.exportDXF(), filename, 'application/dxf');
  }
}
