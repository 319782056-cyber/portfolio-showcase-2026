import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs";

const PDF_URL = "portfolio.pdf";
const MAX_SCALE = 2.4;
const MIN_SCALE = 0.7;
const SCALE_STEP = 0.15;

const reader = document.querySelector("#reader");
const stage = document.querySelector("#reader-stage");
const canvas = document.querySelector("#pdf-canvas");
const context = canvas.getContext("2d", { alpha: false });
const loading = document.querySelector("#reader-loading");
const loadingLabel = document.querySelector("#loading-label");
const loadingProgress = document.querySelector("#loading-progress");
const errorPanel = document.querySelector("#reader-error");
const pageInput = document.querySelector("#page-input");
const pageCount = document.querySelector("#page-count");
const mobilePageStatus = document.querySelector("#mobile-page-status");
const zoomValue = document.querySelector("#zoom-value");

const controls = {
  previous: [document.querySelector("#prev-page"), document.querySelector("#mobile-prev")],
  next: [document.querySelector("#next-page"), document.querySelector("#mobile-next")],
  zoomOut: document.querySelector("#zoom-out"),
  zoomIn: document.querySelector("#zoom-in"),
  fit: document.querySelector("#fit-page"),
  fullscreen: document.querySelector("#fullscreen"),
};

let pdfDocument = null;
let pageNumber = 1;
let scaleMultiplier = 1;
let renderTask = null;
let renderSequence = 0;
let resizeTimer = null;
let touchStart = null;

function setDisabled(buttons, disabled) {
  const list = Array.isArray(buttons) ? buttons : [buttons];
  list.forEach((button) => {
    button.disabled = disabled;
  });
}

function updateControls() {
  if (!pdfDocument) return;
  const total = pdfDocument.numPages;
  pageInput.value = String(pageNumber);
  pageInput.max = String(total);
  pageCount.textContent = String(total);
  mobilePageStatus.textContent = `第 ${pageNumber} / ${total} 页`;
  canvas.setAttribute("aria-label", `作品集第 ${pageNumber} 页，共 ${total} 页`);
  setDisabled(controls.previous, pageNumber <= 1);
  setDisabled(controls.next, pageNumber >= total);
  controls.zoomOut.disabled = scaleMultiplier <= MIN_SCALE;
  controls.zoomIn.disabled = scaleMultiplier >= MAX_SCALE;
  zoomValue.textContent = scaleMultiplier === 1 ? "适合页面" : `${Math.round(scaleMultiplier * 100)}%`;
}

function getAvailableSize() {
  const styles = window.getComputedStyle(stage);
  const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  return {
    width: Math.max(240, stage.clientWidth - horizontalPadding),
    height: Math.max(320, stage.clientHeight - verticalPadding),
  };
}

async function renderPage(number, { resetScroll = true } = {}) {
  if (!pdfDocument) return;
  const sequence = ++renderSequence;

  if (renderTask) {
    renderTask.cancel();
    renderTask = null;
  }

  const page = await pdfDocument.getPage(number);
  if (sequence !== renderSequence) return;

  const naturalViewport = page.getViewport({ scale: 1 });
  const available = getAvailableSize();
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  const fitScale = isMobile
    ? available.width / naturalViewport.width
    : Math.min(available.width / naturalViewport.width, available.height / naturalViewport.height);
  const displayScale = fitScale * scaleMultiplier;
  const viewport = page.getViewport({ scale: displayScale });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.hidden = false;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  renderTask = page.render({
    canvasContext: context,
    viewport,
    transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
  });

  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
    return;
  } finally {
    renderTask = null;
  }

  if (sequence !== renderSequence) return;
  if (resetScroll) stage.scrollTo({ top: 0, left: 0, behavior: "auto" });
  updateControls();
  page.cleanup();

  const adjacent = number < pdfDocument.numPages ? number + 1 : number - 1;
  if (adjacent >= 1) pdfDocument.getPage(adjacent).catch(() => {});
}

async function goToPage(nextPage) {
  if (!pdfDocument) return;
  const target = Math.min(pdfDocument.numPages, Math.max(1, Number(nextPage) || 1));
  if (target === pageNumber) {
    pageInput.value = String(pageNumber);
    return;
  }
  pageNumber = target;
  updateControls();
  await renderPage(pageNumber);
}

async function changeScale(delta) {
  scaleMultiplier = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scaleMultiplier + delta));
  scaleMultiplier = Math.round(scaleMultiplier * 100) / 100;
  updateControls();
  await renderPage(pageNumber, { resetScroll: false });
}

controls.previous.forEach((button) => button.addEventListener("click", () => goToPage(pageNumber - 1)));
controls.next.forEach((button) => button.addEventListener("click", () => goToPage(pageNumber + 1)));
controls.zoomOut.addEventListener("click", () => changeScale(-SCALE_STEP));
controls.zoomIn.addEventListener("click", () => changeScale(SCALE_STEP));
controls.fit.addEventListener("click", async () => {
  scaleMultiplier = 1;
  updateControls();
  await renderPage(pageNumber);
});

pageInput.addEventListener("change", () => goToPage(pageInput.value));
pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    goToPage(pageInput.value);
    pageInput.blur();
  }
});

controls.fullscreen.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await reader.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
});

document.addEventListener("fullscreenchange", () => {
  controls.fullscreen.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(pageNumber, { resetScroll: false }), 120);
});

document.addEventListener("keydown", (event) => {
  if (!pdfDocument || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.key === "ArrowLeft" || event.key === "PageUp") goToPage(pageNumber - 1);
  if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
    event.preventDefault();
    goToPage(pageNumber + 1);
  }
  if (event.key === "Home") goToPage(1);
  if (event.key === "End") goToPage(pdfDocument.numPages);
  if (event.key === "+" || event.key === "=") changeScale(SCALE_STEP);
  if (event.key === "-") changeScale(-SCALE_STEP);
});

stage.addEventListener(
  "touchstart",
  (event) => {
    const touch = event.changedTouches[0];
    touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  },
  { passive: true },
);

stage.addEventListener(
  "touchend",
  (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    const elapsed = Date.now() - touchStart.time;
    touchStart = null;
    if (elapsed < 700 && Math.abs(deltaX) > 55 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25) {
      goToPage(deltaX < 0 ? pageNumber + 1 : pageNumber - 1);
    }
  },
  { passive: true },
);

const resizeObserver = new ResizeObserver(() => {
  if (!pdfDocument) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(pageNumber, { resetScroll: false }), 180);
});
resizeObserver.observe(stage);

async function initializeViewer() {
  try {
    const loadingTask = pdfjsLib.getDocument({
      url: PDF_URL,
      cMapUrl: "./pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "./pdfjs/standard_fonts/",
      wasmUrl: "./pdfjs/wasm/",
    });

    loadingTask.onProgress = ({ loaded, total }) => {
      if (!total) return;
      const percent = Math.min(100, Math.round((loaded / total) * 100));
      loadingProgress.style.width = `${percent}%`;
      loadingLabel.textContent = `正在加载作品集 · ${percent}%`;
    };

    pdfDocument = await loadingTask.promise;
    pageInput.disabled = false;
    controls.zoomOut.disabled = false;
    controls.zoomIn.disabled = false;
    controls.fit.disabled = false;
    await renderPage(pageNumber);
    loading.hidden = true;
    stage.setAttribute("aria-busy", "false");
  } catch (error) {
    console.error("PDF viewer failed to initialize", error);
    loading.hidden = true;
    errorPanel.hidden = false;
    stage.setAttribute("aria-busy", "false");
  }
}

initializeViewer();
