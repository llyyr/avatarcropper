import { JSZip } from "./vendor.js";
import {
  DEFAULT_BORDER_COLORS,
  decodeGif,
  outputSize,
  transformImage,
  drawCrop,
  blob,
  gifExport,
  staticGifExport,
  download,
} from "./engine.js";

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const svgNS = "http://www.w3.org/2000/svg";
const palette = ["#a78bfa", "#5fc8ac", "#edb55e", "#e18ba2", "#79aee3"];
const presets = {
  "Discord banner": [600, 240],
  "X / Twitter header": [1500, 500],
  "YouTube banner": [2560, 1440],
  "Twitch banner": [1200, 400],
};
const state = {
  file: null,
  image: null,
  objectURL: null,
  source: null,
  frame: null,
  gif: false,
  crops: [],
  active: "",
  serial: 0,
  mode: "avatar",
  tab: "crop",
  transform: { rotation: 0, flipX: false, flipY: false, smooth: true },
  zoom: 100,
  pan: { x: 0, y: 0 },
  guides: true,
  bannerGuide: false,
  mask: 35,
  lock: false,
  previewSizes: [128, 64, 40, 30],
  busy: false,
};
const boxes = new Map();
const rows = new Map();
let gesture = null;
let renderPending = false;
let loadVersion = 0;
let animationTimer = null;
let toastTimer = null;
let aspect = 1.5;

function selected() {
  return state.crops.find((crop) => crop.id === state.active);
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

function notify(message) {
  clearTimeout(toastTimer);
  $("toast").querySelector("span").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 4000);
}

function saveSettings() {
  try {
    const { guides, mask, lock, previewSizes } = state;
    localStorage.setItem(
      "avatarcropper-settings",
      JSON.stringify({ guides, mask, lock, previewSizes }),
    );
  } catch {
    // Editing also works when browser storage is disabled.
  }
}

function restoreSettings() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("avatarcropper-settings") || "null",
    );
    if (!saved) return;
    state.guides = saved.guides !== false;
    state.lock = saved.lock === true;
    state.mask = clamp(Number(saved.mask ?? 35), 0, 85);
    if (Array.isArray(saved.previewSizes)) {
      state.previewSizes = [
        ...new Set(
          saved.previewSizes.filter(
            (n) => Number.isInteger(n) && n >= 16 && n <= 256,
          ),
        ),
      ];
    }
  } catch {
    // Invalid saved settings never prevent the editor from opening.
  }
}

function bannerSize() {
  return (
    presets[$("preset").value] || [
      Number($("custom-width").value),
      Number($("custom-height").value),
    ]
  );
}

function createCrop(kind) {
  const ratio = kind === "avatar" ? 1 : bannerSize()[0] / bannerSize()[1];
  let w = kind === "avatar" ? 0.3 : 0.7;
  let h = (w * aspect) / ratio;
  if (h > 0.85) {
    h = 0.85;
    w = (h * ratio) / aspect;
  }
  const number = ++state.serial;
  return {
    id: String(number),
    name: `${kind === "avatar" ? "Avatar" : "Banner"} ${String(number).padStart(2, "0")}`,
    x: clamp(0.15 + (number % 3) * 0.1, 0, 1 - w),
    y: clamp(0.15 + (number % 2) * 0.1, 0, 1 - h),
    w,
    h,
    width: Math.max(1, Math.round(w * state.source.width)),
    height: Math.max(1, Math.round(h * state.source.height)),
    ratio,
    resize: false,
    shape: kind === "avatar" ? "square" : "banner",
    border: "none",
    colors: [...DEFAULT_BORDER_COLORS],
    angle: 45,
    thickness: 4,
  };
}

function addCrop(kind = state.mode) {
  if (!state.source) return;
  const crop = createCrop(kind);
  state.crops.push(crop);
  selectCrop(crop.id);
}

function selectCrop(id) {
  state.active = id;
  const crop = selected();
  if (crop) state.mode = crop.shape === "banner" ? "banner" : "avatar";
  scheduleRender();
}

function updateCrop(patch) {
  const crop = selected();
  if (!crop) return;
  Object.assign(crop, patch);
  scheduleRender();
}

function centerCrop() {
  const crop = selected();
  if (crop) updateCrop({ x: (1 - crop.w) / 2, y: (1 - crop.h) / 2 });
}

function changeBannerSize() {
  const crop = selected();
  if (crop?.shape === "banner") {
    const [width, height] = bannerSize();
    let w = crop.w;
    let h = (w * aspect) / (width / height);
    if (h > 1) {
      h = 1;
      w = width / height / aspect;
    }
    updateCrop({
      ...(crop.resize ? { width, height } : {}),
      ratio: width / height,
      w,
      h,
      x: clamp(crop.x, 0, 1 - w),
      y: clamp(crop.y, 0, 1 - h),
    });
  }
  scheduleRender();
}

function refreshSource() {
  const image = state.frame || state.image;
  if (!image) return;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  state.source = transformImage(image, width, height, state.transform);
  const nextAspect = state.source.width / state.source.height;
  if (Math.abs(nextAspect - aspect) > 0.00001) {
    aspect = nextAspect;
    for (const crop of state.crops) {
      crop.h = (crop.w * aspect) / crop.ratio;
      if (crop.h > 1) {
        crop.h = 1;
        crop.w = crop.ratio / aspect;
      }
      crop.x = clamp(crop.x, 0, 1 - crop.w);
      crop.y = clamp(crop.y, 0, 1 - crop.h);
    }
  }
  const canvas = $("image");
  canvas.width = state.source.width;
  canvas.height = state.source.height;
  canvas.getContext("2d").drawImage(state.source, 0, 0);
  scheduleRender();
}

async function loadFile(file) {
  if (!file) return;
  if (
    !file.type.startsWith("image/") &&
    !/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(file.name)
  ) {
    notify("Please choose an image file.");
    return;
  }
  const version = ++loadVersion;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    if (version !== loadVersion) {
      URL.revokeObjectURL(url);
      return;
    }
    clearTimeout(animationTimer);
    if (state.objectURL) URL.revokeObjectURL(state.objectURL);
    state.objectURL = url;
    state.file = file;
    state.image = image;
    state.frame = null;
    state.gif = file.type === "image/gif" || /\.gif$/i.test(file.name);
    if (state.gif) $("format").value = "gif";
    state.transform = {
      ...state.transform,
      rotation: 0,
      flipX: false,
      flipY: false,
    };
    state.zoom = 100;
    state.pan = { x: 0, y: 0 };
    state.serial = 0;
    state.crops = [];
    aspect = image.naturalWidth / image.naturalHeight;
    refreshSource();
    addCrop("avatar");
    if (!state.gif) return;
    try {
      const { gif, frames, repeat } = await decodeGif(await file.arrayBuffer());
      if (version !== loadVersion) return;
      playGif(gif, frames, version, repeat);
    } catch {
      notify(
        "Could not decode this GIF. Choose PNG only if you want a still frame.",
      );
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    if (version === loadVersion)
      notify("This image could not be decoded. Try PNG, JPEG, WebP or GIF.");
  };
  image.src = url;
}

function playGif(gif, frames, version, repeat) {
  const canvas = document.createElement("canvas");
  canvas.width = gif.lsd.width;
  canvas.height = gif.lsd.height;
  const context = canvas.getContext("2d");
  let index = 0;
  let repeats = 0;
  function step() {
    if (version !== loadVersion) return;
    if (index === 0) context.clearRect(0, 0, canvas.width, canvas.height);
    const frame = frames[index];
    const previous =
      frame.disposalType === 3
        ? context.getImageData(0, 0, canvas.width, canvas.height)
        : null;
    const patch = document.createElement("canvas");
    patch.width = frame.dims.width;
    patch.height = frame.dims.height;
    patch
      .getContext("2d")
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(frame.patch),
          patch.width,
          patch.height,
        ),
        0,
        0,
      );
    context.drawImage(patch, frame.dims.left, frame.dims.top);
    state.frame = canvas;
    refreshSource();
    const lastFrame = index === frames.length - 1;
    if (lastFrame && (repeat === -1 || (repeat > 0 && repeats >= repeat)))
      return;
    animationTimer = setTimeout(() => {
      if (version !== loadVersion) return;
      if (frame.disposalType === 2)
        context.clearRect(
          frame.dims.left,
          frame.dims.top,
          frame.dims.width,
          frame.dims.height,
        );
      if (previous) context.putImageData(previous, 0, 0);
      if (lastFrame) repeats++;
      index = (index + 1) % frames.length;
      step();
    }, frame.delay || 100);
  }
  step();
}

function syncValue(id, value) {
  const input = $(id);
  if (document.activeElement !== input) input.value = value;
}

function renderPreview(canvas, crop, width) {
  if (!state.source) return;
  const preview = drawCrop(state.source, crop, state.transform.smooth, width);
  canvas.width = preview.width;
  canvas.height = preview.height;
  canvas.style.width = `${width}px`;
  canvas.getContext("2d").drawImage(preview, 0, 0);
}

function renderControls() {
  const crop = selected();
  for (const button of document.querySelectorAll("[data-tab]")) {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    $(`panel-${button.dataset.tab}`).hidden = !active;
  }
  for (const button of document.querySelectorAll("[data-mode]"))
    button.classList.toggle("active", button.dataset.mode === state.mode);
  $("avatar-options").hidden = state.mode !== "avatar";
  $("banner-options").hidden = state.mode !== "banner";
  $("custom-banner").hidden = $("preset").value !== "Custom";
  $("preset-size").textContent = bannerSize().join(" × ") + " px";
  for (const button of document.querySelectorAll("[data-shape]")) {
    button.disabled = !crop || crop.shape === "banner";
    button.classList.toggle("selected", crop?.shape === button.dataset.shape);
    button.setAttribute(
      "aria-pressed",
      String(crop?.shape === button.dataset.shape),
    );
  }
  for (const button of document.querySelectorAll("[data-border]")) {
    button.disabled = !crop;
    button.classList.toggle("active", crop?.border === button.dataset.border);
    button.setAttribute(
      "aria-pressed",
      String(crop?.border === button.dataset.border),
    );
  }
  $("gradient-options").hidden = crop?.border !== "gradient";
  $("gif-format").textContent = state.gif ? "GIF (animated)" : "GIF";
  for (const [format, label] of [
    ["png", "PNG"],
    ["jpg", "JPEG"],
    ["webp", "WebP"],
  ]) {
    $("format").querySelector(`option[value="${format}"]`).textContent =
      state.gif ? `${label} (still frame)` : label;
  }
  $("jpeg-note").hidden = $("format").value !== "jpg";
  for (const id of ["download", "download-all", "open-image"])
    $(id).disabled = state.busy || (id !== "open-image" && !state.source);
  for (const id of ["add-banner", "add-selection", "center"])
    $(id).disabled = !state.source;
  $("selection-count").textContent = state.crops.length;
  syncValue("rotation", state.transform.rotation);
  $("rotation-value").textContent = state.transform.rotation + "°";
  $("zoom-value").textContent = Math.round(state.zoom) + "%";
  for (const [id, property] of [
    ["flip-x", "flipX"],
    ["flip-y", "flipY"],
  ]) {
    $(id).classList.toggle("chosen", state.transform[property]);
    $(id).setAttribute("aria-pressed", String(state.transform[property]));
  }
  for (const [id, value] of [
    ["guides", state.guides],
    ["banner-guide", state.bannerGuide],
    ["smooth", state.transform.smooth],
    ["lock", state.lock],
  ])
    $(id).checked = value;
  syncValue("mask-opacity", state.mask);
  $("mask-value").textContent = state.mask + "%";
  for (const id of [
    "selection-name",
    "crop-width",
    "gradient-angle",
    "border-width",
  ])
    $(id).disabled = !crop;
  $("resize-output").disabled = !crop;
  $("resize-output").checked = Boolean(crop?.resize);
  $("output-width").disabled = !crop?.resize;
  if (!crop) return;
  const size = outputSize(state.source, crop);
  syncValue("selection-name", crop.name);
  syncValue("output-width", size.width);
  syncValue("output-height", size.height);
  $("output-width").max = Math.max(
    4096,
    Math.round(crop.w * state.source.width),
  );
  syncValue("crop-width", Math.round(crop.w * state.source.width));
  $("crop-width").max = state.source.width;
  syncValue("gradient-angle", crop.angle);
  syncValue("border-width", crop.thickness);
  $("angle-value").textContent = crop.angle + "°";
  $("border-value").textContent = crop.thickness + "%";
  $("gradient-preview").style.background =
    `linear-gradient(${crop.angle}deg,${crop.colors.join(",")})`;
  const stops = $("color-stops");
  if (stops.childElementCount !== crop.colors.length) {
    stops.replaceChildren(
      ...crop.colors.map((_, index) => {
        const input = document.createElement("input");
        input.type = "color";
        input.dataset.stop = index;
        input.setAttribute("aria-label", `Gradient color ${index + 1}`);
        return input;
      }),
    );
  }
  for (const [index, input] of [...stops.children].entries())
    if (document.activeElement !== input) input.value = crop.colors[index];
  $("remove-color").disabled = crop.colors.length <= 2;
}

function newBox(crop) {
  const box = document.createElement("div");
  box.className = "crop-box";
  box.dataset.cropId = crop.id;
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  // Static markup only; user-provided names are assigned with textContent.
  box.innerHTML = `<div class="thirds"><i></i><i></i><b></b><b></b></div>
    <span class="crop-tag"></span>
    <svg class="avatar-guides" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <rect class="guide-underlay" width="100" height="100"></rect><rect class="guide-line" width="100" height="100"></rect>
      <circle class="guide-underlay" cx="50" cy="50" r="50"></circle><circle class="guide-line" cx="50" cy="50" r="50"></circle>
    </svg>`;
  for (const corner of ["tl", "tr", "bl", "br"]) {
    const handle = document.createElement("span");
    handle.className = "handle " + corner;
    handle.dataset.corner = corner;
    box.append(handle);
  }
  const hole = document.createElementNS(svgNS, "rect");
  hole.setAttribute("fill", "black");
  $("mask-holes").append(hole);
  $("crop-boxes").append(box);
  boxes.set(crop.id, { box, hole });
  return { box, hole };
}

function newRow(crop) {
  const row = document.createElement("div");
  row.className = "selection-row";
  const main = document.createElement("div");
  main.className = "selection-main";
  const thumb = document.createElement("button");
  thumb.className = "selection-thumb";
  thumb.dataset.select = crop.id;
  thumb.setAttribute("aria-label", "Select crop");
  const canvas = document.createElement("canvas");
  canvas.className = "preview-canvas";
  thumb.append(canvas);
  const name = document.createElement("div");
  name.className = "selection-info";
  const title = document.createElement("input");
  title.type = "text";
  title.className = "selection-name-input";
  title.dataset.rename = crop.id;
  title.setAttribute("aria-label", "Selection name");
  title.placeholder = "Selection name";
  const dimensions = document.createElement("small");
  name.append(title, dimensions);
  main.append(thumb, name);
  const remove = document.createElement("button");
  remove.className = "icon-btn delete";
  remove.dataset.remove = crop.id;
  remove.textContent = "×";
  row.append(main, remove);
  $("selection-list").append(row);
  const value = { row, thumb, canvas, title, dimensions, remove };
  rows.set(crop.id, value);
  return value;
}

function renderSelections() {
  const ids = new Set(state.crops.map((crop) => crop.id));
  for (const [id, nodes] of boxes)
    if (!ids.has(id)) {
      nodes.box.remove();
      nodes.hole.remove();
      boxes.delete(id);
    }
  for (const [id, nodes] of rows)
    if (!ids.has(id)) {
      nodes.row.remove();
      rows.delete(id);
    }
  for (const [index, crop] of state.crops.entries()) {
    const { box, hole } = boxes.get(crop.id) || newBox(crop);
    const active = crop.id === state.active;
    box.classList.toggle("active", active);
    box.setAttribute("aria-label", `Move ${crop.name}`);
    box.style.left = crop.x * 100 + "%";
    box.style.top = crop.y * 100 + "%";
    box.style.width = crop.w * 100 + "%";
    box.style.height = crop.h * 100 + "%";
    box.style.setProperty("--crop-color", palette[index % palette.length]);
    box.querySelector(".crop-tag").textContent = crop.name || "Unnamed crop";
    box.querySelector(".thirds").hidden = !state.guides || !active;
    box
      .querySelector(".avatar-guides")
      .toggleAttribute("hidden", crop.shape === "banner");
    for (const handle of box.querySelectorAll(".handle"))
      handle.hidden = !active;
    for (const [key, value] of Object.entries({
      x: crop.x,
      y: crop.y,
      width: crop.w,
      height: crop.h,
    }))
      hole.setAttribute(key, value);
    const row = rows.get(crop.id) || newRow(crop);
    row.row.classList.toggle("active", active);
    row.thumb.style.borderColor = palette[index % palette.length];
    if (document.activeElement !== row.title) row.title.value = crop.name;
    const size = outputSize(state.source, crop);
    row.dimensions.textContent = `${crop.shape} · ${size.width} × ${size.height}`;
    row.remove.disabled = state.crops.length === 1;
    row.remove.setAttribute("aria-label", `Remove ${crop.name}`);
    renderPreview(row.canvas, crop, 30);
  }
}

function renderPreviews() {
  const container = $("size-previews");
  const signature = state.previewSizes.join(",");
  if (container.dataset.sizes !== signature) {
    container.dataset.sizes = signature;
    container.replaceChildren();
    $("preview-chips").replaceChildren();
    for (const size of state.previewSizes) {
      const preview = document.createElement("div");
      const canvas = document.createElement("canvas");
      canvas.className = "preview-canvas";
      const label = document.createElement("small");
      label.textContent = size + "px";
      preview.append(canvas, label);
      container.append(preview);
      const chip = document.createElement("button");
      chip.dataset.size = size;
      chip.textContent = size + "px ×";
      chip.setAttribute("aria-label", `Remove ${size}px preview`);
      $("preview-chips").append(chip);
    }
  }
  if (!selected() || !$("previews").open) return;
  for (const [index, canvas] of [
    ...container.querySelectorAll("canvas"),
  ].entries())
    renderPreview(canvas, selected(), Math.min(128, state.previewSizes[index]));
}

function render() {
  renderControls();
  renderSelections();
  renderPreviews();
  $("pan-area").hidden = !state.source;
  $("empty-upload").hidden = Boolean(state.source);
  $("image-info").hidden = !state.source;
  $("discord-guide").hidden = !state.bannerGuide;
  $("mask-fill").setAttribute("opacity", state.mask / 100);
  if (!state.source) return;
  const workspace = $("workspace").getBoundingClientRect();
  const width =
    (Math.max(
      1,
      Math.min(workspace.width - 48, (workspace.height - 48) * aspect),
    ) *
      state.zoom) /
    100;
  $("stage").style.width = width + "px";
  $("stage").style.aspectRatio = String(aspect);
  $("stage").style.transform = `translate(${state.pan.x}px, ${state.pan.y}px)`;
  $("image-info").textContent =
    `${state.file.name} · ${state.source.width} × ${state.source.height}`;
}

function startGesture(event) {
  if (!state.source || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  const box = event.target.closest(".crop-box");
  const crop =
    box && state.crops.find((item) => item.id === box.dataset.cropId);
  const rect = $("stage").getBoundingClientRect();
  gesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    pan: { ...state.pan },
    crop: crop ? structuredClone(crop) : null,
    corner: event.target.dataset.corner || "",
    rect,
  };
  if (crop) selectCrop(crop.id);
  else $("pan-area").classList.add("panning");
  $("pan-area").setPointerCapture(event.pointerId);
}

function moveGesture(event) {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  const dx = event.clientX - gesture.startX;
  const dy = event.clientY - gesture.startY;
  if (!gesture.crop) {
    state.pan = { x: gesture.pan.x + dx, y: gesture.pan.y + dy };
    scheduleRender();
    return;
  }
  const crop = gesture.crop;
  const nx = dx / gesture.rect.width,
    ny = dy / gesture.rect.height;
  if (!gesture.corner) {
    updateCrop({
      x: clamp(crop.x + nx, 0, 1 - crop.w),
      y: clamp(crop.y + ny, 0, 1 - crop.h),
    });
    return;
  }
  const ratio = crop.w / crop.h;
  const left = gesture.corner.includes("l"),
    top = gesture.corner.includes("t");
  const change =
    Math.abs(nx) > Math.abs(ny * ratio)
      ? nx * (left ? -1 : 1)
      : ny * ratio * (top ? -1 : 1);
  const anchorX = left ? crop.x + crop.w : crop.x;
  const anchorY = top ? crop.y + crop.h : crop.y;
  const centerX = crop.x + crop.w / 2,
    centerY = crop.y + crop.h / 2;
  const limitX = state.lock
    ? 2 * Math.min(centerX, 1 - centerX)
    : left
      ? anchorX
      : 1 - anchorX;
  const limitY = state.lock
    ? 2 * Math.min(centerY, 1 - centerY)
    : top
      ? anchorY
      : 1 - anchorY;
  const w = Math.max(
    0.02,
    Math.min(crop.w + change * (state.lock ? 2 : 1), limitX, limitY * ratio),
  );
  const h = w / ratio;
  updateCrop({
    w,
    h,
    x: state.lock ? centerX - w / 2 : left ? anchorX - w : anchorX,
    y: state.lock ? centerY - h / 2 : top ? anchorY - h : anchorY,
  });
}

function endGesture(event) {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  gesture = null;
  $("pan-area").classList.remove("panning");
  if ($("pan-area").hasPointerCapture(event.pointerId))
    $("pan-area").releasePointerCapture(event.pointerId);
}

function filenameStem(name) {
  // Keep Unicode names while replacing characters forbidden in file paths.
  const stem = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.(png|jpe?g|webp|gif)$/i, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 160);
  return stem || "crop";
}

async function exportCrops(all = false) {
  if (!state.source || state.busy) return;
  state.busy = true;
  const crops = structuredClone(all ? state.crops : [selected()]);
  const transform = { ...state.transform };
  const source = state.source;
  const file = state.file;
  const format = $("format").value;
  const animated = state.gif;
  $("export-progress").hidden = false;
  $("progress-text").textContent = "Preparing export…";
  scheduleRender();
  try {
    const zip = new JSZip();
    const usedNames = new Set();
    for (const [index, crop] of crops.entries()) {
      const extension = format;
      const data =
        extension === "gif"
          ? animated
            ? await gifExport(
                await file.arrayBuffer(),
                crop,
                transform,
                (percent) => {
                  $("progress-text").textContent =
                    `Rendering ${index + 1}/${crops.length} · ${percent}%`;
                },
              )
            : await staticGifExport(drawCrop(source, crop, transform.smooth))
          : await blob(
              drawCrop(source, crop, transform.smooth),
              { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[
                extension
              ],
            );
      const stem = filenameStem(crop.name);
      let name = `${stem}.${extension}`;
      let duplicate = 2;
      while (usedNames.has(name.toLowerCase())) {
        name = `${stem} (${duplicate++}).${extension}`;
      }
      usedNames.add(name.toLowerCase());
      if (all) zip.file(name, data);
      else download(data, name);
    }
    if (all) download(await zip.generateAsync({ type: "blob" }), "crops.zip");
    notify("Downloaded.");
  } catch (error) {
    notify("Export failed. " + error.message);
  } finally {
    state.busy = false;
    $("export-progress").hidden = true;
    scheduleRender();
  }
}

// Fixed controls bind once. Dynamic selections use event delegation.
for (const id of ["open-image", "empty-upload"])
  $(id).addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  loadFile(event.target.files[0]);
  event.target.value = "";
});
$("hide-options").addEventListener("click", () => {
  $("editor").classList.add("collapsed");
  $("show-options").hidden = false;
});
$("show-options").addEventListener("click", () => {
  $("editor").classList.remove("collapsed");
  $("show-options").hidden = true;
});
$("download").addEventListener("click", () => exportCrops());
$("download-all").addEventListener("click", () => exportCrops(true));
$("format").addEventListener("change", scheduleRender);
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    scheduleRender();
  });
for (const button of document.querySelectorAll("[data-mode]"))
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    const match = state.crops.find(
      (crop) => (crop.shape === "banner") === (state.mode === "banner"),
    );
    if (match) state.active = match.id;
    scheduleRender();
  });
for (const button of document.querySelectorAll("[data-shape]"))
  button.addEventListener("click", () =>
    updateCrop({ shape: button.dataset.shape }),
  );
for (const button of document.querySelectorAll("[data-border]"))
  button.addEventListener("click", () =>
    updateCrop({ border: button.dataset.border }),
  );
$("preset").addEventListener("change", changeBannerSize);
for (const id of ["custom-width", "custom-height"])
  $(id).addEventListener("change", () => {
    $(id).value = clamp(Number($(id).value) || 16, 16, 4096);
    changeBannerSize();
  });
$("add-banner").addEventListener("click", () => addCrop("banner"));
$("add-selection").addEventListener("click", () => addCrop());
$("selection-list").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.select) selectCrop(button.dataset.select);
  if (button?.dataset.remove && state.crops.length > 1) {
    state.crops = state.crops.filter(
      (crop) => crop.id !== button.dataset.remove,
    );
    if (!selected()) selectCrop(state.crops[0].id);
    scheduleRender();
  }
});
$("selection-list").addEventListener("focusin", (event) => {
  if (event.target.dataset.rename) selectCrop(event.target.dataset.rename);
});
$("selection-list").addEventListener("input", (event) => {
  const crop = state.crops.find(
    (item) => item.id === event.target.dataset.rename,
  );
  if (!crop) return;
  crop.name = event.target.value;
  scheduleRender();
});
$("selection-name").addEventListener("input", (event) =>
  updateCrop({ name: event.target.value }),
);
$("color-stops").addEventListener("input", (event) => {
  const crop = selected();
  if (crop && event.target.matches("input[type=color]")) {
    crop.colors[Number(event.target.dataset.stop)] = event.target.value;
    scheduleRender();
  }
});
$("add-color").addEventListener("click", () => {
  const crop = selected();
  if (crop) updateCrop({ colors: [...crop.colors, crop.colors.at(-1)] });
});
$("remove-color").addEventListener("click", () => {
  const crop = selected();
  if (crop?.colors.length > 2) updateCrop({ colors: crop.colors.slice(0, -1) });
});
$("gradient-angle").addEventListener("input", (event) =>
  updateCrop({ angle: Number(event.target.value) }),
);
$("border-width").addEventListener("input", (event) =>
  updateCrop({ thickness: Number(event.target.value) }),
);
$("resize-output").addEventListener("change", (event) => {
  const crop = selected();
  if (!crop) return;
  const size = outputSize(state.source, { ...crop, resize: false });
  updateCrop({
    resize: event.target.checked,
    width: size.width,
    height: size.height,
  });
});
$("output-width").addEventListener("change", (event) => {
  const crop = selected();
  if (!crop?.resize) return;
  const width = clamp(
    Number(event.target.value) || 1,
    1,
    Number(event.target.max),
  );
  updateCrop({
    width,
    height: Math.max(1, Math.round((width * crop.h) / crop.w / aspect)),
  });
  event.target.value = width;
});
$("crop-width").addEventListener("change", (event) => {
  const crop = selected();
  if (!crop) return;
  const ratio = crop.w / crop.h;
  const w = Math.max(
    0.02,
    Math.min(
      Number(event.target.value) / state.source.width,
      1 - crop.x,
      (1 - crop.y) * ratio,
    ),
  );
  updateCrop({ w, h: w / ratio });
});
$("rotation").addEventListener("input", (event) => {
  state.transform.rotation = Number(event.target.value);
  refreshSource();
  scheduleRender();
});
for (const [id, property] of [
  ["flip-x", "flipX"],
  ["flip-y", "flipY"],
])
  $(id).addEventListener("click", () => {
    state.transform[property] = !state.transform[property];
    refreshSource();
    scheduleRender();
  });
$("reset-transform").addEventListener("click", () => {
  Object.assign(state.transform, { rotation: 0, flipX: false, flipY: false });
  refreshSource();
  scheduleRender();
});
for (const [id, property] of [
  ["guides", "guides"],
  ["banner-guide", "bannerGuide"],
  ["lock", "lock"],
])
  $(id).addEventListener("change", (event) => {
    state[property] = event.target.checked;
    saveSettings();
    scheduleRender();
  });
$("smooth").addEventListener("change", (event) => {
  state.transform.smooth = event.target.checked;
  refreshSource();
  scheduleRender();
});
$("mask-opacity").addEventListener("input", (event) => {
  state.mask = Number(event.target.value);
  saveSettings();
  scheduleRender();
});
$("preview-chips").addEventListener("click", (event) => {
  const button = event.target.closest("[data-size]");
  if (button) {
    state.previewSizes = state.previewSizes.filter(
      (size) => size !== Number(button.dataset.size),
    );
    saveSettings();
    scheduleRender();
  }
});
$("add-preview").addEventListener("click", () => {
  const size = Number($("preview-size").value);
  if (
    Number.isInteger(size) &&
    size >= 16 &&
    size <= 256 &&
    !state.previewSizes.includes(size)
  ) {
    state.previewSizes.push(size);
    saveSettings();
    scheduleRender();
  }
});
$("previews").addEventListener("toggle", scheduleRender);
$("zoom-out").addEventListener("click", () => {
  state.zoom = Math.max(25, state.zoom - 25);
  scheduleRender();
});
$("zoom-in").addEventListener("click", () => {
  state.zoom = Math.min(400, state.zoom + 25);
  scheduleRender();
});
$("fit").addEventListener("click", () => {
  state.zoom = 100;
  state.pan = { x: 0, y: 0 };
  scheduleRender();
});
$("center").addEventListener("click", centerCrop);
$("shortcuts").addEventListener("click", () => $("help").showModal());
$("close-help").addEventListener("click", () => $("help").close());
$("help").addEventListener("click", (event) => {
  if (event.target === $("help")) {
    const rect = $("help").getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      $("help").close();
  }
});
$("toast")
  .querySelector("button")
  .addEventListener("click", () => {
    $("toast").hidden = true;
  });
$("pan-area").addEventListener(
  "wheel",
  (event) => {
    if (!state.source || gesture || event.deltaY === 0) return;
    event.preventDefault();
    const rect = $("workspace").getBoundingClientRect();
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const delta = clamp(event.deltaY * unit, -400, 400);
    const nextZoom = clamp(state.zoom * Math.exp(-delta * 0.0015), 25, 400);
    const scale = nextZoom / state.zoom;
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    state.pan.x = x - (x - state.pan.x) * scale;
    state.pan.y = y - (y - state.pan.y) * scale;
    state.zoom = nextZoom;
    scheduleRender();
  },
  { passive: false },
);
$("pan-area").addEventListener("pointerdown", startGesture);
$("pan-area").addEventListener("pointermove", moveGesture);
for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
  $("pan-area").addEventListener(name, endGesture);
$("crop-boxes").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const box = event.target.closest("[data-crop-id]");
    if (box) selectCrop(box.dataset.cropId);
  }
});
new ResizeObserver(scheduleRender).observe($("workspace"));

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input,select,textarea,[contenteditable=true]"))
    return;
  if (event.key === "?" && !$("help").open) {
    event.preventDefault();
    $("help").showModal();
  }
  if ($("help").open) return;
  const crop = selected();
  const step = event.shiftKey ? 0.01 : 0.001;
  const moves = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  if (crop && moves[event.key]) {
    event.preventDefault();
    updateCrop({
      x: clamp(crop.x + moves[event.key][0], 0, 1 - crop.w),
      y: clamp(crop.y + moves[event.key][1], 0, 1 - crop.h),
    });
  }
});
document.addEventListener("paste", (event) => {
  const item = [...(event.clipboardData?.items || [])].find((item) =>
    item.type.startsWith("image/"),
  );
  if (item) loadFile(item.getAsFile());
});
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) {
    event.preventDefault();
    dragDepth++;
    $("drop-overlay").hidden = false;
  }
});
document.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("dragleave", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("drop-overlay").hidden = true;
  }
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  if (event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]);
});
window.addEventListener("pagehide", () => {
  clearTimeout(animationTimer);
  if (state.objectURL) URL.revokeObjectURL(state.objectURL);
});
restoreSettings();
render();
