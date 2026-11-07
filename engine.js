const DEFAULT_BORDER_COLORS = ["#ffffff", "#ffffff"];
function transformImage(image, w, h, t) {
  const a = (t.rotation * Math.PI) / 180;
  const c = document.createElement("canvas");
  c.width = Math.ceil(
    Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)) - 1e-8,
  );
  c.height = Math.ceil(
    Math.abs(h * Math.cos(a)) + Math.abs(w * Math.sin(a)) - 1e-8,
  );
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = t.smooth;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(a);
  ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  return c;
}
// Snap the crop to whole source pixels. Without opt-in resizing, pixels map 1:1.
function sourceRect(source, crop) {
  const width = Math.max(
    1,
    Math.min(source.width, Math.round(crop.w * source.width)),
  );
  const height = Math.max(
    1,
    Math.min(source.height, Math.round(crop.h * source.height)),
  );
  return {
    x: Math.max(
      0,
      Math.min(source.width - width, Math.round(crop.x * source.width)),
    ),
    y: Math.max(
      0,
      Math.min(source.height - height, Math.round(crop.y * source.height)),
    ),
    width,
    height,
  };
}

function outputSize(source, crop) {
  if (crop.resize) return { width: crop.width, height: crop.height };
  const { width, height } = sourceRect(source, crop);
  return { width, height };
}

function drawCrop(source, crop, smooth = true, previewWidth) {
  const c = document.createElement("canvas");
  const size = outputSize(source, crop);
  const rect = sourceRect(source, crop);
  c.width = previewWidth || size.width;
  c.height = previewWidth
    ? Math.max(1, Math.round((previewWidth * size.height) / size.width))
    : size.height;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = "high";
  if (crop.shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(
      c.width / 2,
      c.height / 2,
      c.width / 2,
      c.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.clip();
  }
  ctx.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    c.width,
    c.height,
  );
  if (crop.border !== "none" && crop.thickness > 0) {
    const thickness = (crop.thickness / 100) * Math.min(c.width, c.height);
    const a = (crop.angle * Math.PI) / 180;
    const gradient = ctx.createLinearGradient(
      c.width / 2 - (Math.cos(a) * c.width) / 2,
      c.height / 2 - (Math.sin(a) * c.height) / 2,
      c.width / 2 + (Math.cos(a) * c.width) / 2,
      c.height / 2 + (Math.sin(a) * c.height) / 2,
    );
    crop.colors.forEach((color, i) =>
      gradient.addColorStop(i / Math.max(1, crop.colors.length - 1), color),
    );
    ctx.strokeStyle = gradient;
    ctx.lineWidth = thickness;
    if (crop.shape === "circle") {
      ctx.beginPath();
      ctx.ellipse(
        c.width / 2,
        c.height / 2,
        (c.width - thickness) / 2,
        (c.height - thickness) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else
      ctx.strokeRect(
        thickness / 2,
        thickness / 2,
        c.width - thickness,
        c.height - thickness,
      );
  }
  return c;
}
function blob(canvas, type = "image/png", quality = 0.95) {
  let output = canvas;
  if (type === "image/jpeg") {
    output = document.createElement("canvas");
    output.width = canvas.width;
    output.height = canvas.height;
    const ctx = output.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.drawImage(canvas, 0, 0);
  }
  return new Promise((resolve, reject) =>
    output.toBlob(
      (b) => (b ? resolve(b) : reject(Error("Could not export image"))),
      type,
      quality,
    ),
  );
}
async function decodeGif(data) {
  const { parseGIF, decompressFrames } = await import("./vendor.js");
  const gif = parseGIF(data);
  if (gif.header.signature !== "GIF") throw new Error("Not a valid GIF file");
  const frames = decompressFrames(gif, true);
  if (!frames.length) throw new Error("This GIF contains no image frames");

  // gifuct-js normalizes zero delays. Keep the original values for export.
  const imageBlocks = gif.frames.filter((frame) => frame.image);
  frames.forEach((frame, index) => {
    frame.delay = (imageBlocks[index].gce?.delay ?? 10) * 10;
  });

  // No looping extension means play once. Zero means repeat indefinitely.
  let repeat = -1;
  for (const frame of gif.frames) {
    const application = frame.application;
    if (
      !application ||
      !["NETSCAPE2.0", "ANIMEXTS1.0"].includes(application.id)
    )
      continue;
    const bytes = application.blocks;
    if (bytes.length >= 3 && bytes[0] === 1) {
      repeat = bytes[1] | (bytes[2] << 8);
      break;
    }
  }
  return { gif, frames, repeat };
}

function writeGifFrame(encoder, canvas, tools, options) {
  const pixels = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const palette = tools.quantize(pixels, 256, {
    format: "rgba4444",
    oneBitAlpha: true,
  });
  const index = tools.applyPalette(pixels, palette, "rgba4444");
  const transparentIndex = palette.findIndex(
    (color) => color.length > 3 && color[3] === 0,
  );
  encoder.writeFrame(index, canvas.width, canvas.height, {
    palette,
    transparent: transparentIndex >= 0,
    transparentIndex: Math.max(0, transparentIndex),
    dispose: 2,
    ...options,
  });
}

async function staticGifExport(canvas) {
  const tools = await import("./vendor.js");
  const encoder = tools.GIFEncoder();
  writeGifFrame(encoder, canvas, tools, { delay: 0, repeat: -1 });
  encoder.finish();
  return new Blob([new Uint8Array(encoder.bytes())], { type: "image/gif" });
}

async function gifExport(data, crop, t, onProgress) {
  const { gif, frames, repeat } = await decodeGif(data);
  const tools = await import("./vendor.js");
  const composite = document.createElement("canvas");
  composite.width = gif.lsd.width;
  composite.height = gif.lsd.height;
  const ctx = composite.getContext("2d");
  const encoder = tools.GIFEncoder();
  let previous = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.disposalType === 3)
      previous = ctx.getImageData(0, 0, composite.width, composite.height);
    const patch = document.createElement("canvas");
    patch.width = f.dims.width;
    patch.height = f.dims.height;
    patch
      .getContext("2d")
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(f.patch),
          patch.width,
          patch.height,
        ),
        0,
        0,
      );
    ctx.drawImage(patch, f.dims.left, f.dims.top);
    const transformed = transformImage(
      composite,
      composite.width,
      composite.height,
      t,
    );
    const out = drawCrop(transformed, crop, t.smooth);
    writeGifFrame(encoder, out, tools, { delay: f.delay ?? 100, repeat });
    if (f.disposalType === 2)
      ctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
    if (f.disposalType === 3 && previous) ctx.putImageData(previous, 0, 0);
    onProgress(Math.round(((i + 1) / frames.length) * 100));
    await new Promise((r) => setTimeout(r, 0));
  }
  encoder.finish();
  return new Blob([new Uint8Array(encoder.bytes())], { type: "image/gif" });
}
function download(data, name) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
export {
  staticGifExport,
  decodeGif,
  outputSize,
  DEFAULT_BORDER_COLORS,
  blob,
  download,
  drawCrop,
  gifExport,
  transformImage,
};
