const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  curve: "parabolic",
  span: 32,
  rise: 10,
  width: 5,
  thickness: 2,
  railings: true,
  material: "sandstone",
  rotation: 0,
  symmetry: false,
  customPoints: [
    { t: 0, h: 0 },
    { t: .25, h: .62 },
    { t: .5, h: 1 },
    { t: .75, h: .62 },
    { t: 1, h: 0 },
  ],
  selectedPoint: 2,
  viewMode: "orbital",
  firstPersonEye: null,
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
let lastViewProjection;
let pointPopoverOpen = false;
let popoverEditRecorded = false;
const movementKeys = new Set();
let lastMoveTime = 0;
const history = [];
let historyTransaction = false;

function snapshotState() {
  return JSON.stringify({
    curve: state.curve,
    span: state.span,
    rise: state.rise,
    width: state.width,
    thickness: state.thickness,
    railings: state.railings,
    material: state.material,
    rotation: state.rotation,
    symmetry: state.symmetry,
    customPoints: state.customPoints,
    selectedPoint: state.selectedPoint,
  });
}

function pushHistory() {
  const snapshot = snapshotState();
  if (history[history.length - 1] !== snapshot) history.push(snapshot);
  if (history.length > 80) history.shift();
  $("#undoAction").disabled = history.length === 0;
}

function beginHistoryTransaction() {
  if (!historyTransaction) pushHistory();
  historyTransaction = true;
}

function endHistoryTransaction() {
  historyTransaction = false;
}

function syncControls() {
  ["span", "rise", "width", "thickness", "rotation"].forEach((id) => {
    $(`#${id}`).value = state[id];
  });
  $("#railings").checked = state.railings;
  $("#symmetry").checked = state.symmetry;
  $$(".segmented button").forEach((button) => button.classList.toggle("active", button.dataset.value === state.curve));
  $$(".swatch").forEach((button) => button.classList.toggle("active", button.dataset.material === state.material));
}

function undo() {
  const snapshot = history.pop();
  if (!snapshot) return;
  const restored = JSON.parse(snapshot);
  Object.assign(state, restored);
  syncControls();
  $("#undoAction").disabled = history.length === 0;
  buildModel();
  closePointPopover();
}

function rawCurve(t) {
  if (state.curve === "custom") {
    const points = state.customPoints;
    let index = points.findIndex((point) => point.t >= t);
    if (index <= 0) return points[0].h * state.rise;
    if (index < 0) return points[points.length - 1].h * state.rise;
    const p1 = points[index - 1];
    const p2 = points[index];
    const p0 = points[Math.max(0, index - 2)];
    const p3 = points[Math.min(points.length - 1, index + 1)];
    const u = (t - p1.t) / Math.max(.001, p2.t - p1.t);
    const m1 = ((p2.h - p0.h) / Math.max(.001, p2.t - p0.t)) * (p2.t - p1.t);
    const m2 = ((p3.h - p1.h) / Math.max(.001, p3.t - p1.t)) * (p2.t - p1.t);
    const u2 = u * u;
    const u3 = u2 * u;
    const h = (2*u3 - 3*u2 + 1)*p1.h + (u3 - 2*u2 + u)*m1
      + (-2*u3 + 3*u2)*p2.h + (u3 - u2)*m2;
    return Math.max(-1, Math.min(2, h)) * state.rise;
  }
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
  return Math.round(rawCurve(t));
}

function bridgeAngle() {
  return state.rotation * Math.PI / 180;
}

function bridgeWorldPosition(t, y, across = 0) {
  const angle = bridgeAngle();
  const along = t * state.span - state.span / 2;
  return {
    x: along * Math.cos(angle) - across * Math.sin(angle),
    y,
    z: along * Math.sin(angle) + across * Math.cos(angle),
  };
}

function firstPersonStart() {
  const start = bridgeWorldPosition(0, curveHeight(0) + 2.1, 0);
  return [start.x, start.y, start.z];
}

function moveFirstPerson(time = performance.now()) {
  if (state.viewMode !== "first-person" || movementKeys.size === 0) {
    lastMoveTime = time;
    return false;
  }
  if (!state.firstPersonEye) state.firstPersonEye = firstPersonStart();
  const dt = Math.min(.05, Math.max(0, (time - lastMoveTime) / 1000 || 0));
  lastMoveTime = time;
  if (!dt) return true;

  const speed = 10;
  const distance = speed * dt;
  const forward = [Math.cos(state.yaw), 0, Math.sin(state.yaw)];
  const right = [-Math.sin(state.yaw), 0, Math.cos(state.yaw)];
  const delta = [0, 0, 0];
  if (movementKeys.has("KeyW")) {
    delta[0] += forward[0];
    delta[2] += forward[2];
  }
  if (movementKeys.has("KeyS")) {
    delta[0] -= forward[0];
    delta[2] -= forward[2];
  }
  if (movementKeys.has("KeyD")) {
    delta[0] += right[0];
    delta[2] += right[2];
  }
  if (movementKeys.has("KeyA")) {
    delta[0] -= right[0];
    delta[2] -= right[2];
  }
  if (movementKeys.has("Space")) delta[1] += 1;
  if (movementKeys.has("ShiftLeft") || movementKeys.has("ShiftRight")) delta[1] -= 1;

  const length = Math.hypot(...delta);
  if (length === 0) return true;
  state.firstPersonEye = state.firstPersonEye.map((value, index) => value + (delta[index] / length) * distance);
  return true;
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
    const y = curveHeight(i / state.span);
    for (let across = -halfWidth; across <= halfWidth; across++) {
      const position = bridgeWorldPosition(i / state.span, y, across);
      const x = Math.round(position.x);
      const z = Math.round(position.z);
      for (let d = 0; d < state.thickness; d++) add(x, y - d, z);
    }
    if (state.railings) {
      [-halfWidth, halfWidth].forEach((across) => {
        const position = bridgeWorldPosition(i / state.span, y + 1, across);
        add(Math.round(position.x), y + 1, Math.round(position.z), "railing");
      });
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
  orthographic(left, right, bottom, top, near, far) {
    return [
      2/(right-left),0,0,0,
      0,2/(top-bottom),0,0,
      0,0,-2/(far-near),0,
      -(right+left)/(right-left),-(top+bottom)/(top-bottom),-(far+near)/(far-near),1,
    ];
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

function render(time) {
  animationFrame = null;
  if (!gl) return;
  moveFirstPerson(time);
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
  const aspect = width / height;
  let eye;
  let target;
  if (state.viewMode === "first-person") {
    if (!state.firstPersonEye) state.firstPersonEye = firstPersonStart();
    const cp = Math.cos(state.pitch);
    const direction = [
      cp * Math.cos(state.yaw),
      Math.sin(state.pitch),
      cp * Math.sin(state.yaw),
    ];
    eye = state.firstPersonEye;
    target = [
      eye[0] + direction[0] * 42,
      eye[1] + direction[1] * 42,
      eye[2] + direction[2] * 42,
    ];
  } else {
    const cp = Math.cos(state.pitch);
    eye = [
      state.target[0] + state.zoom * cp * Math.cos(state.yaw),
      state.target[1] + state.zoom * Math.sin(state.pitch),
      state.target[2] + state.zoom * cp * Math.sin(state.yaw),
    ];
    target = state.target;
  }
  const projection = state.viewMode === "orthographic"
    ? mat4.orthographic(-state.zoom * aspect / 2, state.zoom * aspect / 2, -state.zoom / 2, state.zoom / 2, .1, 400)
    : mat4.perspective(Math.PI / 4.2, aspect, .1, 300);
  const view = mat4.lookAt(eye, target, [0, 1, 0]);
  lastViewProjection = mat4.multiply(projection, view);
  gl.uniformMatrix4fv(matrixLocation, false, new Float32Array(lastViewProjection));

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
  updateWorldHandles();
  if (state.viewMode === "first-person" && movementKeys.size > 0) scheduleRender();
}

function scheduleRender() {
  if (!animationFrame) animationFrame = requestAnimationFrame(render);
}

function updateStats() {
  const heights = Array.from({ length: state.span + 1 }, (_, i) => curveHeight(i / state.span));
  const maxStep = Math.max(...heights.slice(1).map((h, i) => Math.abs(h - heights[i])));
  const xs = blocks.map((block) => block.x);
  const zs = blocks.map((block) => block.z);
  $("#blockCount").textContent = blocks.length.toLocaleString();
  $("#structureCount").textContent = structureCount.toLocaleString();
  $("#railingCount").textContent = railingCount.toLocaleString();
  $("#footprintStat").textContent = `${Math.max(...xs) - Math.min(...xs) + 1} × ${Math.max(...zs) - Math.min(...zs) + 1}`;
  $("#heightStat").textContent = `${Math.max(...heights) + 2}`;
  $("#slopeStat").textContent = maxStep === 0 ? "Level" : `1 : ${Math.max(1, Math.round(1 / maxStep))}`;
  $("#layersStat").textContent = `${Math.max(...blocks.map((b) => b.y)) - Math.min(...blocks.map((b) => b.y)) + 1}`;
  $("#profileName").textContent = state.curve[0].toUpperCase() + state.curve.slice(1);
  $("#spanDimension").textContent = `${state.span} block span`;
  $("#riseDimension").textContent = `${state.rise} block rise`;
  $("#spanOutput").textContent = `${state.span} blocks`;
  $("#riseOutput").textContent = `${state.rise} blocks`;
  $("#rotationOutput").textContent = `${state.rotation}°`;
  updatePointControls();
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

function projectWorldPoint(x, y, z = 0) {
  if (!lastViewProjection || !gl) return null;
  const m = lastViewProjection;
  const w = m[3]*x + m[7]*y + m[11]*z + m[15];
  if (w <= 0) return null;
  const clipX = (m[0]*x + m[4]*y + m[8]*z + m[12]) / w;
  const clipY = (m[1]*x + m[5]*y + m[9]*z + m[13]) / w;
  return {
    x: (clipX * .5 + .5) * gl.canvas.clientWidth,
    y: (.5 - clipY * .5) * gl.canvas.clientHeight,
  };
}

function updateWorldHandles() {
  const overlay = $("#worldHandles");
  if (state.curve !== "custom" || overlay.hidden) return;
  const handles = $("#curveHandles");
  handles.innerHTML = "";
  state.customPoints.forEach((point, index) => {
    const world = bridgeWorldPosition(point.t, point.h * state.rise);
    const position = projectWorldPoint(world.x, world.y, world.z);
    if (!position) return;
    const handle = document.createElement("button");
    handle.className = `curve-handle${index === state.selectedPoint ? " selected" : ""}${index === 0 || index === state.customPoints.length - 1 ? " endpoint" : ""}`;
    handle.style.left = `${position.x}px`;
    handle.style.top = `${position.y}px`;
    handle.dataset.index = index;
    handle.setAttribute("aria-label", `Control point ${index + 1}`);
    handles.appendChild(handle);
  });
  const selected = state.customPoints[state.selectedPoint];
  const selectedWorld = bridgeWorldPosition(selected.t, selected.h * state.rise);
  const selectedPosition = projectWorldPoint(selectedWorld.x, selectedWorld.y, selectedWorld.z);
  if (selectedPosition) {
    const angle = bridgeAngle();
    const xDirection = projectWorldPoint(selectedWorld.x + Math.cos(angle), selectedWorld.y, selectedWorld.z + Math.sin(angle));
    const yDirection = projectWorldPoint(selectedWorld.x, selectedWorld.y + 1, selectedWorld.z);
    const axes = [
      ["pointXAxis", xDirection],
      ["pointYAxis", yDirection],
    ];
    axes.forEach(([id, direction]) => {
      const axis = $(`#${id}`);
      axis.style.left = `${selectedPosition.x}px`;
      axis.style.top = `${selectedPosition.y}px`;
      if (direction) {
        const angle = Math.atan2(direction.y - selectedPosition.y, direction.x - selectedPosition.x) * 180 / Math.PI;
        axis.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
      }
    });
    $("#pointXAxis").hidden = state.selectedPoint === 0 || state.selectedPoint === state.customPoints.length - 1;
    positionPointPopover(selectedPosition);
  }
}

function updatePointControls() {
  const custom = state.curve === "custom";
  $("#customControls").hidden = !custom;
  $("#worldHandles").hidden = !custom;
  if (!custom) {
    closePointPopover();
    return;
  }
  const point = state.customPoints[state.selectedPoint];
  const endpoint = state.selectedPoint === 0 || state.selectedPoint === state.customPoints.length - 1;
  $("#popoverPointLabel").textContent = endpoint
    ? `${state.selectedPoint === 0 ? "Start" : "End"} endpoint`
    : `Point ${state.selectedPoint} of ${state.customPoints.length - 2}`;
  $("#popupPointX").value = Number((point.t * state.span).toFixed(2));
  $("#popupPointY").value = Number((point.h * state.rise).toFixed(2));
  $("#popupPointX").min = 0;
  $("#popupPointX").max = state.span;
  $("#popupPointY").min = -state.rise;
  $("#popupPointY").max = state.rise * 2;
  $("#popupPointX").disabled = endpoint;
  $("#deletePopupPoint").disabled = endpoint || state.customPoints.length <= 3;
  updateWorldHandles();
}

function positionPointPopover(position) {
  if (!pointPopoverOpen) return;
  const popover = $("#pointPopover");
  const viewport = $(".viewport-wrap");
  const width = 210;
  const height = 190;
  let left = position.x + 22;
  let top = position.y - 22;
  if (left + width > viewport.clientWidth - 12) left = position.x - width - 22;
  left = Math.max(12, Math.min(viewport.clientWidth - width - 12, left));
  top = Math.max(12, Math.min(viewport.clientHeight - height - 12, top));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function openPointPopover() {
  pointPopoverOpen = true;
  popoverEditRecorded = false;
  $("#pointPopover").hidden = false;
  updatePointControls();
}

function closePointPopover() {
  pointPopoverOpen = false;
  popoverEditRecorded = false;
  $("#pointPopover").hidden = true;
}

function updateSelectedPoint(axis, value) {
  const index = state.selectedPoint;
  const point = state.customPoints[index];
  const previousT = point.t;
  if (axis === "t") {
    if (index === 0 || index === state.customPoints.length - 1) return;
    point.t = Math.max(.02, Math.min(.98, value));
  } else {
    point.h = Math.max(-1, Math.min(2, value));
  }
  mirrorPointChange(point, previousT);
  reorderSelectedPoint(point);
  buildModel();
}

function reorderSelectedPoint(point) {
  state.customPoints.sort((a, b) => a.t - b.t);
  state.selectedPoint = state.customPoints.indexOf(point);
}

function mirrorPointChange(point, previousT) {
  if (!state.symmetry) return;
  const oldMirrorT = 1 - previousT;
  const mirror = state.customPoints
    .filter((candidate) => candidate !== point)
    .sort((a, b) => Math.abs(a.t - oldMirrorT) - Math.abs(b.t - oldMirrorT))[0];
  if (!mirror) return;
  if (Math.abs(previousT - .5) < .001) {
    point.t = .5;
    return;
  }
  mirror.t = 1 - point.t;
  mirror.h = point.h;
}

function enableSymmetry() {
  const currentHeight = rawCurve(.5) / state.rise;
  const left = state.customPoints.filter((point) => point.t < .5);
  const center = state.customPoints.find((point) => Math.abs(point.t - .5) < .001) || { t: .5, h: currentHeight };
  const mirrored = left.slice().reverse().map((point) => ({ t: 1 - point.t, h: point.h }));
  state.customPoints = [...left, center, ...mirrored].sort((a, b) => a.t - b.t);
  state.selectedPoint = state.customPoints.indexOf(center);
}

function deleteSelectedPoint() {
  const index = state.selectedPoint;
  if (index === 0 || index === state.customPoints.length - 1 || state.customPoints.length <= 3) return;
  pushHistory();
  const point = state.customPoints[index];
  if (state.symmetry && Math.abs(point.t - .5) > .001) {
    const mirrorT = 1 - point.t;
    state.customPoints = state.customPoints.filter((candidate) => candidate !== point && Math.abs(candidate.t - mirrorT) > .001);
  } else {
    state.customPoints.splice(index, 1);
  }
  state.selectedPoint = Math.min(Math.max(1, index - 1), state.customPoints.length - 2);
  closePointPopover();
  buildModel();
}

function setView(view) {
  if (view === "perspective") view = "orbital";
  movementKeys.clear();
  if (view === "orthographic") {
    Object.assign(state, { viewMode: view, yaw: -.78, pitch: .58, zoom: Math.max(42, state.span * 1.28), target: [0, state.rise / 2 - 1, 0] });
  } else if (view === "first-person") {
    Object.assign(state, { viewMode: view, firstPersonEye: firstPersonStart(), yaw: bridgeAngle(), pitch: .08, zoom: Math.max(48, state.span * 1.45), target: [0, state.rise / 2 - 1, 0] });
    lastMoveTime = performance.now();
  } else {
    Object.assign(state, { viewMode: "orbital", yaw: -.78, pitch: .48, zoom: Math.max(48, state.span * 1.45), target: [0, state.rise / 2 - 1, 0] });
  }
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === state.viewMode));
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
    $(`#${id}`).addEventListener("pointerdown", beginHistoryTransaction);
    $(`#${id}`).addEventListener("pointerup", endHistoryTransaction);
    $(`#${id}`).addEventListener("input", (event) => {
      if (!historyTransaction) pushHistory();
      state[id] = Number(event.target.value);
      if (id === "span") state.zoom = Math.max(48, state.span * 1.45);
      state.target[1] = state.rise / 2 - 1;
      buildModel();
    });
  });
  ["railings"].forEach((id) => $(`#${id}`).addEventListener("change", (e) => {
    pushHistory();
    state[id] = e.target.checked;
    buildModel();
  }));
  $$(".segmented button").forEach((button) => button.addEventListener("click", () => {
    pushHistory();
    state.curve = button.dataset.value;
    $$(".segmented button").forEach((b) => b.classList.toggle("active", b === button));
    buildModel();
  }));
  $$(".stepper button").forEach((button) => button.addEventListener("click", () => {
    pushHistory();
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
    pushHistory();
    state.material = button.dataset.material;
    $$(".swatch").forEach((b) => b.classList.toggle("active", b === button));
    rebuildGeometry();
    scheduleRender();
  }));
  $$(".tab").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#resetView").addEventListener("click", () => setView("orbital"));
  $("#undoAction").addEventListener("click", undo);
  $("#exportPlan").addEventListener("click", exportPlan);
  ["rotation"].forEach((id) => {
    $(`#${id}`).addEventListener("pointerdown", beginHistoryTransaction);
    $(`#${id}`).addEventListener("pointerup", endHistoryTransaction);
  });
  $("#popupPointX").addEventListener("input", (event) => {
    if (event.target.value === "") return;
    if (!popoverEditRecorded) pushHistory();
    popoverEditRecorded = true;
    updateSelectedPoint("t", Number(event.target.value) / state.span);
  });
  $("#popupPointY").addEventListener("input", (event) => {
    if (event.target.value === "") return;
    if (!popoverEditRecorded) pushHistory();
    popoverEditRecorded = true;
    updateSelectedPoint("h", Number(event.target.value) / state.rise);
  });
  $("#rotation").addEventListener("input", (event) => {
    if (!historyTransaction) pushHistory();
    state.rotation = Number(event.target.value);
    if (state.viewMode === "first-person") state.yaw = bridgeAngle();
    buildModel();
  });
  $("#symmetry").addEventListener("change", (event) => {
    pushHistory();
    state.symmetry = event.target.checked;
    if (state.symmetry) enableSymmetry();
    buildModel();
  });
  $("#addPoint").addEventListener("click", () => {
    pushHistory();
    let gapIndex = 0;
    let largestGap = 0;
    state.customPoints.slice(0, -1).forEach((point, index) => {
      const gap = state.customPoints[index + 1].t - point.t;
      if (gap > largestGap) { largestGap = gap; gapIndex = index; }
    });
    const left = state.customPoints[gapIndex];
    const right = state.customPoints[gapIndex + 1];
    const point = { t: (left.t + right.t) / 2, h: (left.h + right.h) / 2 };
    state.customPoints.splice(gapIndex + 1, 0, point);
    if (state.symmetry && Math.abs(point.t - .5) > .001) {
      state.customPoints.push({ t: 1 - point.t, h: point.h });
      reorderSelectedPoint(point);
    } else {
      state.selectedPoint = gapIndex + 1;
    }
    buildModel();
  });
  $("#deletePopupPoint").addEventListener("click", deleteSelectedPoint);
  $("#closePointPopover").addEventListener("click", closePointPopover);
  $("#randomize").addEventListener("click", () => {
    pushHistory();
    const curves = ["parabolic", "catenary", "circular"];
    state.curve = curves[Math.floor(Math.random() * curves.length)];
    state.span = 20 + Math.floor(Math.random() * 29);
    state.rise = 5 + Math.floor(Math.random() * 13);
    $("#span").value = state.span;
    $("#rise").value = state.rise;
    $$(".segmented button").forEach((b) => b.classList.toggle("active", b.dataset.value === state.curve));
    setView("orbital");
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
    const pitchDelta = (e.clientY - lastY) * .006;
    state.pitch = state.viewMode === "first-person"
      ? Math.max(-1.2, Math.min(1.2, state.pitch - pitchDelta))
      : Math.max(-1.35, Math.min(1.48, state.pitch + pitchDelta));
    lastX = e.clientX; lastY = e.clientY; scheduleRender();
  });
  canvas.addEventListener("pointerup", () => dragging = false);
  canvas.addEventListener("pointercancel", () => dragging = false);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    state.zoom = Math.max(12, Math.min(150, state.zoom * Math.exp(e.deltaY * .001)));
    scheduleRender();
  }, { passive: false });
  let draggingPoint = false;
  let dragAxis = "free";
  let lastPointer = { x: 0, y: 0 };
  let lastPointClick = { index: -1, time: 0 };
  const moveWorldPoint = (event) => {
    if (!draggingPoint) return;
    const index = state.selectedPoint;
    const point = state.customPoints[index];
    const previousT = point.t;
    const world = bridgeWorldPosition(point.t, point.h * state.rise);
    const angle = bridgeAngle();
    const origin = projectWorldPoint(world.x, world.y, world.z);
    const xStep = projectWorldPoint(world.x + Math.cos(angle), world.y, world.z + Math.sin(angle));
    const yStep = projectWorldPoint(world.x, world.y + 1, world.z);
    if (!origin || !xStep || !yStep) return;
    const vx = { x: xStep.x - origin.x, y: xStep.y - origin.y };
    const vy = { x: yStep.x - origin.x, y: yStep.y - origin.y };
    const dx = event.clientX - lastPointer.x;
    const dy = event.clientY - lastPointer.y;
    const det = vx.x * vy.y - vx.y * vy.x;
    if (Math.abs(det) < .02) return;
    const deltaWorldX = (dx * vy.y - dy * vy.x) / det;
    const deltaWorldY = (vx.x * dy - vx.y * dx) / det;
    if (dragAxis !== "y" && index > 0 && index < state.customPoints.length - 1) {
      point.t = Math.max(.02, Math.min(.98, point.t + deltaWorldX / state.span));
    }
    if (dragAxis !== "x") {
      point.h = Math.max(-1, Math.min(2, point.h + deltaWorldY / state.rise));
    }
    mirrorPointChange(point, previousT);
    reorderSelectedPoint(point);
    lastPointer = { x: event.clientX, y: event.clientY };
    buildModel();
  };
  $("#worldHandles").addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".curve-handle");
    const axis = event.target.closest(".world-axis");
    if (!handle && !axis) return;
    if (handle) {
      const pointIndex = Number(handle.dataset.index);
      const now = Date.now();
      const isDoubleClick = lastPointClick.index === pointIndex && now - lastPointClick.time < 900;
      state.selectedPoint = pointIndex;
      dragAxis = state.selectedPoint === 0 || state.selectedPoint === state.customPoints.length - 1 ? "y" : "free";
      updatePointControls();
      if (isDoubleClick) {
        lastPointClick = { index: -1, time: 0 };
        openPointPopover();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      lastPointClick = { index: pointIndex, time: now };
    } else {
      dragAxis = axis.dataset.axis;
      axis.classList.add("active");
    }
    beginHistoryTransaction();
    draggingPoint = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  });
  window.addEventListener("pointermove", moveWorldPoint);
  const stopWorldDrag = () => {
    draggingPoint = false;
    endHistoryTransaction();
    $$(".world-axis").forEach((axis) => axis.classList.remove("active"));
  };
  window.addEventListener("pointerup", stopWorldDrag);
  window.addEventListener("pointercancel", stopWorldDrag);
  const firstPersonMovementCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
  const isEditingText = (target) => target.matches("input, textarea, select, [contenteditable='true']");
  document.addEventListener("keydown", (event) => {
    if (state.viewMode === "first-person"
      && firstPersonMovementCodes.has(event.code)
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !isEditingText(event.target)
    ) {
      event.preventDefault();
      movementKeys.add(event.code);
      lastMoveTime = performance.now();
      scheduleRender();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && state.curve === "custom") {
      if (event.target.matches("input")) return;
      event.preventDefault();
      deleteSelectedPoint();
    }
    if (event.key === "Escape") closePointPopover();
  });
  document.addEventListener("keyup", (event) => {
    if (!firstPersonMovementCodes.has(event.code)) return;
    movementKeys.delete(event.code);
  });
  window.addEventListener("blur", () => movementKeys.clear());
  window.addEventListener("resize", () => { drawProfile(); scheduleRender(); });
}

initWebGL();
bindControls();
buildModel();
setView("orbital");
