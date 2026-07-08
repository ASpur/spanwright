const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  curve: "parabolic",
  span: 32,
  rise: 10,
  width: 5,
  thickness: 2,
  stepping: true,
  railings: true,
  material: "sandstone",
  yaw: -0.78,
  pitch: 0.48,
  zoom: 54,
  target: [0, 5, 0],
};

const palettes = {
  sandstone: [0.82, 0.52, 0.27],
  stone: [0.48, 0.53, 0.50],
  deepslate: [0.26, 0.30, 0.30],
  brick: [0.58, 0.27, 0.20],
  prismarine: [0.30, 0.61, 0.52],
};

let blocks = [];
let structureCount = 0;
let railingCount = 0;
let gl;
let program;
let positionBuffer;
let colorBuffer;
let gridPositionBuffer;
let gridColorBuffer;
let vertexCount = 0;
let gridVertexCount = 0;
let positionLocation;
let colorLocation;
let matrixLocation;
let animationFrame;

function rawCurve(t) {
  if (state.curve === "catenary") {
    const a = 2.25;
    const edge = Math.cosh(a);
    return state.rise * (edge - Math.cosh(a * (2 * t - 1))) / (edge - 1);
  }
  if (state.curve === "circular") {
    const x = 2 * t - 1;
    return state.rise * Math.sqrt(Math.max(0, 1 - x * x));
  }
  return state.rise * 4 * t * (1 - t);
}

function curveHeight(t) {
  const value = rawCurve(t);
  return state.stepping ? Math.round(value) : Math.round(value * 2) / 2;
}

function buildModel() {
  const map = new Map();
  structureCount = 0;
  railingCount = 0;
  const halfWidth = Math.floor(state.width / 2);
  const add = (x, y, z, type = "structure") => {
    const key = `${x},${y},${z}`;
    if (map.has(key)) return;
    map.set(key, { x, y, z, type });
    if (type === "railing") railingCount++;
    else structureCount++;
  };

  for (let i = 0; i <= state.span; i++) {
    const x = i - state.span / 2;
    const y = curveHeight(i / state.span);
    for (let z = -halfWidth; z <= halfWidth; z++) {
      for (let d = 0; d < state.thickness; d++) add(x, y - d, z);
    }
    if (state.railings) {
      add(x, y + 1, -halfWidth, "railing");
      add(x, y + 1, halfWidth, "railing");
    }
  }
  blocks = [...map.values()];
  rebuildGeometry();
  updateStats();
  drawProfile();
  scheduleRender();
}

const faces = [
  { n: [0, 1, 0], v: [[-1,1,-1],[-1,1,1],[1,1,1],[-1,1,-1],[1,1,1],[1,1,-1]], light: 1.04 },
  { n: [0,-1,0], v: [[-1,-1,-1],[1,-1,1],[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]], light: .48 },
  { n: [1,0,0], v: [[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,-1],[1,1,1],[1,-1,1]], light: .78 },
  { n: [-1,0,0], v: [[-1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,-1],[-1,-1,1],[-1,1,1]], light: .61 },
  { n: [0,0,1], v: [[-1,-1,1],[1,-1,1],[1,1,1],[-1,-1,1],[1,1,1],[-1,1,1]], light: .86 },
  { n: [0,0,-1], v: [[-1,-1,-1],[1,1,-1],[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]], light: .55 },
];

function rebuildGeometry() {
  if (!gl) return;
  const positions = [];
  const colors = [];
  const occupied = new Set(blocks.map((b) => `${b.x},${b.y},${b.z}`));
  const base = palettes[state.material];

  for (const block of blocks) {
    const blockColor = block.type === "railing" ? base.map((c) => c * .74) : base;
    for (const face of faces) {
      const neighbor = `${block.x + face.n[0]},${block.y + face.n[1]},${block.z + face.n[2]}`;
      if (occupied.has(neighbor)) continue;
      for (const vertex of face.v) {
        positions.push(block.x + vertex[0] * .48, block.y + vertex[1] * .48, block.z + vertex[2] * .48);
        colors.push(
          Math.min(1, blockColor[0] * face.light),
          Math.min(1, blockColor[1] * face.light),
          Math.min(1, blockColor[2] * face.light),
        );
      }
    }
  }
  vertexCount = positions.length / 3;
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
}

function makeGrid() {
  const positions = [];
  const colors = [];
  const size = 60;
  for (let i = -size; i <= size; i += 2) {
    const major = i % 10 === 0;
    const c = major ? .17 : .105;
    positions.push(-size, -2.51, i, size, -2.51, i, i, -2.51, -size, i, -2.51, size);
    for (let n = 0; n < 4; n++) colors.push(c, c * 1.08, c);
  }
  gridVertexCount = positions.length / 3;
  gl.bindBuffer(gl.ARRAY_BUFFER, gridPositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, gridColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function initWebGL() {
  const canvas = $("#glCanvas");
  const creationErrors = [];
  canvas.addEventListener("webglcontextcreationerror", (event) => {
    if (event.statusMessage) creationErrors.push(event.statusMessage);
  });

  const contextAttempts = [
    ["webgl2", undefined],
    ["webgl2", { antialias: false, failIfMajorPerformanceCaveat: false }],
    ["webgl", undefined],
    ["webgl", { antialias: false, failIfMajorPerformanceCaveat: false }],
    ["experimental-webgl", undefined],
  ];
  let contextName = "";
  for (const [name, options] of contextAttempts) {
    try {
      gl = options ? canvas.getContext(name, options) : canvas.getContext(name);
      if (gl) {
        contextName = name;
        break;
      }
    } catch (error) {
      creationErrors.push(`${name}: ${error.message}`);
    }
  }

  const webgl2 = contextName === "webgl2";
  if (!gl) {
    const errorPanel = $("#webglError");
    const reason = [...new Set(creationErrors)].filter(Boolean).join(" ");
    errorPanel.textContent = reason
      ? `WebGL could not start: ${reason}`
      : "WebGL could not start. Helium may be blocking it for this local site.";
    errorPanel.hidden = false;
    return;
  }
  const vertexShader = compileShader(
    gl.VERTEX_SHADER,
    webgl2
      ? `#version 300 es
        in vec3 a_position;
        in vec3 a_color;
        uniform mat4 u_matrix;
        out vec3 v_color;
        void main() {
          gl_Position = u_matrix * vec4(a_position, 1.0);
          v_color = a_color;
        }
      `
      : `
        attribute vec3 a_position;
        attribute vec3 a_color;
        uniform mat4 u_matrix;
        varying vec3 v_color;
        void main() {
          gl_Position = u_matrix * vec4(a_position, 1.0);
          v_color = a_color;
        }
      `,
  );
  const fragmentShader = compileShader(
    gl.FRAGMENT_SHADER,
    webgl2
      ? `#version 300 es
        precision mediump float;
        in vec3 v_color;
        out vec4 outColor;
        void main() {
          float fog = smoothstep(0.0, 1.0, gl_FragCoord.z);
          outColor = vec4(mix(v_color, vec3(0.075, 0.09, 0.072), fog * 0.38), 1.0);
        }
      `
      : `
        precision mediump float;
        varying vec3 v_color;
        void main() {
          float fog = smoothstep(0.0, 1.0, gl_FragCoord.z);
          gl_FragColor = vec4(mix(v_color, vec3(0.075, 0.09, 0.072), fog * 0.38), 1.0);
        }
      `,
  );
  program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  positionLocation = gl.getAttribLocation(program, "a_position");
  colorLocation = gl.getAttribLocation(program, "a_color");
  matrixLocation = gl.getUniformLocation(program, "u_matrix");
  positionBuffer = gl.createBuffer();
  colorBuffer = gl.createBuffer();
  gridPositionBuffer = gl.createBuffer();
  gridColorBuffer = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  makeGrid();
}

const mat4 = {
  multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++)
      out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  },
  perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,(2*far*near)/(near-far),0];
  },
  lookAt(eye, target, up) {
    const normalize = (v) => { const l = Math.hypot(...v); return v.map((x) => x/l); };
    const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    const z = normalize(eye.map((v,i) => v-target[i]));
    const x = normalize(cross(up,z));
    const y = cross(z,x);
    return [
      x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
      -x.reduce((s,v,i)=>s+v*eye[i],0), -y.reduce((s,v,i)=>s+v*eye[i],0), -z.reduce((s,v,i)=>s+v*eye[i],0), 1
    ];
  }
};

function render() {
  animationFrame = null;
  if (!gl) return;
  const canvas = gl.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(canvas.clientWidth * dpr);
  const height = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.clearColor(.075, .09, .071, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(program);
  const cp = Math.cos(state.pitch);
  const eye = [
    state.target[0] + state.zoom * cp * Math.cos(state.yaw),
    state.target[1] + state.zoom * Math.sin(state.pitch),
    state.target[2] + state.zoom * cp * Math.sin(state.yaw),
  ];
  const projection = mat4.perspective(Math.PI / 4.2, width / height, .1, 300);
  const view = mat4.lookAt(eye, state.target, [0, 1, 0]);
  gl.uniformMatrix4fv(matrixLocation, false, new Float32Array(mat4.multiply(projection, view)));

  const draw = (pos, color, mode, count) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, color);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(mode, 0, count);
  };
  draw(gridPositionBuffer, gridColorBuffer, gl.LINES, gridVertexCount);
  draw(positionBuffer, colorBuffer, gl.TRIANGLES, vertexCount);
}

function scheduleRender() {
  if (!animationFrame) animationFrame = requestAnimationFrame(render);
}

function updateStats() {
  const heights = Array.from({ length: state.span + 1 }, (_, i) => curveHeight(i / state.span));
  const maxStep = Math.max(...heights.slice(1).map((h, i) => Math.abs(h - heights[i])));
  $("#blockCount").textContent = blocks.length.toLocaleString();
  $("#structureCount").textContent = structureCount.toLocaleString();
  $("#railingCount").textContent = railingCount.toLocaleString();
  $("#footprintStat").textContent = `${state.span + 1} × ${state.width}`;
  $("#heightStat").textContent = `${Math.max(...heights) + 2}`;
  $("#slopeStat").textContent = maxStep === 0 ? "Level" : `1 : ${Math.max(1, Math.round(1 / maxStep))}`;
  $("#layersStat").textContent = `${Math.max(...blocks.map((b) => b.y)) - Math.min(...blocks.map((b) => b.y)) + 1}`;
  $("#profileName").textContent = state.curve[0].toUpperCase() + state.curve.slice(1);
  $("#spanDimension").textContent = `${state.span} block span`;
  $("#riseDimension").textContent = `${state.rise} block rise`;
  $("#spanOutput").textContent = `${state.span} blocks`;
  $("#riseOutput").textContent = `${state.rise} blocks`;
}

function drawProfile() {
  const canvas = $("#profileCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(236,233,223,.08)";
  ctx.lineWidth = 1;
  for (let y = 12; y < h; y += 22) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  const points = Array.from({ length: state.span + 1 }, (_, i) => ({
    x: 6 + (i / state.span) * (w - 12),
    y: h - 10 - (curveHeight(i / state.span) / Math.max(1,state.rise)) * (h - 28),
  }));
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y));
  ctx.lineTo(w - 6, h - 8);
  ctx.lineTo(6, h - 8);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "rgba(230,164,93,.26)");
  gradient.addColorStop(1, "rgba(230,164,93,0)");
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y));
  ctx.strokeStyle = "#e6a45d";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function setView(view) {
  if (view === "elevation") {
    Object.assign(state, { yaw: -Math.PI / 2, pitch: .04, zoom: Math.max(42, state.span * 1.35), target: [0, state.rise / 2, 0] });
  } else if (view === "plan") {
    Object.assign(state, { yaw: -Math.PI / 2, pitch: 1.48, zoom: Math.max(42, state.span * 1.25), target: [0, 2, 0] });
  } else {
    Object.assign(state, { yaw: -.78, pitch: .48, zoom: Math.max(48, state.span * 1.45), target: [0, state.rise / 2 - 1, 0] });
  }
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  scheduleRender();
}

function exportPlan() {
  const layers = {};
  for (const block of blocks) {
    (layers[block.y] ||= []).push({ x: block.x, z: block.z, type: block.type });
  }
  const plan = {
    generator: "Spanwright",
    version: 1,
    settings: { ...state, target: undefined, yaw: undefined, pitch: undefined, zoom: undefined },
    summary: { totalBlocks: blocks.length, structureBlocks: structureCount, railingBlocks: railingCount },
    layers,
  };
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `spanwright-${state.span}x${state.width}-${state.curve}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindControls() {
  ["span", "rise"].forEach((id) => {
    $(`#${id}`).addEventListener("input", (event) => {
      state[id] = Number(event.target.value);
      if (id === "span") state.zoom = Math.max(48, state.span * 1.45);
      state.target[1] = state.rise / 2 - 1;
      buildModel();
    });
  });
  ["stepping", "railings"].forEach((id) => $(`#${id}`).addEventListener("change", (e) => {
    state[id] = e.target.checked;
    buildModel();
  }));
  $$(".segmented button").forEach((button) => button.addEventListener("click", () => {
    state.curve = button.dataset.value;
    $$(".segmented button").forEach((b) => b.classList.toggle("active", b === button));
    buildModel();
  }));
  $$(".stepper button").forEach((button) => button.addEventListener("click", () => {
    const input = $(`#${button.dataset.target}`);
    let next = Number(input.value) + Number(button.dataset.step);
    next = Math.max(Number(input.min), Math.min(Number(input.max), next));
    if (button.dataset.target === "width" && next % 2 === 0) next += Number(button.dataset.step);
    next = Math.max(Number(input.min), Math.min(Number(input.max), next));
    input.value = next;
    state[button.dataset.target] = next;
    buildModel();
  }));
  $$(".swatch").forEach((button) => button.addEventListener("click", () => {
    state.material = button.dataset.material;
    $$(".swatch").forEach((b) => b.classList.toggle("active", b === button));
    rebuildGeometry();
    scheduleRender();
  }));
  $$(".tab").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#resetView").addEventListener("click", () => setView("perspective"));
  $("#exportPlan").addEventListener("click", exportPlan);
  $("#randomize").addEventListener("click", () => {
    const curves = ["parabolic", "catenary", "circular"];
    state.curve = curves[Math.floor(Math.random() * curves.length)];
    state.span = 20 + Math.floor(Math.random() * 29);
    state.rise = 5 + Math.floor(Math.random() * 13);
    $("#span").value = state.span;
    $("#rise").value = state.rise;
    $$(".segmented button").forEach((b) => b.classList.toggle("active", b.dataset.value === state.curve));
    setView("perspective");
    buildModel();
  });

  const canvas = $("#glCanvas");
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    state.yaw += (e.clientX - lastX) * .008;
    state.pitch = Math.max(-1.35, Math.min(1.48, state.pitch + (e.clientY - lastY) * .006));
    lastX = e.clientX; lastY = e.clientY; scheduleRender();
  });
  canvas.addEventListener("pointerup", () => dragging = false);
  canvas.addEventListener("pointercancel", () => dragging = false);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    state.zoom = Math.max(12, Math.min(150, state.zoom * Math.exp(e.deltaY * .001)));
    scheduleRender();
  }, { passive: false });
  window.addEventListener("resize", () => { drawProfile(); scheduleRender(); });
}

initWebGL();
bindControls();
buildModel();
setView("perspective");
