/*
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

'use strict';

// Simulation section

const canvas = document.getElementsByTagName('canvas')[0];
resizeCanvas();

let config = {
    SIM_RESOLUTION: 512,
    DYE_RESOLUTION: 2048,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 0,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 1.0,
    PRESSURE_ITERATIONS: 20,
    CURL: 40,
    SPLAT_RADIUS: 0.08,
    SPLAT_FORCE: 6000,
    LUT_RESOLUTION: 256,
    DRAG_FORCE: 6000,
    SHADING: false,
    SHADING_INTENSITY: 1.0,
    COLORFUL: false,
    COLOR_UPDATE_SPEED: 2,
    PAUSED: false,
    TICK_RATE: 1.0,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    BLOOM: false,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.8,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: false,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 1.0,
}

function pointerPrototype () {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [30, 0, 300];
}

let pointers = [];
let splatStack = [];
var STARS = []; var FANS = []; var STAR_PICK_RGB = {r:1,g:0.004,b:0}; var STAR_TICK = 0; var _starDown = null; var _starDrag = false;
pointers.push(new pointerPrototype());

const { gl, ext } = getWebGLContext(canvas);

if (isMobile()) {
    config.DYE_RESOLUTION = 512;
}
if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
}

startGUI();

// ── Eraser cursor + logic ─────────────────────────────────────────────────
var ERASER_RADIUS_PX = 40; // visual radius in CSS pixels — single source of truth

// Eraser circle is drawn directly onto _dotCanvas rather than a DOM div.
// This avoids mobile browser synthetic mouse events showing a stuck cursor.
var _eraserCursorX = -999, _eraserCursorY = -999, _eraserCursorVisible = false;
function _eraserCursorShow(x, y) { _eraserCursorX = x; _eraserCursorY = y; _eraserCursorVisible = true; starDrawDots(); }
function _eraserCursorHide()     { if (_eraserCursorVisible) { _eraserCursorVisible = false; starDrawDots(); } }
// Stub so existing deactivateEraser references don't break
var eraserCursor = { style: { display: '' } };

function eraserUVRadius() {
    // Convert the CSS pixel radius to UV space using the canvas's current rendered size.
    // The splat gaussian uses UV coords where y spans 0-1 regardless of aspect ratio,
    // so we convert via canvas height. correctRadius() then handles aspect ratio for x.
    var rect = canvas.getBoundingClientRect();
    return ERASER_RADIUS_PX / rect.height;
}

function eraserApply(clientX, clientY) {
    if (!window.ERASER_ACTIVE) return;
    var rect = canvas.getBoundingClientRect();
    var x = (clientX - rect.left) / rect.width;
    var y = 1.0 - (clientY - rect.top) / rect.height;

    // Clear a circular area of dye by splatting zeroed color over it
    // Use a large negative-value approach: write val=0, sat=0, sc=(0,0) into dye
    gl.disable(gl.BLEND);
    dyeSplatProgram.bind();
    gl.uniform1i(dyeSplatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1f(dyeSplatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(dyeSplatProgram.uniforms.point, x, y);
    gl.uniform3f(dyeSplatProgram.uniforms.color, -1.0, 0.0, 0.0); // sentinel: erase path
    gl.uniform1f(dyeSplatProgram.uniforms.radius, eraserUVRadius());
    blit(dye.write);
    dye.swap();

    // Also zero out velocity within the erased circle.
    // Gaussian sigma = r²/5.3 constrains the tail to fade out at the circle edge.
    var vr = eraserUVRadius();
    var velocityRadius = (vr * vr) / 5.3;
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, 0.0, 0.0, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, velocityRadius);
    blit(velocity.write);
    velocity.swap();

    // Remove any stars or fans within eraser radius
    var removeThreshold = eraserUVRadius() * 1.5;
    STARS = STARS.filter(function(s) {
        var dx = s.x - x, dy = s.y - y;
        return Math.sqrt(dx*dx + dy*dy) > removeThreshold;
    });
    FANS = FANS.filter(function(f) {
        var dx = f.x - x, dy = f.y - y;
        return Math.sqrt(dx*dx + dy*dy) > removeThreshold;
    });
    starDrawDots();
}

// Track real touch activity to block synthetic mouse events on mobile
var _realTouchActive = false;
document.addEventListener('touchstart', function() { _realTouchActive = true; }, { passive: true });
document.addEventListener('touchend',   function() { setTimeout(function() { _realTouchActive = false; }, 500); }, { passive: true });

// Mouse eraser events (desktop only — blocked during touch to prevent synthetic mousemove)
canvas.addEventListener('mousemove', function(e) {
    if (!window.ERASER_ACTIVE || _realTouchActive) return;
    _eraserCursorShow(e.clientX, e.clientY);
    if (e.buttons & 1) eraserApply(e.clientX, e.clientY);
});
canvas.addEventListener('mousedown', function(e) {
    if (!window.ERASER_ACTIVE || e.button !== 0 || _realTouchActive) return;
    eraserApply(e.clientX, e.clientY);
});
canvas.addEventListener('mouseleave', function() {
    _eraserCursorHide();
});

// Touch eraser events
// Tap: erase silently, no circle shown
// Drag: show circle on canvas while moving, hide on lift
var _eraserIsDragging = false;

canvas.addEventListener('touchstart', function(e) {
    if (!window.ERASER_ACTIVE) return;
    _eraserIsDragging = false;
    var t = e.touches[0];
    eraserApply(t.clientX, t.clientY);
}, { passive: true });

canvas.addEventListener('touchmove', function(e) {
    if (!window.ERASER_ACTIVE) return;
    _eraserIsDragging = true;
    var t = e.touches[0];
    eraserApply(t.clientX, t.clientY);
}, { passive: true });

document.addEventListener('touchend', function() {
    if (_eraserIsDragging) {
        _eraserIsDragging = false;
        _eraserCursorHide();
    }
}, { passive: true });
// ── End eraser ────────────────────────────────────────────────────────────

function getWebGLContext (canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
        gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2)
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    }
    else
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    return {
        gl,
        ext: {
            formatRGBA,
            formatRG,
            formatR,
            halfFloatTexType,
            supportLinearFiltering
        }
    };
}

function getSupportedFormat (gl, internalFormat, format, type)
{
    if (!supportRenderTextureFormat(gl, internalFormat, format, type))
    {
        switch (internalFormat)
        {
            case gl.R16F:
                return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F:
                return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:
                return null;
        }
    }

    return {
        internalFormat,
        format
    }
}

function supportRenderTextureFormat (gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
}

function startGUI () {
    // ── Unified Control Panel ──────────────────────────────────────────────
    var css = document.createElement('style');
    css.textContent = `
    #ctrl-panel{position:fixed;top:10px;left:10px;width:310px;font-family:monospace;
      font-size:13px;color:#ccc;z-index:10000;user-select:none}
    #ctrl-panel *{box-sizing:border-box}
    .cp-header{background:rgba(0,0,0,0.88);border:1px solid rgba(255,255,255,0.12);
      border-radius:8px 8px 0 0;padding:6px 8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .cp-tab-bar{display:flex;background:rgba(0,0,0,0.82);border-left:1px solid rgba(255,255,255,0.12);
      border-right:1px solid rgba(255,255,255,0.12)}
    .cp-tab{flex:1;padding:6px 4px;text-align:center;font-size:14px;color:#666;
      cursor:pointer;border-bottom:2px solid transparent;transition:color 0.15s}
    .cp-tab:hover{color:#aaa}
    .cp-tab.active{color:#4af;border-bottom-color:#4af}
    .cp-pane{background:rgba(0,0,0,0.82);border:1px solid rgba(255,255,255,0.12);
      border-top:none;border-radius:0 0 8px 8px;padding:10px 12px;display:none}
    .cp-pane.active{display:block}
    .cp-row{display:grid;grid-template-columns:115px 1fr 48px;align-items:center;
      gap:5px;margin-bottom:6px}
    .cp-lbl{font-size:12px;color:#888}
    .cp-sl{width:100%;accent-color:#4af;cursor:pointer}
    .cp-val{font-size:12px;color:#4af;text-align:right}
    .cp-select{background:#111;color:#ccc;border:1px solid rgba(255,255,255,0.15);
      border-radius:3px;padding:2px 4px;font-size:12px;width:100%;cursor:pointer}
    .cp-check-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer}
    .cp-check-row input{accent-color:#4af;cursor:pointer}
    .cp-check-lbl{font-size:12px;color:#888}
    .cp-sec{font-size:10px;color:#555;letter-spacing:1px;text-transform:uppercase;margin:8px 0 4px}
    .cp-btn{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);
      border-radius:4px;color:#aaa;padding:4px 8px;cursor:pointer;font-size:12px;
      font-family:monospace;margin:2px}
    .cp-btn:hover{background:rgba(255,255,255,0.18);color:#fff}
    .cp-collapse-btn{width:100%;margin-top:8px;background:rgba(255,255,255,0.05);
      border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#888;padding:4px;
      cursor:pointer;font-size:12px;font-family:monospace;text-align:center}
    .cp-collapse-btn:hover{background:rgba(255,255,255,0.12);color:#fff}
    #ctrl-panel.cp-hidden .cp-tab-bar,
    #ctrl-panel.cp-hidden .cp-pane{display:none!important}
    #ctrl-panel.cp-hidden .cp-header{border-radius:8px}
    @media (max-width: 600px) {
      #ctrl-panel{left:0;right:0;top:auto;bottom:0;width:100%;border-radius:0;height:33vh;display:flex;flex-direction:column}
      .cp-header{border-radius:0!important;flex-shrink:0}
      .cp-tab-bar{flex-shrink:0}
      .cp-pane{border-radius:0!important;flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;min-height:0;max-height:none}
      .sp-sl{min-height:28px}
    }
    `;
    document.head.appendChild(css);

    var panel = document.createElement('div');
    panel.id = 'ctrl-panel';
    document.body.appendChild(panel);

    // Header
    var header = document.createElement('div');
    header.className = 'cp-header';

    // Eraser button
    var eraserBtn = document.createElement('button');
    eraserBtn.className = 'cp-btn';
    eraserBtn.style.margin = '0';
    eraserBtn.textContent = '⌫ Eraser';
    eraserBtn.setAttribute('data-eraser-btn', '1');
    window.ERASER_ACTIVE = false;
    eraserBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        window.ERASER_ACTIVE = !window.ERASER_ACTIVE;
        eraserBtn.style.color          = window.ERASER_ACTIVE ? '#f55' : '';
        eraserBtn.style.borderColor    = window.ERASER_ACTIVE ? '#f55' : '';
        eraserBtn.style.background     = window.ERASER_ACTIVE ? 'rgba(255,80,80,0.15)' : '';
        canvas.style.cursor            = window.ERASER_ACTIVE ? 'none' : '';
        if (!window.ERASER_ACTIVE) _eraserCursorHide();
    });

    // Clear Stars/Fans button (header)
    var hClrStarsBtn = document.createElement('button');
    hClrStarsBtn.className = 'cp-btn';
    hClrStarsBtn.style.margin = '0';
    hClrStarsBtn.textContent = 'Clear Stars';
    hClrStarsBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        STARS.length = 0; FANS.length = 0;
        window._moveSelected = null;
        starDrawDots();
    });

    // Clear Dye button (header)
    var hClrDyeBtn = document.createElement('button');
    hClrDyeBtn.className = 'cp-btn';
    hClrDyeBtn.style.margin = '0';
    hClrDyeBtn.textContent = 'Clear Dye';
    hClrDyeBtn.addEventListener('click', function(e) { e.stopPropagation(); clearDye(); });

    // Open/Close button pushed right with spacer
    var hSpacer = document.createElement('span');
    hSpacer.style.flex = '1';
    var hbtn = document.createElement('button');
    hbtn.className = 'cp-btn';
    hbtn.style.margin = '0';
    hbtn.setAttribute('data-toggle-btn', '1');
    hbtn.textContent = 'Close Controls ▲';
    var panelOpen = true;
    hbtn.addEventListener('click', function() {
        panelOpen = !panelOpen;
        panel.classList.toggle('cp-hidden', !panelOpen);
        hbtn.textContent = panelOpen ? 'Close Controls ▲' : 'Open Controls ▼';
    });

    header.appendChild(eraserBtn);
    header.appendChild(hClrStarsBtn);
    header.appendChild(hClrDyeBtn);
    header.appendChild(hSpacer);
    header.appendChild(hbtn);
    panel.appendChild(header);

    // Tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'cp-tab-bar';
    panel.appendChild(tabBar);

    // Pane container
    var paneWrap = document.createElement('div');
    panel.appendChild(paneWrap);

    var tabs = [], panes = [], activeTab = 0;
    function addTab(label) {
        var t = document.createElement('div');
        t.className = 'cp-tab';
        t.textContent = label;
        var idx = tabs.length;
        t.addEventListener('click', function() { switchTab(idx); });
        tabBar.appendChild(t);
        tabs.push(t);

        var pane = document.createElement('div');
        pane.className = 'cp-pane';
        paneWrap.appendChild(pane);
        panes.push(pane);
        return pane;
    }
    function switchTab(idx) {
        tabs.forEach(function(t,i){ t.classList.toggle('active', i===idx); });
        panes.forEach(function(p,i){ p.classList.toggle('active', i===idx); });
        activeTab = idx;
    }

    // ── Helper builders ───────────────────────────────────────────────────
    function makeSlider(pane, label, min, max, value, step, decimals, onChange) {
        var row = document.createElement('div'); row.className = 'cp-row';
        var lbl = document.createElement('span'); lbl.className = 'cp-lbl'; lbl.textContent = label;
        var sl = document.createElement('input');
        sl.type = 'range'; sl.className = 'cp-sl';
        sl.min = min; sl.max = max; sl.value = value; sl.step = step;
        var valEl = document.createElement('span'); valEl.className = 'cp-val';
        valEl.textContent = parseFloat(value).toFixed(decimals);
        sl.addEventListener('input', function() {
            var v = parseFloat(sl.value);
            valEl.textContent = v.toFixed(decimals);
            onChange(v);
        });
        sl.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        row.appendChild(lbl); row.appendChild(sl); row.appendChild(valEl);
        pane.appendChild(row);
        return sl;
    }
    function makeCheckbox(pane, label, value, onChange) {
        var row = document.createElement('label'); row.className = 'cp-check-row';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = value;
        var lbl = document.createElement('span'); lbl.className = 'cp-check-lbl'; lbl.textContent = label;
        cb.addEventListener('change', function() { onChange(cb.checked); });
        row.appendChild(cb); row.appendChild(lbl);
        pane.appendChild(row);
        return cb;
    }
    function makeSelect(pane, label, options, value, onChange) {
        var row = document.createElement('div'); row.className = 'cp-row';
        var lbl = document.createElement('span'); lbl.className = 'cp-lbl'; lbl.textContent = label;
        var sel = document.createElement('select'); sel.className = 'cp-select';
        Object.keys(options).forEach(function(k) {
            var opt = document.createElement('option');
            opt.value = options[k]; opt.textContent = k;
            if (options[k] === value) opt.selected = true;
            sel.appendChild(opt);
        });
        sel.addEventListener('change', function() { onChange(parseInt(sel.value)); });
        sel.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        var spacer = document.createElement('span');
        row.appendChild(lbl); row.appendChild(sel); row.appendChild(spacer);
        pane.appendChild(row);
        return sel;
    }
    function makeSec(pane, text) {
        var d = document.createElement('div'); d.className = 'cp-sec'; d.textContent = text;
        pane.appendChild(d);
    }

    // ── TAB 0: STARS (placeholder — star panel IIFE populates its own DOM) ─
    addTab('Stars');   // panes[0]

    // ── TAB 1: FANS (placeholder — fan panel IIFE populates its own DOM) ──
    addTab('Fans');    // panes[1]

    // ── TAB 2: QUALITY ────────────────────────────────────────────────────
    var qualPane = addTab('Quality');

    makeSelect(qualPane, 'Quality', {'128':128,'256':256,'512':512,'1024':1024,'2048':2048},
        config.DYE_RESOLUTION, function(v){ config.DYE_RESOLUTION = v; initFramebuffers(); });
    makeSelect(qualPane, 'Sim Resolution', {'16':16,'32':32,'64':64,'128':128,'256':256,'512':512},
        config.SIM_RESOLUTION, function(v){ config.SIM_RESOLUTION = v; initFramebuffers(); });

    makeSec(qualPane, 'Simulation');

    var tickSlider = makeSlider(qualPane, 'Tick Rate', 0.05, 3.0, config.TICK_RATE, 0.05, 2,
        function(v){ config.TICK_RATE = v; });

    var pausedCb = makeCheckbox(qualPane, 'Paused', config.PAUSED, function(v){ config.PAUSED = v; });
    setInterval(function(){ pausedCb.checked = config.PAUSED; }, 100);

    // ── TAB 3: GLOBAL CONTROLS ────────────────────────────────────────────
    var globalPane = addTab('Controls');

    makeSlider(globalPane, 'Density Diffuse', 0, 4.0, config.DENSITY_DISSIPATION, 0.01, 2,
        function(v){ config.DENSITY_DISSIPATION = v; });
    makeSlider(globalPane, 'Velocity Diffuse', 0, 4.0, config.VELOCITY_DISSIPATION, 0.01, 2,
        function(v){ config.VELOCITY_DISSIPATION = v; });
    makeSlider(globalPane, 'Pressure', 0, 1.0, config.PRESSURE, 0.01, 2,
        function(v){ config.PRESSURE = v; });
    makeSlider(globalPane, 'Vorticity', 0, 50, config.CURL, 1, 0,
        function(v){ config.CURL = v; });
    makeSlider(globalPane, 'Splat Radius', 0.01, 1.0, config.SPLAT_RADIUS, 0.01, 2,
        function(v){ config.SPLAT_RADIUS = v; });
    makeSlider(globalPane, 'Color Drag Force', 0, 12000, config.DRAG_FORCE, 100, 0,
        function(v){ config.DRAG_FORCE = v; });
    makeCheckbox(globalPane, 'Random Color Drag', config.COLORFUL, function(v){ config.COLORFUL = v; });
    makeSlider(globalPane, 'Color Change Rate', 0.1, 10.0, config.COLOR_UPDATE_SPEED, 0.1, 1,
        function(v){ config.COLOR_UPDATE_SPEED = v; });
    makeCheckbox(globalPane, 'Shading', config.SHADING, function(v){ config.SHADING = v; updateKeywords(); });
    makeSlider(globalPane, 'Shading Intensity', 0.0, 1.0, config.SHADING_INTENSITY, 0.05, 2,
        function(v){ config.SHADING_INTENSITY = v; });

    makeSec(globalPane, 'Bloom');
    makeCheckbox(globalPane, 'Bloom Enabled', config.BLOOM, function(v){ config.BLOOM = v; updateKeywords(); });
    makeSlider(globalPane, 'Bloom Intensity', 0.1, 2.0, config.BLOOM_INTENSITY, 0.05, 2,
        function(v){ config.BLOOM_INTENSITY = v; });
    makeSlider(globalPane, 'Bloom Threshold', 0, 1.0, config.BLOOM_THRESHOLD, 0.01, 2,
        function(v){ config.BLOOM_THRESHOLD = v; });

    makeSec(globalPane, 'Sunrays');
    makeCheckbox(globalPane, 'Sunrays', config.SUNRAYS, function(v){ config.SUNRAYS = v; updateKeywords(); });
    makeSlider(globalPane, 'Sunrays Weight', 0.3, 1.0, config.SUNRAYS_WEIGHT, 0.01, 2,
        function(v){ config.SUNRAYS_WEIGHT = v; });

    // Activate Stars tab by default
    switchTab(0);

    // Expose tab switcher and panes so IIFEs can inject content
    window._cpSwitchTab = switchTab;
    window._cpPanes = panes;

    if (isMobile()) {
        panelOpen = false;
        panel.classList.add('cp-hidden');
        hbtn.textContent = 'Open Controls ▼';
    }
}

function isMobile () {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function captureScreenshot () {
    let res = getResolution(config.CAPTURE_RESOLUTION);
    let target = createFBO(res.width, res.height, ext.formatRGBA.internalFormat, ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);
    render(target);

    let texture = framebufferToTexture(target);
    texture = normalizeTexture(texture, target.width, target.height);

    let captureCanvas = textureToCanvas(texture, target.width, target.height);
    let datauri = captureCanvas.toDataURL();
    downloadURI('fluid.png', datauri);
    URL.revokeObjectURL(datauri);
}

function framebufferToTexture (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length = target.width * target.height * 4;
    let texture = new Float32Array(length);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
    return texture;
}

function normalizeTexture (texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    for (let i = height - 1; i >= 0; i--) {
        for (let j = 0; j < width; j++) {
            let nid = i * width * 4 + j * 4;
            result[nid + 0] = clamp01(texture[id + 0]) * 255;
            result[nid + 1] = clamp01(texture[id + 1]) * 255;
            result[nid + 2] = clamp01(texture[id + 2]) * 255;
            result[nid + 3] = clamp01(texture[id + 3]) * 255;
            id += 4;
        }
    }
    return result;
}

function clamp01 (input) {
    return Math.min(Math.max(input, 0), 1);
}

function textureToCanvas (texture, width, height) {
    let captureCanvas = document.createElement('canvas');
    let ctx = captureCanvas.getContext('2d');
    captureCanvas.width = width;
    captureCanvas.height = height;

    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);

    return captureCanvas;
}

function downloadURI (filename, uri) {
    let link = document.createElement('a');
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

class Material {
    constructor (vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }

    setKeywords (keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++)
            hash += hashCode(keywords[i]);

        let program = this.programs[hash];
        if (program == null)
        {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }

        if (program == this.activeProgram) return;

        this.uniforms = getUniforms(program);
        this.activeProgram = program;
    }

    bind () {
        gl.useProgram(this.activeProgram);
    }
}

class Program {
    constructor (vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = createProgram(vertexShader, fragmentShader);
        this.uniforms = getUniforms(this.program);
    }

    bind () {
        gl.useProgram(this.program);
    }
}

function createProgram (vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.trace(gl.getProgramInfoLog(program));

    return program;
}

function getUniforms (program) {
    let uniforms = [];
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
        let uniformName = gl.getActiveUniform(program, i).name;
        uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
}

function compileShader (type, source, keywords) {
    source = addKeywords(source, keywords);

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.trace(gl.getShaderInfoLog(shader));

    return shader;
};

function addKeywords (source, keywords) {
    if (keywords == null) return source;
    let keywordsString = '';
    keywords.forEach(keyword => {
        keywordsString += '#define ' + keyword + '\n';
    });
    return keywordsString + source;
}

// ── Subtractive Color LUT ────────────────────────────────────────────────
// 2D texture: LUT[hueA][hueB] = subtractive mix result of hueA and hueB
// Both axes are RYB storage hues (0-1). Result stored as (sinH, cosH, sat).
// Built on CPU using canvas2D, uploaded as WebGL texture.

var lutTexture = null;
var lutCanvas  = null; // kept for preview

function rybStoredToDisplayHue(stored) {
    // Invert RYB piecewise map (same as GLSL sc2rgb)
    var rr = [0, 0.0972, 0.1667, 0.3333, 0.5,    0.6667, 0.8333, 1.0];
    var yr = [0, 0.1667, 0.3333, 0.5,    0.5833, 0.6667, 0.8333, 1.0];
    for (var i = 0; i < 7; i++) {
        if (stored >= yr[i] && stored <= yr[i+1]) {
            var t = (stored - yr[i]) / (yr[i+1] - yr[i]);
            return rr[i] + t * (rr[i+1] - rr[i]);
        }
    }
    return stored;
}

function displayHueToRybStored(display) {
    // Forward RYB piecewise map
    var rr = [0, 0.0972, 0.1667, 0.3333, 0.5,    0.6667, 0.8333, 1.0];
    var yr = [0, 0.1667, 0.3333, 0.5,    0.5833, 0.6667, 0.8333, 1.0];
    for (var i = 0; i < 7; i++) {
        if (display >= rr[i] && display <= rr[i+1]) {
            var t = (display - rr[i]) / (rr[i+1] - rr[i]);
            return yr[i] + t * (yr[i+1] - yr[i]);
        }
    }
    return display;
}

function subtractiveBlend(h1stored, h2stored) {
    // Map RYB stored hue (0-1) to a paint-accurate pigment RGB
    // so Mixbox (Kubelka-Munk) operates on real pigment colors.
    // HSV colors give wrong results (e.g. HSV violet is electric purple,
    // not a real paint violet — causing yellow+violet to mix green).
    //
    // Anchor pigments at key RYB stored hues (matching real paint tubes):
    //   0.000 = Red       (179,0,0)
    //   0.167 = Orange    (255,100,0)
    //   0.333 = Yellow    (255,220,0)
    //   0.500 = Green     (0,140,40)
    //   0.583 = Cyan      (0,170,160)
    //   0.667 = Blue      (0,40,170)
    //   0.833 = Violet    (110,0,170)
    //   1.000 = Red       (179,0,0)
    function rybHueToPigmentRgb(h) {
        h = ((h % 1.0) + 1.0) % 1.0;
        var stops = [
            [0.000, [179,  0,   0  ]],  // Red
            [0.167, [255, 100,  0  ]],  // Orange
            [0.333, [255, 220,  0  ]],  // Yellow
            [0.500, [0,   140,  40 ]],  // Green
            [0.583, [0,   170, 160 ]],  // Cyan
            [0.667, [0,    20, 170 ]],  // Blue (ultramarine)
            [0.750, [110,   0, 170 ]],  // Violet (dioxazine) — key fix
            [0.833, [165,   0, 100 ]],  // Red-Violet/Magenta
            [1.000, [179,   0,   0 ]],  // Red (wrap)
        ];
        for (var i = 0; i < stops.length - 1; i++) {
            if (h >= stops[i][0] && h <= stops[i+1][0]) {
                var t = (h - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
                var a = stops[i][1], b = stops[i+1][1];
                return [
                    Math.round(a[0] + t*(b[0]-a[0])),
                    Math.round(a[1] + t*(b[1]-a[1])),
                    Math.round(a[2] + t*(b[2]-a[2]))
                ];
            }
        }
        return [179, 0, 0];
    }

    var rgb1 = rybHueToPigmentRgb(h1stored);
    var rgb2 = rybHueToPigmentRgb(h2stored);
    var c1 = 'rgb('+rgb1[0]+','+rgb1[1]+','+rgb1[2]+')';
    var c2 = 'rgb('+rgb2[0]+','+rgb2[1]+','+rgb2[2]+')';

    var mixed;
    if (window.mixbox && window.mixbox.lerp) {
        var res = window.mixbox.lerp(c1, c2, 0.5);
        var m = res.toString().match(/(\d+),\s*(\d+),\s*(\d+)/);
        mixed = m ? [parseInt(m[1]),parseInt(m[2]),parseInt(m[3])] : [128,128,128];
    } else {
        // Fallback: geometric mean (subtractive approximation)
        mixed = [
            Math.round(Math.sqrt(rgb1[0]*rgb2[0])),
            Math.round(Math.sqrt(rgb1[1]*rgb2[1])),
            Math.round(Math.sqrt(rgb1[2]*rgb2[2]))
        ];
    }

    // Convert mixed RGB back to RYB stored hue + sat + val
    var r=mixed[0]/255, g=mixed[1]/255, b=mixed[2]/255;
    var mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn, hD=0;
    if(d>0.001){
        if(mx===r) hD=((g-b)/d+6)%6/6;
        else if(mx===g) hD=((b-r)/d+2)/6;
        else hD=((r-g)/d+4)/6;
    }
    var sat=(mx<0.001)?0:d/mx;
    var val=Math.max(0.40,mx*0.92);
    return {h:displayHueToRybStored(hD)%1.0, s:sat, v:val};
}
function hsvToRgb255(h, s, v) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f*s), t = v * (1 - (1-f)*s);
    var r, g, b;
    switch(i % 6) {
        case 0: r=v; g=t; b=p; break; case 1: r=q; g=v; b=p; break;
        case 2: r=p; g=v; b=t; break; case 3: r=p; g=q; b=v; break;
        case 4: r=t; g=p; b=v; break; case 5: r=v; g=p; b=q; break;
    }
    return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

function buildLUT() {
    var N = config.LUT_RESOLUTION; // e.g. 64
    lutCanvas = document.createElement('canvas');
    lutCanvas.width  = N;
    lutCanvas.height = N;
    var ctx = lutCanvas.getContext('2d');
    var img = ctx.createImageData(N, N);

    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            var h1 = x / N; // RYB stored hue 0-1
            var h2 = y / N;
            var res = subtractiveBlend(h1, h2);
            // Convert result to display RGB for preview
            var dispH = rybStoredToDisplayHue(res.h);
            var rgb = hsvToRgb255(dispH, res.s, res.v || 0.85);
            var idx = (y * N + x) * 4;
            img.data[idx]   = rgb[0];
            img.data[idx+1] = rgb[1];
            img.data[idx+2] = rgb[2];
            img.data[idx+3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    // Build texture data: encode SC and sat as UNSIGNED_BYTE (0-255)
    // R = sin(hue*2PI) mapped 0-255 (128=0, 0=-1, 255=+1)
    // G = cos(hue*2PI) mapped 0-255
    // B = saturation * 255
    // A = 255
    var texData = new Uint8Array(N * N * 4);
    for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
            var h1 = x / N;
            var h2 = y / N;
            var res = subtractiveBlend(h1, h2);
            var angle = res.h * Math.PI * 2;
            var i = (y * N + x) * 4;
            texData[i]   = Math.round((Math.sin(angle) * 0.5 + 0.5) * 255);
            texData[i+1] = Math.round((Math.cos(angle) * 0.5 + 0.5) * 255);
            texData[i+2] = Math.round(res.s * 255);
            texData[i+3] = Math.round((res.v || 0.85) * 255); // val in alpha
        }
    }

    // Upload as standard UNSIGNED_BYTE texture — no float extension needed
    if (!lutTexture) lutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, texData);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (window.updateLUTPreview) updateLUTPreview();
}

// ── LUT Preview Popup ─────────────────────────────────────────────────────
function buildLUTPreviewUI() {
    // Small button in star panel area — added after star panel builds
    var btn = document.createElement('button');
    btn.textContent = '🎨 LUT';
    btn.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:9999;' +
        'background:rgba(30,30,30,0.9);color:#ccc;border:1px solid #555;' +
        'padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;';
    document.body.appendChild(btn);

    var popup = document.createElement('div');
    popup.style.cssText = 'position:fixed;bottom:50px;right:10px;z-index:9998;' +
        'background:#111;border:1px solid #444;border-radius:6px;padding:8px;' +
        'display:none;box-shadow:0 4px 16px rgba(0,0,0,0.7);';

    var title = document.createElement('div');
    title.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:6px;text-align:center;';
    title.textContent = 'Subtractive Mix LUT';
    popup.appendChild(title);

    var previewCanvas = document.createElement('canvas');
    previewCanvas.width  = 256;
    previewCanvas.height = 256;
    previewCanvas.style.cssText = 'display:block;border-radius:4px;image-rendering:pixelated;';
    popup.appendChild(previewCanvas);

    var info = document.createElement('div');
    info.style.cssText = 'color:#777;font-size:10px;margin-top:5px;text-align:center;';
    info.textContent = 'X/Y axes = hue  ·  center = mix result';
    popup.appendChild(info);

    document.body.appendChild(popup);

    btn.addEventListener('click', function() {
        popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
        if (popup.style.display === 'block') updateLUTPreview();
    });

    window.updateLUTPreview = function() {
        if (popup.style.display === 'none' || !lutCanvas) return;
        // Draw LUT onto preview canvas (scaled up to 256px)
        // Apply "quantization" effect based on blend strength:
        // low blend = coarse LUT (few distinct colors), high = fine
        var ctx = previewCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        // Draw the actual LUT canvas scaled to 256x256
        ctx.drawImage(lutCanvas, 0, 0, 256, 256);
        // Overlay axis labels
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 248, 256, 8);
        ctx.fillStyle = '#888';
        ctx.font = '9px monospace';
        ctx.fillText('Hue A →', 2, 255);
        // Show current resolution
        info.textContent = 'LUT ' + config.LUT_RESOLUTION + 'x' + config.LUT_RESOLUTION;
    };
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`);

const copyShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        gl_FragColor = texture2D(uTexture, vUv);
    }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`);

const colorShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`);

const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`);


const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform sampler2D uLUT;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;
    uniform float uShadingIntensity;

    vec3 linearToGamma (vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    // Recover RYB-stored hue (0-1) from SC unit vector
    float scToHue (vec2 sc) {
        return mod(atan(sc.x, sc.y) / 6.28318530718 + 1.0, 1.0);
    }

    // Invert RYB map: stored hue -> display RGB hue
    float rybToDisplay (float hueStored) {
        float hue = hueStored;
        if      (hueStored <= 0.1667) { float t=(hueStored-0.0)   /0.1667; hue=0.0    +t*0.0972; }
        else if (hueStored <= 0.3333) { float t=(hueStored-0.1667)/0.1666; hue=0.0972 +t*0.0695; }
        else if (hueStored <= 0.5)    { float t=(hueStored-0.3333)/0.1667; hue=0.1667 +t*0.1666; }
        else if (hueStored <= 0.5833) { float t=(hueStored-0.5)   /0.0833; hue=0.3333 +t*0.1667; }
        else if (hueStored <= 0.6667) { float t=(hueStored-0.5833)/0.0834; hue=0.5    +t*0.1667; }
        else if (hueStored <= 0.8333) { float t=(hueStored-0.6667)/0.1666; hue=0.6667 +t*0.1666; }
        else                          { float t=(hueStored-0.8333)/0.1667; hue=0.8333 +t*0.1667; }
        return fract(hue);
    }

    vec3 hsvToRgb (float h, float s, float v) {
        vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 p = abs(fract(vec3(h) + K.xyz) * 6.0 - K.www);
        return v * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), s);
    }

    // Decode SC dye buffer to RGB.
    // When SC magnitude is low (complements cancelled), sample the LUT
    // using the two dominant neighbor hues to get the correct muddy brown.
    vec3 sc2rgb (vec4 sc, vec2 neighborHues) {
        float val = sc.a;
        if (val < 0.02) return vec3(0.0);
        float mag = length(sc.rg);
        float sat = sc.b;

        // Achromatic pixel: low SC magnitude AND low saturation
        // This is white/grey dye (not a complement cancellation).
        // Render as desaturated brightness — pure white at sat=0,
        // tinted white as saturation increases from mixing with color.
        if (mag < 0.08 && sat < 0.15) {
            if (sat < 0.02) return vec3(val);  // pure white/grey
            // Slightly tinted white — has picked up some hue from neighbors
            float tintHue = rybToDisplay(scToHue(sc.rg / max(mag, 0.001)));
            return hsvToRgb(tintHue, sat * 3.0, val);  // desaturated tint
        }

        if (mag < 0.25) {
            // SC vectors have partially or fully cancelled — complements met.
            // Sample LUT with the two neighbor hues to get subtractive result.
            vec4 lutSample = texture2D(uLUT, neighborHues);
            // Decode LUT: R/G are sin/cos 0-1 (UNSIGNED_BYTE normalized), B=sat, A=val
            vec2 lutSC = lutSample.rg * 2.0 - 1.0;
            float lutHueStored = scToHue(lutSC);
            float lutHueDisplay = rybToDisplay(lutHueStored);
            float lutSat = lutSample.b;
            float lutVal = lutSample.a;
            float finalSat = lutSat * max(sc.b, 0.3);
            finalSat = clamp(finalSat, 0.0, lutSat);
            // Scale by pixel's own val so dark edge pixels stay dark (not lifted to 0.38)
            // But don't let lutVal darken below what the pixel already is
            float mixedBrightness = val * max(lutVal, 0.5);
            vec3 mudColor = hsvToRgb(lutHueDisplay, finalSat, mixedBrightness);
            float blend = smoothstep(0.0, 0.25, mag);
            float dispHue = rybToDisplay(scToHue(sc.rg / max(mag, 0.001)));
            vec3 vividColor = hsvToRgb(dispHue, sc.b, val);
            return mix(mudColor, vividColor, blend);
        }

        // Normal pixel — but check if it's sitting between two complements
        // Only correct pixels that are already desaturated/mixed, not pure vivid ones
        float h0 = scToHue(sc.rg / max(mag, 0.001));
        float h1n = neighborHues.x;
        float h2n = neighborHues.y;
        float neighborDist = abs(h1n - h2n);
        if (neighborDist > 0.5) neighborDist = 1.0 - neighborDist;
        // Only apply if neighbors are near-complements AND this pixel has reduced magnitude
        // (meaning it's already in a mixed zone, not a pure color at a boundary)
        if (neighborDist > 0.20 && mag < 0.80) {
            vec4 lutSample = texture2D(uLUT, neighborHues);
            vec2 lutSC2 = lutSample.rg * 2.0 - 1.0;
            float lutH = rybToDisplay(scToHue(lutSC2));
            float lutSat2 = lutSample.b;
            float lutVal2 = max(lutSample.a, 0.35);
            // Correction strength: zero at mag=0.75, full at mag=0
            // Also scales with how complementary the neighbors are
            float compStrength = clamp((neighborDist - 0.20) / 0.20, 0.0, 1.0);
            compStrength *= clamp(1.0 - mag / 0.80, 0.0, 1.0);
            compStrength *= compStrength * 0.9;
            float dispHue0 = rybToDisplay(h0);
            vec3 vividC = hsvToRgb(dispHue0, sc.b, val);
            vec3 mudC = hsvToRgb(lutH, lutSat2, val * max(lutVal2, 0.5));
            return mix(vividC, mudC, compStrength);
        }

        // Normal vivid pixel: decode hue and render
        float hueStored = scToHue(sc.rg);
        float hue = rybToDisplay(hueStored);
        return hsvToRgb(hue, sc.b, val);
    }

    void main () {
        vec4 sc = texture2D(uTexture, vUv);

        // Compute neighbor hues for LUT lookup (used when sc mag is low)
        // Find the two most vivid neighbors and use their hues as LUT coords
        vec4 scL = texture2D(uTexture, vL);
        vec4 scR = texture2D(uTexture, vR);
        vec4 scT = texture2D(uTexture, vT);
        vec4 scB = texture2D(uTexture, vB);
        float wL = length(scL.rg) * scL.b;
        float wR = length(scR.rg) * scR.b;
        float wT = length(scT.rg) * scT.b;
        float wB = length(scB.rg) * scB.b;
        // Sort to find top 2 vivid neighbors
        vec4 n1 = scL; float w1 = wL;
        if (wR > w1) { n1 = scR; w1 = wR; }
        if (wT > w1) { n1 = scT; w1 = wT; }
        if (wB > w1) { n1 = scB; w1 = wB; }
        vec4 n2 = scL; float w2 = (scL != n1) ? wL : 0.0;
        if (scR != n1 && wR > w2) { n2 = scR; w2 = wR; }
        if (scT != n1 && wT > w2) { n2 = scT; w2 = wT; }
        if (scB != n1 && wB > w2) { n2 = scB; w2 = wB; }
        float h1 = scToHue(n1.rg);
        float h2 = scToHue(n2.rg);
        vec2 neighborHues = vec2(h1, h2);

        vec3 c = sc2rgb(sc, neighborHues);

    #ifdef SHADING
        vec3 lc = sc2rgb(scL, neighborHues);
        vec3 rc = sc2rgb(scR, neighborHues);
        vec3 tc = sc2rgb(scT, neighborHues);
        vec3 bc = sc2rgb(scB, neighborHues);

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        c *= mix(1.0, diffuse, uShadingIntensity);
    #endif

    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
    #endif

    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
    #ifdef BLOOM
        bloom *= sunrays;
    #endif
    #endif

    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif

        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`);

const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum;
    }
`);

const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum * intensity;
    }
`);

const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec4 c = texture2D(uTexture, vUv);
        float br = max(c.r, max(c.g, c.b));
        c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
        gl_FragColor = c;
    }
`);

const sunraysShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;

    #define ITERATIONS 16

    void main () {
        float Density = 0.3;
        float Decay = 0.95;
        float Exposure = 0.7;

        vec2 coord = vUv;
        vec2 dir = vUv - 0.5;

        dir *= 1.0 / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;

        float color = texture2D(uTexture, vUv).a;

        for (int i = 0; i < ITERATIONS; i++)
        {
            coord -= dir;
            float col = texture2D(uTexture, coord).a;
            color += col * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }

        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`);

// Velocity splat: original additive blending unchanged
const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        float falloff = exp(-dot(p, p) / radius);
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + falloff * color, 1.0);
    }
`);

// Dye splat: writes into SC (sin/cos hue) dye buffer.
// Dye layout: R=sin(hue*2PI), G=cos(hue*2PI), B=saturation, A=value
// Storing hue as a unit vector means advection interpolates it linearly
// with no ambiguity — yellow+blue interpolates to green naturally.
const dyeSplatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;  // r=hue(0-1), g=sat, b=val
    uniform vec2 point;
    uniform float radius;

    // Nonlinear hue remap: spreads the wheel so no two primary/secondary
    // RYB color wheel remap: maps RGB hues to RYB storage hues so that
    // all three paint primaries (Red, Yellow, Blue) are 120 degrees apart.
    // This makes Red+Yellow->Orange, Yellow+Blue->Green, Red+Blue->Purple
    // all blend at identical speed with equal vector magnitude (0.5).
    // Control points: (RGB_hue -> RYB_hue) in 0-1 range
    float remapHue(float h) {
        h = fract(h);
        // Piecewise linear RYB map (8 segments)
        // RGB: 0/360, 35, 60, 120, 180, 240, 300, 360
        // RYB: 0/360, 60, 120, 180, 210, 240, 300, 360
        if      (h <= 0.0972) return 0.0    + (h-0.0)   /0.0972 * 0.1667;
        else if (h <= 0.1667) return 0.1667 + (h-0.0972)/0.0695 * 0.1666;
        else if (h <= 0.3333) return 0.3333 + (h-0.1667)/0.1666 * 0.1667;
        else if (h <= 0.5)    return 0.5    + (h-0.3333)/0.1667 * 0.0833;
        else if (h <= 0.6667) return 0.5833 + (h-0.5)   /0.1667 * 0.0834;
        else if (h <= 0.8333) return 0.6667 + (h-0.6667)/0.1666 * 0.1666;
        else                  return 0.8333 + (h-0.8333)/0.1667 * 0.1667;
    }

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        float falloff = exp(-dot(p, p) / radius);

        // Skip the gaussian tail entirely — only write where falloff is meaningful.
        // This prevents the tiny tail from permanently raising sat/val across
        // the whole screen every frame stars emit.
        if (falloff < 0.005) {
            gl_FragColor = texture2D(uTarget, vUv);
            return;
        }

        vec4 base = texture2D(uTarget, vUv);

        // ERASE: sentinel color.r = -1.0 (impossible for real hues which are 0-1).
        // This avoids any ambiguity with hue 0° (red) on mobile GPU drivers.
        if (color.r < -0.5) {
            float dist = length(p);
            if (dist > radius) {
                gl_FragColor = base;
                return;
            }
            // Inside circle: erase with a thin softened edge
            float edgeSoft = 1.0 - smoothstep(radius * 0.85, radius, dist);
            gl_FragColor = vec4(base.rg * (1.0 - edgeSoft), base.b * (1.0 - edgeSoft), base.a * (1.0 - edgeSoft));
            return;
        }

        // Remap hue before encoding as unit vector
        float remapped = remapHue(color.r);
        float angle = remapped * 6.28318530718;
        vec2 targetSC = vec2(sin(angle), cos(angle));

        // Blend sin/cos hue vector toward target
        vec2 existingSC = base.rg;
        float existingMag = length(existingSC);
        vec2 newSC;
        if (existingMag < 0.01) {
            newSC = targetSC * falloff;
        } else {
            newSC = mix(existingSC, targetSC, falloff);
        }

        // WHITE: sat=0 → brighten + desaturate existing dye, no hue imprint
        if (color.g < 0.05) {
            float newV2 = min(base.a + color.b * falloff, 1.0);
            float newS2 = max(base.b - color.b * falloff * 0.6, 0.0);
            gl_FragColor = vec4(base.rg, newS2, newV2);
            return;
        }

        // Normal colored star
        float newV = min(base.a + color.b * falloff, 1.0);
        float newS = min(base.b + color.g * falloff, 1.0);
        gl_FragColor = vec4(newSC, newS, newV);
    }
`);

const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;
    uniform int isDye;

    // Bilinear interpolation for SC dye buffer (sin/cos hue encoding).
    // All 4 channels (sinH, cosH, sat, val) interpolate linearly.
    // Because hue is stored as a unit vector, linear interpolation of
    // sin+cos components is equivalent to correct circular interpolation
    // with no ambiguity — yellow+blue gives green, not red.
    vec4 bilerpHSV (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        // Standard bilinear on all 4 channels
        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 iuv = floor(st);
        vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    uniform sampler2D uLUT; // subtractive color LUT

    // Get hue 0-1 from SC vector
    float scHue (vec2 sc) {
        // atan(0,1)=0 → 0/TWO_PI+1 = 1.0 exactly, and fract(1.0) is
        // implementation-defined on some GPUs (returns 1.0 not 0.0).
        // mod(x, 1.0) is more reliable: mod(1.0, 1.0) = 0.0 always.
        return mod(atan(sc.x, sc.y) / 6.28318530718 + 1.0, 1.0);
    }

    void main () {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        float decay = 1.0 + dissipation * dt;
        if (isDye == 1) {
            // Sample the four bilinear neighbors individually
            vec2 st = coord / dyeTexelSize - 0.5;
            vec2 iuv = floor(st);
            vec2 fuv = fract(st);
            vec4 a = texture2D(uSource, (iuv + vec2(0.5,0.5)) * dyeTexelSize);
            vec4 b = texture2D(uSource, (iuv + vec2(1.5,0.5)) * dyeTexelSize);
            vec4 c = texture2D(uSource, (iuv + vec2(0.5,1.5)) * dyeTexelSize);
            vec4 d = texture2D(uSource, (iuv + vec2(1.5,1.5)) * dyeTexelSize);

            // Standard bilinear for val and sat
            vec4 result = mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
            float newVal = result.a / decay;
            float newSat = result.b / decay;

            // Check SC magnitude — if low, complements are cancelling here
            float mag = length(result.rg);

            if (mag < 0.65 && newVal > 0.02) {
                // Find the two most vivid samples by weight (vividness = mag*sat*val)
                float wa = length(a.rg) * a.b * a.a;
                float wb = length(b.rg) * b.b * b.a;
                float wc = length(c.rg) * c.b * c.a;
                float wd = length(d.rg) * d.b * d.a;

                // Pick top two by index to avoid float equality comparison bugs
                // Sort all four weights, track which sample each belongs to
                // Use hues from the two highest-weighted samples
                float hA = scHue(a.rg);
                float hB = scHue(b.rg);
                float hC = scHue(c.rg);
                float hD = scHue(d.rg);

                // Weighted average of all hues as SC vectors (circular mean)
                // This correctly handles the case where neighbors cancel
                vec2 scA = vec2(sin(hA*6.28318), cos(hA*6.28318)) * wa;
                vec2 scB = vec2(sin(hB*6.28318), cos(hB*6.28318)) * wb;
                vec2 scC = vec2(sin(hC*6.28318), cos(hC*6.28318)) * wc;
                vec2 scD = vec2(sin(hD*6.28318), cos(hD*6.28318)) * wd;
                float wTotal = wa + wb + wc + wd;

                if (wTotal > 0.02) {
                    // Find dominant hue (highest weight) and secondary hue (second highest)
                    float w1 = wa; float h1 = hA;
                    if (wb > w1) { w1 = wb; h1 = hB; }
                    if (wc > w1) { w1 = wc; h1 = hC; }
                    if (wd > w1) { w1 = wd; h1 = hD; }

                    // Second: highest weight with meaningfully different hue from h1
                    float w2 = 0.0; float h2 = h1;
                    float hueDiffA = abs(hA - h1); if (hueDiffA > 0.5) hueDiffA = 1.0 - hueDiffA;
                    float hueDiffB = abs(hB - h1); if (hueDiffB > 0.5) hueDiffB = 1.0 - hueDiffB;
                    float hueDiffC = abs(hC - h1); if (hueDiffC > 0.5) hueDiffC = 1.0 - hueDiffC;
                    float hueDiffD = abs(hD - h1); if (hueDiffD > 0.5) hueDiffD = 1.0 - hueDiffD;
                    // Only consider neighbors with meaningfully different hue (>5% of wheel)
                    if (hueDiffA > 0.05 && wa > w2) { w2 = wa; h2 = hA; }
                    if (hueDiffB > 0.05 && wb > w2) { w2 = wb; h2 = hB; }
                    if (hueDiffC > 0.05 && wc > w2) { w2 = wc; h2 = hC; }
                    if (hueDiffD > 0.05 && wd > w2) { w2 = wd; h2 = hD; }

                    if (w2 > 0.01) {
                        // Two distinct hues found — sample LUT for their subtractive mix
                        vec4 lutResult = texture2D(uLUT, vec2(h1, h2));
                        // Decode: R=sin*0.5+0.5, G=cos*0.5+0.5, B=sat, A=val
                        vec2 lutSC = normalize(lutResult.rg * 2.0 - 1.0);
                        float lutSat = lutResult.b;
                        float lutVal = lutResult.a;

                        // How far apart are the two hues on the color wheel?
                        float hueDist = abs(h1 - h2);
                        if (hueDist > 0.5) hueDist = 1.0 - hueDist;

                        // Blend strength based on BOTH magnitude cancellation AND
                        // hue complementarity. Near-complements (hueDist > 0.3) get
                        // LUT correction even when magnitude hasn't fully cancelled yet.
                        // This prevents yellow+violet from passing through green.
                        float magBlend = 1.0 - (mag / 0.65);
                        magBlend = clamp(magBlend * magBlend, 0.0, 1.0);

                        // Additional blend for complement pairs based on hue distance:
                        // hueDist=0.25 → complementBlend=0, hueDist=0.5 → complementBlend=1
                        float complementBlend = clamp((hueDist - 0.20) / 0.20, 0.0, 1.0);
                        complementBlend *= complementBlend;

                        // Weight by the minority color's contribution (w2/wTotal)
                        // Only correct when both colors are meaningfully present (>15% minority)
                        float minorityWeight = clamp((w2 / (wTotal + 0.001) - 0.08) / 0.15, 0.0, 1.0);
                        complementBlend *= minorityWeight;

                        // Combined blend: either path triggers correction
                        float lutBlend = clamp(max(magBlend, complementBlend), 0.0, 1.0);
                        // Square it for faster onset, then boost overall strength
                        lutBlend = clamp(lutBlend * lutBlend * 1.4, 0.0, 1.0);

                        // Write LUT SC at higher magnitude so mixed color is vivid
                        float targetMag = mix(mag, 0.7, lutBlend);
                        vec2 finalSC = mix(result.rg, lutSC * targetMag, lutBlend);
                        newSat = mix(newSat, lutSat, lutBlend);
                        float mixedVal = newVal * max(lutVal, 0.5);
                        newVal = mix(newVal, mixedVal, lutBlend);

                        if (newVal < 0.02) { newVal = 0.0; newSat = 0.0; finalSC = vec2(0.0); }
                        gl_FragColor = vec4(finalSC, newSat, newVal);
                        return;
                    }
                }
            }

            if (newVal < 0.02) { newVal = 0.0; newSat = 0.0; }
            gl_FragColor = vec4(result.r, result.g, newSat, newVal);
        } else {
            vec4 result = bilerp(uSource, coord, texelSize);
            gl_FragColor = result / decay;
        }
    }`,
    null
);

const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`);

const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`);

const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`);

const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target, clear = false) => {
        if (target == null)
        {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        else
        {
            gl.viewport(0, 0, target.width, target.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear)
        {
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        // CHECK_FRAMEBUFFER_STATUS();
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
})();

function CHECK_FRAMEBUFFER_STATUS () {
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE)
        console.trace("Framebuffer error: " + status);
}

let dye;
let velocity;
let divergence;
let curl;
let pressure;
let bloom;
let bloomFramebuffers = [];
let sunrays;
let sunraysTemp;

let ditheringTexture = createTextureAsync('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAbkklEQVR4nD3bZdhVVRMG4KVY2Ah2t2Jid3diYRd2d7fYYAvYIAaCCioo2I2BYHd3d+f43XNd870/99l7rYknZu1z3rbmmmvGb7/9FmPHjo077rgjlltuuejbt2/stttucfbZZ8fxxx8fq622Whx00EExfvz4mHXWWeONN96Iyy+/PPbZZ5/4888/Y7PNNsv7Pv744+jQoUNstdVW8cUXX8TAgQNjscUWix9//DEOPPDAWGihheKkk06KnXfeOZ5++umYd95547PPPov77rsv/v3333juuefi0ksvjammmiq23XbbOOuss+LXX3+NJ554ImN7//33Y+WVV46ddtopzjjjjBgyZEh069YtRo0aFX369Mm9V1pppbjxxhszzmeffTamnHLKjOfxxx+PiSaaKAYMGJD3W8O6bejQofnwTDPNFKecckom6k9wL774Ymy++ebxyCOPxJ133hnnn39+3HzzzTHFFFPEuuuuG6effnrcfffduZnAl1hiiXjooYfCmmuttVYmIrlNNtkkWmu54XXXXZefXXLJJXHrrbfGvvvum4kKfPfdd8/1Pv/88xg0aFAcccQRMc8888SGG24YE044YXz77bd5/f77749JJpkkfvrpp3jzzTdjzjnnzHjE+fPPP2fxrC++33//Pff54IMPcq+vvvoqpp9++nzuqKOOivb1119nFT101VVXZRctNs0008RNN92UDyjOkksuGT169IhjjjkmA3nsscdihx12yEDeeeedrPp+++0XXbp0yQIee+yxGcRLL70Up512Wmy33XZhL5svs8wy8csvv0SnTp0yuWuvvTb3mHTSSePkk0+ORRZZJNZYY4148MEHM9Bdd901Tj311JhxxhkTJYsvvngcdthhcfHFF8c222wTe++9d3zyyScZG5Ttv//+8e6772ah5QatimRtz3puxRVXjMknnzyajqnMK6+8khDq2rVrdkonXNfZCSaYIN577734+++/Y5VVVsmu6CR4q/iqq64azz//fJx55pmx/fbbx5NPPhnzzz9/rLDCCpno7LPPHsOGDctADj/88Ezs5ZdfTsSNGDEiC/r6669nUUEeCmeZZZb4/vvvE01LL710NgeNtthii/jjjz9ittlmy/vFM3z48Ljiiiuic+fOGQe6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');

const blurProgram            = new Program(blurVertexShader, blurShader);
const copyProgram            = new Program(baseVertexShader, copyShader);
const clearProgram           = new Program(baseVertexShader, clearShader);
const colorProgram           = new Program(baseVertexShader, colorShader);
const checkerboardProgram    = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram  = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram       = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram      = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram     = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram         = new Program(baseVertexShader, sunraysShader);
const splatProgram           = new Program(baseVertexShader, splatShader);
const dyeSplatProgram        = new Program(baseVertexShader, dyeSplatShader);
const advectionProgram       = new Program(baseVertexShader, advectionShader);
const divergenceProgram      = new Program(baseVertexShader, divergenceShader);
const curlProgram            = new Program(baseVertexShader, curlShader);
const vorticityProgram       = new Program(baseVertexShader, vorticityShader);
const pressureProgram        = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

const displayMaterial = new Material(baseVertexShader, displayShaderSource);

function initFramebuffers () {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba    = ext.formatRGBA;
    const rg      = ext.formatRG;
    const r       = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (dye == null)
        dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    else
        dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity == null)
        velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    else
        velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    divergence = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl       = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

    initBloomFramebuffers();
    initSunraysFramebuffers();
}

function initBloomFramebuffers () {
    let res = getResolution(config.BLOOM_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++)
    {
        let width = res.width >> (i + 1);
        let height = res.height >> (i + 1);

        if (width < 2 || height < 2) break;

        let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
        bloomFramebuffers.push(fbo);
    }
}

function initSunraysFramebuffers () {
    let res = getResolution(config.SUNRAYS_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    sunrays     = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
}

function createFBO (w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let texelSizeX = 1.0 / w;
    let texelSizeY = 1.0 / h;

    return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX,
        texelSizeY,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

function createDoubleFBO (w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
        width: w,
        height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read () {
            return fbo1;
        },
        set read (value) {
            fbo1 = value;
        },
        get write () {
            return fbo2;
        },
        set write (value) {
            fbo2 = value;
        },
        swap () {
            let temp = fbo1;
            fbo1 = fbo2;
            fbo2 = temp;
        }
    }
}

function resizeFBO (target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
}

function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
    if (target.width == w && target.height == h)
        return target;
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
}

function createTextureAsync (url) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));

    let obj = {
        texture,
        width: 1,
        height: 1,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };

    let image = new Image();
    image.onload = () => {
        obj.width = image.width;
        obj.height = image.height;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    };
    image.src = url;

    return obj;
}

function updateKeywords () {
    let displayKeywords = [];
    if (config.SHADING) displayKeywords.push("SHADING");
    if (config.BLOOM) displayKeywords.push("BLOOM");
    if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
    displayMaterial.setKeywords(displayKeywords);
}

updateKeywords();
initFramebuffers();
buildLUT();
buildLUTPreviewUI();
let lastUpdateTime = Date.now();
let colorUpdateTimer = 0.0;
update();

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas())
        initFramebuffers();
    updateColors(dt);
    applyInputs();
    if (!config.PAUSED)
        step(dt);
    starUpdate(dt);
    fanUpdate(dt);
    render(null);
    requestAnimationFrame(update);
}

function calcDeltaTime () {
    let now = Date.now();
    let dt = (now - lastUpdateTime) / 1000;
    dt = Math.min(dt, 0.016666);
    lastUpdateTime = now;
    return dt * config.TICK_RATE;
}

function resizeCanvas () {
    let width = scaleByPixelRatio(canvas.clientWidth);
    let height = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
        return true;
    }
    return false;
}

function updateColors (dt) {
    if (!config.COLORFUL) return;

    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
        colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
        pointers.forEach(p => {
            p.color = generateColor();
        });
    }
}

function applyInputs () {
    if (splatStack.length > 0)
        multipleSplats(splatStack.pop());

    // Don't create fluid splats while an object is selected — prevents
    // accidental painting while moving/rotating
    if (window._moveSelected) return;

    pointers.forEach(p => {
        if (p.moved) {
            p.moved = false;
            splatPointer(p);
        }
    });
}

function step (dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    let velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    gl.uniform1i(advectionProgram.uniforms.isDye, 0);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    gl.uniform1i(advectionProgram.uniforms.isDye, 1);
    // Bind LUT for subtractive mixing during advection
    if (lutTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, lutTexture);
        gl.uniform1i(advectionProgram.uniforms.uLUT, 2);
    }
    blit(dye.write);
    dye.swap();

    // Hue diffusion pass — blends hue between neighboring dye pixels.
    // Runs after advection so it acts on already-moved dye.
    // Strength 0 = sharp color boundaries, 1 = maximum blending.
}

function render (target) {
    if (config.BLOOM)
        applyBloom(dye.read, bloom);
    if (config.SUNRAYS) {
        applySunrays(dye.read, dye.write, sunrays);
        blur(sunrays, sunraysTemp, 1);
    }

    if (target == null || !config.TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    }
    else {
        gl.disable(gl.BLEND);
    }

    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));
    if (target == null && config.TRANSPARENT)
        drawCheckerboard(target);
    drawDisplay(target);
}

function drawColor (target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
}

function clearDye () {
    // Clear both dye FBO halves and velocity to eliminate all residual dye and flow
    [dye.read.fbo, dye.write.fbo, velocity.read.fbo, velocity.write.fbo].forEach(function(fbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function drawCheckerboard (target) {
    checkerboardProgram.bind();
    gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    blit(target);
}

function drawDisplay (target) {
    let width = target == null ? gl.drawingBufferWidth : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;

    displayMaterial.bind();
    if (config.SHADING)
        gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
    gl.uniform1f(displayMaterial.uniforms.uShadingIntensity, config.SHADING ? config.SHADING_INTENSITY : 0.0);
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    if (config.BLOOM) {
        gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let scale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
    }
    if (config.SUNRAYS)
        gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    // Bind LUT texture for subtractive complement mixing
    if (lutTexture) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, lutTexture);
        gl.uniform1i(displayMaterial.uniforms.uLUT, 4);
    }
    blit(target);
}

function applyBloom (source, destination) {
    if (bloomFramebuffers.length < 2)
        return;

    let last = destination;

    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);

    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        let dest = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        blit(dest);
        last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
        let baseTex = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        gl.viewport(0, 0, baseTex.width, baseTex.height);
        blit(baseTex);
        last = baseTex;
    }

    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
}

function applySunrays (source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);

    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
}

function blur (target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
        gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
        gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
        blit(temp);

        gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
        gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
        blit(target);
    }
}

function splatPointer (pointer) {
    let dx = pointer.deltaX * config.DRAG_FORCE;
    let dy = pointer.deltaY * config.DRAG_FORCE;
    var _pc = RGBtoHSV(pointer.color.r, pointer.color.g, pointer.color.b);
    splat(pointer.texcoordX, pointer.texcoordY, dx, dy, _pc);
}

function multipleSplats (amount) {
    for (let i = 0; i < amount; i++) {
        const _rc = generateColor();
        _rc.r *= 10.0; _rc.g *= 10.0; _rc.b *= 10.0;
        const color = RGBtoHSV(_rc.r, _rc.g, _rc.b);
        const x = Math.random();
        const y = Math.random();
        const dx = 1000 * (Math.random() - 0.5);
        const dy = 1000 * (Math.random() - 0.5);
        splat(x, y, dx, dy, color);
    }
}

function splat (x, y, dx, dy, color, velocityOnly) {
    // Disable blending — splats must replace dye buffer contents, not composite
    // on top. If blend is ON (left over from render()), the dye write gets
    // additively blended into dye.write, raising saturation/value globally.
    gl.disable(gl.BLEND);

    // Velocity pass — original additive splat
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(velocity.write);
    velocity.swap();

    if (velocityOnly) return;

    // Dye pass — HSV circular-hue blend
    dyeSplatProgram.bind();
    gl.uniform1i(dyeSplatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1f(dyeSplatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(dyeSplatProgram.uniforms.point, x, y);
    gl.uniform3f(dyeSplatProgram.uniforms.color, color.h, color.s, color.v);
    gl.uniform1f(dyeSplatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(dye.write);
    dye.swap();
}

function correctRadius (radius) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1)
        radius *= aspectRatio;
    return radius;
}

canvas.addEventListener('mousedown', e => {
    if (window.ERASER_ACTIVE) return;
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    let pointer = pointers.find(p => p.id == -1);
    if (pointer == null)
        pointer = new pointerPrototype();
    updatePointerDownData(pointer, -1, posX, posY);
});

canvas.addEventListener('mousemove', e => {
    let pointer = pointers[0];
    if (!pointer.down) return;
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    updatePointerMoveData(pointer, posX, posY);
});

window.addEventListener('mouseup', () => {
    updatePointerUpData(pointers[0]);
});

canvas.addEventListener('touchstart', e => {
    if (window.ERASER_ACTIVE) return;
    e.preventDefault();
    const touches = e.targetTouches;
    while (touches.length >= pointers.length)
        pointers.push(new pointerPrototype());
    for (let i = 0; i < touches.length; i++) {
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
    }
});

canvas.addEventListener('touchmove', e => {
    if (window.ERASER_ACTIVE) return;
    e.preventDefault();
    const touches = e.targetTouches;
    for (let i = 0; i < touches.length; i++) {
        let pointer = pointers[i + 1];
        if (!pointer.down) continue;
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerMoveData(pointer, posX, posY);
    }
}, false);

window.addEventListener('touchend', e => {
    const touches = e.changedTouches;
    for (let i = 0; i < touches.length; i++)
    {
        let pointer = pointers.find(p => p.id == touches[i].identifier);
        if (pointer == null) continue;
        updatePointerUpData(pointer);
    }
});

window.addEventListener('keydown', e => {
    if (e.code === 'KeyP')
        config.PAUSED = !config.PAUSED;
    if (e.key === ' ')
        splatStack.push(parseInt(Math.random() * 20) + 5);
});

function updatePointerDownData (pointer, id, posX, posY) {
    pointer.id = id;
    pointer.down = true;
    pointer.moved = false;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.deltaX = 0;
    pointer.deltaY = 0;
    pointer.color = config.COLORFUL ? generateColor() : { r: STAR_PICK_RGB.r, g: STAR_PICK_RGB.g, b: STAR_PICK_RGB.b };
}

function updatePointerMoveData (pointer, posX, posY) {
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;
    pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
    pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
    pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
}

function updatePointerUpData (pointer) {
    pointer.down = false;
}

function correctDeltaX (delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio < 1) delta *= aspectRatio;
    return delta;
}

function correctDeltaY (delta) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) delta /= aspectRatio;
    return delta;
}

function generateColor () {
    let c = HSVtoRGB(Math.random(), 1.0, 1.0);
    c.r *= 0.15;
    c.g *= 0.15;
    c.b *= 0.15;
    return c;
}

function HSVtoRGB (h, s, v) {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);

    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }

    return {
        r,
        g,
        b
    };
}

function RGBtoHSV (r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var d = max - min;
    var h = 0, s = (max === 0) ? 0 : d / max, v = max;
    if (d > 0) {
        if      (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else                h = (r - g) / d + 4;
        h /= 6;
    }
    // Nudge h away from exactly 0 — mobile GPUs have boundary issues at h=0
    // (sin(0)=0, cos(0)=1 produces SC=(0,1) which some drivers mishandle).
    // 0.001 is imperceptibly different from pure red visually.
    if (h === 0) h = 0.001;
    return { h: h, s: s, v: v };
}

function normalizeColor (input) {
    let output = {
        r: input.r / 255,
        g: input.g / 255,
        b: input.b / 255
    };
    return output;
}

function wrap (value, min, max) {
    let range = max - min;
    if (range == 0) return min;
    return (value - min) % range + min;
}

function getResolution (resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1)
        aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
        return { width: max, height: min };
    else
        return { width: min, height: max };
}

function getTextureScale (texture, width, height) {
    return {
        x: width / texture.width,
        y: height / texture.height
    };
}

function scaleByPixelRatio (input) {
    let pixelRatio = window.devicePixelRatio || 1;
    return Math.floor(input * pixelRatio);
}


// ============================================================
// STAR SYSTEM
// Stars emit hot splat material outward in all directions.
// Material starts hot (repelled from star) and cools over time
// (attracted back toward star), creating convection loops.
//
// splat(x, y, dx, dy, color)
//   x, y  : 0-1 normalized coords, y=0=bottom
//   dx,dy : velocity force (Pavel uses ~1000-6000 range)
//   color : {r,g,b} brightness ~10 = vivid
// ============================================================

// (STARS, STAR_PICK_RGB, STAR_TICK declared above)


function starHeat(star, px, py) {
    // Returns 0-1 heat value at position px,py relative to star
    // 1.0 = at star center, 0.0 = at gravity radius edge
    var dx = px - star.x;
    var dy = py - star.y;
    var dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > star.gravRadius) return 0;
    return Math.max(0, 1.0 - dist / star.gravRadius);
}

function starUpdate(dt) {
    if (!STARS || !STARS.length) return;
    STAR_TICK++;

    // Stagger rays across 2 frames — fire half each frame.
    // The fluid fills gaps via advection so halving per-frame splats is imperceptible.
    var RAYS = 8;
    var RAYS_PER_FRAME = 4; // half the ring per frame
    var rayOffset = (STAR_TICK % 2) * RAYS_PER_FRAME;

    STARS.forEach(function(star) {
        var pulse = 1.0;
        if (star.pulseHz > 0)
            pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * star.pulseHz * STAR_TICK * dt + star.phase);

        var emitForce = star.emitForce * pulse;
        var emitH = (star.h === 0) ? 0.001 : star.h;

        // ── Outward emission — fire half the rays each frame ──────────────
        var frameAngle = (STAR_TICK % RAYS) * (2 * Math.PI / RAYS / RAYS) + (star.rotation || 0);
        for (var i = rayOffset; i < rayOffset + RAYS_PER_FRAME; i++) {
            var angle = frameAngle + 2 * Math.PI * i / RAYS;
            var cos = Math.cos(angle);
            var sin = Math.sin(angle);

            var ir = star.emitRadius * 0.55;
            var ix = star.x + cos * ir;
            var iy = star.y + sin * ir;
            if (ix >= 0.01 && ix <= 0.99 && iy >= 0.01 && iy <= 0.99) {
                splat(ix, iy, cos * emitForce, sin * emitForce,
                    { h: emitH, s: star.s, v: 0.15 * pulse });
            }

            var or2 = star.emitRadius * 0.75;
            var ox2 = star.x + cos * or2;
            var oy2 = star.y + sin * or2;
            if (ox2 >= 0.01 && ox2 <= 0.99 && oy2 >= 0.01 && oy2 <= 0.99) {
                splat(ox2, oy2, cos * emitForce * 0.6, sin * emitForce * 0.6,
                    { h: emitH, s: star.s, v: 0.08 * pulse });
            }
        }

        // ── Gravity: inward pull — skip entirely when gravForce is zero ───
        if (star.gravForce > 0) {
            var GSAMP = 6;
            var gAngleOff = (STAR_TICK * 7) % (GSAMP * 100) / 100 * (2*Math.PI/GSAMP);
            for (var j = 0; j < GSAMP; j++) {
                var ga = gAngleOff + 2 * Math.PI * j / GSAMP;
                var cosg = Math.cos(ga), sing = Math.sin(ga);
                var gd = star.gravRadius * (0.5 + 0.3 * ((j * 0.618) % 1));
                var gx = star.x + cosg * gd;
                var gy = star.y + sing * gd;
                if (gx >= 0.01 && gx <= 0.99 && gy >= 0.01 && gy <= 0.99) {
                    splat(gx, gy,
                        -cosg * star.gravForce,
                        -sing * star.gravForce,
                        null, true);
                }
            }
        }
    });
}

function fanUpdate(dt) {
    if (!FANS || !FANS.length) return;
    FANS.forEach(function(fan) {
        var pulse = 1.0;
        if (fan.pulseHz > 0)
            pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * fan.pulseHz * STAR_TICK * dt + fan.phase);

        var angleRad = fan.angle * Math.PI / 180;
        var spreadRad = fan.spread * Math.PI / 180;
        // Fire velocity splats in a cone centered on fan.angle
        var RAYS = 8;
        for (var i = 0; i < RAYS; i++) {
            var t = (i / (RAYS - 1)) - 0.5; // -0.5 to 0.5
            var a = angleRad + t * spreadRad;
            var cos = Math.cos(a);
            var sin = Math.sin(a);
            // Sample at various distances within the radius
            var dist = fan.radius * (0.3 + 0.7 * Math.abs(t + 0.5));
            var fx = fan.x + cos * dist;
            var fy = fan.y + sin * dist;
            if (fx >= 0.01 && fx <= 0.99 && fy >= 0.01 && fy <= 0.99) {
                // Velocity only — no dye from fans
                splatProgram.bind();
                gl.disable(gl.BLEND);
                gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
                gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
                gl.uniform2f(splatProgram.uniforms.point, fx, fy);
                gl.uniform3f(splatProgram.uniforms.color, cos * fan.force * pulse, sin * fan.force * pulse, 0.0);
                gl.uniform1f(splatProgram.uniforms.radius, correctRadius(fan.radius * 0.3));
                blit(velocity.write);
                velocity.swap();
            }
        }
    });
}

// ── Star placement: click to place, right-click to remove ─────────────────────
// (_starDown, _starDrag declared above)

canvas.addEventListener('mousedown', function(e) {
    if (window.ERASER_ACTIVE) return;
    if (e.button !== 0) return;
    _starDown = {x: e.clientX, y: e.clientY};
    _starDrag = false;
}, true);

canvas.addEventListener('mousemove', function(e) {
    if (!_starDown) return;
    if (Math.hypot(e.clientX - _starDown.x, e.clientY - _starDown.y) > 6)
        _starDrag = true;
}, true);

canvas.addEventListener('mouseup', function(e) {
    if (e.button !== 0 || !_starDown || _starDrag) { _starDown = null; return; }
    if (starPanelHit(e.clientX, e.clientY)) { _starDown = null; return; }
    if (window._moveSelected) { _starDown = null; return; }
    if (window._justDeselected) { window._justDeselected = false; _starDown = null; return; }
    // Use getBoundingClientRect so coords are correct even when canvas is CSS-scaled
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = 1.0 - (e.clientY - rect.top) / rect.height;
    if (window._starPanelMode && window._starPanelMode() === 'fan') {
        fanPlace(x, y);
    } else {
        starPlace(x, y);
    }
    _starDown = null;
}, true);

canvas.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    if (starPanelHit(e.clientX, e.clientY)) return;
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = 1.0 - (e.clientY - rect.top) / rect.height;
    if (window._starPanelMode && window._starPanelMode() === 'fan') {
        fanRemove(x, y);
    } else {
        starRemove(x, y);
    }
}, true);

// ── Touch handlers for star/fan placement ────────────────────────────────
// Tap = place star/fan, long-press (500ms) = remove nearest star/fan
var _touchPlaceTimer = null;
var _touchPlaceId = null;
var _touchMoved = false;

canvas.addEventListener('touchstart', function(e) {
    // Only handle single-finger taps for placement (multi-touch handled by fluid)
    if (window.ERASER_ACTIVE) return;
    if (e.targetTouches.length !== 1) return;
    var t = e.targetTouches[0];
    if (starPanelHit(t.clientX, t.clientY)) return;
    // Check directly if this touch hits an existing object — if so, don't place
    if (_moveHitTest(t.clientX, t.clientY)) return;
    _touchMoved = false;
    _touchPlaceId = t.identifier;
    _touchPlaceTimer = setTimeout(function() {
        // Long-press: remove
        _touchPlaceTimer = null;
        if (_touchMoved) return;
        var rect = canvas.getBoundingClientRect();
        var x = (t.clientX - rect.left) / rect.width;
        var y = 1.0 - (t.clientY - rect.top) / rect.height;
        if (window._starPanelMode && window._starPanelMode() === 'fan') {
            fanRemove(x, y);
        } else {
            starRemove(x, y);
        }
    }, 500);
}, { passive: true });

canvas.addEventListener('touchmove', function(e) {
    if (e.targetTouches.length !== 1) return;
    var t = e.targetTouches[0];
    if (t.identifier !== _touchPlaceId) return;
    // If finger moves more than ~8px, cancel tap placement
    if (!_touchMoved) {
        _touchMoved = true;
        if (_touchPlaceTimer) { clearTimeout(_touchPlaceTimer); _touchPlaceTimer = null; }
    }
}, { passive: true });

canvas.addEventListener('touchend', function(e) {
    var found = false;
    for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === _touchPlaceId) { found = true; break; }
    }
    if (!found) return;
    if (_touchPlaceTimer) {
        clearTimeout(_touchPlaceTimer);
        _touchPlaceTimer = null;
        if (!_touchMoved) {
            // Short tap: place star/fan only if not tapping an existing object or deselecting
            var t = e.changedTouches[0];
            if (window._justDeselected) { window._justDeselected = false; }
            else if (!starPanelHit(t.clientX, t.clientY) && !_moveHitTest(t.clientX, t.clientY)) {
                var rect = canvas.getBoundingClientRect();
                var x = (t.clientX - rect.left) / rect.width;
                var y = 1.0 - (t.clientY - rect.top) / rect.height;
                if (window._starPanelMode && window._starPanelMode() === 'fan') {
                    fanPlace(x, y);
                } else {
                    starPlace(x, y);
                }
            }
        }
    }
    _touchPlaceId = null;
    _touchMoved = false;
}, { passive: true });

function starPanelHit(cx, cy) {
    var p = document.getElementById('ctrl-panel');
    if (!p) return false;
    var r = p.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
}

function starGetVal(id, def) {
    var el = document.getElementById(id);
    return el ? parseFloat(el.value) : def;
}

function starPlace(x, y) {
    // Convert RGB pick to HSV for storage — dye buffer is now HSV
    var _ph = RGBtoHSV(STAR_PICK_RGB.r, STAR_PICK_RGB.g, STAR_PICK_RGB.b);
    STARS.push({
        x: x, y: y,
        h: _ph.h, s: _ph.s, v: _ph.v,
        emitForce:  starGetVal('s-force', 30),
        emitRadius: starGetVal('s-rad',   0.05),
        gravForce:  starGetVal('s-grav',  0),
        gravRadius: starGetVal('s-grad',  0.2),
        pulseHz:    starGetVal('s-pulse', 0),
        phase:      Math.random() * Math.PI * 2,
        rotation:   0
    });
    starDrawDots();
}

function fanPlace(x, y) {
    FANS.push({
        x: x, y: y,
        angle:     starGetVal('f-angle', 0),   // direction in degrees
        force:     starGetVal('f-force', 0.3),  // velocity magnitude
        radius:    starGetVal('f-grad',  0.15), // influence radius
        spread:    starGetVal('f-spread',60),   // cone spread in degrees
        pulseHz:   starGetVal('s-pulse', 0),
        phase:     Math.random() * Math.PI * 2
    });
    starDrawDots();
}

function fanRemove(x, y) {
    var best = 0.06, idx = -1;
    FANS.forEach(function(f, i) {
        var d = Math.hypot(f.x - x, f.y - y);
        if (d < best) { best = d; idx = i; }
    });
    if (idx >= 0) { FANS.splice(idx, 1); starDrawDots(); }
}

function starRemove(x, y) {
    var best = 0.06, idx = -1;
    STARS.forEach(function(s, i) {
        var d = Math.hypot(s.x - x, s.y - y);
        if (d < best) { best = d; idx = i; }
    });
    if (idx >= 0) { STARS.splice(idx, 1); starDrawDots(); }
}

// ── Dot overlay canvas ────────────────────────────────────────────────────────
var _dotCanvas = document.createElement('canvas'); // star dot overlay
_dotCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:500';
document.body.appendChild(_dotCanvas);
function _dotResize() {
    _dotCanvas.width  = window.innerWidth;
    _dotCanvas.height = window.innerHeight;
    starDrawDots();
}
_dotResize();
window.addEventListener('resize', _dotResize);

// ── Selection / Move / Rotate (always-on) ───────────────────────────────
// No mode button needed — clicking an object selects it directly.
window._moveSelected = null; // { obj, type:'star'|'fan', dragMode:'move'|'rotate'|null, startAngle, copyTimer }

var MOVE_SELECT_RADIUS_PX = 14;  // px — tap within this to select
var MOVE_RING_INNER_PX    = 18;  // inner edge of rotate ring
var MOVE_RING_OUTER_PX    = 34;  // outer edge of rotate ring

function _moveHitTest(cx, cy) {
    var W = _dotCanvas.width, H = _dotCanvas.height;
    var best = null, bestD = MOVE_RING_OUTER_PX; // allow hits anywhere inside outer ring
    STARS.forEach(function(s) {
        var sx = s.x * W, sy = (1 - s.y) * H;
        var d = Math.hypot(cx - sx, cy - sy);
        if (d < bestD) { bestD = d; best = { obj: s, type: 'star' }; }
    });
    FANS.forEach(function(f) {
        var fx = f.x * W, fy = (1 - f.y) * H;
        var d = Math.hypot(cx - fx, cy - fy);
        if (d < bestD) { bestD = d; best = { obj: f, type: 'fan' }; }
    });
    return best;
}

function _moveGetDragMode(cx, cy, obj) {
    var W = _dotCanvas.width, H = _dotCanvas.height;
    var ox = obj.x * W, oy = (1 - obj.y) * H;
    var d = Math.hypot(cx - ox, cy - oy);
    if (d <= MOVE_RING_INNER_PX) return 'move';
    if (d <= MOVE_RING_OUTER_PX) return 'rotate';
    return 'move'; // fallback
}

function _copySelected() {
    var sel = window._moveSelected;
    if (!sel) return;
    var o = sel.obj;
    if (sel.type === 'star') {
        STARS.push({
            x: o.x, y: o.y,
            h: o.h, s: o.s, v: o.v,
            emitForce: o.emitForce, emitRadius: o.emitRadius,
            gravForce: o.gravForce, gravRadius: o.gravRadius,
            pulseHz: o.pulseHz, phase: Math.random() * Math.PI * 2,
            rotation: o.rotation || 0
        });
    } else {
        FANS.push({
            x: o.x, y: o.y,
            angle: o.angle, force: o.force,
            radius: o.radius, spread: o.spread,
            pulseHz: o.pulseHz, phase: Math.random() * Math.PI * 2
        });
    }
    starDrawDots();
}

function _movePointerDown(cx, cy) {
    // If something already selected, check if tap is inside its ring (move/rotate)
    // or outside (deselect). Copy timer starts for any press on selected object.
    if (window._moveSelected) {
        var sel = window._moveSelected;
        var W = _dotCanvas.width, H = _dotCanvas.height;
        var ox = sel.obj.x * W, oy = (1 - sel.obj.y) * H;
        var d = Math.hypot(cx - ox, cy - oy);
        if (d <= MOVE_RING_OUTER_PX) {
            // Press inside ring — start move/rotate + copy timer
            sel.dragMode = _moveGetDragMode(cx, cy, sel.obj);
            sel.startAngle = Math.atan2(cy - oy, cx - ox);
            sel.hasMoved = false;
            sel.copyTimer = setTimeout(function() {
                sel.copyTimer = null;
                if (!sel.hasMoved) _copySelected();
            }, 1000);
            return true; // consumed
        } else {
            // Tap outside ring — check if hitting a different object
            var hit = _moveHitTest(cx, cy);
            if (hit && hit.obj !== sel.obj) {
                if (sel.copyTimer) { clearTimeout(sel.copyTimer); sel.copyTimer = null; }
                var W2 = _dotCanvas.width, H2 = _dotCanvas.height;
                var ox2 = hit.obj.x * W2, oy2 = (1 - hit.obj.y) * H2;
                window._moveSelected = {
                    obj: hit.obj, type: hit.type,
                    dragMode: _moveGetDragMode(cx, cy, hit.obj),
                    startAngle: Math.atan2(cy - oy2, cx - ox2),
                    hasMoved: false, copyTimer: null
                };
                _onSelectionChanged(window._moveSelected);
                starDrawDots();
                return true;
            }
            // Tap on empty canvas — deselect, consume the tap
            if (sel.copyTimer) { clearTimeout(sel.copyTimer); sel.copyTimer = null; }
            window._moveSelected = null;
            window._justDeselected = true;
            _onSelectionChanged(null);
            starDrawDots();
            return true; // consumed — prevent placement on this tap
        }
    }

    // Nothing selected — check if tapping an object to select it
    var hit = _moveHitTest(cx, cy);
    if (!hit) return false; // let placement proceed
    var W = _dotCanvas.width, H = _dotCanvas.height;
    var ox = hit.obj.x * W, oy = (1 - hit.obj.y) * H;
    window._moveSelected = {
        obj: hit.obj, type: hit.type,
        dragMode: _moveGetDragMode(cx, cy, hit.obj),
        startAngle: Math.atan2(cy - oy, cx - ox),
        hasMoved: false, copyTimer: null
    };
    // Start copy timer immediately on selection too
    var newSel = window._moveSelected;
    newSel.copyTimer = setTimeout(function() {
        newSel.copyTimer = null;
        if (!newSel.hasMoved) _copySelected();
    }, 1000);
    _onSelectionChanged(window._moveSelected);
    starDrawDots();
    return true; // consumed — don't place a new object
}

function _onSelectionChanged(sel) {
    if (!sel) {
        if (window._clearStarPanelStatus) window._clearStarPanelStatus();
        if (window._clearFanPanelStatus) window._clearFanPanelStatus();
        return;
    }
    if (sel.type === 'star') {
        if (window._syncStarPanel) window._syncStarPanel(sel.obj);
        if (window._clearFanPanelStatus) window._clearFanPanelStatus();
    } else {
        if (window._syncFanPanel) window._syncFanPanel(sel.obj);
        if (window._clearStarPanelStatus) window._clearStarPanelStatus();
    }
}

function _movePointerMove(cx, cy) {
    if (!window._moveSelected || !window._moveSelected.dragMode) return false;
    var sel = window._moveSelected;
    var W = _dotCanvas.width, H = _dotCanvas.height;

    // Cancel copy timer if the user moves
    if (!sel.hasMoved) {
        sel.hasMoved = true;
        if (sel.copyTimer) { clearTimeout(sel.copyTimer); sel.copyTimer = null; }
    }

    if (sel.dragMode === 'move') {
        sel.obj.x = Math.max(0.01, Math.min(0.99, cx / W));
        sel.obj.y = Math.max(0.01, Math.min(0.99, 1 - cy / H));
    } else if (sel.dragMode === 'rotate') {
        var ox = sel.obj.x * W, oy = (1 - sel.obj.y) * H;
        var angle = Math.atan2(cy - oy, cx - ox);
        var delta = angle - sel.startAngle;
        sel.startAngle = angle;
        if (sel.type === 'star') {
            sel.obj.rotation = ((sel.obj.rotation || 0) - delta) % (Math.PI * 2);
        } else {
            sel.obj.angle = ((sel.obj.angle - delta * 180 / Math.PI) % 360 + 360) % 360;
            var fSlider = document.getElementById('f-angle');
            if (fSlider) { fSlider.value = Math.round(sel.obj.angle); var fv = document.getElementById('f-angle-v'); if(fv) fv.textContent = Math.round(sel.obj.angle); }
        }
    }
    starDrawDots();
    return true;
}

function _movePointerUp() {
    if (!window._moveSelected) return;
    if (window._moveSelected.copyTimer) {
        clearTimeout(window._moveSelected.copyTimer);
        window._moveSelected.copyTimer = null;
    }
    window._moveSelected.dragMode = null;
}

// Mouse handlers (capture phase — run before fluid drag and placement)
canvas.addEventListener('mousedown', function(e) {
    if (window.ERASER_ACTIVE) return;
    if (e.button !== 0) return;
    var consumed = _movePointerDown(e.clientX, e.clientY);
    if (consumed) e.stopPropagation();
}, true);
window.addEventListener('mousemove', function(e) {
    if (!window._moveSelected || !window._moveSelected.dragMode) return;
    _movePointerMove(e.clientX, e.clientY);
});
window.addEventListener('mouseup', function() { _movePointerUp(); });

// Touch handlers
canvas.addEventListener('touchstart', function(e) {
    if (window.ERASER_ACTIVE) return;
    var t = e.touches[0];
    var consumed = _movePointerDown(t.clientX, t.clientY);
    if (consumed) e.stopPropagation();
}, { passive: true });
canvas.addEventListener('touchmove', function(e) {
    if (!window._moveSelected || !window._moveSelected.dragMode) return;
    e.preventDefault();
    var t = e.touches[0];
    _movePointerMove(t.clientX, t.clientY);
}, { passive: false });
canvas.addEventListener('touchend', function() { _movePointerUp(); }, { passive: true });
// ── End selection/move/rotate ─────────────────────────────────────────────



function starDrawDots() {
    var ctx = _dotCanvas.getContext('2d');
    var W = _dotCanvas.width, H = _dotCanvas.height;
    ctx.clearRect(0, 0, W, H);

    // Draw eraser circle if visible (canvas-drawn, immune to synthetic mouse events)
    if (_eraserCursorVisible) {
        var er = ERASER_RADIUS_PX;
        ctx.save();
        ctx.beginPath();
        ctx.arc(_eraserCursorX, _eraserCursorY, er, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,60,60,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    }
    STARS.forEach(function(s) {
        var sx = s.x * W;
        var sy = (1 - s.y) * H;
        var _rgb = HSVtoRGB(s.h, s.s, s.v);
        var cr = [Math.round(_rgb.r*255), Math.round(_rgb.g*255), Math.round(_rgb.b*255)].join(',');
        ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI*2);
        ctx.fillStyle = 'rgb('+cr+')'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.strokeStyle = 'rgba('+cr+',0.4)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx-12,sy); ctx.lineTo(sx+12,sy);
        ctx.moveTo(sx,sy-12); ctx.lineTo(sx,sy+12);
        ctx.stroke();
        // Draw rotation direction arrow (black, corrected for Y-flip)
        if (s.rotation) {
            var len = 13, headLen = 5;
            var rx = Math.cos(s.rotation) * len;
            var ry = -Math.sin(s.rotation) * len; // negate Y to match WebGL UV space
            var ang = Math.atan2(ry, rx);
            ctx.save();
            ctx.translate(sx, sy);
            // Shaft
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(rx, ry);
            ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 2; ctx.stroke();
            // Arrowhead
            ctx.beginPath();
            ctx.moveTo(rx, ry);
            ctx.lineTo(rx - headLen * Math.cos(ang - 0.4), ry - headLen * Math.sin(ang - 0.4));
            ctx.moveTo(rx, ry);
            ctx.lineTo(rx - headLen * Math.cos(ang + 0.4), ry - headLen * Math.sin(ang + 0.4));
            ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 2; ctx.stroke();
            ctx.restore();
        }
        // Selection ring
        if (window._moveSelected && window._moveSelected.obj === s) {
            _drawSelectionRing(ctx, sx, sy);
        }
    });
    // Draw fans as cyan diamonds with direction arrow
    FANS.forEach(function(f) {
        var fx = f.x * W;
        var fy = (1 - f.y) * H;
        var ar = f.angle * Math.PI / 180;
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(-ar);
        ctx.beginPath();
        ctx.moveTo(0, -10); ctx.lineTo(8, 0); ctx.lineTo(0, 10); ctx.lineTo(-8, 0);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,220,255,0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(16, 0);
        ctx.moveTo(16, 0); ctx.lineTo(11, -4);
        ctx.moveTo(16, 0); ctx.lineTo(11,  4);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
        // Selection ring
        if (window._moveSelected && window._moveSelected.obj === f) {
            _drawSelectionRing(ctx, fx, fy);
        }
    });
}

function _drawSelectionRing(ctx, x, y) {
    var ir = MOVE_RING_INNER_PX, or = MOVE_RING_OUTER_PX;
    // Black dotted ring (offset slightly to create contrast)
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = 0;
    ctx.beginPath(); ctx.arc(x, y, or, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 2.5; ctx.stroke();
    // White dotted ring offset by dash length
    ctx.lineDashOffset = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5; ctx.stroke();
    // Inner ring (move zone boundary)
    ctx.lineDashOffset = 0;
    ctx.beginPath(); ctx.arc(x, y, ir, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineDashOffset = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
}

// ── Star + Fan tab injection ───────────────────────────────────────────────
(function() {
    // Inject CSS for star/fan sliders (reuse cp-* classes, add sp-specific ones)
    var css = document.createElement('style');
    css.textContent =
        '.sp-sec{font-size:10px;color:#555;letter-spacing:1px;text-transform:uppercase;margin:7px 0 4px}'+
        '.sp-row{display:grid;grid-template-columns:105px 1fr 40px;align-items:center;gap:5px;margin-bottom:5px}'+
        '.sp-lbl{font-size:12px;color:#888}'+
        '.sp-sl{width:100%;accent-color:#4af;cursor:pointer}'+
        '.sp-val{font-size:12px;color:#4af;text-align:right}'+
        '.sp-btn{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);'+
        'border-radius:4px;color:#aaa;padding:4px 8px;cursor:pointer;font-size:12px;font-family:monospace;margin:2px}'+
        '.sp-btn:hover{background:rgba(255,255,255,0.18);color:#fff}'+
        '.sp-tip{margin-top:7px;font-size:10px;color:#444;line-height:1.6}'+
        '#sp-sw{width:34px;height:34px;border-radius:5px;flex-shrink:0;border:1px solid rgba(255,255,255,0.15)}'+
        '#sp-hc{width:100%;height:13px;display:block;border-radius:3px;cursor:crosshair;border:1px solid rgba(255,255,255,0.12)}';
    document.head.appendChild(css);

    // Wait for unified panel to exist, then inject
    function inject() {
        var panes = window._cpPanes;
        if (!panes) { setTimeout(inject, 50); return; }

        var starPane = panes[0];
        var fanPane  = panes[1];

        // ── STARS pane ─────────────────────────────────────────────────────

        // Color section
        var csec = document.createElement('div'); csec.className = 'sp-sec'; csec.textContent = 'COLOR';
        starPane.appendChild(csec);

        var crow = document.createElement('div');
        crow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px';

        var swatch = document.createElement('div');
        swatch.id = 'sp-sw';
        swatch.style.background = 'rgb(255,0,0)';
        crow.appendChild(swatch);

        var hueWrap = document.createElement('div'); hueWrap.style.cssText = 'flex:1;min-width:0';
        var hueCanvas = document.createElement('canvas');
        hueCanvas.id = 'sp-hc'; hueCanvas.width = 200; hueCanvas.height = 13;
        hueWrap.appendChild(hueCanvas);
        var hueLabel = document.createElement('div');
        hueLabel.style.cssText = 'display:flex;justify-content:space-between;margin-top:3px';
        var hueSpanL = document.createElement('span'); hueSpanL.style.cssText = 'font-size:9px;color:#555'; hueSpanL.textContent = 'Hue';
        var hueSpanR = document.createElement('span'); hueSpanR.style.cssText = 'font-size:9px;color:#4af'; hueSpanR.textContent = '0°';
        hueLabel.appendChild(hueSpanL); hueLabel.appendChild(hueSpanR);
        hueWrap.appendChild(hueLabel);
        crow.appendChild(hueWrap);
        starPane.appendChild(crow);

        // Preset swatches — 2 rows of 7
        // Row 1: Red, Red-Orange, Orange, Yellow-Orange, Yellow, Yellow-Green, Green
        // Row 2: Blue-Green, Blue, Blue-Violet, Violet, Red-Violet, White
        var presetRow = document.createElement('div');
        presetRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px';
        var presets = [
            { rgb:[220,  1,  0], label:'Red'           },
            { rgb:[230, 60,  0], label:'Red-Orange'    },
            { rgb:[255,120,  0], label:'Orange'         },
            { rgb:[255,185,  0], label:'Yellow-Orange'  },
            { rgb:[240,220,  0], label:'Yellow'         },
            { rgb:[130,190,  0], label:'Yellow-Green'   },
            { rgb:[ 20,160, 40], label:'Green'          },
            { rgb:[  0,160,130], label:'Blue-Green'     },
            { rgb:[  0, 60,200], label:'Blue'           },
            { rgb:[ 50,  0,200], label:'Blue-Violet'    },
            { rgb:[110,  0,190], label:'Violet'         },
            { rgb:[190,  0,120], label:'Red-Violet'     },
            { rgb:[255,255,255], label:'White'          },
        ];
        presets.forEach(function(p) {
            var rgb = p.rgb;
            var sw = document.createElement('div');
            sw.title = p.label;
            var isWhite = p.label === 'White';
            sw.style.cssText = 'width:28px;height:28px;border-radius:4px;cursor:pointer;flex-shrink:0;'+
                'background:rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+');'+
                'border:1px solid rgba(255,255,255,0.15)';
            sw.addEventListener('click', function(e) {
                e.stopPropagation();
                STAR_PICK_RGB = {r:rgb[0]/255, g:rgb[1]/255, b:rgb[2]/255};
                swatch.style.background = 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
                var hsv = RGBtoHSV(rgb[0]/255, rgb[1]/255, rgb[2]/255);
                hueSpanR.textContent = isWhite ? 'White' : Math.round(hsv.h * 360) + '\u00b0';
                var sel = window._moveSelected;
                if (sel && sel.type === 'star') { sel.obj.h = hsv.h; sel.obj.s = hsv.s; sel.obj.v = hsv.v; starDrawDots(); }
            });
            sw.addEventListener('touchend', function(e) {
                e.stopPropagation();
                e.preventDefault();
                STAR_PICK_RGB = {r:rgb[0]/255, g:rgb[1]/255, b:rgb[2]/255};
                swatch.style.background = 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
                var hsv = RGBtoHSV(rgb[0]/255, rgb[1]/255, rgb[2]/255);
                hueSpanR.textContent = isWhite ? 'White' : Math.round(hsv.h * 360) + '\u00b0';
                var sel = window._moveSelected;
                if (sel && sel.type === 'star') { sel.obj.h = hsv.h; sel.obj.s = hsv.s; sel.obj.v = hsv.v; starDrawDots(); }
            });
            presetRow.appendChild(sw);
        });
        starPane.appendChild(presetRow);

        // Parameters
        var psec = document.createElement('div'); psec.className = 'sp-sec'; psec.textContent = 'PARAMETERS';
        starPane.appendChild(psec);

        // Status label — shows whether editing selected object or setting defaults
        var starStatus = document.createElement('div');
        starStatus.style.cssText = 'font-size:9px;color:#4af;margin-bottom:4px;min-height:12px';
        starPane.appendChild(starStatus);

        var starDefs = [
            {id:'s-force', lbl:'Emit Force',   mn:0,   mx:100,  v:30,   st:1,    dp:0, prop:'emitForce'},
            {id:'s-rad',   lbl:'Emit Radius',  mn:0.005,mx:0.12, v:0.05, st:0.005,dp:3, prop:'emitRadius'},
            {id:'s-grav',  lbl:'Gravity Force',mn:0,   mx:800,  v:0,    st:10,   dp:0, prop:'gravForce'},
            {id:'s-grad',  lbl:'Gravity Radius',mn:0.01,mx:0.5, v:0.2,  st:0.01, dp:2, prop:'gravRadius'},
            {id:'s-pulse', lbl:'Pulse Hz',     mn:0,   mx:10,   v:0,    st:0.1,  dp:1, prop:'pulseHz'},
        ];
        starDefs.forEach(function(def) {
            var row = document.createElement('div'); row.className = 'sp-row';
            var lbl = document.createElement('span'); lbl.className = 'sp-lbl'; lbl.textContent = def.lbl;
            var sl = document.createElement('input');
            sl.type = 'range'; sl.className = 'sp-sl'; sl.id = def.id;
            sl.min = def.mn; sl.max = def.mx; sl.value = def.v; sl.step = def.st;
            var val = document.createElement('span'); val.className = 'sp-val'; val.id = def.id+'-v';
            val.textContent = def.v.toFixed(def.dp);
            sl.addEventListener('input', function() {
                val.textContent = parseFloat(sl.value).toFixed(def.dp);
                // Live-edit selected star
                var sel = window._moveSelected;
                if (sel && sel.type === 'star') sel.obj[def.prop] = parseFloat(sl.value);
            });
            sl.addEventListener('mousedown', function(e) { e.stopPropagation(); });
            row.appendChild(lbl); row.appendChild(sl); row.appendChild(val);
            starPane.appendChild(row);
            if (def.id === 's-rad') {
                var hint = document.createElement('div');
                hint.style.cssText = 'font-size:9px;color:#4af;margin-top:-2px;margin-bottom:3px;padding-left:2px';
                hint.textContent = '▲ min = single direction emit';
                starPane.appendChild(hint);
            }
        });

        // Sync star sliders and color swatch to a newly selected star
        window._syncStarPanel = function(star) {
            if (!star) {
                starStatus.textContent = '';
                return;
            }
            starStatus.textContent = '✦ Editing selected star';
            starDefs.forEach(function(def) {
                var sl = document.getElementById(def.id);
                var vl = document.getElementById(def.id + '-v');
                if (sl) sl.value = star[def.prop];
                if (vl) vl.textContent = parseFloat(star[def.prop]).toFixed(def.dp);
            });
            // Update color swatch to show star's color
            var rgb = HSVtoRGB(star.h, star.s, star.v);
            var r = Math.round(rgb.r*255), g = Math.round(rgb.g*255), b = Math.round(rgb.b*255);
            STAR_PICK_RGB = {r: rgb.r, g: rgb.g, b: rgb.b};
            swatch.style.background = 'rgb('+r+','+g+','+b+')';
            var isWhite = star.s < 0.05;
            hueSpanR.textContent = isWhite ? 'White' : Math.round(star.h * 360) + '\u00b0';
        };
        window._clearStarPanelStatus = function() { starStatus.textContent = ''; };

        var tip = document.createElement('div'); tip.className = 'sp-tip';
        tip.textContent = 'Tap canvas = place  |  Tap object = select  |  Drag center = move  |  Drag ring = rotate  |  Hold 1s = copy';
        starPane.appendChild(tip);

        // ── FANS pane ──────────────────────────────────────────────────────
        var fsec = document.createElement('div'); fsec.className = 'sp-sec'; fsec.textContent = 'PARAMETERS';
        fanPane.appendChild(fsec);

        // Status label
        var fanStatus = document.createElement('div');
        fanStatus.style.cssText = 'font-size:9px;color:#4af;margin-bottom:4px;min-height:12px';
        fanPane.appendChild(fanStatus);

        var fanDefs = [
            {id:'f-angle',  lbl:'Direction°', mn:0,   mx:360,  v:0,    st:1,   dp:0, prop:'angle'},
            {id:'f-force',  lbl:'Fan Force',  mn:0,   mx:1,    v:0.3,  st:0.01,dp:2, prop:'force'},
            {id:'f-grad',   lbl:'Radius',     mn:0.01,mx:0.4,  v:0.05, st:0.005,dp:3, prop:'radius'},
            {id:'f-spread', lbl:'Spread°',    mn:5,   mx:180,  v:60,   st:5,   dp:0, prop:'spread'},
        ];
        fanDefs.forEach(function(def) {
            var row = document.createElement('div'); row.className = 'sp-row';
            var lbl = document.createElement('span'); lbl.className = 'sp-lbl'; lbl.textContent = def.lbl;
            var sl = document.createElement('input');
            sl.type = 'range'; sl.className = 'sp-sl'; sl.id = def.id;
            sl.min = def.mn; sl.max = def.mx; sl.value = def.v; sl.step = def.st;
            var val = document.createElement('span'); val.className = 'sp-val'; val.id = def.id+'-v';
            val.textContent = def.v.toFixed(def.dp);
            sl.addEventListener('input', function() {
                val.textContent = parseFloat(sl.value).toFixed(def.dp);
                // Live-edit selected fan
                var sel = window._moveSelected;
                if (sel && sel.type === 'fan') {
                    sel.obj[def.prop] = parseFloat(sl.value);
                    starDrawDots(); // redraw arrow direction live
                }
            });
            sl.addEventListener('mousedown', function(e) { e.stopPropagation(); });
            row.appendChild(lbl); row.appendChild(sl); row.appendChild(val);
            fanPane.appendChild(row);
        });

        // Sync fan sliders to a newly selected fan
        window._syncFanPanel = function(fan) {
            if (!fan) { fanStatus.textContent = ''; return; }
            fanStatus.textContent = '◈ Editing selected fan';
            fanDefs.forEach(function(def) {
                var sl = document.getElementById(def.id);
                var vl = document.getElementById(def.id + '-v');
                if (sl) sl.value = fan[def.prop];
                if (vl) vl.textContent = parseFloat(fan[def.prop]).toFixed(def.dp);
            });
        };
        window._clearFanPanelStatus = function() { fanStatus.textContent = ''; };
        var clrFanBtn = document.createElement('button');
        clrFanBtn.className = 'sp-btn'; clrFanBtn.textContent = 'Clear Fans';
        clrFanBtn.style.marginTop = '6px';
        clrFanBtn.addEventListener('click', function(e) { e.stopPropagation(); FANS.length = 0; starDrawDots(); });
        fanPane.appendChild(clrFanBtn);

        var fanTip = document.createElement('div'); fanTip.className = 'sp-tip';
        fanTip.textContent = 'Tap canvas = place  |  Tap object = select  |  Drag center = move  |  Drag ring = rotate  |  Hold 1s = copy';
        fanPane.appendChild(fanTip);

        // ── Mode routing via active tab ────────────────────────────────────
        // 'star' mode when Stars tab (2) is active, 'fan' when Fans tab (3) is active
        window._starPanelMode = function() {
            if (window._cpActiveTab) return window._cpActiveTab();
            return 'star';
        };

        // ── Draw hue gradient ──────────────────────────────────────────────
        var hx = hueCanvas.getContext('2d');
        var grad = hx.createLinearGradient(0, 0, hueCanvas.width, 0);
        for (var i = 0; i <= 12; i++) grad.addColorStop(i/12, 'hsl('+(i/12*360)+',100%,50%)')
        hx.fillStyle = grad; hx.fillRect(0, 0, hueCanvas.width, hueCanvas.height);

        // Wire hue picker
        var hDrag = false;
        function pickHue(cx) {
            var r = hueCanvas.getBoundingClientRect();
            var t = Math.max(0, Math.min(1, (cx - r.left) / r.width));
            var rgb = HSVtoRGB(t, 1, 1);
            STAR_PICK_RGB = {r: rgb.r, g: rgb.g, b: rgb.b};
            swatch.style.background = 'rgb('+Math.round(rgb.r*255)+','+Math.round(rgb.g*255)+','+Math.round(rgb.b*255)+')';
            hueSpanR.textContent = Math.round(t*360)+'°';
            // Live-update selected star's color
            var sel = window._moveSelected;
            if (sel && sel.type === 'star') {
                var hsv = RGBtoHSV(rgb.r, rgb.g, rgb.b);
                sel.obj.h = hsv.h; sel.obj.s = hsv.s; sel.obj.v = hsv.v;
                starDrawDots();
            }
        }
        hueCanvas.addEventListener('mousedown', function(e) { hDrag=true; pickHue(e.clientX); e.stopPropagation(); });
        window.addEventListener('mousemove', function(e) { if(hDrag) pickHue(e.clientX); });
        window.addEventListener('mouseup',   function()  { hDrag=false; });
        hueCanvas.addEventListener('touchstart', function(e) { e.stopPropagation(); e.preventDefault(); pickHue(e.touches[0].clientX); }, { passive: false });
        hueCanvas.addEventListener('touchmove',  function(e) { e.stopPropagation(); e.preventDefault(); pickHue(e.touches[0].clientX); }, { passive: false });
        hueCanvas.addEventListener('touchend',   function(e) { e.stopPropagation(); }, { passive: false });

        // Block panel clicks from reaching canvas
        // Also deactivate eraser whenever the user interacts with the panel
        function deactivateEraser(sourceEvent) {
            if (!window.ERASER_ACTIVE) return;
            // Don't deactivate if the eraser button itself was clicked — it handles its own toggle
            if (sourceEvent && sourceEvent.target && sourceEvent.target.closest('[data-eraser-btn]')) return;
            window.ERASER_ACTIVE = false;
            var eb = document.querySelector('[data-eraser-btn]');
            if (eb) { eb.style.color = ''; eb.style.borderColor = ''; eb.style.background = ''; }
            canvas.style.cursor = '';
            _eraserCursorHide();
        }
        function deactivateMoveRotate(sourceEvent) {
            if (!window._moveSelected) return;
            // Don't deselect when interacting with panel content or the open/close button
            if (sourceEvent && sourceEvent.target) {
                var t = sourceEvent.target;
                if (t.closest('.cp-pane') || t.closest('.cp-tab-bar')) return;
                if (t.closest('[data-toggle-btn]')) return;
            }
            if (window._moveSelected.copyTimer) { clearTimeout(window._moveSelected.copyTimer); }
            window._moveSelected = null;
            _onSelectionChanged(null);
            starDrawDots();
        }
        var ctrlPanel = document.getElementById('ctrl-panel');
        if (ctrlPanel) {
            ctrlPanel.addEventListener('click',       function(e){ e.stopPropagation(); deactivateEraser(e); deactivateMoveRotate(e); });
            ctrlPanel.addEventListener('contextmenu', function(e){ e.stopPropagation(); e.preventDefault(); });
            ctrlPanel.addEventListener('mousedown',   function(e){ e.stopPropagation(); }, false);
            ctrlPanel.addEventListener('touchstart',  function(e){ deactivateEraser(e); deactivateMoveRotate(e); }, { passive: true });
        }
    }
    inject();

    // Expose active tab mode
    window._cpActiveTab = function() {
        var panes = window._cpPanes;
        if (!panes) return 'star';
        // Tab 2 = Stars, Tab 3 = Fans
        if (panes[1] && panes[1].classList.contains('active')) return 'fan';
        return 'star';
    };
})();

function hashCode (s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash << 5) - hash + s.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
};